package com.sovereign.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.Display;
import android.view.WindowManager;

import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * Shares this phone's screen into a call: holds the MediaProjection, draws it
 * into a VirtualDisplay, and turns frames into JPEGs for the page
 * ({@link ScreenShareFrames} says why the page, and not a native sender).
 *
 * <h3>Android's rules, all of which this follows</h3>
 * <ul>
 *   <li>A MediaProjection may only be obtained from INSIDE a running
 *       foreground service of type {@code mediaProjection} (Android 10+,
 *       enforced from 14), so the consent result is handed to this service and
 *       {@code startForeground} runs before {@code getMediaProjection}.</li>
 *   <li>From Android 14 one consent is good for ONE VirtualDisplay, and the
 *       callback must be registered before it is created. A resize (the phone
 *       turned, or the shared app's window changed) therefore resizes the
 *       display it has, never makes a second one, and hands it the new
 *       surface BEFORE the new size ({@link ScreenShareFrames#swapReader}).</li>
 *   <li>The system can end the projection itself (the status-bar chip's Stop,
 *       another app starting one, the screen locking on some versions):
 *       {@code onStop} ends the share exactly as Stop Sharing does.</li>
 * </ul>
 *
 * One share at a time, process-wide: {@link #current} is the share the plugin
 * talks to. Started only by {@link SovereignScreenSharePlugin} with a fresh
 * consent; not exported.
 */
public class ScreenShareService extends Service {

    private static final String TAG = "PucaScreenShare";
    static final String CHANNEL_ID = "puca_screen_share";
    static final int NOTIFICATION_ID = 4713;

    static final String ACTION_START = "com.sovereign.app.SCREEN_SHARE_START";
    static final String ACTION_STOP = "com.sovereign.app.SCREEN_SHARE_STOP";
    static final String EXTRA_RESULT_CODE = "resultCode";
    static final String EXTRA_RESULT_DATA = "resultData";
    static final String EXTRA_WIDTH = "width";
    static final String EXTRA_HEIGHT = "height";
    static final String EXTRA_FPS = "fps";
    /** Which start this is (ScreenShareSlot): every event carries it back. */
    static final String EXTRA_SHARE_ID = "shareId";

    private static final int JPEG_QUALITY = 70;

    /** What the share tells the plugin, each event with the share's id.
     *  Called on the capture thread except {@link #onEnded} and
     *  {@link #onFailed}, which may come from any thread. */
    interface Listener {
        void onStarted(long shareId, int width, int height, int fps);
        void onFailed(long shareId, String message);
        /** One frame as a JPEG. The listener owns the bytes. */
        void onFrame(long shareId, byte[] jpeg);
        void onEnded(long shareId, String reason);
    }

    /** The answer to {@link #resize}: {width, height, fps}, or null. */
    interface ResizeResult {
        void done(int[] now);
    }

    private static volatile Listener listener;
    private static volatile ScreenShareService current;
    /** The gate the plugin releases when the page acknowledges a frame. */
    static volatile ScreenShareFrames.Gate gate;

    static void setListener(Listener l) {
        listener = l;
    }

    static boolean isSharing() {
        ScreenShareService s = current;
        return s != null && s.projection != null;
    }

    /**
     * What the running share captures: {contentW, contentH, visible (0/1),
     * changedAt (elapsedRealtime of the last change of shape or visibility)},
     * or null when nothing is shared. Content is the screen as turned now, or
     * (Android 14+, one app shared) that app's window, which may be hidden
     * behind another app. Read by the full build's control of this phone,
     * which must not aim a viewer's point at anything but the whole screen.
     */
    static long[] contentState() {
        ScreenShareService s = current;
        if (s == null || s.projection == null || s.ended || s.display == null) return null;
        return new long[] { s.contentW, s.contentH, s.contentVisible ? 1 : 0, s.contentChangedAt };
    }

    /** An extra line on the share's notification and one action beside Stop
     *  sharing, or none (all null). Safe from any thread. */
    private static volatile String noticeLine;
    private static volatile String noticeActionLabel;
    private static volatile PendingIntent noticeAction;

    static void setNotice(String line, String actionLabel, PendingIntent action) {
        noticeLine = line;
        noticeActionLabel = line == null ? null : actionLabel;
        noticeAction = line == null ? null : action;
        ScreenShareService s = current;
        if (s == null || s.ended) return;
        NotificationManager nm = (NotificationManager) s.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) {
            try {
                nm.notify(NOTIFICATION_ID, s.buildNotification());
            } catch (RuntimeException e) {
                Log.w(TAG, "notification update refused", e);
            }
        }
    }

    /** Told every time a share ends (teardown), from the thread that ended
     *  it. The full build's control of this phone ends with the share. */
    private static volatile Runnable endWatcher;

    static void setEndWatcher(Runnable r) {
        endWatcher = r;
    }

    /** The running share's id, or 0. */
    static long sharingId() {
        ScreenShareService s = current;
        return s != null && s.projection != null ? s.shareId : 0;
    }

    /**
     * The page acknowledged a frame. When a frame was being held back for it,
     * look again now rather than at the next timer. Safe from any thread.
     */
    static void frameAcknowledged() {
        ScreenShareFrames.Gate g = gate;
        ScreenShareService s = current;
        if (g != null && g.release() && s != null) s.handler().post(s.pump);
    }

    /** Ends the running share, if any. Safe from any thread. */
    static void stopSharing(Context ctx, String reason) {
        ScreenShareService s = current;
        if (s != null) {
            s.handler().post(() -> s.end(reason));
        } else {
            try {
                ctx.stopService(new Intent(ctx, ScreenShareService.class));
            } catch (Exception ignored) {
                // not running
            }
        }
    }

    /**
     * Re-size the running share in place (the live Stream quality panel, and
     * the step-down when the phone cannot keep up): the same projection and
     * display, a new size and frame rate. Answers {width, height, fps} as now
     * captured, on the capture thread, or null when nothing is shared. Never
     * blocks the caller: Capacitor runs every plugin's methods on one shared
     * thread.
     */
    static void resize(int w, int h, int fps, ResizeResult result) {
        ScreenShareService s = current;
        if (s == null || s.projection == null) {
            result.done(null);
            return;
        }
        s.handler().post(() -> {
            if (s.ended) {
                result.done(null);
                return;
            }
            s.wantW = w;
            s.wantH = h;
            s.fps = ScreenShareFrames.clampFps(fps);
            gate = new ScreenShareFrames.Gate(s.fps);
            s.resizeTo(s.contentW, s.contentH);
            result.done(new int[] { s.width, s.height, s.fps });
        });
    }

    // Read by isSharing() from other threads; written on the main and
    // capture threads.
    private volatile MediaProjection projection;
    private volatile long shareId;
    private VirtualDisplay display;
    private ImageReader reader;
    private HandlerThread thread;
    private Handler captureHandler;
    private DisplayManager.DisplayListener displayListener;
    private int wantW;
    private int wantH;
    private int fps;
    /** What is being captured, before fitting: the screen, or (Android 14+,
     *  one app shared) that app's window. */
    private int contentW;
    private int contentH;
    /** Whether the captured content is on screen (Android 14+ tells, for one
     *  app shared; the whole screen always is), and when the content last
     *  changed shape or visibility. Read from other threads. */
    private volatile boolean contentVisible = true;
    private volatile long contentChangedAt;
    private int width;
    private int height;
    private int dpi;
    private Bitmap padded;
    /** The frame without the row padding, when the reader pads rows. Kept
     *  between frames, like padded: a new one per frame was garbage at 30 fps. */
    private Bitmap cropped;
    private Canvas croppedCanvas;
    private final ByteArrayOutputStream jpegOut = new ByteArrayOutputStream(256 * 1024);
    private volatile boolean ended;
    /** Look at the reader again (a frame the gate held back). Capture thread. */
    private final Runnable pump = this::pump;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Handler handler() {
        if (captureHandler == null) {
            thread = new HandlerThread("PucaScreenShare");
            thread.start();
            captureHandler = new Handler(thread.getLooper());
        }
        return captureHandler;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            // The notification's Stop: the same end as the app's own button.
            if (current == this && projection != null) {
                handler().post(() -> end("Stopped from the notification"));
            } else {
                stopSelf();
            }
            return START_NOT_STICKY;
        }

        // FIRST, before anything can fail: a service started with
        // startForegroundService must call startForeground within seconds, and
        // getMediaProjection refuses to run outside a mediaProjection-typed one.
        createChannel();
        Notification n = buildNotification();
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Exception e) {
            fail("Android refused the screen-share service: " + e.getMessage());
            return START_NOT_STICKY;
        }

        if (intent == null || !ACTION_START.equals(action)) {
            // Restarted with nothing to do (START_NOT_STICKY makes this rare).
            fail("No screen-share consent to start from");
            return START_NOT_STICKY;
        }
        if (current != null && current != this) {
            current.end("Another share started");
        }
        current = this;
        ended = false;
        shareId = intent.getLongExtra(EXTRA_SHARE_ID, 0);

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent data = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(EXTRA_RESULT_DATA, Intent.class)
                : intent.getParcelableExtra(EXTRA_RESULT_DATA);
        wantW = intent.getIntExtra(EXTRA_WIDTH, 1280);
        wantH = intent.getIntExtra(EXTRA_HEIGHT, 720);
        fps = ScreenShareFrames.clampFps(intent.getIntExtra(EXTRA_FPS, 30));
        gate = new ScreenShareFrames.Gate(fps);

        MediaProjectionManager mpm = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (mpm == null || data == null) {
            fail("Screen capture is not available on this phone");
            return START_NOT_STICKY;
        }
        try {
            projection = mpm.getMediaProjection(resultCode, data);
        } catch (Exception e) {
            projection = null;
            Log.w(TAG, "getMediaProjection failed", e);
        }
        if (projection == null) {
            fail("Android did not allow the screen capture");
            return START_NOT_STICKY;
        }
        handler().post(this::beginCapture);
        return START_NOT_STICKY;
    }

    /** Capture thread. */
    private void beginCapture() {
        try {
            // Registered BEFORE the display (Android 14 throws otherwise).
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    end("Android ended the screen capture");
                }

                @Override
                public void onCapturedContentResize(int w, int h) {
                    // Android 14+: the shared app's window (or the turned
                    // screen) changed size. Fit the new shape.
                    resizeTo(w, h);
                }

                @Override
                public void onCapturedContentVisibilityChanged(boolean isVisible) {
                    // Android 14+: one app shared and it went behind another
                    // (or came back). The whole screen is always visible.
                    if (contentVisible != isVisible) {
                        contentVisible = isVisible;
                        contentChangedAt = SystemClock.elapsedRealtime();
                    }
                }
            }, handler());

            int[] screen = screenSize();
            contentW = screen[0];
            contentH = screen[1];
            contentVisible = true;
            contentChangedAt = SystemClock.elapsedRealtime();
            int[] size = ScreenShareFrames.fit(contentW, contentH, wantW, wantH);
            width = size[0];
            height = size[1];
            reader = newReader(width, height);
            display = projection.createVirtualDisplay("PucaScreenShare", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler());
            watchRotation();
            Listener l = listener;
            if (l != null) l.onStarted(shareId, width, height, fps);
        } catch (Exception e) {
            Log.w(TAG, "starting the capture failed", e);
            fail("The screen capture could not start: " + e.getMessage());
        }
    }

    private ImageReader newReader(int w, int h) {
        ImageReader r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        r.setOnImageAvailableListener(ignored -> pump(), handler());
        return r;
    }

    /** The running display and its readers, for {@link ScreenShareFrames#swapReader}. Capture thread. */
    private final ScreenShareFrames.Resizable<ImageReader> resizable = new ScreenShareFrames.Resizable<ImageReader>() {
        @Override public ImageReader newReader(int w, int h) { return ScreenShareService.this.newReader(w, h); }
        @Override public void setSurface(ImageReader r) { display.setSurface(r.getSurface()); }
        @Override public void resizeDisplay(int w, int h) { display.resize(w, h, dpi); }
        @Override public void close(ImageReader r) { r.close(); }
    };

    /** The real screen size in pixels, as it is turned right now. */
    private int[] screenSize() {
        DisplayMetrics m = new DisplayMetrics();
        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (Build.VERSION.SDK_INT >= 30 && wm != null) {
            android.graphics.Rect b = wm.getMaximumWindowMetrics().getBounds();
            dpi = getResources().getDisplayMetrics().densityDpi;
            return new int[] { b.width(), b.height() };
        }
        DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        Display d = dm == null ? null : dm.getDisplay(Display.DEFAULT_DISPLAY);
        if (d != null) d.getRealMetrics(m);
        else m = getResources().getDisplayMetrics();
        dpi = m.densityDpi;
        return new int[] { m.widthPixels, m.heightPixels };
    }

    /** Below Android 14 nothing tells a projection the screen turned: watch
     *  the display, and fit the new shape. */
    private void watchRotation() {
        // 14+: onCapturedContentResize reports the turn, and for a single
        // shared app the APP's size, which the screen's size here would undo.
        if (Build.VERSION.SDK_INT >= 34) return;
        DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
        if (dm == null) return;
        displayListener = new DisplayManager.DisplayListener() {
            @Override public void onDisplayAdded(int id) {}
            @Override public void onDisplayRemoved(int id) {}
            @Override public void onDisplayChanged(int id) {
                if (id != Display.DEFAULT_DISPLAY) return;
                int[] s = screenSize();
                resizeTo(s[0], s[1]);
            }
        };
        dm.registerDisplayListener(displayListener, handler());
    }

    /** Capture thread. */
    private void resizeTo(int contentW, int contentH) {
        if (ended || display == null || contentW <= 0 || contentH <= 0) return;
        if (contentW != this.contentW || contentH != this.contentH) {
            contentChangedAt = SystemClock.elapsedRealtime();
        }
        this.contentW = contentW;
        this.contentH = contentH;
        int[] size = ScreenShareFrames.fit(contentW, contentH, wantW, wantH);
        if (size[0] == width && size[1] == height) return;
        width = size[0];
        height = size[1];
        // The new surface before the new size (ScreenShareFrames.swapReader
        // says why: the other way round, a turned phone could be drawn for its
        // old shape for the rest of the share).
        reader = ScreenShareFrames.swapReader(resizable, reader, width, height);
        Log.i(TAG, "capture re-sized to " + width + "x" + height + " for content " + contentW + "x" + contentH);
        padded = null;
        cropped = null;
        croppedCanvas = null;
    }

    /**
     * Capture thread: a frame is waiting in the reader (or may be). When the
     * gate says not yet, the frame STAYS in the reader and this runs again
     * when it may go: on the page's next ack (frameAcknowledged), or at the
     * gate's next slot. Taking it out and dropping it lost the last picture of
     * every quick movement: the display sends nothing new while the screen is
     * still, so viewers sat on half a swipe until something moved.
     */
    private void pump() {
        ImageReader r = reader;
        ScreenShareFrames.Gate g = gate;
        if (ended || r == null || g == null) return;
        long now = SystemClock.elapsedRealtime();
        long wait = g.waitMs(now);
        if (wait > 0) {
            g.holdFrame();
            Handler h = handler();
            h.removeCallbacks(pump);
            h.postDelayed(pump, wait);
            return;
        }
        Image image = null;
        try {
            image = r.acquireLatestImage();
            if (image == null) return;
            if (!g.tryAcquire(now)) return;
            byte[] jpeg;
            try {
                jpeg = encode(image);
            } catch (RuntimeException e) {
                g.release();
                throw e;
            }
            Listener l = listener;
            if (l != null) l.onFrame(shareId, jpeg);
            else g.release();
        } catch (Exception e) {
            Log.w(TAG, "frame dropped", e);
        } finally {
            if (image != null) image.close();
        }
    }

    private byte[] encode(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buf = plane.getBuffer();
        int w = image.getWidth();
        int h = image.getHeight();
        int pixelStride = plane.getPixelStride();
        int rowWidth = plane.getRowStride() / pixelStride;
        if (padded == null || padded.getWidth() != rowWidth || padded.getHeight() != h) {
            padded = Bitmap.createBitmap(rowWidth, h, Bitmap.Config.ARGB_8888);
        }
        buf.rewind();
        padded.copyPixelsFromBuffer(buf);
        Bitmap frame = padded;
        if (rowWidth != w) {
            if (cropped == null || cropped.getWidth() != w || cropped.getHeight() != h) {
                cropped = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                croppedCanvas = new Canvas(cropped);
            }
            // The padded columns fall outside the w-wide bitmap.
            croppedCanvas.drawBitmap(padded, 0, 0, null);
            frame = cropped;
        }
        jpegOut.reset();
        frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpegOut);
        return jpegOut.toByteArray();
    }

    private void fail(String message) {
        Listener l = listener;
        if (l != null) l.onFailed(shareId, message);
        teardown();
    }

    /** Capture thread (or any thread once: it is idempotent). */
    private synchronized void end(String reason) {
        if (ended) return;
        ended = true;
        Listener l = listener;
        long id = shareId;
        teardown();
        if (l != null) l.onEnded(id, reason);
    }

    private void teardown() {
        ended = true;
        noticeLine = null;
        noticeActionLabel = null;
        noticeAction = null;
        Runnable w = endWatcher;
        if (w != null) {
            try {
                w.run();
            } catch (RuntimeException e) {
                Log.w(TAG, "share-end watcher failed", e);
            }
        }
        if (displayListener != null) {
            DisplayManager dm = (DisplayManager) getSystemService(Context.DISPLAY_SERVICE);
            if (dm != null) dm.unregisterDisplayListener(displayListener);
            displayListener = null;
        }
        if (display != null) {
            display.release();
            display = null;
        }
        if (reader != null) {
            reader.close();
            reader = null;
        }
        if (projection != null) {
            MediaProjection p = projection;
            projection = null;
            try { p.stop(); } catch (Exception ignored) { /* already stopped */ }
        }
        if (captureHandler != null) captureHandler.removeCallbacks(pump);
        if (current == this) current = null;
        gate = null;
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** Swiped out of Recents: when it is the app's own task, the page that
     *  sent the share is gone with it, so the share is over. The floating
     *  stream window's task (PipActivity) is not that page. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        String removed = rootIntent == null || rootIntent.getComponent() == null
                ? null : rootIntent.getComponent().getClassName();
        if (ScreenShareFrames.taskRemovalEndsShare(removed, MainActivity.class.getName())) {
            end("The app was closed");
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        end("The share service stopped");
        if (thread != null) {
            thread.quitSafely();
            thread = null;
            captureHandler = null;
        }
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, ScreenShareService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String line = noticeLine;
        String text = line != null ? line : "Everyone in the call sees this phone's screen.";
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Sharing your screen")
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setSmallIcon(android.R.drawable.ic_menu_slideshow)
                .setContentIntent(openPi);
        PendingIntent extra = noticeAction;
        String extraLabel = noticeActionLabel;
        if (line != null && extra != null && extraLabel != null) b.addAction(0, extraLabel, extra);
        return b
                .addAction(0, "Stop sharing", stopPi)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .build();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // DEFAULT, not LOW: a LOW notification lands in the shade's "Silent"
        // section, collapsed under the call's own, with its Stop sharing
        // hidden. What is being shown to other people deserves the visible
        // control. It still makes no sound and no vibration.
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription("Shown while this phone's screen is shared into a call.");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }
}
