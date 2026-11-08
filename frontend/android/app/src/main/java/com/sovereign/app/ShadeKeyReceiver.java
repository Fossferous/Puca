package com.sovereign.app;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

/**
 * A press on one of the remote-control notification's key buttons.
 *
 * A BROADCAST, deliberately, not an activity: the point is to type on the
 * computer without opening Púca, and Android 12+ forbids a notification
 * action from starting an activity through a receiver or service anyway (the
 * "trampoline" rule). Not exported: only the app's own immutable
 * PendingIntents can reach it.
 *
 * The receiver reads one fact Android owns — is the keyguard up — and hands
 * the rest to {@link KeepAliveService#onShadePress}, where {@link ShadeKeys}
 * decides. On Android 12+ the button is authentication-required, so a locked
 * phone asks for the unlock first and delivers the press after it (with the
 * keyguard still going, hence the wait below); below 12 this check is the
 * gate.
 */
public class ShadeKeyReceiver extends BroadcastReceiver {

    static final String ACTION = "com.sovereign.app.SHADE_KEY";
    static final String EXTRA_ID = "id";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION.equals(intent.getAction())) return;
        String id = intent.getStringExtra(EXTRA_ID);
        KeyguardManager km = (KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
        if (!locked(km)) {
            KeepAliveService.onShadePress(id, false);
            return;
        }
        // Delivered with the keyguard still up: either the press Android hands
        // over right after the PIN (the keyguard is still going), or a press on
        // an older Android's lock screen. Wait for the keyguard to go — a phone
        // that stays locked is refused when the grace runs out (ShadeKeys).
        PendingResult pending = goAsync();
        Handler main = new Handler(Looper.getMainLooper());
        long started = SystemClock.uptimeMillis();
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                boolean still = locked(km);
                if (ShadeKeys.keepWaiting(still, SystemClock.uptimeMillis() - started)) {
                    main.postDelayed(this, ShadeKeys.UNLOCK_POLL_MS);
                    return;
                }
                try {
                    KeepAliveService.onShadePress(id, still);
                } finally {
                    pending.finish();
                }
            }
        }, ShadeKeys.UNLOCK_POLL_MS);
    }

    /** Either reading counts as locked: isKeyguardLocked covers a swipe-only
     *  lock screen too, isDeviceLocked a secure one whose keyguard is
     *  momentarily not showing. Unknown (no service) is treated as locked. */
    private static boolean locked(KeyguardManager km) {
        return km == null || km.isKeyguardLocked() || km.isDeviceLocked();
    }
}
