package com.sovereign.app.control;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;

/**
 * A viewer's pointer and keys as strokes and actions on a phone. The planner
 * is pure, so each case drives it with times it chooses and plays the
 * injector's part ({@code done}) itself. Each says what would have to break
 * for it to go red.
 */
public class TouchPlannerTest {

    /** Everything the planner gives out from {@code now}, the injector's way:
     *  one at a time, each stroke reported done (completed) a millisecond on. */
    private static List<TouchPlanner.Work> drain(TouchPlanner p, long now) {
        List<TouchPlanner.Work> out = new ArrayList<>();
        TouchPlanner.Work w;
        while ((w = p.poll(now)) != null) {
            out.add(w);
            if (w.isStroke()) {
                now += Math.max(1, w.durationMs);
                p.done(true, now);
            }
        }
        return out;
    }

    @Test
    public void aTapIsAFingerDownThenUpAtThePointer() {
        TouchPlanner p = new TouchPlanner();
        p.move(0.25, 0.75, 0);
        p.down(0, 0);
        TouchPlanner.Work open = p.poll(0);
        assertNotNull(open);
        assertTrue(open.isStroke());
        assertFalse(open.continues);
        // The finger STAYS down: the release has not arrived yet.
        assertTrue(open.willContinue);
        assertEquals(1, open.points.size());
        assertEquals(0.25, open.points.get(0).x, 1e-9);
        assertEquals(0.75, open.points.get(0).y, 1e-9);
        p.done(true, 1);
        // Held still, nothing to send.
        assertNull(p.poll(40));
        p.up(0, 80);
        TouchPlanner.Work lift = p.poll(81);
        assertTrue(lift.continues);
        assertFalse(lift.willContinue);
        assertEquals(1, lift.points.size());
        // The hold already happened in real time (finger down at 1, now 81).
        assertTrue(lift.durationMs <= 5);
        p.done(true, 82);
        assertNull(p.poll(100));
        assertFalse(p.busy());
    }

    @Test
    public void aDragPlaysLiveSegmentByTheTimeItTook() {
        TouchPlanner p = new TouchPlanner();
        p.move(0.5, 0.8, 0);
        p.down(0, 0);
        assertTrue(p.poll(0).willContinue);
        p.done(true, 1);
        p.move(0.5, 0.7, 16);
        p.move(0.5, 0.6, 32);
        TouchPlanner.Work seg = p.poll(33);
        assertTrue(seg.continues);
        assertTrue("still down: more may come", seg.willContinue);
        // From where the finger IS, through what arrived.
        assertEquals(3, seg.points.size());
        assertEquals(0.8, seg.points.get(0).y, 1e-9);
        assertEquals(0.6, seg.points.get(2).y, 1e-9);
        assertEquals(32, seg.durationMs);
        p.done(true, 65);
        p.move(0.5, 0.4, 48);
        p.up(0, 50);
        TouchPlanner.Work last = p.poll(66);
        assertTrue(last.continues);
        assertFalse("released: this segment lifts it", last.willContinue);
        assertEquals(0.6, last.points.get(0).y, 1e-9);
        assertEquals(0.4, last.points.get(1).y, 1e-9);
        p.done(true, 82);
        assertFalse(p.busy());
    }

    @Test
    public void aBacklogPlaysFasterThanRealTimeRatherThanFallingBehind() {
        TouchPlanner p = new TouchPlanner();
        p.down(0, 0);
        p.poll(0);
        p.done(true, 1);
        for (int i = 1; i <= 100; i++) p.move(0.5, 0.5 + i * 0.001, i * 10L);
        TouchPlanner.Work seg = p.poll(1000);
        assertEquals(TouchPlanner.MAX_SEGMENT_MS, seg.durationMs);
    }

    @Test
    public void aRightClickIsALongPress() {
        TouchPlanner p = new TouchPlanner();
        p.move(0.3, 0.3, 0);
        p.down(2, 0);
        assertNull("nothing until the right button comes up", p.poll(0));
        p.up(2, 100);
        TouchPlanner.Work open = p.poll(100);
        assertTrue(open.willContinue);
        p.done(true, 101);
        TouchPlanner.Work lift = p.poll(101);
        assertFalse(lift.willContinue);
        assertEquals(TouchPlanner.LONG_PRESS_MS, lift.durationMs, 2);
    }

