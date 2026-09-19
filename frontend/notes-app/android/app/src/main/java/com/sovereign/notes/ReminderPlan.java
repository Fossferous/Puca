package com.sovereign.notes;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The due-reminder decision core: which items fire NOW, and when to wake next.
 *
 * Pure Java (no android.*, no org.json) so it runs under plain JUnit — the
 * JS twin is planEntries in frontend/src/api/reminderFeed.ts, and this
 * keeps its rules:
 *
 *  - an item fires once per MARK: the fired map holds id -> the mark it last
 *    fired under, and an entry whose mark differs (an edited due time, a
 *    snooze — whatever the JS side decides the mark means) fires again;
 *  - markers for items that are no longer due, or no longer in the feed at
 *    all, are pruned, so the map cannot grow without bound;
 *  - a time already in the past fires on the next arm, which is what makes a
 *    phone that was off (or dozing) at the due time still say something.
 *
 * The mark is OPAQUE here on purpose: the server's due_at, "due|snooze" while
 * a snooze is in force, or a repeating item's occurrence instant — whatever
 * the page decides (frontend/src/api/reminderFeed.ts). Keying on an opaque
 * string is what lets such a change land in JS alone, with no new APK.
 *
 * Content-free by contract: an entry is an id, a time and a mark. No title,
 * no item text — this class could not leak what it never holds.
 */
public final class ReminderPlan {

    private ReminderPlan() {}

    /** One reminder: the task id, when it fires (epoch ms, snooze included),
     *  the mark it fires under, and the server due_at it was derived from
     *  (null when the sender did not say — see ReminderMerge). */
    public static final class Entry {
        public final long id;
        public final long atMs;
        public final String mark;
        public final String due;

        public Entry(long id, long atMs, String mark, String due) {
            this.id = id;
            this.atMs = atMs;
            this.mark = mark == null ? "" : mark;
            this.due = due;
        }
    }

    public static final class Result {
        /** Ids that are due and have not fired under their current mark. */
        public final List<Long> dueNow;
        /** Epoch ms of the next FUTURE entry, or -1 when there is none. */
        public final long nextAtMs;
        /** The replacement fired map: every entry that is past due, keyed by
         *  id, with the mark it has now fired (or is now firing) under. */
        public final Map<String, String> prunedFired;

        Result(List<Long> dueNow, long nextAtMs, Map<String, String> prunedFired) {
            this.dueNow = dueNow;
            this.nextAtMs = nextAtMs;
            this.prunedFired = prunedFired;
        }
    }

    /**
     * An id may have SEVERAL entries — a repeating item's upcoming reminders,
     * which the page precomputes because this side cannot open the sealed
     * rule (frontend/src/api/reminderFeed.ts). Only its LATEST past entry
     * counts: with two past entries of one id, each would overwrite the one
     * fired marker in turn and every arm would fire the item again. The JS
     * twin (planEntries) applies the same rule.
     */
    public static Result plan(List<Entry> entries, Map<String, String> fired, long now) {
        // Insertion order kept, so dueNow follows the order entries arrived in.
        Map<Long, Entry> latestPast = new LinkedHashMap<>();
        long next = -1;
        for (Entry e : entries) {
            if (e.atMs <= now) {
                Entry cur = latestPast.get(e.id);
                if (cur == null || e.atMs > cur.atMs) latestPast.put(e.id, e);
            } else if (next < 0 || e.atMs < next) {
                next = e.atMs;
            }
        }
        List<Long> dueNow = new ArrayList<>();
        Map<String, String> pruned = new HashMap<>();
        for (Entry e : latestPast.values()) {
            String key = Long.toString(e.id);
            String prev = fired == null ? null : fired.get(key);
            if (!e.mark.equals(prev)) dueNow.add(e.id);
            pruned.put(key, e.mark);
        }
        return new Result(dueNow, next, pruned);
    }

    /**
     * When the single alarm should go off for this plan: now if something is
     * owed, else the next future time, else -1 (cancel). One alarm is enough
     * because one notification collapses everything due at once.
     */
    public static long alarmAt(Result r, long now) {
        if (!r.dueNow.isEmpty()) return now;
        return r.nextAtMs;
    }

    /** "An item is due" / "3 items are due" — a count, never content. */
    public static String dueText(int count) {
        return count == 1 ? "An item is due" : count + " items are due";
    }
}
