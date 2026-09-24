import { beforeEach, describe, expect, it, vi } from 'vitest';

const patchTaskTiming = vi.fn();
vi.mock('../api/tasks', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/tasks')>()),
    patchTaskTiming: (...a: unknown[]) => patchTaskTiming(...a),
}));

import { planToggle } from '../api/taskCompletion';
import { type Task } from '../api/tasks';
import { parseSchedule, serializeSchedule, serializeSnooze, type EventSchedule } from '../api/taskSchedule';
import { ApiError } from '../api/client';

const T = (s: string) => Date.parse(s);
const mk = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false, position: id,
    created_at: '2026-10-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
});
const daily: EventSchedule = { v: 1, kind: 'task', uid: 'uid-rep-0001', allDay: false, start: '2026-10-05T09:00', tz: 'UTC', rrule: 'FREQ=DAILY' };

beforeEach(() => { patchTaskTiming.mockReset(); patchTaskTiming.mockResolvedValue(undefined); });

describe('planToggle — the one completion path', () => {
    it('a plain task toggles exactly as before (subtree swept), and says it is recurrence-aware', async () => {
        const tasks = [mk(1), mk(2, { parent_id: 1 })];
        const p = planToggle(tasks, tasks[0], true, { canEdit: true });
        expect(p.advanced).toBe(false);
        expect(p.next.every(t => t.is_completed)).toBe(true);
        await p.send();
        expect(patchTaskTiming).toHaveBeenCalledWith(tasks[0], { is_completed: true });
    });

    it('a repeating task ADVANCES: stays open, moves due_at, records doneThrough, reopens its subtasks', async () => {
        const sched = serializeSchedule(daily, { futureField: 1 });
        const snz = serializeSnooze({ forDue: '2026-10-05T09:00:00.000Z', until: '2026-10-05T10:00:00.000Z' });
        const parent = mk(1, { schedule: sched, due_at: '2026-10-05T09:00:00.000Z', snooze: snz });
        const kid = mk(2, { parent_id: 1, is_completed: true });
        const p = planToggle([parent, kid], parent, true, { canEdit: true, now: T('2026-10-05T12:00:00Z') });
        expect(p.advanced).toBe(true);
        const np = p.next.find(t => t.id === 1)!;
        expect(np.is_completed).toBe(false);
        expect(np.due_at).toBe('2026-10-06T09:00:00.000Z');
        expect(p.next.find(t => t.id === 2)!.is_completed).toBe(false);
        const reparsed = parseSchedule(np.schedule);
        expect(reparsed.state === 'ok' && reparsed.schedule.doneThrough).toBe('2026-10-05T09:00');
        expect(reparsed.state === 'ok' && reparsed.raw.futureField).toBe(1);   // unknown keys survive the advance
        await p.send();
        expect(patchTaskTiming).toHaveBeenCalledWith(parent, expect.objectContaining({
            due_at: '2026-10-06T09:00:00.000Z', expect_due_at: '2026-10-05T09:00:00.000Z', snooze: null, reopen_subtree: true,
            schedule: np.schedule,
        }));
        expect(patchTaskTiming.mock.calls[0][1]).not.toHaveProperty('is_completed');
    });

    it('the last occurrence completes for good', async () => {
        const last = mk(1, { schedule: serializeSchedule({ ...daily, rrule: 'FREQ=DAILY;COUNT=2', doneThrough: '2026-10-05T09:00' }) });
        const p = planToggle([last], last, true, { canEdit: true, now: T('2026-10-06T12:00:00Z') });
        expect(p.advanced).toBe(false);
        expect(p.next[0].is_completed).toBe(true);
    });

    it('a member who cannot edit the item cannot advance it — refused like a 409, nothing changes', async () => {
        const t = mk(1, { schedule: serializeSchedule(daily) });
        const p = planToggle([t], t, true, { canEdit: false, now: T('2026-10-05T12:00:00Z') });
        expect(p.next).toEqual([t]);
        await expect(p.send()).rejects.toBeInstanceOf(ApiError);
        expect(patchTaskTiming).not.toHaveBeenCalled();
        // Positive control: a plain item from the same member ticks normally.
        const plain = mk(2);
        await planToggle([plain], plain, true, { canEdit: false }).send();
        expect(patchTaskTiming).toHaveBeenCalledTimes(1);
    });

    it('an unreadable schedule is never ticked blind (it may repeat)', async () => {
        const t = mk(1, { schedule: '[Encrypted — key unavailable]' });
        const p = planToggle([t], t, true, { canEdit: true });
        await expect(p.send()).rejects.toThrow(/can’t be read/);
        // Un-ticking one is fine.
        await planToggle([t], t, false, { canEdit: true }).send();
        expect(patchTaskTiming).toHaveBeenCalledWith(t, { is_completed: false });
    });

    describe('ticking a PARENT never ends a series below it (the server sweeps the subtree)', () => {
        const weekly = serializeSchedule({ ...daily, rrule: 'FREQ=WEEKLY' });
        const NOW = T('2026-10-05T12:00:00Z');

        it('a plain parent with a repeating child is refused, nothing changes, nothing is sent', async () => {
            const parent = mk(1);
            const kid = mk(2, { parent_id: 1, description: 'Water the plants', schedule: weekly, due_at: '2026-10-05T09:00:00.000Z' });
            const p = planToggle([parent, kid], parent, true, { canEdit: true, now: NOW });
            expect(p.next).toEqual([parent, kid]);
            await expect(p.send()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Water the plants.*repeats/) });
            expect(patchTaskTiming).not.toHaveBeenCalled();
        });

        it('a GRANDCHILD that repeats blocks too, and so does a one-off parent (its own schedule completes)', async () => {
            const oneOff = mk(1, { schedule: serializeSchedule({ ...daily, rrule: undefined }) });
            const mid = mk(2, { parent_id: 1 });
            const grand = mk(3, { parent_id: 2, schedule: weekly });
            await expect(planToggle([oneOff, mid, grand], oneOff, true, { canEdit: true, now: NOW }).send()).rejects.toBeInstanceOf(ApiError);
            expect(patchTaskTiming).not.toHaveBeenCalled();
        });

        it('a descendant schedule this device cannot read blocks (it may repeat)', async () => {
            const parent = mk(1);
            const kid = mk(2, { parent_id: 1, schedule: '[Encrypted — key unavailable]' });
            await expect(planToggle([parent, kid], parent, true, { canEdit: true, now: NOW }).send()).rejects.toThrow(/can’t read/);
            expect(patchTaskTiming).not.toHaveBeenCalled();
        });

        it('positive controls: a one-off child, a finished series, an already-done child and UN-ticking all go through', async () => {
            const parent = mk(1);
            const oneOffKid = mk(2, { parent_id: 1, schedule: serializeSchedule({ ...daily, rrule: undefined }) });
            await planToggle([parent, oneOffKid], parent, true, { canEdit: true, now: NOW }).send();
            const endedKid = mk(3, { parent_id: 1, schedule: serializeSchedule({ ...daily, rrule: 'FREQ=DAILY;COUNT=1', doneThrough: '2026-10-05T09:00' }) });
            await planToggle([parent, endedKid], parent, true, { canEdit: true, now: NOW }).send();
            const doneKid = mk(4, { parent_id: 1, schedule: weekly, is_completed: true });
            await planToggle([parent, doneKid], parent, true, { canEdit: true, now: NOW }).send();
            const openKid = mk(5, { parent_id: 1, schedule: weekly });
            await planToggle([{ ...parent, is_completed: true }, openKid], { ...parent, is_completed: true }, false, { canEdit: true, now: NOW }).send();
            expect(patchTaskTiming).toHaveBeenCalledTimes(4);
            // An unrelated repeating item elsewhere in the list does not block.
            const other = mk(6, { schedule: weekly });
            await planToggle([parent, other], parent, true, { canEdit: true, now: NOW }).send();
            expect(patchTaskTiming).toHaveBeenCalledTimes(5);
        });

        it('a repeating PARENT still advances (reopening its subtree, never sweeping it)', async () => {
            const parent = mk(1, { schedule: weekly, due_at: '2026-10-05T09:00:00.000Z' });
            const kid = mk(2, { parent_id: 1, schedule: weekly });
            const p = planToggle([parent, kid], parent, true, { canEdit: true, now: NOW });
            expect(p.advanced).toBe(true);
            await p.send();
            expect(patchTaskTiming.mock.calls[0][1]).toMatchObject({ reopen_subtree: true });
        });
    });
});

