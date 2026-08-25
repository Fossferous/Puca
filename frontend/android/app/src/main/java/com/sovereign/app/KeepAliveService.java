package com.sovereign.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps the app's process — and with it the WebView, the WebSocket and any
 * WebRTC session living in JavaScript — running while the app is in the
 * background. Same mechanism as {@link TransferService} (see the long comment
 * there for why a foreground service is the only thing that works), but for
 * two open-ended reasons instead of a bounded transfer:
 *
 *  - CONTROL: a My Devices remote-control session is active. Backgrounding
 *    the app used to end it: the process froze, ICE consent lapsed, and the
 *    server reaped the session before the phone thawed.
 *  - NOTIFY: the user opted into background notification delivery. Puca
 *    is self-hosted and data rides no relay (the FCM wake signal carries a
 *    constant only), so like the desktop tray the
 *    only way to hear about a message is to still be connected.
 *
 * Both are open-ended, so the type is specialUse, not dataSync — dataSync
 * carries a cumulative six-hour budget on Android 15 which the transfers
 * service already spends, and a control session must not die because a file
 * transfer ran earlier that day.
 *
 * The wake lock is held only while CONTROL is among the reasons: an active
 * session must survive the screen turning off mid-use, but notification
 * delivery must not pin the CPU around the clock — for that, the process
 * being alive is enough for the socket to wake it.
 */
public class KeepAliveService extends Service {

    public static final String CHANNEL_ID = "sovereign_background";
    public static final int NOTIFICATION_ID = 4712;

    /** Desired state, sent complete on every start. A start carrying these
     *  extras is a DECLARATION: it replaces all three reasons, because JS is
     *  the authority on what is wanted. See {@link KeepAliveReasons}. */
    public static final String EXTRA_CONTROL = "control";
    public static final String EXTRA_NOTIFY = "notify";
    /** Location reminders: task fences exist and the setting is on. The
     *  service watches location and fires content-free arrival notifications
     *  entirely natively — the WebView is not in this loop at all. */
    public static final String EXTRA_GEOFENCE = "geofence";

    /** An EVENT start, not a declaration: the wake doorbell rang and delivery
     *  must be running. Carries no opinion about the other reasons and must
     *  not disturb them — a doorbell is evidence about the server's queue and
     *  nothing else. Sent by {@link SovereignWakeService}. */
    public static final String ACTION_WAKE = "com.sovereign.app.WAKE";

    /** Between fixes, ask again only after moving this far — a phone sitting
     *  on a desk generates no callbacks (and can't change fence state). */
    private static final float MIN_DISTANCE_M = 30f;

    private PowerManager.WakeLock wakeLock;

    /** The last complete set of reasons this service was DECLARED, adjusted by
     *  any events since. Mirrors what JS decided; it never decides anything
     *  itself. Held so an event start (the wake doorbell) can run without
     *  having to invent values for the reasons it knows nothing about — see
     *  {@link KeepAliveReasons}. Dies with the process (START_NOT_STICKY). */
    private KeepAliveReasons reasons = KeepAliveReasons.NONE;

    /** Did we successfully enter the foreground, and are we still there?
     *  Distinguishes a FRESH start that could not be promoted (must stopSelf,
     *  or the system throws the uncatchable "did not start in time") from a
     *  later start against an already-running service (must carry on — the
     *  session it is protecting is still live). */
    private boolean inForeground;

    /** The NATIVE delivery socket (self-hosted push — the user's own server,
     *  no third party). Runs while NOTIFY is among the reasons. Unlike the
     *  WebView's socket it survives swipe-away and JS throttling; see
     *  NativeDelivery for the honest limits. */
    private NativeDelivery delivery;

