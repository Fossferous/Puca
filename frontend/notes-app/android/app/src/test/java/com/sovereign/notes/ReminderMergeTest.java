package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** JVM tests for folding a background-fetched feed into the stored entries. */
public class ReminderMergeTest {

    private static final String DUE = "2026-09-19T10:00:00Z";
    private static final long DUE_MS = 1_789_812_000_000L; // 2026-09-19T10:00:00Z

    @Test
    public void isoParsingMatchesTheServerShapes() {
        assertEquals(DUE_MS, ReminderMerge.parseIsoMillis(DUE));
        assertEquals(DUE_MS + 123, ReminderMerge.parseIsoMillis("2026-09-19T10:00:00.123456Z"));
        assertEquals(DUE_MS, ReminderMerge.parseIsoMillis("2026-09-19T11:00:00+01:00"));
        assertEquals(DUE_MS, ReminderMerge.parseIsoMillis("2026-09-19T08:30:00-01:30"));
        assertEquals(0L, ReminderMerge.parseIsoMillis("1970-01-01T00:00:00Z"));
        assertEquals(951_782_400_000L, ReminderMerge.parseIsoMillis("2000-02-29T00:00:00Z"));
        assertEquals(Long.MIN_VALUE, ReminderMerge.parseIsoMillis("2026-09-19T10:00:00"));
        assertEquals(Long.MIN_VALUE, ReminderMerge.parseIsoMillis("tomorrow"));
        assertEquals(Long.MIN_VALUE, ReminderMerge.parseIsoMillis(null));
        assertEquals(Long.MIN_VALUE, ReminderMerge.parseIsoMillis("2026-13-19T10:00:00Z"));
    }

    @Test
    public void anUnchangedDueKeepsTheAppsTimeAndMark() {
        // The page snoozed item 1 by an hour: its own at + mark must survive.
        ReminderPlan.Entry snoozed = new ReminderPlan.Entry(1, DUE_MS + 3_600_000L, DUE + "|snz", DUE);
        List<ReminderPlan.Entry> out = ReminderMerge.merge(
                Collections.singletonList(snoozed),
                Collections.singletonList(new ReminderMerge.FeedRow(1, DUE)));
        assertEquals(1, out.size());
        assertEquals(DUE_MS + 3_600_000L, out.get(0).atMs);
        assertEquals(DUE + "|snz", out.get(0).mark);
    }

    @Test
    public void anUnchangedDueWrittenDifferentlyStillCounts() {
        ReminderPlan.Entry prev = new ReminderPlan.Entry(1, DUE_MS + 5, "keep", "2026-09-19T10:00:00.000Z");
        List<ReminderPlan.Entry> out = ReminderMerge.merge(
                Collections.singletonList(prev),
                Collections.singletonList(new ReminderMerge.FeedRow(1, DUE)));
        assertEquals("keep", out.get(0).mark);
    }

    @Test
    public void aChangedDueResetsToTheServersTime() {
        ReminderPlan.Entry prev = new ReminderPlan.Entry(1, DUE_MS + 3_600_000L, DUE + "|snz", DUE);
        String moved = "2026-09-20T10:00:00Z";
        List<ReminderPlan.Entry> out = ReminderMerge.merge(
                Collections.singletonList(prev),
                Collections.singletonList(new ReminderMerge.FeedRow(1, moved)));
        assertEquals(DUE_MS + 86_400_000L, out.get(0).atMs);
        assertEquals(moved, out.get(0).mark);
        assertEquals(moved, out.get(0).due);
    }

    @Test
    public void anEntryWithoutDueFallsBackToItsMark() {
        ReminderPlan.Entry prev = new ReminderPlan.Entry(1, DUE_MS, DUE, null);
        List<ReminderPlan.Entry> out = ReminderMerge.merge(
                Collections.singletonList(prev),
                Collections.singletonList(new ReminderMerge.FeedRow(1, DUE)));
        assertEquals(DUE, out.get(0).mark);
        assertEquals(DUE, out.get(0).due);
    }

