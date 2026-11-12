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
        // While it is away the order says "away" (nothing could land anyway;
        // the lock is caught then by the screen-off broadcast,
        // PhoneControl.watchScreen); once it is back, a locked phone ends it.
        assertEquals(ControlGate.SERVICE_SUSPENDED, r(true, false, true, true, true, null));
        assertEquals(ControlGate.LOCKED, r(true, true, true, true, true, null));
    }

    @Test
    public void theShareEndingOrNotTheWholeScreenEndsIt() {
        assertEquals(ScreenMap.NOT_SHARING, r(true, true, true, false, true, ScreenMap.NOT_SHARING));
        assertTrue(ControlGate.ends(ScreenMap.NOT_SHARING));
        assertTrue(ControlGate.ends(ScreenMap.ONE_APP));
    }

    @Test
    public void passingRefusalsOnlyDropInput() {
        // The phone turning, or one app shared with another in front: the
        // session goes on, input is dropped while it lasts.
        assertFalse(ControlGate.ends(ScreenMap.SETTLING));
        assertFalse(ControlGate.ends(ScreenMap.HIDDEN));
        assertFalse(ControlGate.ends(ControlGate.SERVICE_SUSPENDED));
        assertFalse(ControlGate.ends(null));
        assertFalse(ControlGate.ends(ControlGate.NO_SESSION));
    }
}
