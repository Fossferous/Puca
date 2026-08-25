package com.sovereign.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * The declaration-vs-event matrix. The first test here is the regression test
 * for a real field failure: a wake doorbell arriving at a backgrounded phone
 * released the CPU wake lock holding up a live My Devices session, because the
 * wake was shaped like a complete desired-state declaration.
 */
public class KeepAliveReasonsTest {

    // Mask constants standing in for ServiceInfo.FOREGROUND_SERVICE_TYPE_*.
    private static final int SPECIAL_USE = 1 << 30;
    private static final int LOCATION = 1 << 3;

    @Test
    public void aWakePreservesControl() {
        // THE REGRESSION TEST. A doorbell says something is parked on the
        // server; it says nothing whatsoever about whether the user is in the
        // middle of controlling their PC.
        KeepAliveReasons inSession = KeepAliveReasons.declared(true, false, false);
        KeepAliveReasons afterWake = inSession.withWake();
        assertTrue("a wake must never end a control session", afterWake.control);
        assertTrue("the CPU wake lock stays held", afterWake.wantsWakeLock());
        assertTrue("and delivery is now running", afterWake.notify);
    }

    @Test
    public void aWakePreservesGeofence() {
        // The standalone harm: a wake at a geofence-only service used to stop
        // its location watch on the way past.
        KeepAliveReasons fencing = KeepAliveReasons.declared(false, false, true);
        assertTrue(fencing.withWake().geofence);
        assertTrue(fencing.withWake().wantsLocationWatch(true, true));
    }

    @Test
    public void aWakeTurnsDeliveryOn() {
        assertTrue(KeepAliveReasons.NONE.withWake().notify);
    }

    @Test
    public void aWakeNeverProducesTheEmptyState() {
        // If a wake could yield "no reasons", onStartCommand would stop the
        // service it was just asked to start.
        assertTrue(KeepAliveReasons.NONE.withWake().any());
        assertTrue(KeepAliveReasons.declared(false, false, false).withWake().any());
    }

    @Test
    public void aDeclarationReplacesEverything() {
        // Guards the CONTRACT from the fix: JS remains the authority on what
        // is wanted, so a declaration must still clear reasons that are gone.
        KeepAliveReasons all = KeepAliveReasons.declared(true, true, true);
        KeepAliveReasons none = KeepAliveReasons.declared(false, false, false);
        assertFalse(none.control);
        assertFalse(none.notify);
        assertFalse(none.geofence);
        assertFalse("a declaration is not a merge", none.any());
        assertTrue(all.any());
    }

    @Test
    public void aWakeIsIdempotent() {
        KeepAliveReasons delivering = KeepAliveReasons.declared(true, true, true);
        KeepAliveReasons afterWake = delivering.withWake();
        assertEquals(delivering.control, afterWake.control);
        assertEquals(delivering.notify, afterWake.notify);
        assertEquals(delivering.geofence, afterWake.geofence);
    }

    @Test
    public void theWakeLockFollowsControlAlone() {
        assertTrue(KeepAliveReasons.declared(true, false, false).wantsWakeLock());
        assertFalse("delivery must not pin the CPU around the clock",
                KeepAliveReasons.declared(false, true, true).wantsWakeLock());
    }

    @Test
    public void theLocationWatchNeedsTheReasonFencesAndPermission() {
        KeepAliveReasons fencing = KeepAliveReasons.declared(false, false, true);
        assertTrue(fencing.wantsLocationWatch(true, true));
        assertFalse("no fences, nothing to watch for", fencing.wantsLocationWatch(false, true));
        assertFalse("no permission, nothing arrives", fencing.wantsLocationWatch(true, false));
        assertFalse(KeepAliveReasons.declared(true, true, false).wantsLocationWatch(true, true));
    }

    @Test
    public void fgsTypeAddsLocationOnlyWithFenceAndPermission() {
        // Declaring the location type WITHOUT the permission is a
        // SecurityException, so the mask is computed, never constant.
        KeepAliveReasons fencing = KeepAliveReasons.declared(false, true, true);
        assertEquals(SPECIAL_USE | LOCATION, fencing.fgsType(true, SPECIAL_USE, LOCATION));
        assertEquals(SPECIAL_USE, fencing.fgsType(false, SPECIAL_USE, LOCATION));

        KeepAliveReasons noFence = KeepAliveReasons.declared(false, true, false);
        assertEquals(SPECIAL_USE, noFence.fgsType(true, SPECIAL_USE, LOCATION));
        assertEquals(SPECIAL_USE, noFence.fgsType(false, SPECIAL_USE, LOCATION));
    }

    @Test
    public void theNotificationNamesTheHighestPriorityReason() {
        assertEquals("Device session active",
                KeepAliveReasons.declared(true, true, true).title());
        assertEquals("Connected",
                KeepAliveReasons.declared(false, true, true).title());
        assertEquals("Location reminders active",
                KeepAliveReasons.declared(false, false, true).title());
    }

    @Test
    public void theLocationWatchIsNeverHiddenBehindAnotherReason() {
        // Being watchable in the shade is part of that feature's honesty
        // budget: a user whose location is being read must be able to see so.
        assertTrue(KeepAliveReasons.declared(true, false, true).text()
                .contains("Location reminders are on."));
        assertTrue(KeepAliveReasons.declared(false, true, true).text()
                .contains("Location reminders are on."));
        assertFalse(KeepAliveReasons.declared(true, false, false).text()
                .contains("Location reminders"));
    }

    @Test
    public void aWakeAtABackgroundedSessionKeepsTheSessionsNotification() {
        // End to end through the shape the service uses: the shade must not
        // flip from "Device session active" to "Connected" behind the user.
        KeepAliveReasons afterWake = KeepAliveReasons.declared(true, false, false).withWake();
        assertEquals("Device session active", afterWake.title());
    }
}