    @Test
    public void theWheelTurnedAwayIsAFingerMovingDownTheScreen() {
        TouchPlanner p = new TouchPlanner();
        p.move(0.5, 0.4, 0);
        p.wheel(120, 0);
        p.wheel(120, 30);
        assertNull("notches still gathering", p.poll(60));
        List<TouchPlanner.Work> out = drain(p, 30 + TouchPlanner.WHEEL_GAP_MS);
        assertEquals(2, out.size());
        TouchPlanner.Work swipe = out.get(1);
        assertFalse(swipe.willContinue);
        assertEquals(TouchPlanner.WHEEL_SWIPE_MS, swipe.durationMs);
        double y0 = swipe.points.get(0).y;
        double y1 = swipe.points.get(1).y;
        // Two notches up = the page scrolls up = the finger goes DOWN.
        assertTrue(y1 > y0);
        assertEquals(2 * TouchPlanner.WHEEL_STEP, y1 - y0, 1e-9);
        // And the other way.
        TouchPlanner q = new TouchPlanner();
        q.move(0.5, 0.6, 0);
        q.wheel(-120, 0);
        List<TouchPlanner.Work> back = drain(q, TouchPlanner.WHEEL_GAP_MS);
        assertTrue(back.get(1).points.get(1).y < back.get(1).points.get(0).y);
    }

    @Test
    public void aWheelScrollAtTheEdgeStaysOnTheScreen() {
        TouchPlanner p = new TouchPlanner();
        p.move(0.5, 0.97, 0);
        p.wheel(120 * 5, 0);
        List<TouchPlanner.Work> out = drain(p, TouchPlanner.WHEEL_GAP_MS);
        TouchPlanner.Work swipe = out.get(1);
        for (TouchPlanner.Pt pt : swipe.points) {
            assertTrue(pt.y >= 0.02 - 1e-9 && pt.y <= 0.98 + 1e-9);
        }
        assertEquals(5 * TouchPlanner.WHEEL_STEP, swipe.points.get(1).y - swipe.points.get(0).y, 1e-9);
    }

    @Test
    public void aPressThePersonInterruptsIsOverUpToTheRelease() {
        TouchPlanner p = new TouchPlanner();
        p.down(0, 0);
        p.poll(0);
        // The person at the phone touched the screen: Android cancels ours.
        p.done(false, 5);
        p.move(0.9, 0.9, 10);
        assertNull("the rest of that press is dropped, not turned into a new one", p.poll(11));
        p.up(0, 20);
        assertNull(p.poll(21));
        assertFalse(p.busy());
        // The next press is a press again.
        p.down(0, 30);
        assertNotNull(p.poll(30));
    }

    @Test
    public void aFingerNeverStaysDownForGood() {
        TouchPlanner p = new TouchPlanner();
        p.down(0, 0);
        p.poll(0);
        p.done(true, 1);
        assertNull(p.poll(1000));
        assertEquals(TouchPlanner.STALL_MS, p.wakeAt(1000));
        TouchPlanner.Work lift = p.poll(TouchPlanner.STALL_MS);
        assertNotNull("no word from the viewer for STALL_MS: lifted", lift);
        assertFalse(lift.willContinue);
        p.done(true, TouchPlanner.STALL_MS + 1);
        // The viewer's late release (and moves) are swallowed, not a new press.
        p.move(0.1, 0.1, TouchPlanner.STALL_MS + 100);
        p.up(0, TouchPlanner.STALL_MS + 200);
        assertNull(p.poll(TouchPlanner.STALL_MS + 300));
        assertFalse(p.busy());
    }

    @Test
    public void typingWaitsForTheTapBeforeItAndForTheFocusToMove() {
        TouchPlanner p = new TouchPlanner();
        p.down(0, 0);
        p.up(0, 50);
        p.text("hi", 60);
        TouchPlanner.Work open = p.poll(60);
        assertTrue(open.isStroke());
        p.done(true, 61);
        TouchPlanner.Work lift = p.poll(61);
        assertTrue(lift.isStroke());
        p.done(true, 62);
        // Text never goes before the tap that focused its field, and waits
        // TYPE_AFTER_TOUCH_MS for that focus to arrive.
        assertNull(p.poll(100));
        assertEquals(62 + TouchPlanner.TYPE_AFTER_TOUCH_MS, p.wakeAt(100));
        TouchPlanner.Work t = p.poll(62 + TouchPlanner.TYPE_AFTER_TOUCH_MS);
        assertEquals(TouchPlanner.TEXT, t.action);
        assertEquals("hi", t.text);
    }

