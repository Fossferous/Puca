package com.sovereign.app.control;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;

import java.util.List;

/**
 * Plays {@link TouchPlanner}'s output on the screen through the
 * AccessibilityService, one dispatch at a time (a new dispatchGesture cancels
 * the one in progress, so the next is sent only when the last one's callback
 * says how it ended). Main thread only.
 *
 * Every dispatch asks {@link Env#refusal} first: a refusal that ends the
 * session ends it; one that does not drops what is waiting and lifts a finger
 * that is down. And a press that began before the captured picture last
 * changed (the phone turned) is abandoned: the viewer aimed it at a picture
 * that is not on the screen any more.
 */
final class Injector {

    private static final String TAG = "PucaPhoneControl";

    interface Env {
        /** Why input may not land now (ControlGate), or null. */
        String refusal();
        /** The screen's real size as turned now: {w, h}. */
        int[] screenSize();
        /** When the share's captured content last changed (elapsedRealtime). */
        long shareChangedAt();
        boolean dispatch(GestureDescription g, AccessibilityService.GestureResultCallback cb, Handler h);
        /** A global action or an edit of the focused field (TouchPlanner's actions). */
        void act(TouchPlanner.Work w);
        /** A refusal that ends the session. */
        void ending(String reason);
    }

    private final Handler main;
    private final Env env;
    private final TouchPlanner planner = new TouchPlanner();
    private final Runnable pump = this::pump;
    private boolean inFlight;
    private boolean ended;
    /** The stroke a finger is down on, and where (screen px), while it is. */
    private GestureDescription.StrokeDescription open;
    private float[] openAt;
    /** Counters, for the log line and the live test. */
    int strokes;
    int cancelled;
    int actions;
    int dropped;

    Injector(Handler main, Env env) {
        this.main = main;
        this.env = env;
    }

    TouchPlanner planner() {
        return planner;
    }

    /** Something was added to the planner: look again. */
    void kick() {
        if (!ended) pump();
    }

    void end() {
        ended = true;
        main.removeCallbacks(pump);
        planner.discardAll();
        lift();
    }

    private void pump() {
        if (ended || inFlight) return;
        main.removeCallbacks(pump);
        if (!planner.busy()) return;
        long now = SystemClock.elapsedRealtime();
        String refusal = env.refusal();
        if (refusal != null) {
            dropped++;
            planner.discardAll();
            lift();
            if (ControlGate.ends(refusal)) env.ending(refusal);
            return;
        }
        TouchPlanner.Work w = planner.poll(now);
        if (w == null) {
            long wake = planner.wakeAt(now);
            if (wake > 0) main.postDelayed(pump, wake - now);
            return;
        }
        if (!w.isStroke()) {
            actions++;
            try {
                env.act(w);
            } catch (RuntimeException e) {
                Log.w(TAG, "action failed", e);
            }
            main.post(pump);
            return;
        }
        if (env.shareChangedAt() > w.pressStartedAt) {
            // Aimed at a picture that is not on the screen any more.
            dropped++;
            planner.abandonPress();
            lift();
            main.post(pump);
            return;
        }
        dispatch(w, now);
    }

    private void dispatch(TouchPlanner.Work w, long now) {
        int[] screen = env.screenSize();
        Path path = new Path();
        float[] last = null;
        List<TouchPlanner.Pt> pts = w.points;
        for (int i = 0; i < pts.size(); i++) {
            float[] q = ScreenMap.toScreen(pts.get(i).x, pts.get(i).y, screen[0], screen[1]);
            if (i == 0) path.moveTo(q[0], q[1]);
            else path.lineTo(q[0], q[1]);
            last = q;
        }
        final GestureDescription.StrokeDescription stroke;
        try {
            if (w.continues) {
                if (open == null) {
                    // The finger this was to continue is not down any more.
                    planner.done(false, now);
                    main.post(pump);
                    return;
                }
                stroke = open.continueStroke(path, 0, w.durationMs, w.willContinue);
            } else {
                // A new press while a finger is still down (should not
                // happen: one press at a time) lifts that one first.
                if (open != null) {
                    lift();
                    main.post(pump);
                    planner.abandonPress();
                    return;
                }
                stroke = new GestureDescription.StrokeDescription(path, 0, w.durationMs, w.willContinue);
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "stroke refused", e);
            open = null;
            openAt = null;
            planner.done(false, now);
            main.post(pump);
            return;
        }
        GestureDescription g = new GestureDescription.Builder().addStroke(stroke).build();
        final float[] end = last;
        inFlight = true;
        strokes++;
        boolean sent = env.dispatch(g, new AccessibilityService.GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                inFlight = false;
                open = w.willContinue ? stroke : null;
                openAt = w.willContinue ? end : null;
                if (ended) {
                    // The session ended while this went out: end() found no
                    // finger down to lift, and this one just went down.
                    // Lift it now, or it stays down (a long press firing
                    // after the revoke) until a real touch.
                    lift();
                    return;
                }
                planner.done(true, SystemClock.elapsedRealtime());
                pump();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                // The person at the phone touched the screen (or the system
                // took the touch back): this press is over.
                inFlight = false;
                cancelled++;
                open = null;
                openAt = null;
                planner.done(false, SystemClock.elapsedRealtime());
                pump();
            }
        }, main);
        if (!sent) {
            inFlight = false;
            cancelled++;
            open = null;
            openAt = null;
            planner.done(false, now);
            main.post(pump);
        }
    }

    /** Lift a finger that is down, where it is. */
    private void lift() {
        GestureDescription.StrokeDescription o = open;
        float[] at = openAt;
        open = null;
        openAt = null;
        if (o == null || at == null) return;
        try {
            Path p = new Path();
            p.moveTo(at[0], at[1]);
            GestureDescription g = new GestureDescription.Builder()
                    .addStroke(o.continueStroke(p, 0, 1, false)).build();
            inFlight = true;
            boolean sent = env.dispatch(g, new AccessibilityService.GestureResultCallback() {
                @Override
                public void onCompleted(GestureDescription gestureDescription) {
                    inFlight = false;
                    pump();
                }

                @Override
                public void onCancelled(GestureDescription gestureDescription) {
                    inFlight = false;
                    pump();
                }
            }, main);
            if (!sent) inFlight = false;
        } catch (RuntimeException e) {
            inFlight = false;
            Log.w(TAG, "lift refused", e);
        }
    }
}
