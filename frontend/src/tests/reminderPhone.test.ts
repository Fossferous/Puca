/**
 * L15 on the phone, JS side. A phone's reminder engine runs with Púca Notes
 * CLOSED and cannot open the sealed schedule or snooze, so:
 *  (a) a snooze moves the item's plaintext due_at to the snooze instant (when
 *      the snoozer may edit its time) — the sealed snooze keeps only the UI
 *      state — and the server, hence the phone, sees the next reminder;
 *  (b) the feed hands out a repeating item's upcoming reminders (14 days) as
 *      separate {id, at, mark, due} entries with a distinct mark each, and a
 *      planner fires only the LATEST past entry per id.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/tasks', () => ({ openReminderTiming: vi.fn(), patchTaskTiming: vi.fn() }));

import {
    MAX_ENTRIES_PER_ITEM, OCCURRENCE_HORIZON_MS, planEntries, toReminderEntries, type OpenedReminder,
} from '../api/reminderFeed';
import {
    activeSnooze, effectiveReminderMs, parseSnooze, serializeSchedule, serializeSnooze, snoozeLocked, snoozeMovedDue, snoozePatch, type EventSchedule,
} from '../api/taskSchedule';

const T = (s: string) => Date.parse(s);
const DUE = '2026-10-05T19:00:00Z';
const row = (over: Partial<OpenedReminder> = {}): OpenedReminder => ({ id: 7, channel_id: null, list_id: 3, due_at: DUE, created_by: 1, ...over });
const weekly: EventSchedule = { v: 1, kind: 'event', uid: 'uid-evt-0002', allDay: false, start: '2026-10-05T19:10', tz: 'UTC', alerts: [10], rrule: 'FREQ=WEEKLY' };

describe('(a) a snooze moves the plaintext due_at', () => {
    const until = T('2026-10-05T20:00:00Z');

    it('an editor’s snooze sends due_at = the snooze instant, CAS on the old one, and seals the pushed-back time', () => {
        const p = snoozePatch({ due_at: DUE, snooze: null }, until, true)!;
        expect(p.due_at).toBe('2026-10-05T20:00:00.000Z');
        expect(p.expect_due_at).toBe(DUE);
        expect(parseSnooze(p.snooze)).toEqual({ k: 'snooze/1', forDue: DUE, until: '2026-10-05T20:00:00.000Z' });
    });

    it('a member who may only complete: the sealed snooze alone (the server gives due_at to editors)', () => {
        const p = snoozePatch({ due_at: DUE, snooze: null }, until, false)!;
        expect(p).not.toHaveProperty('due_at');
        expect(parseSnooze(p.snooze)?.forDue).toBe(DUE);
    });

    it('the moved form reads as snoozed; a re-snooze keeps the ORIGINAL time; an unsnooze moves it back', () => {
        const moved = { due_at: '2026-10-05T20:00:00.000Z', snooze: serializeSnooze({ forDue: DUE, until: '2026-10-05T20:00:00.000Z' }) };
        const s = activeSnooze(moved.due_at, moved.snooze);
        expect(s).not.toBeNull();
        expect(snoozeMovedDue(moved.due_at, s)).toBe(true);
        expect(effectiveReminderMs(moved.due_at, moved.snooze)).toBe(until);
        const again = snoozePatch(moved, T('2026-10-06T09:00:00Z'), true)!;
        expect(parseSnooze(again.snooze)?.forDue).toBe(DUE);
        expect(again.expect_due_at).toBe(moved.due_at);
        expect(snoozePatch(moved, null, true)).toEqual({ snooze: null, due_at: DUE, expect_due_at: moved.due_at });
        // Positive controls: a stale snooze is not active; nothing to snooze without a due time.
        expect(activeSnooze('2026-10-12T19:00:00Z', moved.snooze)).toBeNull();
        expect(snoozePatch({ due_at: null }, until, true)).toBeNull();
    });

    it('a member who may only complete cannot re-snooze or unsnooze an editor’s MOVED snooze', () => {
        const moved = { due_at: '2026-10-05T20:00:00.000Z', snooze: serializeSnooze({ forDue: DUE, until: '2026-10-05T20:00:00.000Z' }) };
        expect(snoozeLocked(moved, false)).toBe(true);
        // Unsnooze: {snooze:null} alone would strand due_at at the snooze instant and lose DUE.
        expect(snoozePatch(moved, null, false)).toBeNull();
        // Re-snooze: sealed against DUE it would not match due_at (inert); against due_at it would lose DUE.
        expect(snoozePatch(moved, T('2026-10-06T09:00:00Z'), false)).toBeNull();
        // Positive controls: the editor still can; the same member can on a
        // sealed-only snooze and on an unsnoozed item.
        expect(snoozeLocked(moved, true)).toBe(false);
        expect(snoozePatch(moved, null, true)).not.toBeNull();
        const sealedOnly = { due_at: DUE, snooze: serializeSnooze({ forDue: DUE, until: '2026-10-05T20:00:00.000Z' }) };
        expect(snoozeLocked(sealedOnly, false)).toBe(false);
        expect(snoozePatch(sealedOnly, null, false)).toEqual({ snooze: null });
        const again = snoozePatch(sealedOnly, T('2026-10-06T09:00:00Z'), false)!;
        expect(parseSnooze(again.snooze)?.forDue).toBe(DUE);
        expect(snoozeLocked({ due_at: DUE, snooze: null }, false)).toBe(false);
        // A lapsed moved snooze (due_at since edited) locks nothing.
        expect(snoozeLocked({ due_at: '2026-10-12T19:00:00Z', snooze: moved.snooze }, false)).toBe(false);
    });

    it('the feed fires a moved snooze at the snooze instant, with due_at as its mark', () => {
        const due = '2026-10-05T20:00:00Z';
        const [e] = toReminderEntries([row({ due_at: due, openSnooze: serializeSnooze({ forDue: DUE, until: '2026-10-05T20:00:00.000Z' }) })], T(DUE));
        expect(e).toEqual({ id: 7, at: until, mark: due, due });
    });
});

describe('(b) a repeating item’s upcoming reminders, as separate entries', () => {
    const sched = serializeSchedule(weekly);

    it('within 14 days: the current reminder and the next ones, one id, a distinct mark each', () => {
        const now = T(DUE) - 3_600_000;
        const es = toReminderEntries([row({ openSchedule: sched })], now);
        expect(es.map(e => new Date(e.at).toISOString())).toEqual(['2026-10-05T19:00:00.000Z', '2026-10-12T19:00:00.000Z']);
        expect(es.every(e => e.id === 7 && e.due === DUE)).toBe(true);
        expect(new Set(es.map(e => e.mark)).size).toBe(es.length);
        expect(es.every(e => e.at <= now + OCCURRENCE_HORIZON_MS)).toBe(true);
    });

    it('an occurrence’s mark is exactly what the primary’s mark will be once due_at is advanced there', () => {
        const before = toReminderEntries([row({ openSchedule: sched })], T(DUE) - 3_600_000);
        // The server echoes the advance without milliseconds.
        const after = toReminderEntries([row({ openSchedule: sched, due_at: '2026-10-12T19:00:00Z' })], T('2026-10-12T19:05:00Z'));
        expect(after[0].mark).toBe(before[1].mark);
    });

    it('a busy series is capped (daily with five alerts would be 70 entries in 14 days)', () => {
        const busy = serializeSchedule({ ...weekly, kind: 'task', rrule: 'FREQ=DAILY', alerts: [0, 10, 20, 30, 60] });
        const es = toReminderEntries([row({ openSchedule: busy })], T(DUE));
        expect(es.length).toBe(MAX_ENTRIES_PER_ITEM);
    });

    it('none for a one-off, a private series, an unreadable schedule or a plain row (positive control above)', () => {
        const now = T(DUE) - 3_600_000;
        expect(toReminderEntries([row({ openSchedule: serializeSchedule({ ...weekly, rrule: undefined }) })], now)).toHaveLength(1);
        expect(toReminderEntries([row({ openSchedule: serializeSchedule({ ...weekly, privateTiming: true }) })], now)).toHaveLength(1);
        expect(toReminderEntries([row({ openSchedule: '[Unable to decrypt]' })], now)).toHaveLength(1);
        expect(toReminderEntries([row()], now)).toEqual([{ id: 7, at: T(DUE), mark: DUE, due: DUE }]);
    });

    it('a series not advanced for weeks spends its entries on NOW, not on the past', () => {
        const now = T('2026-12-01T12:00:00Z');
        const es = toReminderEntries([row({ openSchedule: sched })], now);
        expect(es.slice(1).every(e => e.at >= now - 86_400_000)).toBe(true);
        expect(es.some(e => e.at > now)).toBe(true);
    });
});

describe('planEntries with several entries per id', () => {
    it('fires only the LATEST past entry, and a second pass fires nothing (no two marks taking turns)', () => {
        const now = T('2026-10-13T00:00:00Z');
        const es = [
            { id: 7, at: T('2026-10-05T19:00:00Z'), mark: 'a' },
            { id: 7, at: T('2026-10-12T19:00:00Z'), mark: 'b' },
            { id: 7, at: T('2026-10-19T19:00:00Z'), mark: 'c' },
        ];
        const first = planEntries(es, {}, now);
        expect(first.toFire.map(e => e.mark)).toEqual(['b']);
        expect(first.prunedFired).toEqual({ 7: 'b' });
        expect(first.nextAt).toBe(T('2026-10-19T19:00:00Z'));
        const second = planEntries(es, first.prunedFired, now);
        expect(second.toFire).toEqual([]);
        expect(planEntries(es, second.prunedFired, now).toFire).toEqual([]);
        // Positive control: once the next occurrence passes it fires, once.
        const later = planEntries(es, second.prunedFired, T('2026-10-20T00:00:00Z'));
        expect(later.toFire.map(e => e.mark)).toEqual(['c']);
    });
});
