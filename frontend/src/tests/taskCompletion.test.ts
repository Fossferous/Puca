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
});
