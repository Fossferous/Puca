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
 * The JS side owns the EFFECTIVE time: it may know things the server cannot
 * (a sealed snooze), so what it sent is kept for any id whose server due time
 * has NOT moved. A new id, or one whose due time changed on another device,
 * starts over from the server's due_at. An id the feed no longer lists
 * (completed, deleted, access lost) is dropped — that is how an item finished
 * elsewhere stops being announced here.
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
        Map<Long, ReminderPlan.Entry> byId = new HashMap<>();
        for (ReminderPlan.Entry e : stored) byId.put(e.id, e);
        List<ReminderPlan.Entry> out = new ArrayList<>();
        for (FeedRow row : feed) {
            long ms = parseIsoMillis(row.dueAt);
            if (ms == Long.MIN_VALUE) continue; // unparseable: no alarm is better than a wrong one
            ReminderPlan.Entry prev = byId.get(row.id);
            if (prev != null && sameDue(prev, row.dueAt, ms)) {
                out.add(new ReminderPlan.Entry(prev.id, prev.atMs, prev.mark, row.dueAt));
            } else {
                out.add(new ReminderPlan.Entry(row.id, ms, row.dueAt, row.dueAt));
            }
        }
        return out;
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
