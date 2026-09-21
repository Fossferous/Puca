package com.sovereign.notes;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Three small decisions the background side makes, kept pure (no android.*)
 * so each runs under plain JUnit (ReminderRulesTest):
 *
 *  - what an HTTP status from GET /task-reminders means for the session;
 *  - which entries an alarm that is firing RIGHT NOW still announces when its
 *    pre-fire check finds the session dead;
 *  - whether Púca Notes can honestly tell Púca "I own due-item reminders on
 *    this phone" (ReminderOwnerProvider), so Púca stays quiet only when one
 *    alert per item is actually going to happen.
 */
public final class ReminderRules {

    private ReminderRules() {}

    public static final int OK = 0;
    public static final int AUTH_DEAD = 1;
    public static final int FAILED = 2;

    /**
     * 401 and only 401 is a dead session: the auth middleware answers 401 for
     * a bad, expired or revoked token and nothing else (src/auth.rs). A 403 is
     * a permission answer, and a 5xx or a proxy's error page is the server
     * having a bad minute — both are FAILED, retried next period, never a
     * reason to drop the token and stop the job for good.
     */
    public static int refreshOutcome(int httpStatus) {
        if (httpStatus == 200) return OK;
        if (httpStatus == 401) return AUTH_DEAD;
        return FAILED;
    }

    /**
     * The entries an alarm plans its notification from after its pre-fire
     * check. Normally what the store holds now (the check may have dropped an
     * item completed elsewhere). But a DEAD session drops every passed entry
     * unchecked, and that includes the one this alarm woke up to announce: the
     * user asked to be reminded, and a lost session is not a reason to stay
     * silent about it. So on AUTH_DEAD the entries that were due at `now`
     * BEFORE the check are put back for this one firing (the store itself
     * keeps them dropped — they fire once, here, and are never re-armed).
     */
    public static List<ReminderPlan.Entry> entriesToFire(
            List<ReminderPlan.Entry> before, List<ReminderPlan.Entry> after, int outcome, long now) {
        if (outcome != AUTH_DEAD) return after;
        List<ReminderPlan.Entry> out = new ArrayList<>(after);
        // Per ENTRY, not per id: a repeating item keeps its FUTURE
        // occurrences through the drop, and matching on the id alone would
        // then skip the occurrence that is firing now.
        Set<String> have = new HashSet<>();
        for (ReminderPlan.Entry e : after) have.add(entryKey(e));
        for (ReminderPlan.Entry e : before) {
            if (e.atMs <= now && !have.contains(entryKey(e))) out.add(e);
        }
        return out;
    }

    private static String entryKey(ReminderPlan.Entry e) {
        return e.id + "|" + e.atMs + "|" + e.mark;
    }

    /** How recently the reminder feed must have been read (the hourly job, or
     *  the open page's own poll) for Notes to claim it is keeping up. Three
     *  periods of the ~hourly job: one late run is normal, three is not. */
    public static final long OWNERSHIP_FRESH_MS = 3L * 60 * 60_000L;
    /** A last-sync stamp this far in the FUTURE is a clock that moved back;
     *  a little is NTP noise, more is not trusted. */
    public static final long CLOCK_SKEW_MS = 5L * 60_000L;

    /** The stored token must outlive "now" by at least this: a token about
     *  to lapse cannot fetch the next feed, and exp comes from the server's
     *  clock (the same allowance as {@link #CLOCK_SKEW_MS}). */
    public static final long TOKEN_MARGIN_MS = 5L * 60_000L;

    /** What Notes knows about itself when Púca asks. */
    public static final class OwnerState {
        public final boolean hasToken;
        /** The stored token's JWT exp, epoch ms; -1 when unreadable. */
        public final long tokenExpMs;
        public final String account;
        /** The API base the stored session talks to. */
        public final String apiBase;
        public final long lastSyncMs;
        public final boolean notificationsAllowed;
        public final boolean alarmNeeded;
        public final boolean alarmPresent;
        /** The armed entries (ids, times, marks). */
        public final List<ReminderPlan.Entry> entries;

        public OwnerState(boolean hasToken, long tokenExpMs, String account, String apiBase, long lastSyncMs,
                          boolean notificationsAllowed, boolean alarmNeeded, boolean alarmPresent,
                          List<ReminderPlan.Entry> entries) {
            this.hasToken = hasToken;
            this.tokenExpMs = tokenExpMs;
            this.account = account;
            this.apiBase = apiBase;
            this.lastSyncMs = lastSyncMs;
            this.notificationsAllowed = notificationsAllowed;
            this.alarmNeeded = alarmNeeded;
            this.alarmPresent = alarmPresent;
            this.entries = entries == null ? new ArrayList<ReminderPlan.Entry>() : entries;
        }
    }

