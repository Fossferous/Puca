package com.sovereign.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * The SharedPreferences mirror of the notification gates that live in the
 * WebView's localStorage.
 *
 * WHY THIS EXISTS. Background message delivery runs in Java (NativeDelivery's
 * socket inside KeepAliveService), in a process whose WebView may be throttled
 * or long gone: it cannot read localStorage, where the user's mutes and blocks
 * actually live. So the JS side write-through-mirrors the gate state here on
 * every change (SovereignAppPlugin.syncPushGates), and the native handler
 * reads this. Without the mirror, native delivery silently degrades to
 * "notify for everything", which would be worse than the feature not existing.
 *
 * Value shapes mirror the JS stores byte-for-byte rather than re-modelling:
 * muted servers map to `true` ('nothing') or `"mentions"` — both suppress a
 * push, because a push is a generic ping and the server cannot detect an
 * @mention inside encrypted content.
 */
public final class PushPrefs {

    private static final String FILE = "sovereign_push";
    private static final String KEY_ACCOUNT = "account_user_id";
    private static final String KEY_MUTED_SERVERS = "muted_servers";
    private static final String KEY_MUTED_CHANNELS = "muted_channels";
    private static final String KEY_BLOCKED = "blocked_ids";
    private static final String KEY_ENABLED = "push_enabled";
    /** The user's "deliver in the background" switch, mirrored separately from
     *  {@link #KEY_ENABLED}. Deliberately NOT the same key: push_enabled is
     *  the MASTER notification switch (PushGate reads it to decide whether to
     *  notify at all), so folding background delivery into it would silence
     *  foreground notifications for anyone who merely wanted their phone to
     *  stop holding a socket open. Two user-facing switches, two prefs. */
    private static final String KEY_DELIVERY_OPT_IN = "delivery_opt_in";
    /** Native delivery socket credentials — the app's OWN server, no third
     *  party. Synced by JS on login/renewal; cleared with the account. The
     *  token is the session JWT, stored MODE_PRIVATE — the same protection
     *  class as the WebView localStorage it mirrors. */
    private static final String KEY_WS_URL = "delivery_ws_url";
    private static final String KEY_AUTH_TOKEN = "delivery_auth_token";
    /** Device id the delivery socket CLAIMS at connect so "sign out this
     *  device" can hang it up server-side. Kill-only; never an identity. */
    private static final String KEY_DELIVERY_DEVICE = "delivery_device_id";
    /** FCM wake token minted while the app was dead — parked here by
     *  SovereignWakeService.onNewToken, drained by JS on next app start
     *  (registration needs the JWT, which lives in WebView storage). */
    private static final String KEY_PENDING_WAKE_TOKEN = "pending_wake_token";
    /** Set by MainActivity's lifecycle: the app is on screen, so the in-app
     *  UI owns the moment and the native path must not post over it. */
    private static final String KEY_APP_VISIBLE = "app_visible";

    private PushPrefs() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    // --- writes (from the plugin, driven by JS) ---------------------------

    public static void setAccount(Context ctx, String userId) {
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (userId == null || userId.isEmpty()) {
            // Logout clears EVERYTHING, not just the account: the next account
            // on this phone must not inherit the previous one's mutes/blocks.
            e.clear();
        } else {
            e.putString(KEY_ACCOUNT, userId);
        }
        e.apply();
    }

    public static void setGates(Context ctx, String mutedServersJson, String mutedChannelsJson,
                                String blockedIdsJson, boolean pushEnabled,
                                boolean backgroundDelivery) {
        prefs(ctx).edit()
                .putString(KEY_MUTED_SERVERS, mutedServersJson)
                .putString(KEY_MUTED_CHANNELS, mutedChannelsJson)
                .putString(KEY_BLOCKED, blockedIdsJson)
                .putBoolean(KEY_ENABLED, pushEnabled)
                .putBoolean(KEY_DELIVERY_OPT_IN, backgroundDelivery)
                .apply();
    }

