package com.sovereign.app.control;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.app.KeyguardManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Point;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Log;
import android.view.Display;

/**
 * One control session of this phone at a time: who is in control, what may
 * land, and every way it ends. Main thread for all state; the plugin hops
 * here.
 *
 * A session exists only between {@link #begin} (the person at the phone
 * pressed Allow for that viewer, in the page) and {@link #end}. Input outside
 * one is dropped by {@link ControlGate}, whatever arrives. While it lasts the
 * phone shows {@link Indicator} over every app and a line with "Stop control"
 * on the share's notification. It ends, natively and at once, on: that Stop,
 * the indicator's Stop, the phone locking or its screen going off, the
 * service being switched off, the share ending or no longer being of the
 * whole screen; and from the page (the in-app Stop, the call ending, the
 * viewer stopping). The page is told of every native end
 * ({@link Listener#ended}) and tells the viewer.
 */
public final class PhoneControl {

    private PhoneControl() {}

    private static final String TAG = "PucaPhoneControl";

    static final String STOPPED_NOTIFICATION = "notification";
    static final String STOPPED_INDICATOR = "indicator";

    interface Listener {
        void ended(String reason);
        void statusChanged();
    }

    private static final Handler main = new Handler(Looper.getMainLooper());
    private static volatile Context app;
    private static volatile ShareHost host;
    private static volatile Listener listener;

    private static boolean active;
    private static String viewer;
    private static Injector injector;
    private static Indicator indicator;
    private static BroadcastReceiver screenOff;

    /** From the app's full-build ControlRegistrar, once per process (again is harmless). */
    public static void install(Context context, ShareHost shareHost) {
        app = context.getApplicationContext();
        host = shareHost;
        // The share ending ends control at once, here, whatever the page
        // does (it may be slow, or gone): control is of a share, and a share
        // started again later is a new one nobody has been allowed into.
        shareHost.watchShareEnd(() -> end(ScreenMap.NOT_SHARING, true));
    }

    static void setListener(Listener l) {
        listener = l;
    }

    /** Forget {@code l}, if it is still the one listening (a plugin of a
     *  destroyed activity must not be held by this static, and must not
     *  take away the next activity's). */
    static void clearListener(Listener l) {
        if (listener == l) listener = null;
    }

    static Handler main() {
        return main;
    }

    static boolean installed() {
        return app != null && host != null;
    }

    // ---- what the page asks ------------------------------------------------

    static ComponentName component(Context c) {
        return new ComponentName(c, PhoneControlService.class);
    }

