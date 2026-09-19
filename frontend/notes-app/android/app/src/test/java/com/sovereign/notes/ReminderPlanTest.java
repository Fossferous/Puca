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

    @Test
    public void textIsACountNeverContent() {
        assertEquals("An item is due", ReminderPlan.dueText(1));
        assertEquals("3 items are due", ReminderPlan.dueText(3));
    }
}
