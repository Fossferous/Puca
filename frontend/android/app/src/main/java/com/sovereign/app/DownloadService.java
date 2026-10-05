package com.sovereign.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;

/**
 * Keeps a native download ({@link NativeDownloads}) alive with the screen off
 * or the app in the background, and shows its progress.
 *
 * <p>Its own service, not {@link TransferService}: that one belongs to the
 * page's P2P transfers, which start and STOP it from JavaScript — a P2P
 * transfer finishing would take a clip download's foreground status with it.
 * Same channel ("File transfers"), so there is one switch for both in
 * Android's settings; a different notification id, so both can show.
 *
 * <p>Like TransferService it holds a PARTIAL_WAKE_LOCK (a foreground service
 * keeps the process, not the CPU), is a dataSync service, and handles Android
 * 15's {@code onTimeout} by cancelling instead of being killed. Unlike it, it
 * does NOT stop when the task is swiped away: the download is native work
 * that needs no WebView, so it finishes and the notification says so.
 *
 * <p>The progress notification asks to be DEFERRED: Android 12+ then holds
 * it back ~10 s, so a 2-second attachment download shows nothing — even with
 * its Cancel action, since an explicit FOREGROUND_SERVICE_DEFERRED outranks the
 * "action buttons show at once" rule. But Android grants an app ONE deferral
 * per two minutes (deferred_fgs_notification_exclusion_time = 120000 on the
 * emulator): within two minutes of the app's own KeepAliveService starting, or
 * of an earlier download, the system shows it at once and a short download
 * flashes it (measured 2026-10-05: id 4714 at +0.5 s inside that window, never
 * outside it, with and without the Cancel action). Before Android 12 there is
 * no deferral. When a download ends while the app is not on screen, a plain
 * notification says it was saved (tap to open) or that it failed.
 */
public class DownloadService extends Service {

    /**
     * Its own id. 4711 is TransferService's, 4712 KeepAliveService's (and 4713
     * its "paused" notice): sharing 4712 made a download's progress REPLACE
     * the keep-alive's foreground notification, and the download's ending
     * left it stuck on "Downloading <name>" for as long as the keep-alive ran
     * (seen on the emulator, 2026-10-05).
     */
    static final int NOTIFICATION_ID = 4714;
    /** Result notifications: 4800 + (id hash & 0x3ff), clear of every fixed id above. */
    static final int RESULT_ID_BASE = 4800;
    /** Result ids are RESULT_ID_BASE + (hash & RESULT_ID_MASK). */
    static final int RESULT_ID_MASK = 0x3ff;
    static final String ACTION_START = "com.sovereign.app.DOWNLOAD_START";
    static final String ACTION_CANCEL = "com.sovereign.app.DOWNLOAD_CANCEL";
    static final String EXTRA_ID = "id";

    private static volatile boolean running;
    private static volatile String currentName = "file";
    private static volatile String currentId;
    private static volatile int currentPct = -1;
    private static volatile long currentBytes;
    private static long lastNotify;

    private PowerManager.WakeLock wakeLock;

    // ---- the engine's handle -------------------------------------------------

    static void begin(Context app, String name) {
        try {
            Intent i = new Intent(app, DownloadService.class).setAction(ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i);
            else app.startService(i);
        } catch (RuntimeException e) {
            // Android 12+ refuses a foreground start from the background. The
            // download still runs; it is simply not protected from a freeze.
        }
    }

