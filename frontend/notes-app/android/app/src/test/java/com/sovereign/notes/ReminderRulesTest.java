package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;

import org.junit.Test;

public class ReminderRulesTest {

    private static final long NOW = 1_789_816_183_000L;
    private static final long H = 60 * 60_000L;

    // --- which HTTP status is a dead session --------------------------------

    @Test
    public void only401IsADeadSession() {
        assertEquals(ReminderRules.AUTH_DEAD, ReminderRules.refreshOutcome(401));
        assertEquals(ReminderRules.OK, ReminderRules.refreshOutcome(200));
    }

    @Test
    public void a403OrAServerErrorIsAFailedLookRetriedNextPeriod() {
        for (int s : new int[] { 403, 404, 429, 500, 502, 503 }) {
            assertEquals("HTTP " + s, ReminderRules.FAILED, ReminderRules.refreshOutcome(s));
        }
    }

    // --- the alarm that is firing when the session turns out dead ------------

    private static ReminderPlan.Entry e(long id, long at) {
        return new ReminderPlan.Entry(id, at, "m" + id, "m" + id);
    }

    @Test
    public void aDeadSessionAtFireTimeStillAnnouncesTheItemThatArmedTheAlarm() {
        List<ReminderPlan.Entry> before = Arrays.asList(e(1, NOW - 1000), e(2, NOW + H));
        // what authDead left in the store: the passed entry dropped unchecked
        List<ReminderPlan.Entry> after = ReminderMerge.dropPassed(before, NOW);
        List<ReminderPlan.Entry> fire = ReminderRules.entriesToFire(before, after, ReminderRules.AUTH_DEAD, NOW);
        ReminderPlan.Result r = ReminderPlan.plan(fire, new HashMap<>(), NOW);
        assertEquals(Collections.singletonList(1L), r.dueNow);
        assertEquals(NOW + H, r.nextAtMs);
    }

    @Test
    public void aLiveCheckStillDropsAnItemCompletedElsewhere() {
        // positive control for the rule above: with the session alive, the
        // check's answer stands and a completed item is NOT announced
        List<ReminderPlan.Entry> before = Arrays.asList(e(1, NOW - 1000), e(2, NOW + H));
        List<ReminderPlan.Entry> after = Collections.singletonList(e(2, NOW + H));
        for (int outcome : new int[] { ReminderRules.OK, ReminderRules.FAILED, ReminderRefresh.NO_SESSION }) {
            List<ReminderPlan.Entry> fire = ReminderRules.entriesToFire(before, after, outcome, NOW);
            assertTrue(ReminderPlan.plan(fire, new HashMap<>(), NOW).dueNow.isEmpty());
        }
    }

    @Test
    public void aDeadSessionDoesNotResurrectAFutureItemOrDoubleAnEntry() {
        List<ReminderPlan.Entry> before = Arrays.asList(e(1, NOW - 1000), e(2, NOW + H));
        List<ReminderPlan.Entry> after = Arrays.asList(e(1, NOW - 1000), e(2, NOW + H));
        List<ReminderPlan.Entry> fire = ReminderRules.entriesToFire(before, after, ReminderRules.AUTH_DEAD, NOW);
        assertEquals(2, fire.size());
    }

    @Test
    public void anItemAlreadyAnnouncedIsNotAnnouncedAgainBecauseTheSessionDied() {
        List<ReminderPlan.Entry> before = Collections.singletonList(e(1, NOW - 1000));
        List<ReminderPlan.Entry> fire = ReminderRules.entriesToFire(before,
                Collections.<ReminderPlan.Entry>emptyList(), ReminderRules.AUTH_DEAD, NOW);
        HashMap<String, String> fired = new HashMap<>();
        fired.put("1", "m1");
        assertTrue(ReminderPlan.plan(fire, fired, NOW).dueNow.isEmpty());
    }

    // --- may Púca stay quiet? -------------------------------------------------

    private static ReminderRules.OwnerState owner(boolean token, String account, long lastSync,
                                                  boolean notif, boolean need, boolean present) {
        return new ReminderRules.OwnerState(token, account, lastSync, notif, need, present);
    }

    private static final ReminderRules.OwnerState GOOD = owner(true, "42", NOW - 30 * 60_000L, true, true, true);

    @Test
    public void signedInFreshAllowedAndArmedOwnsTheReminders() {
        assertTrue(ReminderRules.ownsDueReminders(GOOD, "42", NOW));
        // nothing owed needs no alarm
        assertTrue(ReminderRules.ownsDueReminders(owner(true, "42", NOW - H, true, false, false), "42", NOW));
    }

    @Test
    public void signedOutDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(owner(false, "42", NOW - H, true, true, true), "42", NOW));
    }

    @Test
    public void anotherAccountOrNoAccountDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(GOOD, "43", NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, null, NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, "", NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, null, NOW - H, true, true, true), "42", NOW));
    }

    @Test
    public void aFeedNotReadForMoreThanThreeHoursDoesNotOwnThem() {
        assertTrue(ReminderRules.ownsDueReminders(owner(true, "42", NOW - 3 * H, true, true, true), "42", NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW - 3 * H - 1, true, true, true), "42", NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", 0, true, true, true), "42", NOW));
    }

    @Test
    public void aSyncStampFromTheFutureIsNotTrusted() {
        assertTrue(ReminderRules.ownsDueReminders(owner(true, "42", NOW + 60_000L, true, true, true), "42", NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW + H, true, true, true), "42", NOW));
    }

    @Test
    public void notificationsOffDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW - H, false, true, true), "42", NOW));
    }

    @Test
    public void aWipedAlarmWhileSomethingIsOwedDoesNotOwnThem() {
        // a force-stop cancels the app's PendingIntents and with them its alarm
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW - H, true, true, false), "42", NOW));
    }

    @Test
    public void noStateAtAllDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(null, "42", NOW));
    }
}