    @Test
    public void newIdsAreAddedAndVanishedIdsDropped() {
        ReminderPlan.Entry gone = new ReminderPlan.Entry(9, DUE_MS, DUE, DUE);
        List<ReminderPlan.Entry> out = ReminderMerge.merge(
                Collections.singletonList(gone),
                Collections.singletonList(new ReminderMerge.FeedRow(2, DUE)));
        assertEquals(1, out.size());
        assertEquals(2L, out.get(0).id);
        assertEquals(DUE_MS, out.get(0).atMs);
    }

    @Test
    public void unparseableRowsAreSkippedNotGuessed() {
        List<ReminderPlan.Entry> out = ReminderMerge.merge(
                Collections.emptyList(),
                Arrays.asList(new ReminderMerge.FeedRow(1, "garbage"), new ReminderMerge.FeedRow(2, DUE)));
        assertEquals(1, out.size());
        assertEquals(2L, out.get(0).id);
    }

    @Test
    public void theDeadSessionPathDropsOnlyPassedEntries() {
        List<ReminderPlan.Entry> out = ReminderMerge.dropPassed(Arrays.asList(
                new ReminderPlan.Entry(1, 100, "a", null),
                new ReminderPlan.Entry(2, 200, "b", null),
                new ReminderPlan.Entry(3, 300, "c", null)), 200);
        assertEquals(1, out.size());
        assertEquals(3L, out.get(0).id);
    }

    @Test
    public void parseFeedReadsRows() throws Exception {
        List<ReminderMerge.FeedRow> rows = ReminderMerge.parseFeed(
                "[{\"id\":5,\"channel_id\":null,\"list_id\":3,\"due_at\":\"" + DUE + "\"},{\"id\":6,\"due_at\":null}]");
        assertEquals(1, rows.size());
        assertEquals(5L, rows.get(0).id);
        assertEquals(DUE, rows.get(0).dueAt);
        assertTrue(ReminderMerge.parseFeed("[]").isEmpty());
    }

    @Test
    public void aBodyThatIsNotAFeedIsAnErrorNotAnEmptyFeed() {
        for (String bad : new String[] { "<html>502</html>", "{\"error\":\"x\"}", "[{\"id\":1,\"due_at\":\"" }) {
            try {
                ReminderMerge.parseFeed(bad);
                fail("parsed a non-feed as a feed: " + bad);
            } catch (Exception expected) {
                // the refresh treats this as FAILED and keeps every entry
            }
        }
    }

    // --- a repeating item: several entries per id ------------------------------

    private static final long DAY = 86_400_000L;

    /** What the page hands over for a weekly item due at DUE: its reminder
     *  and the next two, each marked with its own canonical ISO instant. */
    private static List<ReminderPlan.Entry> weekly(String due) {
        return Arrays.asList(
                new ReminderPlan.Entry(1, DUE_MS, ReminderMerge.isoMillis(DUE_MS), due),
                new ReminderPlan.Entry(1, DUE_MS + 7 * DAY, ReminderMerge.isoMillis(DUE_MS + 7 * DAY), due),
                new ReminderPlan.Entry(1, DUE_MS + 14 * DAY, ReminderMerge.isoMillis(DUE_MS + 14 * DAY), due));
    }

    private static void assertSameEntries(List<ReminderPlan.Entry> want, List<ReminderPlan.Entry> got) {
        assertEquals(want.size(), got.size());
        for (int i = 0; i < want.size(); i++) {
            assertEquals(want.get(i).id, got.get(i).id);
            assertEquals(want.get(i).atMs, got.get(i).atMs);
            assertEquals(want.get(i).mark, got.get(i).mark);
        }
    }