    /** JS synced new credentials (login, token renewal): reconnect. */
    static void deliveryCredentialsChanged() {
        KeepAliveService s = live;
        if (s != null) {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (live == s && s.delivery != null) s.delivery.credentialsChanged();
            });
        }
    }

    /** For the wake receiver: the running instance, or null. */
    static KeepAliveService liveInstance() {
        return live;
    }

    /** The wake doorbell rang: get the delivery socket connected NOW.
     *  Returns false when this service has no delivery engine (started for
     *  geofence/control only) — the caller then falls through to a service
     *  restart, because "a KeepAliveService exists" is not "delivery runs":
     *  treating it as such swallowed wakes exactly when they were needed. */
    boolean pokeDelivery() {
        if (delivery == null) return false;
        new Handler(Looper.getMainLooper()).post(() -> {
            if (live == this && delivery != null) delivery.reconnectNow();
        });
        return true;
    }

    /** The delivery socket's auth died (401) with the app backgrounded — the
     *  "Connected" claim is now false. Say so, from wherever noticed it. */
    static void postDeliveryPausedNotice(android.content.Context ctx) {
        KeepAliveService s = live;
        if (s != null) {
            new Handler(Looper.getMainLooper()).post(() -> {
                if (live == s) s.postPausedNoticeIfOwed();
            });
        }
    }

    // --- geofence engine plumbing (all touched on the main thread only) ---
    private final GeofenceEngine engine = new GeofenceEngine();
    private LocationListener fixListener;
    private long currentIntervalMs;

    /** Live instance so SovereignLocationPlugin.setFences can poke a running
     *  service without an intent round-trip (whose extra-less intent the
     *  stop branch in onStartCommand would misread as "no reasons left"). */
    private static volatile KeepAliveService live;

    static void fencesChanged() {
        KeepAliveService s = live;
        if (s != null) {
            // Re-check liveness INSIDE the posted runnable: this is called
            // off the main thread, so a stopService already queued on the
            // main looper can destroy s before the post runs — and a
            // reloadFences on the dead instance would register a location
            // listener nothing can ever remove.
            new Handler(Looper.getMainLooper()).post(() -> {
                if (live == s) s.reloadFences();
            });
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started, never bound
    }

    @Override
    public void onCreate() {
        super.onCreate();
        live = this;
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A wake is an EVENT — it says delivery must run and nothing else. A
        // start carrying reason extras is a DECLARATION from JS and replaces
        // all three. Reading the doorbell as a declaration is what silently
        // released a live session's wake lock (and stopped a geofence-only
        // watch) every time a message arrived at a backgrounded phone.
        if (intent != null && ACTION_WAKE.equals(intent.getAction())) {
            reasons = reasons.withWake();
        } else {
            reasons = KeepAliveReasons.declared(
                    intent != null && intent.getBooleanExtra(EXTRA_CONTROL, false),
                    intent != null && intent.getBooleanExtra(EXTRA_NOTIFY, false),
                    intent != null && intent.getBooleanExtra(EXTRA_GEOFENCE, false));
        }

        if (!reasons.any()) {
            // The last reason went away while we happened to be starting.
            // (Unreachable from a wake, which always wants delivery, and from
            // the plugin, which uses stopService for the all-false case — but
            // this branch must still leave the foreground promise settled.)
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
            inForeground = false;
            stopSelf();
            return START_NOT_STICKY;
        }

        Notification n = buildNotification(reasons.title(), reasons.text());
        boolean promoted = enterForeground(n, reasons.fgsType(
                hasLocationPermission(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION));
        if (!promoted && !inForeground) {
            // A FRESH start the OS refused to promote. Stop immediately and
            // deliberately: stopping cancels the system's "must call
            // startForeground" timer, and letting that timer expire throws
            // ForegroundServiceDidNotStartInTimeException, which is delivered
            // asynchronously and CANNOT be caught anywhere. Retrying here is
            // equally wrong (the ~70-calls-per-second incident); recovery is
            // free — JS re-pushes on foreground return, and the next doorbell
            // is at most 30s away.
            //
            // No "notifications are paused" notice: recovery is seconds away
            // and unattended, so telling the user delivery has stopped would
            // usually be false by the time they read it. That notice is for
            // states nothing will fix on its own (a swipe-away with no
            // credentials), not for a missed exemption window.
            stopSelf();
            return START_NOT_STICKY;
        }
        // Refused while ALREADY in the foreground: carry on with the
        // notification we have. The session this service exists to protect is
        // still live, and stopping would be exactly what the caller was trying
        // to prevent. The specialUse degrade inside enterForeground has
        // already settled the start request in every case it can.

        reloadFences();

        // Starting again means delivery is live — retract any "paused" notice
        // left by onTaskRemoved, or it becomes the inverted lie: "paused"
        // sitting in the shade over a connection that is actually working.
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(NOTIFICATION_ID + 1);

        setWakeLock(reasons.wantsWakeLock());

        // Native delivery follows the NOTIFY reason exactly.
        if (reasons.notify) {
            if (delivery == null) delivery = new NativeDelivery(this);
            delivery.start();
        } else if (delivery != null) {
            delivery.stop();
            delivery = null;
        }

        // START_NOT_STICKY: if the process dies, the WebView and every session
        // in it died too — a resurrected empty service would only show a
        // notification for work that is no longer happening.
        return START_NOT_STICKY;
    }

    /**
     * Enter (or refresh) the foreground. Returns whether we are now there.
     *
     * Every {@code startForeground} in this class goes through here, because
     * an uncaught throw out of {@code onStartCommand} is not a failed start —
     * it is PROCESS DEATH, taking the WebView, the JS WebSocket and every live
     * device session with it. The exception that does this is
     * {@code ForegroundServiceStartNotAllowedException}, thrown when a
     * background start has no exemption, and it extends IllegalStateException
     * — NOT SecurityException, which is why the narrow catch this replaces
     * never saw it.
     */
    private boolean enterForeground(Notification n, int type) {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, n, type);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
            inForeground = true;
            return true;
        } catch (Exception e) {
            // DELIBERATELY BROAD. Two different refusals arrive here and they
            // are NOT the same exception class:
            //  - a while-in-use precondition for the LOCATION type failing is
            //    a SecurityException on some releases and a
            //    ForegroundServiceStartNotAllowedException (an
            //    IllegalStateException) on others;
            //  - a background start with no exemption is always the latter.
            // Catching only SecurityException, as this did before, meant the
            // second class propagated out of onStartCommand — which is not a
            // failed start but PROCESS DEATH, taking the WebView, the JS
            // socket and every live device session with it.
            android.util.Log.i("KeepAlive", "foreground start refused: " + e);
        }
        // Degrade to specialUse and try once more, whatever the first failure
        // was. specialUse needs no runtime permission, so this recovers the
        // 14+ location case; and when the service is ALREADY foreground it
        // settles the start request, which matters more than the type: every
        // caller uses startForegroundService, which arms the framework's
        // "must call startForeground" timer, and letting that expire throws
        // ForegroundServiceDidNotStartInTimeException — delivered
        // asynchronously and catchable NOWHERE.
        if (Build.VERSION.SDK_INT >= 34 && type != ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) {
            try {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                inForeground = true;
                // Only backgrounded location gating is lost; the service lives.
                android.util.Log.i("KeepAlive", "degraded to specialUse");
                return true;
            } catch (Exception e) {
                android.util.Log.i("KeepAlive", "specialUse degrade also refused: " + e);
            }
        }
        return false;
    }

    private void setWakeLock(boolean wanted) {
        if (wanted && wakeLock != null && !wakeLock.isHeld()) {
            // The 6h bound below expired but the field is still set, so the
            // `wakeLock == null` branch would skip and this would silently do
            // nothing — a marathon session losing its wake lock permanently.
            // (Reachable only since the wake stopped clobbering `control`:
            // before, a doorbell's control=false nulled the field and the next
            // declaration re-acquired by accident.)
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        } else if (wanted && wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Sovereign:control");
                wakeLock.setReferenceCounted(false);
                // Bounded so a bug can never hold the CPU indefinitely. A
                // marathon session survives expiry — the process stays alive,
                // only screen-off CPU sleep becomes possible again.
                wakeLock.acquire(6 * 60 * 60 * 1000L);
            }
        } else if (!wanted && wakeLock != null) {
            if (wakeLock.isHeld()) {
                wakeLock.release();
            }
            wakeLock = null;
        }
    }

    /**
     * The user swiped the app out of Recents. On stock Android this service
     * SURVIVES that (stopWithTask defaults to false), and since delivery moved
     * into the NATIVE socket (NativeDelivery), the swipe no longer kills it:
     * only the WebView died, and the WebView is no longer what delivers.
     *
     * So the reasons now sort into three fates:
     *  - CONTROL dies with the task — the remote-control session lives in the
     *    WebView's WebRTC, which is gone. Drop the wake lock.
     *  - NOTIFY survives, IF the JS side ever synced delivery credentials.
     *    The "Connected" foreground text stays TRUE — that is the whole point
     *    of the native socket. Without credentials (old JS bundle, signed
     *    out), fall back to the honest "paused" notice and stop.
     *  - GEOFENCE survives, as before — it was always fully native.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Credentials must EXIST and not be provably expired: the JWT's exp is
        // readable without a network call, and "Connected" over a token the
        // server will refuse is the lie the paused notice exists to retire. A
        // token expiring LATER, while backgrounded, is caught by the socket's
        // own 401 handling (NativeDelivery.authDead), which clears these
        // credentials and posts the paused notice itself.
        boolean deliveryLives = reasons.notify
                && PushPrefs.wsUrl(this) != null
                && PushPrefs.authToken(this) != null
                && !jwtExpired(PushPrefs.authToken(this));
        if (deliveryLives) {
            // The task dying means CONTROL is over — the remote-control
            // session lived in the WebView's WebRTC, which is gone — while
            // delivery and geofencing carry on. That is a genuine change of
            // desired state, so it is recorded as one rather than left for
            // the next start to discover.
            reasons = KeepAliveReasons.declared(false, true, reasons.geofence);
            // The app is no longer visible — make sure the visibility gate
            // reflects that, or a stale "visible" flag from a killed Activity
            // would suppress every notification the survivor exists to
            // deliver.
            PushPrefs.setAppVisible(this, false);
            setWakeLock(false); // control cannot outlive its WebView
            Notification n = buildNotification(reasons.title(), reasons.text());
            enterForeground(n, reasons.fgsType(
                    hasLocationPermission(),
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION));
            super.onTaskRemoved(rootIntent);
            return;
        }
        // GEOFENCE is the other reason that does NOT die with the task: the
        // fence store, the location watch and the arrival notification are
        // all native — the WebView was never in that loop. So a swipe-away
        // demotes the service to geofence-only instead of killing the very
        // "app not in use" case location reminders exist for. The next app
        // open pushes complete reasons again and restores whatever else is
        // wanted.
        if (reasons.wantsLocationWatch(engine.hasFences(), hasLocationPermission())) {
            postPausedNoticeIfOwed();
            // Demoted to geofence-only: control died with the WebView and
            // delivery has no usable credentials. Record it, so the paused
            // notice is not owed a second time and the notification text
            // matches what is actually running.
            reasons = KeepAliveReasons.declared(false, false, true);
            Notification n = buildNotification(reasons.title(), reasons.text());
            enterForeground(n, reasons.fgsType(
                    true, // gated by wantsLocationWatch above
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION));
            setWakeLock(false); // a control session cannot outlive its WebView
            super.onTaskRemoved(rootIntent);
            return;
        }
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        inForeground = false;
        postPausedNoticeIfOwed();
        setWakeLock(false);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    /** The "Notifications are paused" notice from the original onTaskRemoved,
     *  owed whenever message delivery was among the reasons — whether or not
     *  the service itself survives for geofencing. */
    /** Is this JWT past its `exp`? Payload-decode only — no verification
     *  needed to read a public claim, and no network. Unparseable = treat as
     *  live (the server is the authority; this is a courtesy check). */
    private static boolean jwtExpired(String jwt) {
        try {
            String[] parts = jwt.split("\\.");
            if (parts.length < 2) return false;
            byte[] raw = android.util.Base64.decode(parts[1],
                    android.util.Base64.URL_SAFE | android.util.Base64.NO_PADDING | android.util.Base64.NO_WRAP);
            org.json.JSONObject claims = new org.json.JSONObject(new String(raw, java.nio.charset.StandardCharsets.UTF_8));
            long exp = claims.optLong("exp", 0);
            return exp > 0 && exp * 1000L < System.currentTimeMillis();
        } catch (Exception e) {
            return false;
        }
    }

    private void postPausedNoticeIfOwed() {
        if (reasons.notify) {
            NotificationManager nm =
                    (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                Intent open = new Intent(this, MainActivity.class);
                open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                PendingIntent pi = PendingIntent.getActivity(
                        this, 1, open,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                // The quiet background channel, deliberately: this is status,
                // not a message — it must not buzz, but it must be visible the
                // next time the shade is opened.
                nm.notify(NOTIFICATION_ID + 1, new NotificationCompat.Builder(this, CHANNEL_ID)
                        .setContentTitle("Notifications are paused")
                        .setContentText("Puca was closed. Open it again to reconnect.")
                        .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                        .setContentIntent(pi)
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_LOW)
                        .setCategory(NotificationCompat.CATEGORY_STATUS)
                        .build());
            }
        }
    }

    @Override
    public void onDestroy() {
        live = null;
        inForeground = false;
        if (delivery != null) {
            delivery.stop();
            delivery = null;
        }
        stopLocationWatch();
        setWakeLock(false);
        super.onDestroy();
    }

    // --- location-reminder engine (main thread only) -----------------------

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
    }

    /** Provider preference: the platform fused provider (AOSP has one from
     *  API 31 — no Play Services involved), else network (cheap), else GPS.
     *  Shared with SovereignLocationPlugin's one-shot fix. */
    static String pickProvider(LocationManager lm) {
        if (Build.VERSION.SDK_INT >= 31 && lm.hasProvider(LocationManager.FUSED_PROVIDER)) {
            return LocationManager.FUSED_PROVIDER;
        }
        if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
            return LocationManager.NETWORK_PROVIDER;
        }
        if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            return LocationManager.GPS_PROVIDER;
        }
        return null;
    }

    private void reloadFences() {
        engine.setFences(GeofenceStore.load(this));
        updateLocationWatch();
    }

    private void updateLocationWatch() {
        boolean want = reasons.wantsLocationWatch(engine.hasFences(), hasLocationPermission());
        if (want && fixListener == null) {
            startLocationWatch(GeofenceEngine.MIN_INTERVAL_MS);
        } else if (!want && fixListener != null) {
            stopLocationWatch();
        }
    }

    private void startLocationWatch(long intervalMs) {
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return;
        String provider = pickProvider(lm);
        if (provider == null) return; // location off — nothing arrives, nothing fires
        LocationListener l = new LocationListener() {
            @Override
            public void onLocationChanged(Location loc) {
                onFix(loc);
            }
            @Override public void onStatusChanged(String p, int s, android.os.Bundle e) {}
            @Override public void onProviderEnabled(String p) {}
            @Override public void onProviderDisabled(String p) {}
        };
        try {
            lm.requestLocationUpdates(provider, intervalMs, MIN_DISTANCE_M, l, Looper.getMainLooper());
            fixListener = l;
            currentIntervalMs = intervalMs;
        } catch (SecurityException ignored) {
            // Permission revoked between the check and the call: watch stays
            // off; the next reasons push re-evaluates.
        }
    }

    private void stopLocationWatch() {
        if (fixListener == null) return;
        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm != null) {
            try {
                lm.removeUpdates(fixListener);
            } catch (SecurityException ignored) { /* already revoked */ }
        }
        fixListener = null;
        currentIntervalMs = 0;
    }

    private void onFix(Location loc) {
        GeofenceEngine.Result r = engine.onFix(
                loc.getLatitude(), loc.getLongitude(),
                loc.hasAccuracy() ? loc.getAccuracy() : 9999f);
        if (!r.fired.isEmpty()) {
            postArrivalNotification(r.fired.size());
        }
        // Re-register only on a real cadence change — churning the request on
        // every fix costs more than the interval it saves.
        if (fixListener != null
                && (r.nextIntervalMs < currentIntervalMs / 2 || r.nextIntervalMs > currentIntervalMs * 2)) {
            stopLocationWatch();
            startLocationWatch(r.nextIntervalMs);
        }
    }

    /**
     * Arrival notification. CONTENT-FREE like every notification in this app
     * (desktopNotify.ts's rule): a count, never the task text or the place
     * name — this one would otherwise leak WHERE the user just arrived onto
     * a lock screen. Tap lands on the Tasks view via the same nav-extra
     * plumbing as message notifications.
     */
    private void postArrivalNotification(int count) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // The messages channel normally exists (the plugin creates it at
        // load), but this service must not depend on the bridge having run.
        if (Build.VERSION.SDK_INT >= 26
                && nm.getNotificationChannel(SovereignAppPlugin.MSG_CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(
                    SovereignAppPlugin.MSG_CHANNEL_ID, "Messages", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("New messages and friend requests.");
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra(SovereignAppPlugin.EXTRA_NAV, "tasks");
        int id = "geofence-tasks".hashCode();
        PendingIntent pi = PendingIntent.getActivity(
                this, id, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String body = count == 1 ? "A task is waiting here" : count + " tasks are waiting here";
        nm.notify(SovereignAppPlugin.MSG_TAG, id,
                new NotificationCompat.Builder(this, SovereignAppPlugin.MSG_CHANNEL_ID)
                        .setContentTitle("Puca Tasks")
                        .setContentText(body)
                        .setSmallIcon(android.R.drawable.stat_notify_chat)
                        .setContentIntent(pi)
                        .setAutoCancel(true)
                        .setPriority(NotificationCompat.PRIORITY_HIGH)
                        .setCategory(NotificationCompat.CATEGORY_REMINDER)
                        .setDefaults(NotificationCompat.DEFAULT_ALL)
                        .build());
    }

    private Notification buildNotification(String title, String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Background connection", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shown while Puca stays connected in the background.");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }
}