describe('the freshness stamp (finding 8): a completion says how current its view of the schedules is', () => {
    const NOW = T('2026-10-05T12:00:00Z');
    // Stamps exactly as the server renders them: microseconds, trailing
    // zeros dropped, sometimes no fraction at all.
    const A = '2026-10-01T10:00:00.1234Z';
    const B = '2026-10-01T10:00:00.12345Z';   // later than A by 10 µs, same millisecond
    const C = '2026-10-01T09:59:59Z';

    it('a plain tick sends the NEWEST server stamp of the item and everything under it, verbatim', async () => {
        const parent = mk(1, { updated_at: A });
        const kid = mk(2, { parent_id: 1, updated_at: B });
        const grand = mk(3, { parent_id: 2, updated_at: C });
        const other = mk(4, { updated_at: '2027-01-01T00:00:00Z' });   // not under it: never counts
        const p = planToggle([parent, kid, grand, other], parent, true, { canEdit: true, now: NOW });
        expect(p.patch).toEqual({ is_completed: true, expect_schedules_as_of: B });
        await p.send();
        expect(patchTaskTiming).toHaveBeenCalledWith(parent, { is_completed: true, expect_schedules_as_of: B });
    });

    it('an advance sends the item’s OWN stamp (it sweeps nothing)', () => {
        const parent = mk(1, { schedule: serializeSchedule(daily), due_at: '2026-10-05T09:00:00.000Z', updated_at: A });
        const kid = mk(2, { parent_id: 1, updated_at: B });
        const p = planToggle([parent, kid], parent, true, { canEdit: true, now: NOW });
        expect(p.advanced).toBe(true);
        expect(p.patch?.expect_schedules_as_of).toBe(A);
    });

    it('an untick sends none (it ends nothing)', () => {
        const t = mk(1, { is_completed: true, updated_at: A });
        expect(planToggle([t], t, false, { canEdit: true }).patch).toEqual({ is_completed: false });
    });

    it('no stamp when this device cannot vouch for a row: not on the server yet, no stamp, or edited here since', () => {
        const parent = mk(1, { updated_at: A });
        for (const kid of [
            mk(-5, { parent_id: 1 }),                                   // made offline, not created yet
            mk(2, { parent_id: 1 }),                                    // an older server: no stamp
            mk(2, { parent_id: 1, updated_at: B, localEdit: true }),    // changed here, server copy not back
            mk(2, { parent_id: 1, updated_at: 'garbage' }),
        ]) {
            const p = planToggle([parent, kid], parent, true, { canEdit: true, now: NOW });
            expect(p.patch).toEqual({ is_completed: true });
        }
        // Positive control: the same shapes with a stamped, untouched child do carry one.
        const ok = planToggle([parent, mk(2, { parent_id: 1, updated_at: B })], parent, true, { canEdit: true, now: NOW });
        expect(ok.patch?.expect_schedules_as_of).toBe(B);
    });

    it('the rows a plan changes are marked, so a quick second toggle does not send a stamp its own first one outdated', () => {
        const parent = mk(1, { updated_at: A, schedule: serializeSchedule({ ...daily, rrule: undefined }) });
        const kid = mk(2, { parent_id: 1, updated_at: B });
        const lone = mk(3, { updated_at: C });
        const first = planToggle([parent, kid, lone], parent, true, { canEdit: true, now: NOW });
        expect(first.next.find(t => t.id === 1)?.localEdit).toBe(true);
        expect(first.next.find(t => t.id === 2)?.localEdit).toBe(true);
        expect(first.next.find(t => t.id === 3)).toBe(lone);            // untouched rows stay as they were
        const undo = planToggle(first.next, first.next[0], false, { canEdit: true, now: NOW });
        const again = planToggle(undo.next, undo.next[0], true, { canEdit: true, now: NOW });
        expect(again.patch).toEqual({ is_completed: true });
    });

    it('reads migration 071’s schedule_changed_at when every covered row carries it, and updated_at otherwise', () => {
        // The schedule clock is older than the edit clock on each row: a
        // text edit moved updated_at and nothing else.
        const parent = mk(1, { updated_at: B, schedule_changed_at: A });
        const kid = mk(2, { parent_id: 1, updated_at: B, schedule_changed_at: C });
        const p = planToggle([parent, kid], parent, true, { canEdit: true, now: NOW });
        expect(p.patch?.expect_schedules_as_of, 'the newest schedule clock, verbatim').toBe(A);
        expect(p.stampClock).toBe('schedule');
        // One row from a server that does not send it: the whole stamp falls
        // back to updated_at, which is the clock that server compares.
        const older = planToggle([parent, mk(2, { parent_id: 1, updated_at: B })], parent, true, { canEdit: true, now: NOW });
        expect(older.patch?.expect_schedules_as_of).toBe(B);
        expect(older.stampClock).toBe('content');
        // An advance reads its own row the same way.
        const rep = mk(1, { schedule: serializeSchedule(daily), due_at: '2026-10-05T09:00:00.000Z', updated_at: B, schedule_changed_at: C });
        const adv = planToggle([rep], rep, true, { canEdit: true, now: NOW });
        expect(adv.advanced).toBe(true);
        expect(adv.patch?.expect_schedules_as_of).toBe(C);
        expect(adv.stampClock).toBe('schedule');
    });

    it('names the rows whose edits outdate the stamp: the item, everything under it and everything above it', () => {
        const top = mk(1, { updated_at: A });
        const mid = mk(2, { parent_id: 1, updated_at: A });
        const low = mk(3, { parent_id: 2, updated_at: A });
        const side = mk(4, { parent_id: 1, updated_at: A });
        const p = planToggle([top, mid, low, side], mid, true, { canEdit: true, now: NOW });
        expect([...(p.scope ?? [])].sort()).toEqual([1, 2, 3]);
    });
});
