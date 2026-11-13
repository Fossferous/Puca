package com.sovereign.app.control;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** When a viewer's input may touch the phone, and which refusals end control. */
public class ControlGateTest {

    /** refusal(session, connected, enabled, locked, interactive, share). */
    private static String r(boolean session, boolean connected, boolean enabled, boolean locked, boolean interactive,
                            String share) {
        return ControlGate.refusal(session, connected, enabled, locked, interactive, share);
    }

    @Test
    public void nothingLandsWithoutASessionThePersonAllowed() {
        // Even with everything else fine: no Allow, no input.
        assertEquals(ControlGate.NO_SESSION, r(false, true, true, false, true, null));
    }

    @Test
    public void allowedSessionOnAnUnlockedPhoneSharingTheWholeScreenLands() {
        assertNull(r(true, true, true, false, true, null));
    }

    @Test
    public void aLockedPhoneTakesNothingAndEndsTheSession() {
        String locked = r(true, true, true, true, true, null);
        assertEquals(ControlGate.LOCKED, locked);
        assertTrue(ControlGate.ends(locked));
        // Screen off is checked first: a screen that went off is also locked.
        assertEquals(ControlGate.SCREEN_OFF, r(true, true, true, true, false, null));
        assertTrue(ControlGate.ends(ControlGate.SCREEN_OFF));
    }

    @Test
    public void theServiceSwitchedOffEndsIt() {
        assertEquals(ControlGate.SERVICE_OFF, r(true, false, false, false, true, null));
        assertTrue(ControlGate.ends(ControlGate.SERVICE_OFF));
    }

    @Test
    public void theServiceTakenAwayWithItsSwitchStillOnOnlyPauses() {
        // UiAutomation (a test tool, an automation app) unbinds every other
        // accessibility service while it runs: nothing lands, nothing ends.
        String r = r(true, false, true, false, true, null);
        assertEquals(ControlGate.SERVICE_SUSPENDED, r);
        assertFalse(ControlGate.ends(r));
        // A lock while it is away ENDS the session (the screen may stay on,
        // so no screen-off broadcast says so): paused, it used to resume
        // after an unlock with no new Allow.
        assertEquals(ControlGate.LOCKED, r(true, false, true, true, true, null));
        assertTrue(ControlGate.ends(r(true, false, true, true, true, null)));
        assertEquals(ControlGate.SCREEN_OFF, r(true, false, true, false, false, null));
        assertEquals(ControlGate.LOCKED, r(true, true, true, true, true, null));
    }

    @Test
    public void theShareEndingOrNotTheWholeScreenEndsIt() {
        assertEquals(ScreenMap.NOT_SHARING, r(true, true, true, false, true, ScreenMap.NOT_SHARING));
        assertTrue(ControlGate.ends(ScreenMap.NOT_SHARING));
        assertTrue(ControlGate.ends(ScreenMap.ONE_APP));
    }

    @Test
    public void oneAppSharedAndSwitchedAwayFromEndsIt() {
        // A one-app share whose window fills the screen passes Allow (Android
        // does not say which was chosen); switching away from it must END
        // control, never pause it until the person goes back.
        assertTrue(ControlGate.ends(ScreenMap.HIDDEN));
    }

    @Test
    public void passingRefusalsOnlyDropInput() {
        // The phone turning: the session goes on, input is dropped while it
        // lasts.
        assertFalse(ControlGate.ends(ScreenMap.SETTLING));
        assertFalse(ControlGate.ends(ControlGate.SERVICE_SUSPENDED));
        assertFalse(ControlGate.ends(null));
        assertFalse(ControlGate.ends(ControlGate.NO_SESSION));
    }

    @Test
    public void android7CannotBeControlled() {
        // Continued strokes (willContinue, continueStroke) are API 26.
        assertFalse(ControlGate.supported(24));
        assertFalse(ControlGate.supported(25));
        assertTrue(ControlGate.supported(26));
        assertTrue(ControlGate.supported(36));
        assertEquals(26, ControlGate.MIN_SDK);
    }
}
