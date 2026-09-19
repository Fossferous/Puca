import { beforeEach, describe, expect, it, vi } from 'vitest';

const openReminderTiming = vi.fn();
const patchTaskTiming = vi.fn();
vi.mock('../api/tasks', () => ({
    openReminderTiming: (...a: unknown[]) => openReminderTiming(...a),
    patchTaskTiming: (...a: unknown[]) => patchTaskTiming(...a),
}));

import {
    ADVANCE_GRACE_MS, applyAdvances, openReminderFeed, planAdvances, planEntries, reminderMark, toReminderEntries,
    type OpenedReminder,
} from '../api/reminderFeed';
import { serializeSchedule, serializeSnooze, type EventSchedule } from '../api/taskSchedule';
import { ApiError } from '../api/client';

const T = (s: string) => Date.parse(s);
const due = '2026-10-05T19:00:00Z';
const row = (over: Partial<OpenedReminder> = {}): OpenedReminder => ({ id: 7, channel_id: null, list_id: 3, due_at: due, created_by: 1, ...over });
const event: EventSchedule = { v: 1, kind: 'event', uid: 'uid-evt-0001', allDay: false, start: '2026-10-05T15:10', tz: 'America/New_York', alerts: [10], rrule: 'FREQ=WEEKLY' };

beforeEach(() => { openReminderTiming.mockReset(); patchTaskTiming.mockReset(); });

describe('the {id, at, mark} contract', () => {
    it('an unsnoozed row: at = due_at, mark = due_at (so pre-snooze fired markers stay valid)', () => {
        expect(toReminderEntries([row()])).toEqual([{ id: 7, at: T(due), mark: due, due }]);
    });

    it('a snooze in force moves `at` and changes the mark', () => {
        const until = '2026-10-05T20:00:00.000Z';
        const [e] = toReminderEntries([row({ openSnooze: serializeSnooze({ forDue: due, until }) })]);
        expect(e).toEqual({ id: 7, at: T(until), mark: reminderMark(due, until), due });
        expect(e.mark).not.toBe(due);
    });

    it('a stale snooze (taken against an older due_at) is ignored', () => {
        const stale = serializeSnooze({ forDue: '2026-09-28T19:00:00.000Z', until: '2026-09-28T20:00:00.000Z' });
        expect(toReminderEntries([row({ openSnooze: stale })])).toEqual([{ id: 7, at: T(due), mark: due, due }]);
    });

    it('fire once per mark; a new snooze time fires again', () => {
        const now = T('2026-10-05T21:00:00Z');
        const first = planEntries([{ id: 7, at: T(due), mark: due }], {}, now);
        expect(first.toFire).toHaveLength(1);
        expect(planEntries([{ id: 7, at: T(due), mark: due }], first.prunedFired, now).toFire).toHaveLength(0);
        const snoozed = { id: 7, at: T('2026-10-05T20:30:00Z'), mark: `${due}|2026-10-05T20:30:00.000Z` };
        expect(planEntries([snoozed], first.prunedFired, now).toFire).toHaveLength(1);
        // Positive control for the "not yet": a future entry arms, never fires.
        const later = planEntries([{ id: 8, at: now + 5000, mark: 'x' }], {}, now);
        expect(later.toFire).toHaveLength(0);
        expect(later.nextAt).toBe(now + 5000);
    });
});

describe('opening the feed fails OPEN', () => {
    it('a row whose timing cannot be opened keeps its plain due_at', async () => {
        openReminderTiming.mockRejectedValueOnce(new Error('no key'));
        const [r] = await openReminderFeed([row({ snooze: '{"v":2,"t":"self","ct":"x"}' })]);
        expect(toReminderEntries([r])).toEqual([{ id: 7, at: T(due), mark: due, due }]);
    });

    it('a row from an older server is not opened at all', async () => {
        await openReminderFeed([row()]);
        expect(openReminderTiming).not.toHaveBeenCalled();
    });

    it('an opened snooze is used', async () => {
        const until = '2026-10-05T19:30:00.000Z';
        openReminderTiming.mockResolvedValueOnce({ snooze: serializeSnooze({ forDue: due, until }), schedule: null });
        const [r] = await openReminderFeed([row({ snooze: 'sealed', schedule: null })]);
        expect(toReminderEntries([r])[0].at).toBe(T(until));
    });
});

describe('advancing a fired event: the firing path only, after the grace', () => {
    const sched = serializeSchedule(event);

    it('inside the grace window: no advance yet, but a check is armed for when it ends', () => {
        const now = T(due) + ADVANCE_GRACE_MS - 1000;
        const p = planAdvances([row({ openSchedule: sched })], now);
        expect(p.advances).toHaveLength(0);
        expect(p.nextCheckAt).toBe(T(due) + ADVANCE_GRACE_MS);
    });

    it('after the grace: moves to the next weekly alert', () => {
        const now = T(due) + ADVANCE_GRACE_MS + 1000;
        const p = planAdvances([row({ openSchedule: sched })], now);
        expect(p.advances).toEqual([{ row: expect.objectContaining({ id: 7 }), nextDue: '2026-10-12T19:00:00.000Z' }]);
    });

    it('a one-off event with nothing left clears due_at (null) so it leaves the feed', () => {
        const once = serializeSchedule({ ...event, rrule: undefined });
        const p = planAdvances([row({ openSchedule: once })], T('2026-10-06T00:00:00Z'));
        expect(p.advances[0].nextDue).toBeNull();
    });

    it('never advances a repeating TASK, a private item, an unreadable schedule or a plain row', () => {
        const now = T('2026-10-07T00:00:00Z');
        const task = serializeSchedule({ ...event, kind: 'task' });
        expect(planAdvances([row({ openSchedule: task })], now).advances).toHaveLength(0);
        const priv = serializeSchedule({ ...event, privateTiming: true });
        expect(planAdvances([row({ openSchedule: priv })], now).advances).toHaveLength(0);
        // Positive control: the same row with the plain event schedule DOES advance.
        expect(planAdvances([row({ openSchedule: sched })], now).advances).toHaveLength(1);
        expect(planAdvances([row({ openSchedule: '[Unable to decrypt]' })], now).advances).toHaveLength(0);
        expect(planAdvances([row()], now).advances).toHaveLength(0);
    });

    it('a snoozed event waits for the snooze (plus grace) before advancing', () => {
        const until = '2026-10-05T21:00:00.000Z';
        const r = row({ openSchedule: sched, openSnooze: serializeSnooze({ forDue: due, until }) });
        expect(planAdvances([r], T(due) + ADVANCE_GRACE_MS + 1000).advances).toHaveLength(0);
        expect(planAdvances([r], T(until) + ADVANCE_GRACE_MS + 1000).advances).toHaveLength(1);
    });

    it('sends expect_due_at, and a 409 (someone else advanced first) is not an error', async () => {
        patchTaskTiming.mockRejectedValueOnce(new ApiError('changed', 409));
        patchTaskTiming.mockResolvedValueOnce(undefined);
        const adv = [{ row: row(), nextDue: '2026-10-12T19:00:00.000Z' }, { row: row({ id: 8 }), nextDue: null }];
        expect(await applyAdvances(adv)).toBe(1);
        expect(patchTaskTiming).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: 7 }), { due_at: '2026-10-12T19:00:00.000Z', expect_due_at: due });
        expect(patchTaskTiming).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 8 }), { due_at: null, expect_due_at: due });
    });
});
