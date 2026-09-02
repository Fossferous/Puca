package com.sovereign.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Keeps a file transfer running while the app is in the background, and shows
 * the progress notification that says so.
 *
 * WHY THIS IS NEEDED AT ALL. Capacitor does NOT pause the WebView when the app
 * goes to the background — `Bridge.onPause` only forwards to the Cordova shim,
 * and `shouldKeepRunning()` is true by default — so JavaScript, and therefore
 * the transfer, keeps running for a while. What eventually stops it is
 * ANDROID: the process drops into the cached bucket and gets frozen. A
 * foreground service is the documented, and effectively the only, way to say
 * "this process is doing something the user asked for" and stay out of it.
 *
 * TWO THINGS THAT ARE EASY TO MISS, both of which make the difference between
 * this working and appearing to work:
 *
 *  - A foreground service keeps the process ALIVE but does not keep the CPU
 *    awake. With the screen off the device suspends and the transfer stalls
 *    anyway, so this holds a PARTIAL_WAKE_LOCK for its lifetime. It is
 *    released in onDestroy, and the service is deliberately short-lived
 *    (started with the first transfer, stopped with the last).
 *  - Android 15 enforces a cumulative six-hour cap on dataSync services and
 *    kills the app if `onTimeout` is not handled. It is handled below: the
 *    notification says what happened rather than the app simply vanishing.
 */
public class TransferService extends Service {

    public static final String CHANNEL_ID = "sovereign_transfers";
    public static final int NOTIFICATION_ID = 4711;

    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_PROGRESS = "progress";   // 0-100, or -1 for indeterminate

    private PowerManager.WakeLock wakeLock;

    @Override
    public IBinder onBind(Intent intent) {
        return null; // started, never bound
    }

    /**
     * Swiped out of Recents: the WebView doing the actual transfer died with
     * the task (the service survives on stock Android — stopWithTask defaults
     * false). Without this, a permanent "Transferring files" notification
     * sits over work that stopped the moment the task went — the same
     * orphaned-service lie KeepAliveService.onTaskRemoved fixes for delivery.
     * Nothing to hand over: just stop honestly.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Puca:transfer");
            wakeLock.setReferenceCounted(false);
            // Bounded so a bug can never hold the CPU indefinitely; the six-hour
            // service cap below is the real ceiling.
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String title = "Transferring files";
        String text = "In progress";
        int progress = -1;
        if (intent != null) {
            if (intent.getStringExtra(EXTRA_TITLE) != null) title = intent.getStringExtra(EXTRA_TITLE);
            if (intent.getStringExtra(EXTRA_TEXT) != null) text = intent.getStringExtra(EXTRA_TEXT);
            progress = intent.getIntExtra(EXTRA_PROGRESS, -1);
        }

        Notification n = buildNotification(title, text, progress);
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, n);
        }
        // START_NOT_STICKY: if the process dies the transfer is gone with it,
        // so resurrecting a service with nothing to do would only show a
        // notification for work that is not happening.
        return START_NOT_STICKY;
    }

    /** Android 15+: the dataSync budget ran out. Say so instead of being killed. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification(
                    "Transfer paused",
                    "Android stopped background transfers. Open Púca to finish.",
                    -1));
        }
        stopForeground(Service.STOP_FOREGROUND_DETACH);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        wakeLock = null;
        super.onDestroy();
    }

    private Notification buildNotification(String title, String text, int progress) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentIntent(pi)
                .setOngoing(true)          // not swipeable while work is live
                .setOnlyAlertOnce(true)    // progress updates must not buzz
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS);

        if (progress >= 0) {
            b.setProgress(100, Math.min(100, progress), false);
        } else {
            b.setProgress(0, 0, true);
        }
        return b.build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "File transfers", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows progress while files are transferring in the background.");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }
}
