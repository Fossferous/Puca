package com.sovereign.notes;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Folding a freshly fetched GET /task-reminders feed into the entries the app
 * last handed over — the background refresh's decision core. No android.*
 * (org.json is on the unit-test classpath, as for Púca's PushFrames), so it
 * runs under plain JUnit.
 *
 * The JS side owns the EFFECTIVE times: it can open what the server cannot (a
 * sealed snooze, a repeating item's sealed rule), and it hands over SEVERAL
 * entries for one id when the item repeats — its reminders in the next 14
 * days, precomputed because this side cannot read the rule
 * (frontend/src/api/reminderFeed.ts). So, per id in the feed:
 *
 *  - server due_at UNCHANGED: every stored entry of that id is kept as it
 *    was (times and marks), so no future occurrence is lost to an hourly
 *    refresh;
 *  - due_at moved to one of the id's own stored reminder instants: the series
 *    was advanced on another device (the reminder loop moves a fired event
 *    on to its next reminder). The entries from that instant on are kept,
 *    with their marks, so the one this phone may already have fired does not
 *    fire again, and the rest of the series stays armed;
 *  - any other move (an edit, a snooze on another device) or a new id:
 *    everything stored for it is dropped and it starts over from the
 *    server's due_at — marked the way the page would mark it (see
 *    {@link #freshMark}).
 *
 * An id the feed no longer lists (completed, deleted, access lost) is
 * dropped with all its entries — that is how an item finished elsewhere
 * stops being announced here.
 */
public final class ReminderMerge {

    private ReminderMerge() {}

    /** One row of the server feed: `{id, due_at}` (other fields ignored). */
    public static final class FeedRow {
        public final long id;
        public final String dueAt;

        public FeedRow(long id, String dueAt) {
            this.id = id;
            this.dueAt = dueAt;
        }
    }

    public static List<ReminderPlan.Entry> merge(List<ReminderPlan.Entry> stored, List<FeedRow> feed) {
        Map<Long, List<ReminderPlan.Entry>> byId = new HashMap<>();
        for (ReminderPlan.Entry e : stored) {
            List<ReminderPlan.Entry> l = byId.get(e.id);
            if (l == null) {
                l = new ArrayList<>();
                byId.put(e.id, l);
            }
            l.add(e);
        }
        List<ReminderPlan.Entry> out = new ArrayList<>();
        for (FeedRow row : feed) {
            long ms = parseIsoMillis(row.dueAt);
            if (ms == Long.MIN_VALUE) continue; // unparseable: no alarm is better than a wrong one
            List<ReminderPlan.Entry> prev = byId.get(row.id);
            List<ReminderPlan.Entry> kept = keep(prev, row.dueAt, ms);
            if (kept.isEmpty()) {
                out.add(new ReminderPlan.Entry(row.id, ms, freshMark(prev, row.dueAt, ms), row.dueAt));
            } else {
                out.addAll(kept);
            }
        }
        return out;
    }

    /** The stored entries of one id that survive a feed row saying `dueAt`
     *  (see the class comment), re-stamped with that due so the next refresh
     *  reads them as unchanged. Empty = start over. */
    static List<ReminderPlan.Entry> keep(List<ReminderPlan.Entry> prev, String dueAt, long dueMs) {
        List<ReminderPlan.Entry> out = new ArrayList<>();
        if (prev == null || prev.isEmpty()) return out;
        for (ReminderPlan.Entry e : prev) {
            if (sameDue(e, dueAt, dueMs)) out.add(new ReminderPlan.Entry(e.id, e.atMs, e.mark, dueAt));
        }
        if (!out.isEmpty()) return out;
        boolean advancedAlongSeries = false;
        for (ReminderPlan.Entry e : prev) {
            if (e.atMs == dueMs && e.mark.equals(isoMillis(e.atMs))) advancedAlongSeries = true;
        }
        if (!advancedAlongSeries) return out;
        for (ReminderPlan.Entry e : prev) {
            if (e.atMs >= dueMs) out.add(new ReminderPlan.Entry(e.id, e.atMs, e.mark, dueAt));
        }
        return out;
    }

    /**
     * The mark for an entry started over from the server's due_at. The page
     * marks a plain item with the raw due_at string, but a REPEATING one with
     * the canonical ISO instant ("…T10:00:00.000Z"), which the server's own
     * shape ("…T10:00:00Z") does not match. A different string is a new
     * reminder, so guessing wrong fires the item twice once the page next
     * syncs. An id is known to repeat when any stored entry of it carries
     * the canonical ISO of its own time — that is only ever an occurrence
     * mark.
     */
    static String freshMark(List<ReminderPlan.Entry> prev, String dueAt, long dueMs) {
        if (prev != null) {
            for (ReminderPlan.Entry e : prev) {
                if (e.mark.equals(isoMillis(e.atMs))) return isoMillis(dueMs);
            }
        }
        return dueAt;
    }

    /** Epoch ms → "yyyy-MM-ddTHH:mm:ss.SSSZ", exactly JS's toISOString()
     *  (the shape of a repeating item's marks). Hand-rolled like the parser:
     *  no java.time below API 26. */
    public static String isoMillis(long ms) {
        long days = Math.floorDiv(ms, 86_400_000L);
        long rem = ms - days * 86_400_000L;
        long[] ymd = civilFromDays(days);
        long h = rem / 3_600_000L;
        long mi = (rem / 60_000L) % 60;
        long se = (rem / 1000L) % 60;
        long frac = rem % 1000L;
        return String.format(java.util.Locale.ROOT, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                ymd[0], ymd[1], ymd[2], h, mi, se, frac);
    }

    /** Has the server's due time for this entry stayed where it was? An entry
     *  handed over without its due (a JS side that did not send it) falls back
     *  to its mark, which IS the due_at until something like a snooze exists. */
    static boolean sameDue(ReminderPlan.Entry prev, String dueAt, long dueMs) {
        String prevDue = prev.due != null ? prev.due : prev.mark;
        if (prevDue == null) return false;
        if (prevDue.equals(dueAt)) return true;
        long prevMs = parseIsoMillis(prevDue);
        return prevMs != Long.MIN_VALUE && prevMs == dueMs;
    }

    /** Keep only entries still in the future: what a dead session leaves armed.
     *  Anything already due could be done by now, and nothing can check. */
    public static List<ReminderPlan.Entry> dropPassed(List<ReminderPlan.Entry> entries, long now) {
        List<ReminderPlan.Entry> out = new ArrayList<>();
        for (ReminderPlan.Entry e : entries) {
            if (e.atMs > now) out.add(e);
        }
        return out;
    }

    /**
     * Parse the feed body. THROWS on anything that is not an array of rows —
     * a proxy's HTML error page or a truncated body must be a failed refresh,
     * never an empty feed, or one bad response would silently cancel every
     * reminder on the phone.
     */
    public static List<FeedRow> parseFeed(String body) throws JSONException {
        JSONArray arr = new JSONArray(body);
        List<FeedRow> out = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject o = arr.getJSONObject(i);
            if (!o.has("id") || !o.has("due_at") || o.isNull("due_at")) continue;
            out.add(new FeedRow(o.getLong("id"), o.getString("due_at")));
        }
        return out;
    }

    /**
     * ISO-8601 → epoch ms, for the shapes the server emits
     * ("2026-09-19T10:00:00Z", "…:00.123456Z", "…+01:00"). Long.MIN_VALUE when
     * it is none of them. Hand-rolled because java.time needs API 26 and this
     * app's floor is 24.
     */
    public static long parseIsoMillis(String s) {
        if (s == null) return Long.MIN_VALUE;
        try {
            if (s.length() < 19 || s.charAt(4) != '-' || s.charAt(7) != '-'
                    || (s.charAt(10) != 'T' && s.charAt(10) != ' ')
                    || s.charAt(13) != ':' || s.charAt(16) != ':') {
                return Long.MIN_VALUE;
            }
            int y = Integer.parseInt(s.substring(0, 4));
            int mo = Integer.parseInt(s.substring(5, 7));
            int d = Integer.parseInt(s.substring(8, 10));
            int h = Integer.parseInt(s.substring(11, 13));
            int mi = Integer.parseInt(s.substring(14, 16));
            int se = Integer.parseInt(s.substring(17, 19));
            if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 60) return Long.MIN_VALUE;
            int i = 19;
            long frac = 0;
            if (i < s.length() && s.charAt(i) == '.') {
                i++;
                int digits = 0;
                while (i < s.length() && Character.isDigit(s.charAt(i))) {
                    if (digits < 3) frac = frac * 10 + (s.charAt(i) - '0');
                    digits++;
                    i++;
                }
                if (digits == 0) return Long.MIN_VALUE;
                for (int k = digits; k < 3; k++) frac *= 10;
            }
            long offsetMs;
            if (i < s.length() && (s.charAt(i) == 'Z' || s.charAt(i) == 'z')) {
                offsetMs = 0;
                i++;
            } else if (i < s.length() && (s.charAt(i) == '+' || s.charAt(i) == '-')) {
                int sign = s.charAt(i) == '-' ? -1 : 1;
                String rest = s.substring(i + 1).replace(":", "");
                if (rest.length() != 4) return Long.MIN_VALUE;
                int oh = Integer.parseInt(rest.substring(0, 2));
                int om = Integer.parseInt(rest.substring(2, 4));
                offsetMs = sign * ((oh * 60L + om) * 60_000L);
                i = s.length();
            } else {
                return Long.MIN_VALUE; // no zone: the server always says UTC
            }
            if (i != s.length()) return Long.MIN_VALUE;
            long days = daysFromCivil(y, mo, d);
            long ms = ((days * 24 + h) * 60 + mi) * 60_000L + se * 1000L + frac;
            return ms - offsetMs;
        } catch (NumberFormatException | IndexOutOfBoundsException e) {
            return Long.MIN_VALUE;
        }
    }

    /** The inverse of {@link #daysFromCivil}: {year, month, day} (H. Hinnant). */
    static long[] civilFromDays(long z) {
        z += 719468;
        long era = (z >= 0 ? z : z - 146096) / 146097;
        long doe = z - era * 146097;
        long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        long y = yoe + era * 400;
        long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        long mp = (5 * doy + 2) / 153;
        long d = doy - (153 * mp + 2) / 5 + 1;
        long m = mp + (mp < 10 ? 3 : -9);
        return new long[] { m <= 2 ? y + 1 : y, m, d };
    }

    /** Days since 1970-01-01 for a proleptic Gregorian date (H. Hinnant). */
    static long daysFromCivil(long y, long m, long d) {
        y -= m <= 2 ? 1 : 0;
        long era = (y >= 0 ? y : y - 399) / 400;
        long yoe = y - era * 400;
        long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
        long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146097 + doe - 719468;
    }
}
