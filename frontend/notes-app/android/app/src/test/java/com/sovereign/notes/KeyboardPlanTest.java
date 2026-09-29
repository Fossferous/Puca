package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * When NotesKeyboard asks for the keyboard, and when it stops (KeyboardPlan).
 *
 * The rules that matter to the person holding the phone: it asks only while
 * the page has a field focused, so there is never a keyboard with nothing to
 * type into; it never asks again once the keyboard has been up, so a keyboard
 * they put away stays away; and it stops on its own, so a stale request
 * cannot pop the keyboard up seconds later over whatever they moved on to.
 * The device half — does asking actually raise it, and does a focus() alone
 * not? — is androidTest/NotesKeyboardTest.
 */
public class KeyboardPlanTest {

    @Test
    public void asksWhileTheWindowHasFocusAFieldIsFocusedAndTheKeyboardIsDown() {
        // Positive control: the one state in which it asks.
        assertEquals(KeyboardPlan.Step.ASK, KeyboardPlan.next(0, true, true, false));
        assertEquals(KeyboardPlan.Step.ASK, KeyboardPlan.next(KeyboardPlan.BUDGET_MS - 1, true, true, false));
    }

    @Test
    public void waitsForTheWindowRatherThanAskingIntoNothing() {
        // A warm start: onNewIntent comes before onResume, so the page asks
        // while the window is still coming to the front. Android ignores a
        // show request from a window without focus.
        assertEquals(KeyboardPlan.Step.WAIT, KeyboardPlan.next(0, false, true, false));
        assertEquals(KeyboardPlan.Step.WAIT, KeyboardPlan.next(KeyboardPlan.BUDGET_MS - 1, false, true, false));
    }

    @Test
    public void neverAsksWithoutAFieldToTypeInto() {
        // Chromium has not told the WebView about the page's focus() yet —
        // or there is no field at all (the page left it, or never had one).
        assertEquals(KeyboardPlan.Step.WAIT, KeyboardPlan.next(0, true, false, false));
        assertEquals(KeyboardPlan.Step.WAIT, KeyboardPlan.next(KeyboardPlan.BUDGET_MS - 1, true, false, false));
        assertEquals(KeyboardPlan.Step.GIVE_UP, KeyboardPlan.next(KeyboardPlan.BUDGET_MS, true, false, false));
    }

    @Test
    public void stopsTheMomentTheKeyboardIsUpAndNeverAsksAgain() {
        for (long t : new long[] { 0, 1, KeyboardPlan.STEP_MS, KeyboardPlan.BUDGET_MS, KeyboardPlan.BUDGET_MS * 10 }) {
            for (boolean window : new boolean[] { true, false }) {
                for (boolean field : new boolean[] { true, false }) {
                    assertEquals("t=" + t + " window=" + window + " field=" + field,
                            KeyboardPlan.Step.SHOWN, KeyboardPlan.next(t, window, field, true));
                }
            }
        }
    }

    @Test
    public void givesUpOnceTheRequestIsStaleWhateverTheWindowAndField() {
        assertEquals(KeyboardPlan.Step.GIVE_UP, KeyboardPlan.next(KeyboardPlan.BUDGET_MS, true, true, false));
        assertEquals(KeyboardPlan.Step.GIVE_UP, KeyboardPlan.next(KeyboardPlan.BUDGET_MS, false, true, false));
        assertEquals(KeyboardPlan.Step.GIVE_UP, KeyboardPlan.next(Long.MAX_VALUE, true, true, false));
    }

    @Test
    public void everyRunEndsInAnAnswerWithinTheBudget() {
        // Walk the clock the way NotesKeyboard does, with the keyboard never
        // coming up: whatever the window and the field do, the walk must
        // reach GIVE_UP after a bounded number of looks (a page waiting on
        // the answer, and a Handler re-posting itself for ever, are both bugs).
        // The walk itself is capped, so a plan that never gives up FAILS here
        // instead of hanging the suite.
        final int cap = (int) (KeyboardPlan.BUDGET_MS / KeyboardPlan.STEP_MS) * 10 + 10;
        for (boolean window : new boolean[] { true, false }) {
            for (boolean field : new boolean[] { true, false }) {
                int looks = 0;
                KeyboardPlan.Step step;
                long t = 0;
                do {
                    step = KeyboardPlan.next(t, window, field, false);
                    t += KeyboardPlan.STEP_MS;
                    looks++;
                } while ((step == KeyboardPlan.Step.ASK || step == KeyboardPlan.Step.WAIT) && looks < cap);
                assertEquals(KeyboardPlan.Step.GIVE_UP, step);
                assertTrue("looks=" + looks, looks <= KeyboardPlan.BUDGET_MS / KeyboardPlan.STEP_MS + 1);
            }
        }
        assertTrue("short enough not to read as the app misbehaving", KeyboardPlan.BUDGET_MS <= 2000);
        assertTrue("long enough for a warm start's window focus", KeyboardPlan.BUDGET_MS >= 1000);
    }

