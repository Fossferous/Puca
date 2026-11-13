package com.sovereign.app.control;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Turns a viewer's pointer and keys (the in-call remote-control events,
 * remoteControl.ts) into what an AccessibilityService can do on this phone:
 * strokes for dispatchGesture, global actions, text for the focused field.
 * Pure of Android, so every rule is tested off the device
 * (TouchPlannerTest); {@link Injector} hands the result to the system.
 *
 * <h3>A press is played LIVE, in segments</h3>
 * dispatchGesture takes a whole gesture, but a stroke may be marked
 * {@code willContinue} and continued by the next dispatch, the finger staying
 * down in between (Android 8.0+). So a viewer's press becomes: an opening
 * segment at the point it went down (the finger touches the screen now), a
 * segment per batch of movement that arrived since (played over the time it
 * took the viewer to make it), and a closing segment that lifts the finger.
 * A long press is held for real, a drag scrolls as it happens, and a swipe
 * keeps its speed, so a fling flings. The alternative, replaying the whole
 * press once the viewer lets go, showed nothing until the release.
 *
 * <h3>Rules</h3>
 * <ul>
 *   <li>One thing in flight at a time ({@link Injector}): a new dispatch
 *       cancels the one in progress. {@link #poll} is asked only when nothing
 *       is, and {@link #done} is told how it ended.</li>
 *   <li>Everything in order: a tap, then the text typed into what it focused,
 *       never the other way round. Text waits {@link #TYPE_AFTER_TOUCH_MS}
 *       after a touch, for the tapped field to take the focus.</li>
 *   <li>A press the person at the phone interrupts (their own touch cancels
 *       an injected one) is over: the rest of it, up to the viewer's release,
 *       is dropped rather than turned into a second press.</li>
 *   <li>A finger never stays down for good: a press with no word from the
 *       viewer for {@link #STALL_MS} is lifted, and so is one that reaches
 *       {@link #MAX_PRESS_MS}.</li>
 *   <li>Times are all one clock: the injector's (SystemClock.elapsedRealtime),
 *       the page's own arrival times only ever as differences within a batch.</li>
 * </ul>
 */
final class TouchPlanner {

    /** A press with no word from the viewer for this long is lifted. */
    static final long STALL_MS = 5000;
    /** A press is lifted at this age whatever happens (the system's own limit
     *  on one gesture is 60 s). */
    static final long MAX_PRESS_MS = 55_000;
    /** A batch of movement plays over the time it took, but at most this: a
     *  backlog plays faster rather than falling further and further behind. */
    static final long MAX_SEGMENT_MS = 250;
    /** The longest a closing segment holds a finger still. */
    static final long MAX_HOLD_MS = 2000;
    /** A right click is a long press of this length. */
    static final long LONG_PRESS_MS = 700;
    /** Wheel notches this close together are one scroll. */
    static final long WHEEL_GAP_MS = 120;
    /** How long a wheel scroll's swipe takes. */
    static final long WHEEL_SWIPE_MS = 200;
    /** One notch (120 on the wire) moves this fraction of the screen. */
    static final double WHEEL_STEP = 0.12;
    static final double WHEEL_MAX = 0.6;
    /** Typing right after a touch waits this long for the focus to move. */
    static final long TYPE_AFTER_TOUCH_MS = 150;
    /** Bounds on what one session can pile up. */
    static final int MAX_POINTS = 4000;
    static final int MAX_QUEUE = 64;
    /** The most one text action carries (remoteControl.ts validEvent caps an
     *  event at 64; consecutive ones are joined). */
    static final int MAX_TEXT = 512;

    static final String BACK = "back";
    static final String HOME = "home";
    static final String RECENTS = "recents";
    static final String TEXT = "text";
    static final String ENTER = "enter";
    static final String BACKSPACE = "backspace";
    static final String DELETE = "delete";

    /** A point of the picture (0..1 each way) and when it arrived. */
    static final class Pt {
        final double x;
        final double y;
        final long at;

        Pt(double x, double y, long at) {
            this.x = x;
            this.y = y;
            this.at = at;
        }
    }

    /** One dispatch: a stroke segment, or an action. */
    static final class Work {
        /** Stroke: its points, the first where the finger is now. Null for an action. */
        final List<Pt> points;
        final long durationMs;
        /** Continues the previous segment's stroke (the finger is already down). */
        final boolean continues;
        /** The finger stays down after it. */
        final boolean willContinue;
        /** When the press this belongs to went down. */
        final long pressStartedAt;
        /** Action: BACK / HOME / RECENTS / TEXT / ENTER / BACKSPACE / DELETE. */
        final String action;
        final String text;

        private Work(List<Pt> points, long durationMs, boolean continues, boolean willContinue, long pressStartedAt,
                     String action, String text) {
            this.points = points;
            this.durationMs = durationMs;
            this.continues = continues;
            this.willContinue = willContinue;
            this.pressStartedAt = pressStartedAt;
            this.action = action;
            this.text = text;
        }

        static Work stroke(List<Pt> points, long durationMs, boolean continues, boolean willContinue, long startedAt) {
            return new Work(Collections.unmodifiableList(points), durationMs, continues, willContinue, startedAt, null, null);
        }

        static Work action(String action, String text) {
            return new Work(null, 0, false, false, 0, action, text);
        }

        boolean isStroke() {
            return points != null;
        }
    }

    /** One press of the viewer's button (or a whole gesture made up here:
     *  a wheel scroll, a right click's long press). */
    private static final class Press {
        final ArrayList<Pt> pts = new ArrayList<>();
        final long startedAt;
        long lastInputAt;
        boolean closed;
        long closedAt;
        boolean opened;
        /** Points already dispatched (the last of them is where the finger is). */
        int sent;

        Press(Pt first) {
            pts.add(first);
            startedAt = first.at;
            lastInputAt = first.at;
        }
    }

    private final ArrayDeque<Object> queue = new ArrayDeque<>();
    /** The press the viewer's button is down on, while it is (also queued). */
    private Press receiving;
    /** The rest of an interrupted press is dropped up to its release. */
    private boolean swallowUntilUp;
    private double px = 0.5;
    private double py = 0.5;
    private boolean shift;
    /** Ctrl, Alt or the Meta key held (by their key events): a character key
     *  then is a shortcut, which a phone does not have, and is not typed (it
     *  typed the key's letter: Ctrl+A an "a"). The page sends a character an
     *  AltGr or Option makes as text, which this does not touch. */
    private final java.util.Set<String> mods = new java.util.HashSet<>();
    private boolean rightDown;
    private double wheelAcc;
    private long wheelFirstAt;
    private long wheelLastAt;
    private double wheelX;
    private double wheelY;
    private boolean wheelPending;
    /** When the last stroke segment finished (or was cancelled). */
    private long lastStrokeEnd = Long.MIN_VALUE / 2;

    private static double clamp01(double v) {
        if (Double.isNaN(v) || Double.isInfinite(v)) return 0.5;
        return Math.max(0, Math.min(1, v));
    }

    private void enqueue(Object o) {
        if (queue.size() >= MAX_QUEUE) return; // a flood: drop the newest, never what is in progress
        queue.addLast(o);
    }

    // ---- input -----------------------------------------------------------

    void move(double x, double y, long at) {
        px = clamp01(x);
        py = clamp01(y);
        Press p = receiving;
        if (p == null || swallowUntilUp) return;
        p.lastInputAt = at;
        Pt last = p.pts.get(p.pts.size() - 1);
        if (Math.abs(last.x - px) < 1e-5 && Math.abs(last.y - py) < 1e-5) return;
        if (p.pts.size() >= MAX_POINTS) return;
        p.pts.add(new Pt(px, py, Math.max(at, last.at)));
    }

    void down(int button, long at) {
        flushWheel();
        if (button == 0) {
            if (receiving != null) return; // already down
            swallowUntilUp = false;
            Press p = new Press(new Pt(px, py, at));
            if (queue.size() >= MAX_QUEUE) return;
            queue.addLast(p);
            receiving = p;
        } else if (button == 2) {
            rightDown = true;
        }
    }

    void up(int button, long at) {
        if (button == 0) {
            if (swallowUntilUp) {
                swallowUntilUp = false;
                return;
            }
            Press p = receiving;
            if (p == null) return;
            receiving = null;
            p.closed = true;
            p.closedAt = Math.max(at, p.pts.get(p.pts.size() - 1).at);
        } else if (button == 2) {
            if (!rightDown) return;
            rightDown = false;
            flushWheel();
            Press p = new Press(new Pt(px, py, at));
            p.closed = true;
            p.closedAt = at + LONG_PRESS_MS;
            enqueue(p);
        }
    }

    /** {@code dy} as on the wire: 120 a notch, positive = the wheel turned
     *  away from the viewer (the page scrolls UP). */
    void wheel(double dy, long at) {
        if (receiving != null || dy == 0 || Double.isNaN(dy) || Double.isInfinite(dy)) return;
        if (!wheelPending) {
            wheelPending = true;
            wheelFirstAt = at;
            wheelX = px;
            wheelY = py;
            wheelAcc = 0;
        }
        wheelAcc += dy;
        wheelLastAt = at;
    }

    void key(String code, boolean down, long at) {
        if (code == null) return;
        if ("ShiftLeft".equals(code) || "ShiftRight".equals(code)) {
            shift = down;
            return;
        }
        if (code.startsWith("Control") || code.startsWith("Alt") || code.startsWith("Meta")) {
            if (down) mods.add(code);
            else mods.remove(code);
            return;
        }
        if (!down) return;
        flushWheel();
        String action = KeyText.actionFor(code);
        if (action != null) {
            enqueue(Work.action(action, null));
            return;
        }
        if (!mods.isEmpty()) return;
        String ch = KeyText.charFor(code, shift);
        if (ch != null) text(ch, at);
    }

    void nav(String a, long at) {
        if (!BACK.equals(a) && !HOME.equals(a) && !RECENTS.equals(a)) return;
        flushWheel();
        enqueue(Work.action(a, null));
    }

    void text(String s, long at) {
        if (s == null || s.isEmpty()) return;
        flushWheel();
        // Joined onto text still waiting, so a word typed fast is one change
        // to the field rather than one per letter.
        Object tail = queue.peekLast();
        if (tail instanceof Work && TEXT.equals(((Work) tail).action)
                && ((Work) tail).text.length() + s.length() <= MAX_TEXT) {
            queue.removeLast();
            queue.addLast(Work.action(TEXT, ((Work) tail).text + s));
            return;
        }
        enqueue(Work.action(TEXT, s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s));
    }

    /** A wheel scroll becomes a swipe the other way round: the wheel turned
     *  away (positive) scrolls the page up, which a finger does by moving
     *  DOWN the screen. Kept on the screen, starting where the pointer was. */
    private void flushWheel() {
        if (!wheelPending) return;
        wheelPending = false;
        double dist = Math.min(WHEEL_MAX, Math.abs(wheelAcc) / 120.0 * WHEEL_STEP);
        if (dist <= 0) return;
        double dir = wheelAcc > 0 ? 1 : -1;
        double y0 = wheelY;
        double y1 = y0 + dir * dist;
        double lo = 0.02;
        double hi = 0.98;
        if (y1 > hi) { y0 -= y1 - hi; y1 = hi; }
        if (y1 < lo) { y0 += lo - y1; y1 = lo; }
        y0 = Math.max(lo, Math.min(hi, y0));
        Press p = new Press(new Pt(wheelX, y0, wheelFirstAt));
        p.pts.add(new Pt(wheelX, y1, wheelFirstAt + WHEEL_SWIPE_MS));
        p.closed = true;
        p.closedAt = wheelFirstAt + WHEEL_SWIPE_MS;
        enqueue(p);
    }

    // ---- output ----------------------------------------------------------

    /** True while a finger is (or is about to be) down on the screen. */
    boolean strokeOpen() {
        Object head = queue.peekFirst();
        return head instanceof Press && ((Press) head).opened;
    }

    /** Anything waiting at all (to keep the injector's pump turning). */
    boolean busy() {
        return !queue.isEmpty() || wheelPending;
    }

    /**
     * The next thing to dispatch, or null when there is nothing to do yet
     * (a finger held still, text waiting for the focus, a wheel scroll still
     * gathering notches). {@link #wakeAt} says when to ask again.
     */
    Work poll(long now) {
        if (wheelPending && now - wheelLastAt >= WHEEL_GAP_MS) flushWheel();
        Object head = queue.peekFirst();
        if (head == null) return null;
        if (head instanceof Work) {
            Work w = (Work) head;
            if (isTyping(w) && now - lastStrokeEnd < TYPE_AFTER_TOUCH_MS) return null;
            queue.removeFirst();
            return w;
        }
        Press p = (Press) head;
        if (!p.closed && (now - p.lastInputAt >= STALL_MS || now - p.startedAt >= MAX_PRESS_MS)) {
            // Nothing from the viewer for a while (or a press held for nearly
            // a minute): lift it, and drop the rest of it up to the release.
            p.closed = true;
            p.closedAt = now;
            if (receiving == p) {
                receiving = null;
                swallowUntilUp = true;
            }
        }
        if (!p.opened) {
            p.opened = true;
            p.sent = 1;
            List<Pt> first = new ArrayList<>(1);
            first.add(p.pts.get(0));
            return Work.stroke(first, 1, false, true, p.startedAt);
        }
        Pt from = p.pts.get(p.sent - 1);
        if (p.sent < p.pts.size()) {
            List<Pt> seg = new ArrayList<>(p.pts.subList(p.sent - 1, p.pts.size()));
            Pt to = seg.get(seg.size() - 1);
            long dur = Math.max(1, Math.min(MAX_SEGMENT_MS, to.at - from.at));
            p.sent = p.pts.size();
            boolean last = p.closed;
            if (last) queue.removeFirst();
            return Work.stroke(seg, dur, true, !last, p.startedAt);
        }
        if (p.closed) {
            // Lift it, after whatever is left of the viewer's own hold. The
            // finger has already been still since the last segment ended.
            long held = (p.closedAt - from.at) - (now - lastStrokeEnd);
            queue.removeFirst();
            List<Pt> still = new ArrayList<>(1);
            still.add(from);
            return Work.stroke(still, Math.max(1, Math.min(MAX_HOLD_MS, held)), true, false, p.startedAt);
        }
        return null; // the finger is held still: nothing to send until it moves or lifts
    }

    private static boolean isTyping(Work w) {
        return TEXT.equals(w.action) || ENTER.equals(w.action) || BACKSPACE.equals(w.action) || DELETE.equals(w.action);
    }

    /** When to {@link #poll} again with nothing in flight, or 0 for "on the
     *  next input". */
    long wakeAt(long now) {
        long t = 0;
        if (wheelPending) t = wheelLastAt + WHEEL_GAP_MS;
        Object head = queue.peekFirst();
        if (head instanceof Work && isTyping((Work) head)) {
            long w = lastStrokeEnd + TYPE_AFTER_TOUCH_MS;
            t = t == 0 ? w : Math.min(t, w);
        } else if (head instanceof Press && !((Press) head).closed) {
            Press p = (Press) head;
            long w = Math.min(p.lastInputAt + STALL_MS, p.startedAt + MAX_PRESS_MS);
            t = t == 0 ? w : Math.min(t, w);
        }
        return t == 0 ? 0 : Math.max(t, now + 1);
    }

    /**
     * How the last stroke segment from {@link #poll} ended. Not completed (the
     * person at the phone touched the screen, which cancels an injected
     * gesture, or the system refused it): the press it belonged to is over,
     * and the rest of it is dropped up to the viewer's release.
     */
    void done(boolean completed, long now) {
        lastStrokeEnd = now;
        if (completed) return;
        dropHeadPress();
    }

    /** Drop the press in progress (the picture moved under it). */
    void abandonPress() {
        dropHeadPress();
    }

    private void dropHeadPress() {
        Object head = queue.peekFirst();
        if (!(head instanceof Press)) return;
        Press p = (Press) head;
        if (!p.opened) return;
        queue.removeFirst();
        if (receiving == p) {
            receiving = null;
            swallowUntilUp = true;
        }
    }

    /**
     * Drop everything (control refused for now: the screen turning, the shared
     * app hidden). Input that cannot land now must not land later either, when
     * nobody remembers sending it. A press the viewer is still holding is
     * swallowed up to its release.
     */
    void discardAll() {
        boolean holding = receiving != null;
        queue.clear();
        receiving = null;
        wheelPending = false;
        rightDown = false;
        if (holding) swallowUntilUp = true;
    }
}
