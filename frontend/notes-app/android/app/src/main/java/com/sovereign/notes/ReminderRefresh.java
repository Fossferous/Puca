package com.sovereign.notes;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * One background look at GET /task-reminders with the stored session — the
 * shared step behind the hourly refresh job and the alarm's pre-fire check.
 *
 * Talks only to the user's own server (the API base the page itself uses),
 * with no new dependency (HttpURLConnection). The response is ids and due
 * times, which the server already holds in clear; nothing sealed is read or
 * written. A renewed token in `x-renewed-token` is kept (never a staler one —
 * {@link JwtClaims#newer}) and handed back to the page on its next start.
 *
 * On 401/403 the session is dead (expired past its 30-day cap, signed out
 * everywhere, password changed): the token is dropped, the job is cancelled —
 * never retried in a loop — reminders whose time has already passed are
 * dropped (they may be done by now and nothing can check), and ONE
 * content-free notice asks the user to open the app. Future reminders stay
 * armed: they were right when last seen, and the next open re-syncs them.
 */
final class ReminderRefresh {

    static final int OK = 0;
    static final int AUTH_DEAD = 1;
    static final int FAILED = 2;
    static final int NO_SESSION = 3;

    private static final int MAX_BODY = 2 * 1024 * 1024;

    private ReminderRefresh() {}

    static int refresh(Context ctx, int timeoutMs) {
        String apiBase;
        String token;
        String account;
        synchronized (ReminderStore.LOCK) {
            apiBase = ReminderStore.apiBase(ctx);
            token = ReminderStore.token(ctx);
            account = ReminderStore.account(ctx);
        }
        if (apiBase == null || token == null || account == null) return NO_SESSION;

        int status;
        String body = null;
        String renewed = null;
        HttpURLConnection c = null;
        try {
            String base = apiBase.endsWith("/") ? apiBase.substring(0, apiBase.length() - 1) : apiBase;
            c = (HttpURLConnection) new URL(base + "/task-reminders").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setRequestProperty("Accept", "application/json");
            c.setUseCaches(false);
            status = c.getResponseCode();
            renewed = c.getHeaderField("x-renewed-token");
            if (status == 200) body = readCapped(c.getInputStream());
        } catch (Exception e) {
            return FAILED; // offline, DNS, TLS, timeout — try again next period
        } finally {
            if (c != null) c.disconnect();
        }

        if (status == 401 || status == 403) {
            authDead(ctx, token);
            return AUTH_DEAD;
        }
        if (status != 200 || body == null) return FAILED;

        List<ReminderMerge.FeedRow> rows;
        try {
            rows = ReminderMerge.parseFeed(body);
        } catch (Exception e) {
            return FAILED; // not a feed: never read as "nothing is due"
        }
        synchronized (ReminderStore.LOCK) {
            // The session may have moved while the request was out (sign-out,
            // account switch). Only fold into the store it was made for.
            if (!account.equals(ReminderStore.account(ctx)) || ReminderStore.token(ctx) == null) {
                return FAILED;
            }
            if (renewed != null && !renewed.isEmpty()) {
                ReminderStore.setCredentials(ctx, apiBase,
                        JwtClaims.newer(ReminderStore.token(ctx), renewed));
            }
            ReminderStore.setEntries(ctx, ReminderMerge.merge(ReminderStore.entries(ctx), rows));
        }
        ReminderAlarms.arm(ctx);
        return OK;
    }

    /** The 401 path (see the class comment). `tokenUsed` guards a race: if the
     *  page handed over a fresh token while this request was out, the refusal
     *  was for the old one and nothing is dead. */
    static void authDead(Context ctx, String tokenUsed) {
        boolean post;
        synchronized (ReminderStore.LOCK) {
            String cur = ReminderStore.token(ctx);
            if (cur == null || !cur.equals(tokenUsed)) return;
            ReminderStore.clearToken(ctx);
            ReminderStore.setEntries(ctx,
                    ReminderMerge.dropPassed(ReminderStore.entries(ctx), System.currentTimeMillis()));
            post = !ReminderStore.staleNoticePosted(ctx);
            ReminderStore.setStaleNoticePosted(ctx, true);
        }
        ReminderRefreshJob.cancel(ctx);
        if (post) NotesNotifier.postStale(ctx);
        ReminderAlarms.arm(ctx);
    }

    private static String readCapped(InputStream in) throws Exception {
        try (InputStream s = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            int total = 0;
            while ((n = s.read(buf)) > 0) {
                total += n;
                if (total > MAX_BODY) throw new Exception("reminder feed too large");
                out.write(buf, 0, n);
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
