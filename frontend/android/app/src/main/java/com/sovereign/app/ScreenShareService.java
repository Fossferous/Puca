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
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

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
 *       display it has, never makes a second one.</li>
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

    private static final int JPEG_QUALITY = 70;

    /** What the share tells the plugin. Called on the capture thread except
     *  {@link #onEnded}, which may come from any thread. */
    interface Listener {
        void onStarted(int width, int height, int fps);
        void onFailed(String message);
        /** One frame as a JPEG. The listener owns the bytes. */
        void onFrame(byte[] jpeg);
        void onEnded(String reason);
    }

    private static volatile Listener listener;
    private static volatile ScreenShareService current;
    /** The gate the plugin releases when the page acknowledges a frame. */
    static volatile ScreenShareFrames.Gate gate;

    static void setListener(Listener l) {
        listener = l;
    }

    static boolean isSharing() {
        return current != null && current.projection != null;
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
     * display, a new size and frame rate. Returns {width, height, fps} as now
     * captured, or null when nothing is shared. Blocks up to two seconds; call
     * it off the main thread (plugin methods run on their own).
     */
    static int[] resize(int w, int h, int fps) {
        ScreenShareService s = current;
        if (s == null || s.projection == null) return null;
        int[] out = new int[3];
        CountDownLatch done = new CountDownLatch(1);
        s.handler().post(() -> {
            if (!s.ended) {
                s.wantW = w;
                s.wantH = h;
                s.fps = ScreenShareFrames.clampFps(fps);
                gate = new ScreenShareFrames.Gate(s.fps);
                s.resizeTo(s.contentW, s.contentH);
                out[0] = s.width;
                out[1] = s.height;
                out[2] = s.fps;
            }
            done.countDown();
        });
        try {
            if (!done.await(2, TimeUnit.SECONDS)) return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
        return out[0] == 0 ? null : out;
    }

    private MediaProjection projection;
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
    private int width;
    private int height;
    private int dpi;
    private Bitmap padded;
    private final ByteArrayOutputStream jpegOut = new ByteArrayOutputStream(256 * 1024);
    private boolean ended;

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
            }, handler());

            int[] screen = screenSize();
            contentW = screen[0];
            contentH = screen[1];
            int[] size = ScreenShareFrames.fit(contentW, contentH, wantW, wantH);
            width = size[0];
            height = size[1];
            reader = newReader(width, height);
            display = projection.createVirtualDisplay("PucaScreenShare", width, height, dpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, handler());
            watchRotation();
            Listener l = listener;
            if (l != null) l.onStarted(width, height, fps);
        } catch (Exception e) {
            Log.w(TAG, "starting the capture failed", e);
            fail("The screen capture could not start: " + e.getMessage());
        }
    }

    private ImageReader newReader(int w, int h) {
        ImageReader r = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        r.setOnImageAvailableListener(this::onImage, handler());
        return r;
    }

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
        this.contentW = contentW;
        this.contentH = contentH;
        int[] size = ScreenShareFrames.fit(contentW, contentH, wantW, wantH);
        if (size[0] == width && size[1] == height) return;
        width = size[0];
        height = size[1];
        ImageReader old = reader;
        reader = newReader(width, height);
        display.resize(width, height, dpi);
        display.setSurface(reader.getSurface());
        if (old != null) old.close();
        padded = null;
    }

    /** Capture thread: one frame from the display. */
    private void onImage(ImageReader r) {
        Image image = null;
        try {
            image = r.acquireLatestImage();
            if (image == null || ended || r != reader) return;
            ScreenShareFrames.Gate g = gate;
            if (g == null || !g.tryAcquire(SystemClock.elapsedRealtime())) return;
            byte[] jpeg;
            try {
                jpeg = encode(image);
            } catch (RuntimeException e) {
                g.release();
                throw e;
            }
            Listener l = listener;
            if (l != null) l.onFrame(jpeg);
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
        Bitmap frame = rowWidth == w ? padded : Bitmap.createBitmap(padded, 0, 0, w, h);
        jpegOut.reset();
        frame.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, jpegOut);
        if (frame != padded) frame.recycle();
        return jpegOut.toByteArray();
    }

    private void fail(String message) {
        Listener l = listener;
        if (l != null) l.onFailed(message);
        teardown();
    }

    /** Capture thread (or any thread once: it is idempotent). */
    private synchronized void end(String reason) {
        if (ended) return;
        ended = true;
        Listener l = listener;
        teardown();
        if (l != null) l.onEnded(reason);
    }

    private void teardown() {
        ended = true;
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
        if (current == this) current = null;
        gate = null;
        stopForeground(Service.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** Swiped out of Recents: the page that sent the share is gone with the
     *  task, so the share is over. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        end("The app was closed");
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
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Sharing your screen")
                .setContentText("Everyone in the call sees this phone's screen.")
                .setSmallIcon(android.R.drawable.ic_menu_slideshow)
                .setContentIntent(openPi)
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