    /** One reminder Púca is about to announce: the task id and its mark
     *  (frontend/src/api/reminderFeed.ts — the same derivation both apps run). */
    public static final class Due {
        public final long id;
        public final String mark;

        public Due(long id, String mark) {
            this.id = id;
            this.mark = mark == null ? "" : mark;
        }
    }

    /** Púca's question: which account, on which server, about which items. */
    public static final class Ask {
        public final String account;
        public final String server;
        public final List<Due> due;

        public Ask(String account, String server, List<Due> due) {
            this.account = account;
            this.server = server;
            this.due = due;
        }
    }

    /**
     * The `due` query parameter: a JSON array of {id, mark}. null when absent
     * or not that shape — which answers "no" (Púca then notifies).
     */
    public static List<Due> parseDue(String json) {
        if (json == null || json.isEmpty()) return null;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(json);
            List<Due> out = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) {
                org.json.JSONObject o = arr.getJSONObject(i);
                if (!o.has("id") || !o.has("mark") || o.isNull("mark")) return null;
                out.add(new Due(o.getLong("id"), o.getString("mark")));
            }
            return out;
        } catch (Exception e) {
            return null;
        }
    }

    /** The same API base, give or take a trailing slash and letter case (a
     *  scheme and host are case-insensitive). */
    public static boolean sameServer(String a, String b) {
        if (a == null || b == null) return false;
        return trimSlashes(a.trim()).equalsIgnoreCase(trimSlashes(b.trim())) && !a.trim().isEmpty();
    }

    private static String trimSlashes(String s) {
        int end = s.length();
        while (end > 0 && s.charAt(end - 1) == '/') end--;
        return s.substring(0, end);
    }

    /**
     * Does Púca Notes own THESE due reminders for this account right now?
     * EVERY condition must hold; anything unknown is "no", because "no" costs
     * at worst a second notification and a wrong "yes" costs the only one:
     *
     *  - a live session token whose JWT exp is more than
     *    {@link #TOKEN_MARGIN_MS} away (signed out, a 401 seen by the job, or
     *    a token that lapsed between job runs, as at the 30-day cap: no);
     *  - the SAME account on the SAME server Púca is signed in to (user 42 on
     *    another server is someone else; an absent account or server: no);
     *  - the feed read successfully within {@link #OWNERSHIP_FRESH_MS}
     *    (a job Android has not run for hours, a force-stopped app whose job
     *    was cancelled: no);
     *  - notifications allowed (permission, app switch and Reminders channel);
     *  - the alarm actually set whenever something is owed (a force-stop
     *    cancels it; a store with nothing owed needs none);
     *  - and EVERY item Púca is about to announce is armed here under the same
     *    mark — the same reminder, not just the same id. An item created or
     *    re-timed elsewhere since Notes' last look is not, so Púca announces
     *    it rather than leaving it until Notes' next refresh (up to the
     *    freshness window late).
     */
    public static boolean ownsDueReminders(OwnerState s, Ask ask, long now) {
        if (s == null || !s.hasToken || ask == null) return false;
        if (s.tokenExpMs <= 0 || s.tokenExpMs <= now + TOKEN_MARGIN_MS) return false;
        if (ask.account == null || ask.account.isEmpty() || !ask.account.equals(s.account)) return false;
        if (!sameServer(ask.server, s.apiBase)) return false;
        if (s.lastSyncMs <= 0) return false;
        long age = now - s.lastSyncMs;
        if (age > OWNERSHIP_FRESH_MS || age < -CLOCK_SKEW_MS) return false;
        if (!s.notificationsAllowed) return false;
        if (s.alarmNeeded && !s.alarmPresent) return false;
        if (ask.due == null || ask.due.isEmpty()) return false;
        if (s.entries == null) return false; // anything unknown is no, the armed list included
        Set<String> armed = new HashSet<>();
        for (ReminderPlan.Entry e : s.entries) armed.add(e.id + "|" + e.mark);
        for (Due d : ask.due) {
            if (!armed.contains(d.id + "|" + d.mark)) return false;
        }
        return true;
    }
}