    @Test
    public void anUnchangedDueKeepsEveryEntryOfTheId() {
        List<ReminderPlan.Entry> stored = weekly(DUE);
        List<ReminderPlan.Entry> once = ReminderMerge.merge(stored,
                Collections.singletonList(new ReminderMerge.FeedRow(1, DUE)));
        assertSameEntries(stored, once);
        // ...and hour after hour: a refresh never loses a future occurrence
        List<ReminderPlan.Entry> twice = ReminderMerge.merge(once,
                Collections.singletonList(new ReminderMerge.FeedRow(1, DUE)));
        assertSameEntries(stored, twice);
    }

    @Test
    public void everyEntryOfAnIdGoesWhenTheIdLeavesTheFeed() {
        List<ReminderPlan.Entry> out = ReminderMerge.merge(weekly(DUE),
                Collections.singletonList(new ReminderMerge.FeedRow(2, DUE)));
        assertEquals(1, out.size());
        assertEquals(2L, out.get(0).id);
    }

    @Test
    public void aDueMovedElsewhereDropsTheOccurrencesAndStartsOver() {
        // Edited on another device to an hour later: the old series times are
        // no longer known to be right.
        String moved = "2026-09-19T11:00:00Z";
        List<ReminderPlan.Entry> out = ReminderMerge.merge(weekly(DUE),
                Collections.singletonList(new ReminderMerge.FeedRow(1, moved)));
        assertEquals(1, out.size());
        assertEquals(DUE_MS + 3_600_000L, out.get(0).atMs);
        assertEquals(moved, out.get(0).due);
        // marked as the page marks a repeating item, so its next sync does
        // not see a new reminder and fire it twice
        assertEquals("2026-09-19T11:00:00.000Z", out.get(0).mark);
    }

    @Test
    public void aPlainItemStartedOverKeepsTheRawDueAsItsMark() {
        // positive control for the ISO rule: nothing says this item repeats
        ReminderPlan.Entry plain = new ReminderPlan.Entry(1, DUE_MS, DUE, DUE);
        String moved = "2026-09-19T11:00:00Z";
        List<ReminderPlan.Entry> out = ReminderMerge.merge(Collections.singletonList(plain),
                Collections.singletonList(new ReminderMerge.FeedRow(1, moved)));
        assertEquals(moved, out.get(0).mark);
    }

    @Test
    public void advancedAlongItsSeriesOnAnotherDeviceKeepsTheRestOfTheSeries() {
        // The reminder loop elsewhere moved due_at on to next week's reminder,
        // which the page had already handed over as an occurrence.
        String nextWeek = "2026-09-26T10:00:00Z";
        List<ReminderPlan.Entry> out = ReminderMerge.merge(weekly(DUE),
                Collections.singletonList(new ReminderMerge.FeedRow(1, nextWeek)));
        assertEquals(2, out.size());
        assertEquals(DUE_MS + 7 * DAY, out.get(0).atMs);
        assertEquals("the mark it may already have fired under", ReminderMerge.isoMillis(DUE_MS + 7 * DAY), out.get(0).mark);
        assertEquals(DUE_MS + 14 * DAY, out.get(1).atMs);
        assertEquals(nextWeek, out.get(0).due);
        // and the next refresh reads that as unchanged
        assertEquals(2, ReminderMerge.merge(out,
                Collections.singletonList(new ReminderMerge.FeedRow(1, nextWeek))).size());
    }

    @Test
    public void aFiredOccurrenceDoesNotFireAgainWhenTheAdvanceLands() {
        // The phone fired next week's reminder while Notes was closed; then
        // another device advanced due_at to it. One alert, not two.
        long at = DUE_MS + 7 * DAY;
        java.util.Map<String, String> fired = new java.util.HashMap<>();
        fired.put("1", ReminderMerge.isoMillis(at));
        List<ReminderPlan.Entry> out = ReminderMerge.merge(weekly(DUE),
                Collections.singletonList(new ReminderMerge.FeedRow(1, "2026-09-26T10:00:00Z")));
        assertTrue(ReminderPlan.plan(out, fired, at + 60_000).dueNow.isEmpty());
    }

