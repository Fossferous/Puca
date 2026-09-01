package com.sovereign.app;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.Map;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * Background message delivery over a NATIVE WebSocket to the user's OWN
 * server. No third party carries data — the only Google involvement anywhere
 * is the wake doorbell (SovereignWakeService), whose payload is a constant.
 *
 * WHY NATIVE. The app's real socket lives in the WebView, and a backgrounded
 * WebView's JavaScript is throttled/frozen at the platform's whim — its
 * heartbeats stop, the server reaps the session (~75s), and the frames it
 * would have delivered were never queued. Native heartbeats fix the actual
 * fault; the server-side undelivered queue plus the wake signal now cover the
 * remaining gap (frames sent while even this socket was dead).
 *
 * CONNECTS AS `mode=delivery`: the server keeps this session out of presence
 * (a pocketed phone is not "online"), out of file-transfer deliverability
 * (this socket would drop an offer unread), and hands it the undelivered
 * queue on connect. It also claims the device id (`device=`) so "sign out
 * this device" can hang this socket up — the claim is kill-only server-side.
 *
 * EVERY SOCKET GETS ITS OWN LISTENER (SocketListener below), holding its own
 * WebSocket reference and the account it authenticated as. The first shipped
 * version shared one listener across sockets: a reconnect's close-then-open
 * interleaved with the old socket's callbacks, orphaning a live socket on
 * EVERY app open — two sessions per phone, a server reap every 75s, and every
 * background message buzzing twice. Callbacks now self-identify; a callback
 * from a socket that is no longer current cancels that socket and does
 * nothing else. The per-socket account also closes the logout→login race
 * where a frame on a dying socket could be stamped with the NEW account.
 */
final class NativeDelivery {