    public static void setDelivery(Context ctx, String wsUrl, String authToken) {
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (wsUrl == null || authToken == null) {
            e.remove(KEY_WS_URL).remove(KEY_AUTH_TOKEN);
        } else {
            e.putString(KEY_WS_URL, wsUrl).putString(KEY_AUTH_TOKEN, authToken);
        }
        e.apply();
    }

    public static void setAppVisible(Context ctx, boolean visible) {
        prefs(ctx).edit().putBoolean(KEY_APP_VISIBLE, visible).apply();
    }

    // --- reads (from the FCM service and the plugin) ----------------------

    public static String account(Context ctx) {
        return prefs(ctx).getString(KEY_ACCOUNT, null);
    }

    /** Default TRUE: a user who never touched a setting expects notifications.
     *  The JS mirror overwrites this on first sync. */
    public static boolean pushEnabled(Context ctx) {
        return prefs(ctx).getBoolean(KEY_ENABLED, true);
    }

    /** Has the user opted into background delivery?
     *
     *  Default TRUE, and that default is load-bearing: an APK carrying this
     *  key can be installed before the JS bundle that sends it (the OTA lands
     *  separately), and old JS never sets it. Defaulting FALSE would silently
     *  switch background delivery off for every user in that window. */
    public static boolean deliveryOptIn(Context ctx) {
        return prefs(ctx).getBoolean(KEY_DELIVERY_OPT_IN, true);
    }

    public static String wsUrl(Context ctx) {
        return prefs(ctx).getString(KEY_WS_URL, null);
    }

    public static String authToken(Context ctx) {
        return prefs(ctx).getString(KEY_AUTH_TOKEN, null);
    }

    public static void setDeliveryDeviceId(Context ctx, String deviceId) {
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (deviceId == null || deviceId.isEmpty()) e.remove(KEY_DELIVERY_DEVICE);
        else e.putString(KEY_DELIVERY_DEVICE, deviceId);
        e.apply();
    }

    public static String deliveryDeviceId(Context ctx) {
        return prefs(ctx).getString(KEY_DELIVERY_DEVICE, null);
    }

    public static void setPendingWakeToken(Context ctx, String token) {
        prefs(ctx).edit().putString(KEY_PENDING_WAKE_TOKEN, token).apply();
    }

    /** One-shot read-and-clear: a parked token is registered exactly once. */
    public static String takePendingWakeToken(Context ctx) {
        String t = prefs(ctx).getString(KEY_PENDING_WAKE_TOKEN, null);
        if (t != null) prefs(ctx).edit().remove(KEY_PENDING_WAKE_TOKEN).apply();
        return t;
    }

    public static boolean appVisible(Context ctx) {
        return prefs(ctx).getBoolean(KEY_APP_VISIBLE, false);
    }

    /** server id -> "nothing" | "mentions". Absent = 'all' (not muted). */
    public static Map<String, String> mutedServers(Context ctx) {
        Map<String, String> out = new HashMap<>();
        try {
            JSONObject o = new JSONObject(prefs(ctx).getString(KEY_MUTED_SERVERS, "{}"));
            for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                Object v = o.get(k);
                // `true` is the legacy 'nothing' encoding — see mutedServersStore.
                if (Boolean.TRUE.equals(v)) out.put(k, "nothing");
                else if ("mentions".equals(v)) out.put(k, "mentions");
            }
        } catch (Exception ignored) {
            // Unparseable mirror = treat as no mutes; the JS re-sync heals it.
        }
        return out;
    }

    public static Set<String> mutedChannels(Context ctx) {
        Set<String> out = new HashSet<>();
        try {
            JSONObject o = new JSONObject(prefs(ctx).getString(KEY_MUTED_CHANNELS, "{}"));
            for (java.util.Iterator<String> it = o.keys(); it.hasNext(); ) {
                String k = it.next();
                if (o.optBoolean(k, false)) out.add(k);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    public static Set<String> blockedIds(Context ctx) {
        Set<String> out = new HashSet<>();
        try {
            JSONArray a = new JSONArray(prefs(ctx).getString(KEY_BLOCKED, "[]"));
            for (int i = 0; i < a.length(); i++) out.add(String.valueOf(a.get(i)));
        } catch (Exception ignored) {
        }
        return out;
    }
}