    // --- nextLower: no keyboard over a drawing or a photo ---------------------

    @Test
    public void putsAwayAKeyboardWithNothingToTypeInto() {
        // Positive control: the state Android's restore leaves — the window
        // back in front, the keyboard up, no field focused in the page.
        assertEquals(KeyboardPlan.Lower.HIDE, KeyboardPlan.nextLower(0, 0, false, true));
        assertEquals(KeyboardPlan.Lower.HIDE, KeyboardPlan.nextLower(KeyboardPlan.SETTLE_MS + 400, KeyboardPlan.SETTLE_MS - 1, false, true));
    }

    @Test
    public void neverPutsAwayAKeyboardWhileAFieldHasTheFocus() {
        for (long focused : new long[] { 0, 1, KeyboardPlan.SETTLE_MS - 1 }) {
            assertEquals("focused=" + focused, KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(focused, focused, true, true));
        }
    }

    @Test
    public void waitsForTheWindowBecauseTheRestoreComesWithIt() {
        // A warm start's intent reaches the page before the window is back;
        // the keyboard Android restores arrives with the window's focus.
        assertEquals(KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(0, -1, false, false));
        assertEquals(KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(0, -1, false, true));
        assertEquals(KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(KeyboardPlan.LOWER_CAP_MS - 1, -1, false, true));
    }

    @Test
    public void keepsWatchingThroughTheSettleSoALateRestoreIsCaught() {
        // Keyboard down at the first looks is not the end: the restore may
        // not have landed yet.
        assertEquals(KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(0, 0, false, false));
        assertEquals(KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(KeyboardPlan.SETTLE_MS + 300, KeyboardPlan.SETTLE_MS - 1, false, false));
        // ...and after a HIDE it still looks again rather than stopping.
        assertEquals(KeyboardPlan.Lower.HIDE, KeyboardPlan.nextLower(200, 200, false, true));
        assertEquals(KeyboardPlan.Lower.WAIT, KeyboardPlan.nextLower(300, 300, false, false));
        assertEquals(KeyboardPlan.Lower.HIDE, KeyboardPlan.nextLower(400, 400, false, true));
    }

    @Test
    public void stopsOnceSettledOrAtTheCapWhateverItSees() {
        for (boolean field : new boolean[] { true, false }) {
            for (boolean ime : new boolean[] { true, false }) {
                assertEquals(KeyboardPlan.Lower.DONE, KeyboardPlan.nextLower(KeyboardPlan.SETTLE_MS, KeyboardPlan.SETTLE_MS, field, ime));
                assertEquals(KeyboardPlan.Lower.DONE, KeyboardPlan.nextLower(KeyboardPlan.LOWER_CAP_MS, -1, field, ime));
                assertEquals(KeyboardPlan.Lower.DONE, KeyboardPlan.nextLower(Long.MAX_VALUE, 0, field, ime));
            }
        }
    }

    @Test
    public void everyLowerEndsWithinItsCap() {
        // Walk the clock the way NotesKeyboard.lower does, with the keyboard
        // coming straight back after every hide and the window's focus
        // arriving at different moments (or never): it must reach DONE.
        final int cap = (int) (KeyboardPlan.LOWER_CAP_MS / KeyboardPlan.STEP_MS) * 10 + 10;
        for (long focusAt : new long[] { 0, 700, 2900, Long.MAX_VALUE }) {
            for (boolean field : new boolean[] { true, false }) {
                int looks = 0;
                KeyboardPlan.Lower step;
                long t = 0;
                do {
                    long focused = t >= focusAt ? t - focusAt : -1;
                    step = KeyboardPlan.nextLower(t, focused, field, true);
                    t += KeyboardPlan.STEP_MS;
                    looks++;
                } while (step != KeyboardPlan.Lower.DONE && looks < cap);
                assertEquals("focusAt=" + focusAt + " field=" + field, KeyboardPlan.Lower.DONE, step);
                assertTrue("looks=" + looks, looks <= KeyboardPlan.LOWER_CAP_MS / KeyboardPlan.STEP_MS + 1);
            }
        }
        assertTrue("the restore lands with the window's focus, well inside the settle", KeyboardPlan.SETTLE_MS >= 800);
        assertTrue("short enough that a field tapped soon after is never second-guessed for long", KeyboardPlan.SETTLE_MS <= 1500);
    }
}