    static void progress(NativeDownloads.Job job, long bytes, long total) {
        currentId = job.id;
        currentName = SaveTarget.sanitize(job.name);
        currentPct = total > 0 ? (int) Math.min(99, (100 * bytes) / total) : -1;
        currentBytes = bytes;
        long now = SystemClock.elapsedRealtime();
        if (!running || now - lastNotify < 1000) return;
        lastNotify = now;
        Context app = instanceContext;
        if (app == null) return;
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, buildProgress(app));
    }

    static void finished(Context app, NativeDownloads.Job job, boolean ok, String where, Uri uri, String mime) {
        try {
            postResult(app, job, ok, where, uri, mime);
        } catch (RuntimeException e) {
            // A notification that could not be posted never fails a saved download.
        }
    }

    private static void postResult(Context app, NativeDownloads.Job job, boolean ok, String where, Uri uri, String mime) {
        if (PushPrefs.appVisible(app)) return; // the page says it; no shade entry needed
        NotificationManager nm = (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        ensureChannel(app);
        String name = SaveTarget.sanitize(job.name);
        NotificationCompat.Builder b = new NotificationCompat.Builder(app, TransferService.CHANNEL_ID)
                .setSmallIcon(ok ? android.R.drawable.stat_sys_download_done : android.R.drawable.stat_notify_error)
                .setContentTitle(ok ? "Saved " + name : "Download failed")
                .setContentText(ok ? "In " + where : name)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_LOW);
        Intent open;
        if (ok && uri != null) {
            open = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        } else {
            open = new Intent(app, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        }
        b.setContentIntent(PendingIntent.getActivity(app, job.id.hashCode(), open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
        nm.notify(RESULT_ID_BASE + (job.id.hashCode() & RESULT_ID_MASK), b.build());
    }

    /**
     * The last download ended. Stopped HERE only once the service is in the
     * foreground: a service started with startForegroundService and stopped
     * before it called startForeground crashes the app ("did not then call
     * startForeground") — which a download failing within milliseconds (a
     * 404) would otherwise do. Before that point, onStartCommand sees that
     * nothing is running and stops itself.
     */
    static void end(Context app) {
        currentId = null;
        currentPct = -1;
        currentBytes = 0;
        if (!running) return;
        try {
            app.stopService(new Intent(app, DownloadService.class));
        } catch (RuntimeException ignored) {
            // already gone
        }
    }

    // ---- the service ------------------------------------------------------------

    private static volatile Context instanceContext;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instanceContext = getApplicationContext();
        ensureChannel(this);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Puca:download");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(6 * 60 * 60 * 1000L); // bounded; the dataSync cap is the real ceiling
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_CANCEL.equals(intent.getAction())) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (id != null) NativeDownloads.cancel(id);
            if (!running) stopSelf();
            return START_NOT_STICKY;
        }
        Notification n = buildProgress(this);
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(NOTIFICATION_ID, n);
        running = true;
        // Everything may already have finished (see end()).
        if (NativeDownloads.activeCount() == 0) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
        // Nothing to resume after a process death: the job died with it (and its
        // pending MediaStore row is swept on the next start).
        return START_NOT_STICKY;
    }

    /** The task was swiped away: the download is native and carries on. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
    }

    /** Android 15+: the dataSync budget ran out. Cancel cleanly rather than be killed. */
    @Override
    public void onTimeout(int startId, int fgsType) {
        NativeDownloads.cancelAll();
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        instanceContext = null;
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    private static Notification buildProgress(Context ctx) {
        ensureChannel(ctx);
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, TransferService.CHANNEL_ID)
                .setContentTitle("Downloading " + currentName)
                .setContentText(currentPct >= 0 ? currentPct + "%"
                        : currentBytes > 0 ? String.format(java.util.Locale.ROOT, "%.1f MB", currentBytes / 1e6) : "Starting")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setContentIntent(pi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED);
        if (currentPct >= 0) b.setProgress(100, currentPct, false);
        else b.setProgress(0, 0, true);
        String id = currentId;
        if (id != null) {
            Intent cancel = new Intent(ctx, DownloadService.class).setAction(ACTION_CANCEL).putExtra(EXTRA_ID, id);
            PendingIntent cp = PendingIntent.getService(ctx, 1, cancel, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            b.addAction(0, "Cancel", cp);
        }
        return b.build();
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(TransferService.CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(TransferService.CHANNEL_ID, "File transfers", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Shows progress while files are transferring in the background.");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        nm.createNotificationChannel(ch);
    }
}
