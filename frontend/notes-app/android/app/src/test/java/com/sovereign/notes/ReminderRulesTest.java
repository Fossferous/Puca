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

    @Test
    public void aDeadSessionStillAnnouncesTheOccurrenceFiringNowWhenLaterOnesStayArmed() {
        // A weekly item: last week's reminder fired, this week's is firing
        // now, next week's survives the dead-session drop. Matching the put-back
        // on the id alone saw next week's entry and announced nothing.
        long day = 86_400_000L;
        ReminderPlan.Entry lastWeek = new ReminderPlan.Entry(1, NOW - 7 * day, "w1", "d");
        ReminderPlan.Entry thisWeek = new ReminderPlan.Entry(1, NOW - 1000, "w2", "d");
        ReminderPlan.Entry nextWeek = new ReminderPlan.Entry(1, NOW + 7 * day, "w3", "d");
        List<ReminderPlan.Entry> before = Arrays.asList(lastWeek, thisWeek, nextWeek);
        List<ReminderPlan.Entry> after = ReminderMerge.dropPassed(before, NOW);
        List<ReminderPlan.Entry> fire = ReminderRules.entriesToFire(before, after, ReminderRules.AUTH_DEAD, NOW);
        HashMap<String, String> fired = new HashMap<>();
        fired.put("1", "w1");
        assertEquals(Collections.singletonList(1L), ReminderPlan.plan(fire, fired, NOW).dueNow);
    }

    // --- may Púca stay quiet? -------------------------------------------------

    private static final String SERVER = "https://chat.example.test";
    private static final long LIVE_EXP = NOW + 20 * H;
    private static final List<ReminderPlan.Entry> ARMED = Arrays.asList(
            new ReminderPlan.Entry(5, NOW - 1000, "m5", "m5"),
            new ReminderPlan.Entry(6, NOW + H, "m6", "m6"));

    private static ReminderRules.OwnerState owner(boolean token, long exp, String account, String server, long lastSync,
                                                  boolean notif, boolean need, boolean present) {
        return new ReminderRules.OwnerState(token, exp, account, server, lastSync, notif, need, present, ARMED);
    }

    private static ReminderRules.OwnerState owner(boolean token, String account, long lastSync,
                                                  boolean notif, boolean need, boolean present) {
        return owner(token, LIVE_EXP, account, SERVER, lastSync, notif, need, present);
    }

    private static ReminderRules.Ask ask(String account) {
        return new ReminderRules.Ask(account, SERVER, Collections.singletonList(new ReminderRules.Due(5, "m5")));
    }

    private static final ReminderRules.OwnerState GOOD = owner(true, "42", NOW - 30 * 60_000L, true, true, true);

    @Test
    public void signedInFreshAllowedAndArmedOwnsTheReminders() {
        assertTrue(ReminderRules.ownsDueReminders(GOOD, ask("42"), NOW));
        // nothing owed needs no alarm
        assertTrue(ReminderRules.ownsDueReminders(owner(true, "42", NOW - H, true, false, false), ask("42"), NOW));
    }

    @Test
    public void signedOutDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(owner(false, "42", NOW - H, true, true, true), ask("42"), NOW));
    }

    @Test
    public void aStoredTokenPastItsExpiryDoesNotOwnThem() {
        // The 30-day cap, or any lapse between job runs: hasToken is still
        // true until the job next runs and sees the 401, but this token can
        // fetch nothing, so an item created elsewhere would reach no one.
        assertFalse(ReminderRules.ownsDueReminders(owner(true, NOW - 1, "42", SERVER, NOW - 60_000L, true, true, true), ask("42"), NOW));
        assertFalse("about to lapse", ReminderRules.ownsDueReminders(
                owner(true, NOW + ReminderRules.TOKEN_MARGIN_MS, "42", SERVER, NOW - 60_000L, true, true, true), ask("42"), NOW));
        assertFalse("unreadable exp", ReminderRules.ownsDueReminders(owner(true, -1, "42", SERVER, NOW - 60_000L, true, true, true), ask("42"), NOW));
        // control: just outside the margin still owns them
        assertTrue(ReminderRules.ownsDueReminders(
                owner(true, NOW + ReminderRules.TOKEN_MARGIN_MS + 1, "42", SERVER, NOW - 60_000L, true, true, true), ask("42"), NOW));
    }

    @Test
    public void anotherAccountOrNoAccountDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(GOOD, ask("43"), NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, ask(null), NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, ask(""), NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, null, NOW - H, true, true, true), ask("42"), NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, null, NOW));
    }

    @Test
    public void theSameUserIdOnAnotherServerIsSomeoneElse() {
        ReminderRules.Due d = new ReminderRules.Due(5, "m5");
        assertFalse(ReminderRules.ownsDueReminders(GOOD,
                new ReminderRules.Ask("42", "https://other.example.test", Collections.singletonList(d)), NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, new ReminderRules.Ask("42", null, Collections.singletonList(d)), NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, LIVE_EXP, "42", null, NOW - H, true, true, true), ask("42"), NOW));
        // the same base written with a trailing slash or other letter case is the same server
        assertTrue(ReminderRules.ownsDueReminders(GOOD,
                new ReminderRules.Ask("42", "HTTPS://Chat.Example.Test/", Collections.singletonList(d)), NOW));
    }

    @Test
    public void anItemNotArmedHereUnderTheSameMarkIsNotOwned() {
        ReminderRules.Due armed = new ReminderRules.Due(5, "m5");
        assertTrue(ReminderRules.ownsDueReminders(GOOD, new ReminderRules.Ask("42", SERVER,
                Arrays.asList(armed, new ReminderRules.Due(6, "m6"))), NOW));
        // created elsewhere after Notes' last look: not in the store
        assertFalse(ReminderRules.ownsDueReminders(GOOD, new ReminderRules.Ask("42", SERVER,
                Arrays.asList(armed, new ReminderRules.Due(7, "m7"))), NOW));
        // re-timed elsewhere: the id is there, the reminder is not
        assertFalse(ReminderRules.ownsDueReminders(GOOD, new ReminderRules.Ask("42", SERVER,
                Collections.singletonList(new ReminderRules.Due(5, "moved"))), NOW));
        // nothing named: Notes cannot vouch for it
        assertFalse(ReminderRules.ownsDueReminders(GOOD, new ReminderRules.Ask("42", SERVER,
                Collections.<ReminderRules.Due>emptyList()), NOW));
        assertFalse(ReminderRules.ownsDueReminders(GOOD, new ReminderRules.Ask("42", SERVER, null), NOW));
    }

    @Test
    public void theDueParameterParsesOrIsRefused() {
        List<ReminderRules.Due> d = ReminderRules.parseDue("[{\"id\":5,\"mark\":\"2026-09-19T10:00:00Z\"}]");
        assertEquals(1, d.size());
        assertEquals(5L, d.get(0).id);
        assertEquals("2026-09-19T10:00:00Z", d.get(0).mark);
        assertTrue(ReminderRules.parseDue("[]").isEmpty());
        for (String bad : new String[] { null, "", "nope", "{}", "[{\"id\":5}]", "[{\"id\":5,\"mark\":null}]" }) {
            assertEquals("refused: " + bad, null, ReminderRules.parseDue(bad));
        }
    }

    @Test
    public void aFeedNotReadForMoreThanThreeHoursDoesNotOwnThem() {
        assertTrue(ReminderRules.ownsDueReminders(owner(true, "42", NOW - 3 * H, true, true, true), ask("42"), NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW - 3 * H - 1, true, true, true), ask("42"), NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", 0, true, true, true), ask("42"), NOW));
    }

    @Test
    public void aSyncStampFromTheFutureIsNotTrusted() {
        assertTrue(ReminderRules.ownsDueReminders(owner(true, "42", NOW + 60_000L, true, true, true), ask("42"), NOW));
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW + H, true, true, true), ask("42"), NOW));
    }

    @Test
    public void notificationsOffDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW - H, false, true, true), ask("42"), NOW));
    }

    @Test
    public void aWipedAlarmWhileSomethingIsOwedDoesNotOwnThem() {
        // a force-stop cancels the app's PendingIntents and with them its alarm
        assertFalse(ReminderRules.ownsDueReminders(owner(true, "42", NOW - H, true, true, false), ask("42"), NOW));
    }

    @Test
    public void noStateAtAllDoesNotOwnThem() {
        assertFalse(ReminderRules.ownsDueReminders(null, ask("42"), NOW));
    }

    @Test
    public void aStateWithNoEntryListDoesNotOwnThem() {
        // Unreachable through the provider (the store always hands over a
        // list), but the rule is the tested unit: unknown is no, never a throw.
        ReminderRules.OwnerState s = new ReminderRules.OwnerState(true, LIVE_EXP, "42", SERVER,
                NOW - 30 * 60_000L, true, true, true, null);
        assertFalse(ReminderRules.ownsDueReminders(s, ask("42"), NOW));
    }
}
