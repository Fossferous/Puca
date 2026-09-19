package com.sovereign.notes;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

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

    @Test
    public void nullMarkBecomesEmptyAndDueStaysNull() {
        ReminderPlan.Entry e = new ReminderPlan.Entry(1, 5, null, null);
        assertEquals("", e.mark);
        assertNull(e.due);
    }
}
