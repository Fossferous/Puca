package com.sovereign.app;

/**
 * The decisions behind sharing this phone's screen into a call, kept free of
 * Android imports so plain JUnit covers them (the same split as
 * {@link KeepAliveReasons} and {@link PushGate}).
 *
 * <h3>How a share's picture reaches the call</h3>
 *
 * The Android System WebView has no {@code getDisplayMedia}, and the call's
 * media (mesh and SFU alike) is encrypted end to end INSIDE the WebView, by
 * Encoded Transforms on the senders the page creates. A native WebRTC sender
 * would have had to re-implement both encryption formats outside the page.
 * So the picture is handed to the page instead: MediaProjection draws into a
 * VirtualDisplay, each frame becomes a JPEG, and the JPEG goes to the page
 * over a private WebMessagePort (never a socket another app on the phone
 * could reach). The page turns it back into a video track
 * ({@code api/nativeScreenShare.ts}), and from there it is a share like any
 * other: the same encoder, the same transforms, the same keys.
 *
 * What lives here: the size the virtual display is created at, and when the
 * next frame may be encoded at all.
 */
final class ScreenShareFrames {

    /** The highest frame rate the JPEG hand-over is asked to carry. A phone
     *  encodes each frame twice (JPEG here, VP8 or H.264 in the page), and 30
     *  is already more than a phone's screen usually changes. */
    static final int MAX_FPS = 30;

    /** JPEGs the page has not acknowledged yet, at most. One being decoded and
     *  one on its way: enough to keep the pipe full, and a page that falls
     *  behind (a busy main thread, a backgrounded app) is never handed a
     *  backlog it would show late. Frames are skipped BEFORE encoding. */
    static final int MAX_IN_FLIGHT = 2;

    /** An unacknowledged frame older than this no longer counts: its ack was
     *  lost (the page reloaded, the port changed). Without it one lost ack
     *  would hold the share on its last picture for good. */
    static final long STALE_MS = 2000;

    /** The longest edge a frame is captured at, whatever the dialog asks:
     *  the dialog's 1080p. "1440p" and "Source" are a desktop's sizes, and a
     *  phone's screen at those sizes would be JPEG-encoded, decoded and
     *  encoded again on every frame, on the phone, for detail its 6-inch
     *  screen never showed anyone. */
    static final int MAX_LONG_EDGE = 1920;

    private ScreenShareFrames() {}

    /**
     * The capture size for a screen of {@code screenW x screenH} pixels when
     * the share asks for {@code wantW x wantH}.
     *
     * The ask is a box in the share dialog's terms (1280x720, 1920x1080), which
     * is landscape; a phone is usually upright. So the box is turned to match
     * the screen, and the screen is scaled to fit it without changing its
     * shape. Never larger than the screen itself, and even in both directions
     * (H.264 and VP8 encoders work in 2x2 blocks; an odd size gets cropped or
     * refused). Returns {width, height}.
     */
    static int[] fit(int screenW, int screenH, int wantW, int wantH) {
        if (screenW <= 0 || screenH <= 0) return new int[] { 0, 0 };
        if (wantW <= 0 || wantH <= 0) {
            wantW = screenW;
            wantH = screenH;
        }
        int boxLong = Math.max(wantW, wantH);
        int boxShort = Math.min(wantW, wantH);
        if (boxLong > MAX_LONG_EDGE) {
            boxShort = (int) ((long) boxShort * MAX_LONG_EDGE / boxLong);
            boxLong = MAX_LONG_EDGE;
        }
        boolean portrait = screenH > screenW;
        int boxW = portrait ? boxShort : boxLong;
        int boxH = portrait ? boxLong : boxShort;
        double scale = Math.min(1.0, Math.min((double) boxW / screenW, (double) boxH / screenH));
        int w = even((int) Math.floor(screenW * scale));
        int h = even((int) Math.floor(screenH * scale));
        return new int[] { Math.max(2, w), Math.max(2, h) };
    }

    /** The frame rate actually carried: the ask, within 1..{@link #MAX_FPS}. */
    static int clampFps(int fps) {
        if (fps <= 0) return MAX_FPS;
        return Math.min(MAX_FPS, fps);
    }

    /**
     * Whether a task leaving Recents ends the share. Only the app's own task
     * does: the page that shares lives there. The floating stream window
     * (PipActivity) has a task of its own, and dismissing it must not take
     * your share down. Unknown (no component): end it, to be safe.
     */
    static boolean taskRemovalEndsShare(String removedComponentClass, String mainActivityClass) {
        return removedComponentClass == null || removedComponentClass.equals(mainActivityClass);
    }

    private static int even(int v) {
        return v - (v & 1);
    }

    /**
     * Whether the next frame may be encoded: not sooner than the frame rate
     * allows, and not while the page still has {@link #MAX_IN_FLIGHT} frames
     * it has not acknowledged. Thread-safe: frames arrive on the capture
     * thread, acknowledgements on the main thread.
     *
     * <p>A frame the gate holds back is not thrown away: the display sends
     * nothing new while the screen is still, so a dropped frame left viewers
     * on whatever came before it (half a swipe, say) until something moved.
     * The capture leaves it in the reader instead, and the gate says when to
     * look again: {@link #waitMs} for the frame rate (or a lost ack), and
     * {@link #release} answering true when an ack is what it was waiting for.
     */
    static final class Gate {
        private final long intervalMs;
        private long lastSentMs = Long.MIN_VALUE;
        private int inFlight;
        private boolean frameWaiting;

        Gate(int fps) {
            this.intervalMs = 1000L / clampFps(fps);
        }

        /**
         * 0 when a frame may be encoded now; otherwise how many ms until it
         * may, if no ack comes first (the frame rate's next slot, or the moment
         * the unacknowledged frames count as lost).
         */
        synchronized long waitMs(long nowMs) {
            if (inFlight >= MAX_IN_FLIGHT) {
                long stale = lastSentMs + STALE_MS - nowMs;
                if (stale > 0) return stale;
                inFlight = 0;
            }
            if (lastSentMs == Long.MIN_VALUE) return 0;
            // A frame up to a quarter interval early still counts as on time:
            // the display's own vsync jitters around the interval, and a
            // strict comparison halved 30 fps to 15 on a 60 Hz screen.
            long next = lastSentMs + intervalMs - intervalMs / 4 - nowMs;
            return Math.max(0, next);
        }

        /** True, and the frame counted as sent, when it may go now. */
        synchronized boolean tryAcquire(long nowMs) {
            if (waitMs(nowMs) != 0) return false;
            lastSentMs = nowMs;
            inFlight++;
            frameWaiting = false;
            return true;
        }

        /** A frame is being held back: the next {@link #release} reports it. */
        synchronized void holdFrame() {
            frameWaiting = true;
        }

        /**
         * The page decoded a frame (or one could not be sent at all). True
         * when a frame is being held back and may now be worth another look.
         */
        synchronized boolean release() {
            if (inFlight > 0) inFlight--;
            return frameWaiting;
        }

        synchronized int inFlight() {
            return inFlight;
        }
    }
}
