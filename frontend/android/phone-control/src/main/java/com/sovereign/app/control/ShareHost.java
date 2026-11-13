package com.sovereign.app.control;

import android.app.PendingIntent;

/**
 * What this module needs from the app's screen share (ScreenShareService),
 * handed in by the app's full-build ControlRegistrar. The share itself is in
 * the app module because Lite shares too; this module, and so this interface,
 * is in the full APK only, and the share never names it.
 */
public interface ShareHost {
    /**
     * What the share captures now: {contentW, contentH, visible (0/1),
     * changedAt (SystemClock.elapsedRealtime of the last change of shape or
     * visibility)}, or null when no share is running.
     */
    long[] shareState();

    /**
     * Put a line and one action on the share's notification (someone is in
     * control, with a way to stop it), or take them off again (all null).
     */
    void setShareNotice(String line, String actionLabel, PendingIntent action);

    /**
     * Run {@code whenEnded} every time a share ends, however it ends (Stop
     * sharing in the notification or the app, Android ending the projection,
     * a failure), from whatever thread ended it.
     */
    void watchShareEnd(Runnable whenEnded);
}
