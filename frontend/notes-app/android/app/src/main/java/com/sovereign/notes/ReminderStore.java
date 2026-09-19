package com.sovereign.notes;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * App-private state for due reminders and the background refresh.
 *
 * WHAT IS HERE: the signed-in account id, the reminder entries ({id, at,
 * mark, due} — ids and times, which the server already holds in clear), the
 * fired markers, the API base, and a COPY of the session token so the
 * refresh job can call GET /task-reminders while the app is closed (an owner
 * decision; docs/NOTES.md "The Android app"). WHAT IS NOT: any title, item
 * text, label or place — nothing here says what a reminder is about.
 *
 * Backup: excluded. android:allowBackup is false AND the manifest carries the
 * include-only backup / data-extraction rules copied from Púca, so neither a
 * cloud backup nor a device-to-device transfer can carry the token off the
 * phone even if someone later re-enables backup.
 *
 * Every read-modify-write runs under {@link #LOCK}: the plugin thread, the
 * alarm receiver's worker and the refresh job can all touch this at once.
 */
final class ReminderStore {

    static final Object LOCK = new Object();

    private static final String PREFS = "puca_notes_reminders";
    private static final String K_ACCOUNT = "account";
    private static final String K_ENTRIES = "entries";
    private static final String K_FIRED = "fired";
    private static final String K_API = "apiBase";
    private static final String K_TOKEN = "token";
    private static final String K_STALE_POSTED = "staleNoticePosted";

    private ReminderStore() {}

    private static SharedPreferences p(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String account(Context ctx) {
        return p(ctx).getString(K_ACCOUNT, null);
    }

    static String apiBase(Context ctx) {
        return p(ctx).getString(K_API, null);
    }

    static String token(Context ctx) {
        return p(ctx).getString(K_TOKEN, null);
    }

    static boolean staleNoticePosted(Context ctx) {
        return p(ctx).getBoolean(K_STALE_POSTED, false);
    }

    static void setStaleNoticePosted(Context ctx, boolean posted) {
        p(ctx).edit().putBoolean(K_STALE_POSTED, posted).commit();
    }

    /** A different account (or none) replaces EVERYTHING: the next account
     *  must not inherit this one's entries, markers or token. */
    static void bindAccount(Context ctx, String account) {
        String cur = account(ctx);
        if (account != null && account.equals(cur)) return;
        p(ctx).edit().clear().putString(K_ACCOUNT, account).commit();
    }

    static void setCredentials(Context ctx, String apiBase, String token) {
        SharedPreferences.Editor e = p(ctx).edit();
        if (apiBase == null) e.remove(K_API); else e.putString(K_API, apiBase);
        if (token == null) e.remove(K_TOKEN); else e.putString(K_TOKEN, token);
        e.commit();
    }

    static void clearToken(Context ctx) {
        p(ctx).edit().remove(K_TOKEN).commit();
    }

    /** Sign-out, soft expiry, account switch: nothing survives. */
    static void wipe(Context ctx) {
        p(ctx).edit().clear().commit();
    }

    static List<ReminderPlan.Entry> entries(Context ctx) {
        List<ReminderPlan.Entry> out = new ArrayList<>();
        String raw = p(ctx).getString(K_ENTRIES, null);
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null || !o.has("id") || !o.has("at")) continue;
                out.add(new ReminderPlan.Entry(
                        o.getLong("id"),
                        o.getLong("at"),
                        o.optString("mark", ""),
                        o.has("due") && !o.isNull("due") ? o.getString("due") : null));
            }
        } catch (Exception ignored) {
            // A corrupt blob degrades to "no reminders", never to a crash loop
            // inside a broadcast receiver.
        }
        return out;
    }

    static void setEntries(Context ctx, List<ReminderPlan.Entry> entries) {
        JSONArray arr = new JSONArray();
        try {
            for (ReminderPlan.Entry e : entries) {
                JSONObject o = new JSONObject();
                o.put("id", e.id);
                o.put("at", e.atMs);
                o.put("mark", e.mark);
                if (e.due != null) o.put("due", e.due);
                arr.put(o);
            }
        } catch (Exception ignored) { /* JSONObject.put only throws on NaN keys */ }
        p(ctx).edit().putString(K_ENTRIES, arr.toString()).commit();
    }

    static Map<String, String> fired(Context ctx) {
        Map<String, String> out = new HashMap<>();
        String raw = p(ctx).getString(K_FIRED, null);
        if (raw == null || raw.isEmpty()) return out;
        try {
            JSONObject o = new JSONObject(raw);
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                out.put(k, o.optString(k, ""));
            }
        } catch (Exception ignored) { /* as above */ }
        return out;
    }

    static void setFired(Context ctx, Map<String, String> fired) {
        JSONObject o = new JSONObject();
        try {
            for (Map.Entry<String, String> e : fired.entrySet()) o.put(e.getKey(), e.getValue());
        } catch (Exception ignored) { /* string keys and values cannot fail */ }
        p(ctx).edit().putString(K_FIRED, o.toString()).commit();
    }
}