    @Test
    public void isoMillisIsTheShapeOfJavaScriptToIsoString() {
        assertEquals("2026-09-19T10:00:00.000Z", ReminderMerge.isoMillis(DUE_MS));
        assertEquals("2026-09-19T10:00:00.123Z", ReminderMerge.isoMillis(DUE_MS + 123));
        assertEquals("1970-01-01T00:00:00.000Z", ReminderMerge.isoMillis(0));
        assertEquals("2000-02-29T00:00:00.000Z", ReminderMerge.isoMillis(951_782_400_000L));
        assertEquals("1969-12-31T23:59:59.999Z", ReminderMerge.isoMillis(-1));
        for (long ms : new long[] { DUE_MS, DUE_MS + 7 * DAY + 59_999, 4_102_444_800_000L }) {
            assertEquals(ms, ReminderMerge.parseIsoMillis(ReminderMerge.isoMillis(ms)));
        }
    }

    /**
     * A NOTE'S OWN reminder (migration 068) rides the same feed under the
     * NEGATIVE id -list_id. This test is why that design needs no new APK:
     * every id here is an opaque long key, so -5 and 5 are two reminders and
     * neither can silence the other. If it ever goes red, a note reminder is
     * cancelling an item reminder (or the reverse) on every phone.
     */
    @Test
    public void aNegativeNoteIdIsADifferentReminderFromTheTaskWithTheSameNumber() throws Exception {
        String later = "2026-09-19T11:00:00Z";
        List<ReminderMerge.FeedRow> feed = ReminderMerge.parseFeed(
                "[{\"id\":-5,\"due_at\":\"" + DUE + "\",\"list_id\":5,\"is_list\":true},"
                        + "{\"id\":5,\"due_at\":\"" + later + "\"}]");
        assertEquals(2, feed.size());
        assertEquals(-5L, feed.get(0).id);
        assertEquals(5L, feed.get(1).id);

        // The merge keeps both, each with its own time.
        List<ReminderPlan.Entry> merged = ReminderMerge.merge(Collections.<ReminderPlan.Entry>emptyList(), feed);
        assertEquals(2, merged.size());
        Map<Long, Long> at = new HashMap<>();
        for (ReminderPlan.Entry e : merged) at.put(e.id, e.atMs);
        assertEquals(Long.valueOf(DUE_MS), at.get(-5L));
        assertEquals(Long.valueOf(DUE_MS + 3_600_000L), at.get(5L));

        // Both fire, under their own marks.
        long now = DUE_MS + 2 * 3_600_000L;
        ReminderPlan.Result first = ReminderPlan.plan(merged, new HashMap<String, String>(), now);
        assertEquals(2, first.dueNow.size());
        assertTrue(first.dueNow.contains(-5L));
        assertTrue(first.dueNow.contains(5L));
        assertEquals(2, first.prunedFired.size());
        assertTrue(first.prunedFired.containsKey("-5"));
        assertTrue(first.prunedFired.containsKey("5"));

        // Having fired the NOTE, the item with the same number still fires.
        Map<String, String> firedNoteOnly = new HashMap<>();
        firedNoteOnly.put("-5", first.prunedFired.get("-5"));
        assertEquals(Collections.singletonList(5L), ReminderPlan.plan(merged, firedNoteOnly, now).dueNow);

        // ...and the other way round.
        Map<String, String> firedTaskOnly = new HashMap<>();
        firedTaskOnly.put("5", first.prunedFired.get("5"));
        assertEquals(Collections.singletonList(-5L), ReminderPlan.plan(merged, firedTaskOnly, now).dueNow);

        // Positive control: with BOTH marks present nothing fires again.
        assertTrue(ReminderPlan.plan(merged, first.prunedFired, now).dueNow.isEmpty());
    }

    @Test
    public void nullMarkBecomesEmptyAndDueStaysNull() {
        ReminderPlan.Entry e = new ReminderPlan.Entry(1, 5, null, null);
        assertEquals("", e.mark);
        assertNull(e.due);
    }
}
