package com.sovereign.app.control;

/**
 * Where a viewer's point lands on this phone's screen, and when it must not
 * land at all. Pure, so the rules are tested off the device
 * (ScreenMapTest).
 *
 * The viewer sends a point as a fraction of the PICTURE it sees (0..1 each
 * way, remoteControl.ts normalizedOverVideo). That picture is what the share
 * captures (ScreenShareService): the whole screen, as it is turned right now,
 * fitted into the stream's box. So a point maps onto the screen by its
 * fractions alone, and only while three things hold:
 *
 * <ol>
 *   <li>the share captures the WHOLE screen. From Android 14 a person can
 *       share one app instead; its window may sit anywhere (split screen, a
 *       freeform window), and the viewer cannot see what a point outside it
 *       would land on;</li>
 *   <li>what it captures is on screen. One app shared and another one in
 *       front: the viewer sees the shared app, a tap would land on the other
 *       one (onCapturedContentVisibilityChanged);</li>
 *   <li>the picture has settled after the phone turned. The viewer is looking
 *       at a picture a network trip old: for a moment after the screen turns,
 *       its fractions are of the OLD orientation, and the same fractions of
 *       the new one are somewhere else entirely.</li>
 * </ol>
 */
final class ScreenMap {

    private ScreenMap() {}

    /** How long after the captured picture changes shape points are dropped:
     *  the turn itself, the capture catching up, and the viewer's picture
     *  catching up after that. */
    static final long SETTLE_MS = 1000;
    /** Rounding between the capture's size and the screen's. */
    static final int SLACK_PX = 4;

    static final String NOT_SHARING = "not-sharing";
    static final String ONE_APP = "one-app";
    static final String HIDDEN = "hidden";
    static final String SETTLING = "settling";

    /** What the share captures now, as ScreenShareService reports it. */
    static final class Share {
        final int contentW;
        final int contentH;
        final boolean visible;
        /** When the captured content last changed shape or visibility
         *  (SystemClock.elapsedRealtime). */
        final long changedAt;

        Share(int contentW, int contentH, boolean visible, long changedAt) {
            this.contentW = contentW;
            this.contentH = contentH;
            this.visible = visible;
            this.changedAt = changedAt;
        }

        /** From the host's {contentW, contentH, visible 0/1, changedAt}, or
         *  null for anything else (no share running). */
        static Share of(long[] state) {
            if (state == null || state.length < 4) return null;
            return new Share((int) state[0], (int) state[1], state[2] != 0, state[3]);
        }
    }

    private static boolean near(int a, int b) {
        return Math.abs(a - b) <= SLACK_PX;
    }

    /**
     * Why a point may not be mapped now, or null when it may. {@code screenW}
     * and {@code screenH} are the screen's real size as it is turned NOW.
     */
    static String refusal(Share s, int screenW, int screenH, long now) {
        if (s == null || s.contentW <= 0 || s.contentH <= 0 || screenW <= 0 || screenH <= 0) return NOT_SHARING;
        if (!s.visible) return HIDDEN;
        if (near(s.contentW, screenW) && near(s.contentH, screenH)) {
            return now - s.changedAt < SETTLE_MS ? SETTLING : null;
        }
        // The same screen the other way round: the phone has turned and the
        // capture has not caught up yet. Not one app; just not yet.
        if (near(s.contentW, screenH) && near(s.contentH, screenW)) return SETTLING;
        return ONE_APP;
    }

    /**
     * Whether a session may START: settling is no reason to refuse (it is
     * over in a second), and content that is hidden while the person is
     * looking at Púca to press Allow means the share is of some OTHER app.
     */
    static String beginRefusal(Share s, int screenW, int screenH, long now) {
        String r = refusal(s, screenW, screenH, now);
        if (SETTLING.equals(r)) return null;
        if (HIDDEN.equals(r)) return ONE_APP;
        return r;
    }

    private static double clamp01(double v) {
        if (Double.isNaN(v)) return 0.5;
        return Math.max(0, Math.min(1, v));
    }

    /** A point of the picture on the screen, in screen pixels, inside it. */
    static float[] toScreen(double nx, double ny, int screenW, int screenH) {
        double x = clamp01(nx) * screenW;
        double y = clamp01(ny) * screenH;
        return new float[] {
            (float) Math.max(0, Math.min(screenW - 1, x)),
            (float) Math.max(0, Math.min(screenH - 1, y)),
        };
    }
}
