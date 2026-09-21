package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** JVM tests for the due-reminder decision core (the planReminders twin). */
public class ReminderPlanTest {

    private static final long NOW = 1_800_000_000_000L;

    private static ReminderPlan.Entry e(long id, long at, String mark) {
        return new ReminderPlan.Entry(id, at, mark, mark);
    }

    @Test
    public void firesOncePerMark() {
        List<ReminderPlan.Entry> entries = Collections.singletonList(e(1, NOW - 1000, "m1"));
        ReminderPlan.Result first = ReminderPlan.plan(entries, new HashMap<>(), NOW);
        assertEquals(Collections.singletonList(1L), first.dueNow);
        ReminderPlan.Result again = ReminderPlan.plan(entries, first.prunedFired, NOW + 60_000);
        assertTrue("the same mark must not fire twice", again.dueNow.isEmpty());
    }

    @Test
    public void refiresWhenTheMarkChanges() {
        Map<String, String> fired = new HashMap<>();
        fired.put("1", "m1");
        ReminderPlan.Result r = ReminderPlan.plan(
                Collections.singletonList(e(1, NOW - 1000, "m2")), fired, NOW);
        assertEquals("an edited due or a snooze is a new reminder", Collections.singletonList(1L), r.dueNow);
        assertEquals("m2", r.prunedFired.get("1"));
    }

    @Test
    public void prunesVanishedAndFutureIds() {
        Map<String, String> fired = new HashMap<>();
        fired.put("1", "m1");   // vanished from the feed
        fired.put("2", "old");  // now in the future again
        ReminderPlan.Result r = ReminderPlan.plan(
                Collections.singletonList(e(2, NOW + 5000, "new")), fired, NOW);
        assertTrue(r.prunedFired.isEmpty());
        assertTrue(r.dueNow.isEmpty());
    }

    @Test
    public void nextAtIsTheMinimumFutureTime() {
        List<ReminderPlan.Entry> entries = Arrays.asList(
                e(1, NOW + 90_000, "a"), e(2, NOW + 30_000, "b"), e(3, NOW - 10, "c"), e(4, NOW + 60_000, "d"));
        ReminderPlan.Result r = ReminderPlan.plan(entries, new HashMap<>(), NOW);
        assertEquals(NOW + 30_000, r.nextAtMs);
        assertEquals(Collections.singletonList(3L), r.dueNow);
    }

    @Test
    public void aPastTimeFiresOnTheNextArm() {
        // A phone that was off at the due time: the alarm is set for NOW.
        List<ReminderPlan.Entry> entries = Arrays.asList(e(1, NOW - 86_400_000L, "a"), e(2, NOW + 60_000, "b"));
        ReminderPlan.Result r = ReminderPlan.plan(entries, new HashMap<>(), NOW);
        assertEquals(NOW, ReminderPlan.alarmAt(r, NOW));
        // Once fired, the alarm moves on to the next future entry.
        ReminderPlan.Result after = ReminderPlan.plan(entries, r.prunedFired, NOW);
        assertEquals(NOW + 60_000, ReminderPlan.alarmAt(after, NOW));
    }

    @Test
    public void emptyInputMeansNoAlarm() {
        ReminderPlan.Result r = ReminderPlan.plan(Collections.emptyList(), new HashMap<>(), NOW);
        assertEquals(-1, ReminderPlan.alarmAt(r, NOW));
        assertTrue(r.dueNow.isEmpty());
    }

    @Test
    public void exactlyNowCountsAsDue() {
        ReminderPlan.Result r = ReminderPlan.plan(
                Collections.singletonList(e(1, NOW, "a")), new HashMap<>(), NOW);
        assertEquals(Collections.singletonList(1L), r.dueNow);
    }

    // --- several entries per id: a repeating item's occurrences ---------------

    private static final long DAY = 86_400_000L;