    @Test
    public void textTypedFastIsOneEdit() {
        TouchPlanner p = new TouchPlanner();
        p.text("h", 0);
        p.text("e", 1);
        p.key("KeyL", true, 2);
        p.key("KeyL", false, 3);
        p.key("ShiftLeft", true, 4);
        p.key("KeyO", true, 5);
        p.key("ShiftLeft", false, 6);
        p.key("Digit1", true, 7);
        TouchPlanner.Work w = p.poll(1000);
        assertEquals(TouchPlanner.TEXT, w.action);
        assertEquals("helO1", w.text);
        assertNull(p.poll(1000));
    }

    @Test
    public void aShortcutTypesNothingButTheTextAnAltGrMadeStillGoes() {
        TouchPlanner p = new TouchPlanner();
        // Ctrl+A, Meta+V and Alt+F: a phone has no shortcuts, and these
        // typed the key's letter.
        p.key("ControlLeft", true, 0);
        p.key("KeyA", true, 1);
        p.key("KeyA", false, 2);
        p.key("ControlLeft", false, 3);
        p.key("MetaLeft", true, 4);
        p.key("KeyV", true, 5);
        p.key("MetaLeft", false, 6);
        p.key("AltLeft", true, 7);
        p.key("KeyF", true, 8);
        p.key("AltLeft", false, 9);
        // AltGr+Q on a German keyboard: Windows sends ControlLeft and
        // AltRight as keys, and the page sends the '@' it makes as text.
        p.key("ControlLeft", true, 10);
        p.key("AltRight", true, 11);
        p.text("@", 12);
        p.key("AltRight", false, 13);
        p.key("ControlLeft", false, 14);
        // Released: a plain key types again (POSITIVE CONTROL).
        p.key("KeyB", true, 15);
        TouchPlanner.Work w = p.poll(1000);
        assertEquals(TouchPlanner.TEXT, w.action);
        assertEquals("@b", w.text);
        assertNull(p.poll(1000));
    }

    @Test
    public void escapeIsBackAndTheNavButtonsAreGlobalActions() {
        TouchPlanner p = new TouchPlanner();
        p.key("Escape", true, 0);
        p.key("Escape", false, 1);
        p.nav("home", 2);
        p.nav("recents", 3);
        p.nav("power", 4); // not a thing a viewer may press
        p.key("Backspace", true, 5);
        List<TouchPlanner.Work> out = drain(p, 1000);
        assertEquals(4, out.size());
        assertEquals(TouchPlanner.BACK, out.get(0).action);
        assertEquals(TouchPlanner.HOME, out.get(1).action);
        assertEquals(TouchPlanner.RECENTS, out.get(2).action);
        assertEquals(TouchPlanner.BACKSPACE, out.get(3).action);
    }

    @Test
    public void thingsHappenInTheOrderTheViewerDidThem() {
        TouchPlanner p = new TouchPlanner();
        p.nav("back", 0);
        p.down(0, 1);
        p.up(0, 2);
        p.nav("home", 3);
        List<TouchPlanner.Work> out = drain(p, 1000);
        assertEquals(TouchPlanner.BACK, out.get(0).action);
        assertTrue(out.get(1).isStroke());
        assertTrue(out.get(2).isStroke());
        assertEquals(TouchPlanner.HOME, out.get(3).action);
    }

    @Test
    public void discardingWhileTheViewerHoldsSwallowsUpToTheRelease() {
        TouchPlanner p = new TouchPlanner();
        p.down(0, 0);
        p.poll(0);
        p.done(true, 1);
        // The phone turned: everything waiting is dropped.
        p.discardAll();
        assertFalse(p.busy());
        p.move(0.2, 0.2, 10);
        p.up(0, 20);
        assertNull(p.poll(30));
        p.down(0, 40);
        assertNotNull(p.poll(40));
    }

    @Test
    public void aFloodIsBounded() {
        TouchPlanner p = new TouchPlanner();
        for (int i = 0; i < 1000; i++) p.nav("back", i);
        int n = 0;
        while (p.poll(5000) != null) n++;
        assertEquals(TouchPlanner.MAX_QUEUE, n);
    }

    @Test
    public void pointsOffThePictureAreClampedOntoIt() {
        TouchPlanner p = new TouchPlanner();
        p.move(-4, 9, 0);
        p.down(0, 0);
        TouchPlanner.Work w = p.poll(0);
        assertEquals(0, w.points.get(0).x, 1e-9);
        assertEquals(1, w.points.get(0).y, 1e-9);
    }

    @Test
    public void aSecondDownWhileDownIsNotASecondFinger() {
        TouchPlanner p = new TouchPlanner();
        p.down(0, 0);
        p.down(0, 1);
        p.up(0, 2);
        List<TouchPlanner.Work> out = drain(p, 10);
        assertEquals("one press: open and lift", 2, out.size());
    }
}