    private static final String TAG = "PucaDelivery";
    /** App-level heartbeat. The server's staleness watchdog wants ~45s; 25s
     *  leaves one full miss of headroom. okhttp's transport pings (below)
     *  keep NATs open but the server counts only real frames. */
    private static final long PING_MS = 25_000;
    private static final long BACKOFF_MIN_MS = 5_000;
    private static final long BACKOFF_MAX_MS = 300_000;

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS) // transport-level keepalive
            .build();

    /** The CURRENT socket's listener; callbacks from any other are stale.
     *  Main-thread-only. */
    private SocketListener current;
    private boolean running;
    private long backoffMs = BACKOFF_MIN_MS;

    NativeDelivery(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    /** Idempotent. Reads url+token from PushPrefs; no-op until both exist. */
    void start() {
        if (running) return;
        running = true;
        backoffMs = BACKOFF_MIN_MS;
        connect();
    }

    void stop() {
        running = false;
        main.removeCallbacksAndMessages(null);
        dropCurrent("service stopping");
    }

    /** Credentials changed (login, token renewal): reconnect with the new ones. */
    void credentialsChanged() {
        if (!running) return;
        backoffMs = BACKOFF_MIN_MS;
        main.removeCallbacksAndMessages(null);
        dropCurrent("credentials changed");
        connect();
    }

    /**
     * The wake doorbell rang: something undelivered is parked server-side.
     * Drop and redial UNCONDITIONALLY — see the body for why a socket that
     * looks healthy from here is not.
     *
     * (This javadoc used to say the opposite, "a healthy socket is left
     * alone", describing an earlier design the code below deliberately
     * replaced. The server-side delivery-socket dedupe relies on the
     * unconditional behaviour being the real one.)
     */
    void reconnectNow() {
        if (!running) {
            start();
            return;
        }
        // UNCONDITIONAL drop-and-redial. A wake only ever fires because the
        // SERVER saw no session — so whatever this side still holds as
        // `current` is dead or dying (a Doze-frozen socket never learns it:
        // postDelayed uses uptime, which stands still in deep sleep, so the
        // pinger never ran and the FIN was never read). Trusting a non-null
        // `current` here turned the doorbell into a no-op precisely when it
        // was needed; the server's 30s wake rate limit bounds the churn.
        backoffMs = BACKOFF_MIN_MS;
        main.removeCallbacksAndMessages(null);
        dropCurrent("wake: server saw no session");
        connect();
    }

    private void dropCurrent(String reason) {
        if (current != null) {
            current.retire(reason);
            current = null;
        }
    }

    private void connect() {
        if (!running) return;
        String url = PushPrefs.wsUrl(ctx);
        String token = PushPrefs.authToken(ctx);
        String account = PushPrefs.account(ctx);
        if (url == null || token == null || account == null) {
            // Signed out, or the JS side has not synced yet. Poll gently —
            // login triggers a service restart anyway; this is the backstop.
            main.postDelayed(this::connect, 30_000);
            return;
        }
        // Presence-invisible, transfer-excluded, queue-draining.
        StringBuilder full = new StringBuilder(url).append("?mode=delivery");
        String device = PushPrefs.deliveryDeviceId(ctx);
        if (device != null && !device.isEmpty()) {
            full.append("&device=").append(device);
        }
        SocketListener listener = new SocketListener(account);
        current = listener;
        // THE TOKEN RIDES A HEADER, NOT THE URL. This was "?token=" + token,
        // and a query string is written verbatim into the access log of every
        // proxy and web server on the path — so this phone deposited a live
        // session credential into log files on every reconnect, and this socket
        // reconnects often (Doze, network changes, keep-alive restarts).
        //
        // Unlike a browser, OkHttp CAN set request headers on a WebSocket, so
        // this end sends the standard two-value offer directly rather than
        // needing the constructor trick the web client uses.
        //
        // The server prefers this header and still accepts the old query
        // parameter, so an APK older than this keeps connecting.
        listener.ws = http.newWebSocket(
                new Request.Builder()
                        .url(full.toString())
                        .addHeader("Sec-WebSocket-Protocol", "bearer, " + token)
                        .build(),
                listener);
    }

    private void scheduleReconnect(SocketListener from) {
        if (!running) return;
        // Only the CURRENT socket's death schedules anything; a stale
        // socket's close must not cancel the live one's pinger or spawn a
        // competing connect — that interleaving was the orphan loop.
        if (from != current) return;
        current = null;
        long delay = backoffMs;
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
        Log.i(TAG, "reconnecting in " + delay + "ms");
        main.postDelayed(this::connect, delay);
    }

    /** Auth is dead (401): retrying with the same token is noise, and the
     *  shade claiming "Connected" over it is the lie this feature exists to
     *  retire. Park until the JS side syncs a fresh token, and say so. */
    private void authDead(SocketListener from) {
        if (from != current) return;
        current = null;
        Log.i(TAG, "delivery token rejected — parking until credentials refresh");
        PushPrefs.setDelivery(ctx, null, null);
        KeepAliveService.postDeliveryPausedNotice(ctx);
        // running stays true: connect()'s null-credential branch polls gently
        // and picks up the renewed token the moment JS writes it.
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::connect, 30_000);
    }

    /** One WebSocket's lifecycle, and only that socket's. */
    private final class SocketListener extends WebSocketListener {
        /** The account THIS socket authenticated as — frames are stamped with
         *  it, so a socket outliving a logout stamps the OLD account and the
         *  gate drops its frames, never the next user's. */
        private final String account;
        WebSocket ws;
        private final Runnable pinger = new Runnable() {
            @Override public void run() {
                if (SocketListener.this != current || ws == null) return;
                ws.send("{\"type\":\"Ping\"}");
                main.postDelayed(this, PING_MS);
            }
        };

        SocketListener(String account) {
            this.account = account;
        }

        /** No longer the current socket: close and go quiet. */
        void retire(String reason) {
            main.removeCallbacks(pinger);
            if (ws != null) {
                ws.close(1000, reason);
                ws = null;
            }
        }

        @Override public void onOpen(WebSocket webSocket, Response response) {
            main.post(() -> {
                if (SocketListener.this != current) {
                    webSocket.cancel();
                    return;
                }
                Log.i(TAG, "delivery socket open");
                backoffMs = BACKOFF_MIN_MS;
                main.removeCallbacks(pinger);
                main.postDelayed(pinger, PING_MS);
            });
        }

        @Override public void onMessage(WebSocket webSocket, String text) {
            Map<String, String> data = PushFrames.toData(text);
            if (data == null) return;
            // Stamped from THIS socket's account, captured at connect — not
            // from mutable shared state a newer login may have overwritten.
            data.put("recipient_id", account);
            main.post(() -> {
                if (SocketListener.this != current) return; // stale socket
                // On-screen: the in-app UI owns the moment (JS gate's mirror).
                if (PushPrefs.appVisible(ctx)) return;
                String reason = PushGate.suppressReason(
                        PushPrefs.account(ctx),
                        PushPrefs.pushEnabled(ctx),
                        PushPrefs.mutedServers(ctx),
                        PushPrefs.mutedChannels(ctx),
                        PushPrefs.blockedIds(ctx),
                        data);
                if (reason != null) {
                    Log.i(TAG, "notification suppressed: " + reason);
                    return;
                }
                SovereignNotifier.post(ctx, data.get("key"), data.get("title"),
                        data.get("body"), data.get("nav"));
            });
        }

        @Override public void onClosed(WebSocket webSocket, int code, String reason) {
            Log.i(TAG, "delivery socket closed: " + code + " " + reason);
            main.post(() -> scheduleReconnect(SocketListener.this));
        }

        @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
            int code = response == null ? -1 : response.code();
            Log.i(TAG, "delivery socket failure (" + code + "): " + t.getMessage());
            if (code == 401) {
                main.post(() -> authDead(SocketListener.this));
            } else {
                main.post(() -> scheduleReconnect(SocketListener.this));
            }
        }
    }
}