    /** The person switched the service on in Android's settings. */
    static boolean serviceEnabled() {
        Context c = app;
        if (c == null) return false;
        String on = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(on)) return false;
        ComponentName mine = component(c);
        for (String s : on.split(":")) {
            ComponentName cn = ComponentName.unflattenFromString(s);
            if (mine.equals(cn)) return true;
        }
        return false;
    }

    /** Android has bound it (it can inject now). */
    static boolean serviceConnected() {
        return PhoneControlService.current != null;
    }

    static boolean active() {
        return active;
    }

    static int[] screenSize() {
        Context c = app;
        DisplayManager dm = c == null ? null : (DisplayManager) c.getSystemService(Context.DISPLAY_SERVICE);
        Display d = dm == null ? null : dm.getDisplay(Display.DEFAULT_DISPLAY);
        Point p = new Point();
        if (d != null) d.getRealSize(p);
        return new int[] { p.x, p.y };
    }

    private static ScreenMap.Share share() {
        ShareHost h = host;
        return h == null ? null : ScreenMap.Share.of(h.shareState());
    }

    private static boolean locked() {
        Context c = app;
        KeyguardManager km = c == null ? null : (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    private static boolean interactive() {
        Context c = app;
        PowerManager pm = c == null ? null : (PowerManager) c.getSystemService(Context.POWER_SERVICE);
        return pm == null || pm.isInteractive();
    }

    /** Why input may not land now (ControlGate), or null. Main thread. */
    static String refusal() {
        if (!ControlGate.supported(Build.VERSION.SDK_INT)) return ControlGate.UNSUPPORTED;
        int[] s = screenSize();
        boolean connected = serviceConnected();
        // Back from being taken away, but its frame not on screen again yet:
        // nothing lands without the sign that someone is in control.
        if (active && connected && indicator == null) return ControlGate.SERVICE_SUSPENDED;
        return ControlGate.refusal(active, connected, !connected && serviceEnabled(), locked(), interactive(),
                ScreenMap.refusal(share(), s[0], s[1], SystemClock.elapsedRealtime()));
    }

    /** Why a session cannot start now, or null when Allow may start it. */
    static String beginRefusal() {
        if (!ControlGate.supported(Build.VERSION.SDK_INT)) return ControlGate.UNSUPPORTED;
        if (!installed()) return ScreenMap.NOT_SHARING;
        int[] s = screenSize();
        // Not bound: starting waits for Android either way, but the person
        // is told whether the switch itself is off (ControlGateTest).
        return ControlGate.beginRefusal(serviceConnected(), serviceEnabled(), locked(), interactive(),
                ScreenMap.beginRefusal(share(), s[0], s[1], SystemClock.elapsedRealtime()));
    }

    /** How long a session waits for Android to give the service back. */
    static final long RESUME_MS = 60_000;
    /** Its own reason, not SERVICE_OFF: the switch is still on (that is why
     *  the session waited), so "switched off" would be untrue. */
    private static final Runnable resumeTimeout = () -> end(ControlGate.SERVICE_LOST, true);

    /** How often a live session checks, input or not, that it may go on. The
     *  screen going off, Stop, the service and the share's end act at once;
     *  this catches the rest within a second: the keyguard up with the screen
     *  still on, a one-app share now behind another app or no longer the
     *  screen's size. Before, those were seen only when input arrived, and
     *  the frame and "is controlling" stayed up meanwhile. */
    static final long WATCH_MS = 1000;
    private static final Runnable watchdog = new Runnable() {
        @Override
        public void run() {
            if (!active) return;
            String r = refusal();
            if (ControlGate.ends(r)) {
                end(r, true);
                return;
            }
            main.postDelayed(this, WATCH_MS);
        }
    };

    // ---- a session -------------------------------------------------------

    /** The name shown for a viewer: trimmed, at most 64 characters. */
    static String label(String viewerName) {
        String v = viewerName == null || viewerName.trim().isEmpty() ? "Someone" : viewerName.trim();
        return v.length() > 64 ? v.substring(0, 64) : v;
    }

    /** Start a session for {@code viewerName}. Main thread. Null when it
     *  started, else why not (nothing started). */
    static String begin(String viewerName) {
        String r = beginRefusal();
        if (r != null) return r;
        PhoneControlService svc = PhoneControlService.current;
        if (svc == null) return serviceEnabled() ? ControlGate.SERVICE_SUSPENDED : ControlGate.SERVICE_DISABLED;
        if (active) end(null, false); // one at a time: a new grant replaces the old
        viewer = label(viewerName);
        indicator = new Indicator(svc);
        indicator.show(viewer, () -> end(STOPPED_INDICATOR, true));
        if (!indicator.showing()) {
            // No visible sign of control, no control.
            indicator = null;
            return ControlGate.NO_INDICATOR;
        }
        active = true;
        injector = new Injector(main, env());
        watchScreen(true);
        main.removeCallbacks(watchdog);
        main.postDelayed(watchdog, WATCH_MS);
        ShareHost h = host;
        if (h != null) h.setShareNotice(viewer + " is controlling this phone", "Stop control", stopIntent());
        Log.i(TAG, "control session started");
        return null;
    }

    /** End the session. {@code tell}: say so to the page (a native end). */
    static void end(String reason, boolean tell) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(() -> end(reason, tell));
            return;
        }
        if (!active) return;
        active = false;
        main.removeCallbacks(resumeTimeout);
        main.removeCallbacks(watchdog);
        Injector inj = injector;
        injector = null;
        if (inj != null) {
            inj.end();
            Log.i(TAG, "control session ended (" + reason + "): strokes=" + inj.strokes + " cancelled=" + inj.cancelled
                    + " actions=" + inj.actions + " dropped=" + inj.dropped);
        }
        if (indicator != null) indicator.hide();
        indicator = null;
        watchScreen(false);
        ShareHost h = host;
        if (h != null) h.setShareNotice(null, null, null);
        Listener l = listener;
        if (tell && l != null) l.ended(reason == null ? "ended" : reason);
    }

    /** Input from the page, already validated there and again by the plugin. Main thread. */
    static Injector injector() {
        return active ? injector : null;
    }

    /**
     * The service came or went. Main thread (both callers are).
     *
     * Gone with the person's switch OFF: the session ends. Gone with the
     * switch still ON: Android took it away for now (UiAutomation, which test
     * tools and some automation apps use, unbinds every other accessibility
     * service while it runs). Its overlays went with it, and nothing can land
     * meanwhile; the session waits RESUME_MS for it, then ends. Back in time:
     * the frame and the pill are shown again (from the new service) before
     * anything else lands; if they cannot be, the session ends.
     */
    static void serviceChanged() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(PhoneControl::serviceChanged);
            return;
        }
        if (active) {
            PhoneControlService svc = PhoneControlService.current;
            if (svc == null) {
                if (indicator != null) indicator.hide();
                indicator = null;
                if (!serviceEnabled()) {
                    end(ControlGate.SERVICE_OFF, true);
                } else {
                    Log.i(TAG, "control service taken away while switched on: waiting for it");
                    main.removeCallbacks(resumeTimeout);
                    main.postDelayed(resumeTimeout, RESUME_MS);
                }
            } else if (indicator == null) {
                main.removeCallbacks(resumeTimeout);
                // Put away while it was paused: that ends it, it never
                // resumes (the watchdog may not have run since).
                if (!interactive() || locked()) {
                    end(!interactive() ? ControlGate.SCREEN_OFF : ControlGate.LOCKED, true);
                    Listener l = listener;
                    if (l != null) l.statusChanged();
                    return;
                }
                Indicator again = new Indicator(svc);
                again.show(viewer, () -> end(STOPPED_INDICATOR, true));
                if (!again.showing()) {
                    end(ControlGate.NO_INDICATOR, true);
                } else {
                    indicator = again;
                    Log.i(TAG, "control service back: session resumed");
                    Injector inj = injector;
                    if (inj != null) inj.kick();
                }
            }
        }
        Listener l = listener;
        if (l != null) l.statusChanged();
    }

    private static PendingIntent stopIntent() {
        Context c = app;
        Intent i = new Intent(c, StopControlReceiver.class).setAction(StopControlReceiver.ACTION_STOP);
        return PendingIntent.getBroadcast(c, 4714, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The screen going off ends a session at once, not at the next input. */
    private static void watchScreen(boolean on) {
        Context c = app;
        if (c == null) return;
        if (!on) {
            if (screenOff != null) {
                try { c.unregisterReceiver(screenOff); } catch (RuntimeException ignored) { /* gone */ }
                screenOff = null;
            }
            return;
        }
        if (screenOff != null) return;
        screenOff = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                end(ControlGate.SCREEN_OFF, true);
            }
        };
        IntentFilter f = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        if (Build.VERSION.SDK_INT >= 33) c.registerReceiver(screenOff, f, Context.RECEIVER_NOT_EXPORTED);
        else c.registerReceiver(screenOff, f);
    }

    private static Injector.Env env() {
        return new Injector.Env() {
            @Override public String refusal() { return PhoneControl.refusal(); }
            @Override public int[] screenSize() { return PhoneControl.screenSize(); }
            @Override public long shareChangedAt() {
                ScreenMap.Share s = share();
                return s == null ? Long.MAX_VALUE : s.changedAt;
            }
            @Override public boolean dispatch(GestureDescription g, AccessibilityService.GestureResultCallback cb, Handler h) {
                PhoneControlService now = PhoneControlService.current;
                return now != null && now.dispatchGesture(g, cb, h);
            }
            @Override public void act(TouchPlanner.Work w) {
                PhoneControlService now = PhoneControlService.current;
                if (now == null) return;
                switch (w.action) {
                    case TouchPlanner.BACK: now.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK); break;
                    case TouchPlanner.HOME: now.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME); break;
                    case TouchPlanner.RECENTS: now.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS); break;
                    default: now.edit(w.action, w.text); break;
                }
            }
            @Override public void ending(String reason) { end(reason, true); }
        };
    }
}