    @Test
    public void onlyTheLatestPastEntryOfAnIdCountsAndItFiresOnce() {
        // last week's occurrence (A) and today's (B) are both past; C is next week
        List<ReminderPlan.Entry> entries = Arrays.asList(
                e(1, NOW - 7 * DAY, "A"), e(1, NOW - 1000, "B"), e(1, NOW + 7 * DAY, "C"));
        ReminderPlan.Result first = ReminderPlan.plan(entries, new HashMap<>(), NOW);
        assertEquals(Collections.singletonList(1L), first.dueNow);
        assertEquals("the marker is the LATEST past occurrence", "B", first.prunedFired.get("1"));
        assertEquals(NOW + 7 * DAY, first.nextAtMs);
        // The next arm: nothing owed. With every past entry counted, A and B
        // took turns in the one marker and every arm fired the item again.
        ReminderPlan.Result again = ReminderPlan.plan(entries, first.prunedFired, NOW + 1000);
        assertTrue("occurrences of one id must not re-fire each other", again.dueNow.isEmpty());
        assertEquals(NOW + 7 * DAY, ReminderPlan.alarmAt(again, NOW + 1000));
    }

    @Test
    public void theLatestIsByTimeNotByTheOrderEntriesArrive() {
        List<ReminderPlan.Entry> entries = Arrays.asList(e(1, NOW - 1000, "B"), e(1, NOW - 7 * DAY, "A"));
        Map<String, String> fired = new HashMap<>();
        fired.put("1", "B");
        ReminderPlan.Result r = ReminderPlan.plan(entries, fired, NOW);
        assertTrue(r.dueNow.isEmpty());
        assertEquals("B", r.prunedFired.get("1"));
    }

    @Test
    public void theNextOccurrenceFiresExactlyOnceWhenItComes() {
        // Last week's reminder fired (marker A); this week's is a minute away.
        List<ReminderPlan.Entry> entries = Arrays.asList(e(1, NOW - 7 * DAY, "A"), e(1, NOW + 60_000, "B"));
        Map<String, String> fired = new HashMap<>();
        fired.put("1", "A");
        ReminderPlan.Result before = ReminderPlan.plan(entries, fired, NOW);
        assertTrue("nothing owed before it comes", before.dueNow.isEmpty());
        assertEquals(NOW + 60_000, ReminderPlan.alarmAt(before, NOW));
        ReminderPlan.Result at = ReminderPlan.plan(entries, before.prunedFired, NOW + 60_000);
        assertEquals(Collections.singletonList(1L), at.dueNow);
        ReminderPlan.Result after = ReminderPlan.plan(entries, at.prunedFired, NOW + 61_000);
        assertTrue(after.dueNow.isEmpty());
        assertEquals("no alarm left: the series is re-armed by the next sync", -1, ReminderPlan.alarmAt(after, NOW + 61_000));
    }

    @Test
    public void idsAreIndependent() {
        // positive control: the per-id rule must not swallow a different id
        List<ReminderPlan.Entry> entries = Arrays.asList(e(1, NOW - 2000, "a"), e(2, NOW - 1000, "b"));
        assertEquals(Arrays.asList(1L, 2L), ReminderPlan.plan(entries, new HashMap<>(), NOW).dueNow);
    }

    // --- which item a due notification may point at --------------------------

    @Test
    public void soleDueNamesTheOneItem() {
        List<ReminderPlan.Entry> entries = Collections.singletonList(e(1, NOW - 1000, "m1"));
        ReminderPlan.Result r = ReminderPlan.plan(entries, new HashMap<>(), NOW);
        assertEquals(Collections.singletonList(1L), r.dueNow);
        assertEquals(1L, ReminderPlan.soleDue(r));
    }

    @Test
    public void soleDueIsSilentWithSeveral() {
        // The one that matters: with two due, naming either would send the
        // user to an arbitrary note and hide the other. "The first id" would
        // pass the test above and fail this one.
        List<ReminderPlan.Entry> entries = Arrays.asList(e(1, NOW - 2000, "a"), e(2, NOW - 1000, "b"));
        ReminderPlan.Result r = ReminderPlan.plan(entries, new HashMap<>(), NOW);
        assertEquals(2, r.dueNow.size());
        assertEquals(-1L, ReminderPlan.soleDue(r));
    }

    @Test
    public void soleDueIsSilentWithNone() {
        List<ReminderPlan.Entry> entries = Collections.singletonList(e(1, NOW + 60_000, "m1"));
        assertEquals(-1L, ReminderPlan.soleDue(ReminderPlan.plan(entries, new HashMap<>(), NOW)));
        assertEquals(-1L, ReminderPlan.soleDue(null));
    }

    @Test
    public void textIsACountNeverContent() {
        assertEquals("An item is due", ReminderPlan.dueText(1));
        assertEquals("3 items are due", ReminderPlan.dueText(3));
    }
}
