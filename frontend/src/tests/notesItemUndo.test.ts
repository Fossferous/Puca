/**
 * Putting a deleted item back (noteContent.ts recreateSubtree), and the
 * subtree the editor hands it (tasks.ts subtreeInOrder).
 *
 * The thing worth testing here is what the conversion Undo used to get
 * wrong: it restored only text, due time, attachments and the tick, and it
 * restored the tick with the ordinary toggle — which, for a REPEATING
 * to-do, moves the series on to its next occurrence instead of marking it
 * done. An item put back that way came back on the wrong date. The positive
 * control below proves that is what the toggle would have done to this
 * fixture, so a regression cannot pass quietly.
 */
import { describe, it, expect, vi } from 'vitest';
import { type NewTaskTiming, type Task, type TaskAttachmentRef, subtreeInOrder } from '../api/tasks';
import {
    type EventSchedule, parseSchedule, planCompletion, serializeSchedule, serializeSnooze,
} from '../api/taskSchedule';
import { type RecreateActions, recreateSubtree } from '../notes/model/noteContent';
import { type NoteRef } from '../notes/model/notesModel';

const note: NoteRef = { kind: 'list', id: 5 };
const NOW = Date.parse('2026-10-05T12:00:00Z');

function task(id: number, over: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 5, parent_id: null, description: `item ${id}`, is_completed: false,
        position: id, created_at: '2026-09-01T10:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
    };
}
const fileRef = (id: string): TaskAttachmentRef => ({
    href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent('image/png')}`, name: `${id}.png`,
});
/** A weekly to-do already ticked through the 28th. */
const weekly = (over: Partial<EventSchedule> = {}): EventSchedule => ({
    v: 1, kind: 'task', uid: 'uid-weekly-01', allDay: false, start: '2026-09-07T09:00', end: '2026-09-07T09:30',
    tz: 'UTC', rrule: 'FREQ=WEEKLY', doneThrough: '2026-09-28T09:00', ...over,
});

interface Calls {
    actions: RecreateActions;
    added: Array<[string, number | undefined, NewTaskTiming | undefined]>;
    attachments: Array<[number, TaskAttachmentRef[]]>;
    snoozed: Array<[number, number | null]>;
    completed: number[];
    toggled: number[];
}

/** A fake data layer. `fail` names the descriptions whose create is refused. */
function fakes(fail: string[] = []): Calls {
    const c: Partial<Calls> = { added: [], attachments: [], snoozed: [], completed: [], toggled: [] };
    let next = 900;
    c.actions = {
        addTask: vi.fn(async (_n: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming) => {
            c.added!.push([description, parentId, timing]);
            if (fail.includes(description)) return null;
            return task(next++, { description, parent_id: parentId ?? null, due_at: timing?.dueAt ?? null, schedule: timing?.schedule ?? null });
        }),
        setAttachments: vi.fn(async (_n: NoteRef, t: Task, refs: TaskAttachmentRef[]) => { c.attachments!.push([t.id, refs]); }),
        snoozeTask: vi.fn(async (_n: NoteRef, t: Task, until: number | null) => { c.snoozed!.push([t.id, until]); }),
        restoreCompleted: vi.fn(async (_n: NoteRef, t: Task) => { c.completed!.push(t.id); }),
    };
    return c as Calls;
}

describe('subtreeInOrder', () => {
    const all = [
        task(1), task(2), task(3, { parent_id: 2 }), task(4, { parent_id: 3 }), task(5, { parent_id: 2 }), task(6),
    ];
    it('is the item and everything under it, parents first, in display order', () => {
        expect(subtreeInOrder(all, 2).map(t => t.id)).toEqual([2, 3, 4, 5]);
    });
    it('POSITIVE CONTROL: a leaf is just itself, and an id nothing has is empty', () => {
        expect(subtreeInOrder(all, 6).map(t => t.id)).toEqual([6]);
        expect(subtreeInOrder(all, 99)).toEqual([]);
    });
});

describe('recreateSubtree', () => {
    it('re-creates parents before children and nests the children under the NEW ids', async () => {
        const c = fakes();
        const snapshot = [task(2), task(3, { parent_id: 2 }), task(4, { parent_id: 3 })];
        const out = await recreateSubtree(c.actions, note, snapshot);
        expect(c.added.map(a => [a[0], a[1]])).toEqual([['item 2', undefined], ['item 3', 900], ['item 4', 901]]);
        expect(out.idMap.get(4)).toBe(902);
        expect(out.missing).toBe(0);
    });

    it('carries a plain due time, and a date & repeat byte-for-byte — same uid, same progress', async () => {
        const c = fakes();
        const schedule = serializeSchedule(weekly());
        const snapshot = [
            task(1, { due_at: '2026-10-09T08:00:00.000Z' }),
            task(2, { schedule, due_at: '2026-10-05T09:00:00.000Z' }),
        ];
        await recreateSubtree(c.actions, note, snapshot);
        expect(c.added[0][2]).toEqual({ dueAt: '2026-10-09T08:00:00.000Z' });
        const restored = parseSchedule(c.added[1][2]!.schedule!);
        expect(restored.state === 'ok' && restored.schedule.uid).toBe('uid-weekly-01');
        expect(restored.state === 'ok' && restored.schedule.doneThrough).toBe('2026-09-28T09:00');
        expect(c.added[1][2]!.dueAt).toBe('2026-10-05T09:00:00.000Z');
    });

    it('puts a COMPLETED repeating item back as done, without advancing its series', async () => {
        const c = fakes();
        const s = weekly();
        // POSITIVE CONTROL: the ordinary tick path would NOT mark this done
        // — it would move the series on. That is the bug this avoids.
        expect(planCompletion(s, true, NOW).kind).toBe('advance');
        await recreateSubtree(c.actions, note, [task(2, { schedule: serializeSchedule(s), is_completed: true })]);
        expect(c.completed).toEqual([900]);
        expect(c.toggled).toEqual([]);
        expect(c.actions.restoreCompleted).toHaveBeenCalledTimes(1);
        const back = parseSchedule(c.added[0][2]!.schedule!);
        expect(back.state === 'ok' && back.schedule.doneThrough).toBe('2026-09-28T09:00');
    });

    it('marks only the top of a completed branch — completing a parent sweeps its subtree', async () => {
        const c = fakes();
        await recreateSubtree(c.actions, note, [
            task(2, { is_completed: true }), task(3, { parent_id: 2, is_completed: true }),
        ]);
        expect(c.completed).toEqual([900]);
    });

    it('carries the snooze and the readable attachments, and never a locked sidecar', async () => {
        const c = fakes();
        const snooze = serializeSnooze({ forDue: '2026-10-05T09:00:00.000Z', until: '2026-10-05T18:00:00.000Z' });
        await recreateSubtree(c.actions, note, [
            task(1, { due_at: '2026-10-05T09:00:00.000Z', snooze }),
            task(2, { attachments: JSON.stringify([fileRef('f1'), fileRef('f2')]) }),
            task(3, { attachments: '[Unable to decrypt]' }),
        ]);
        expect(c.snoozed).toEqual([[900, Date.parse('2026-10-05T18:00:00.000Z')]]);
        expect(c.attachments).toEqual([[901, [fileRef('f1'), fileRef('f2')]]]);
    });

    it('drops the children of an item that could not be put back, rather than raising them to the top', async () => {
        const c = fakes(['item 2']);
        const out = await recreateSubtree(c.actions, note, [task(2), task(3, { parent_id: 2 }), task(4)]);
        expect(c.added.map(a => a[0])).toEqual(['item 2', 'item 4']);
        expect(out.missing).toBe(2);
        expect(out.idMap.has(3)).toBe(false);
    });

    it('puts an item with an unreadable date back WITHOUT it, and says so', async () => {
        const c = fakes();
        const out = await recreateSubtree(c.actions, note, [task(1, { schedule: '[Unable to decrypt]' })]);
        // Sealing the marker back would write it over the real ciphertext.
        expect(c.added[0][2]).toBeUndefined();
        expect(out.unreadableTiming).toBe(1);
        expect(out.missing).toBe(0);
    });

    it('POSITIVE CONTROL: a plain item costs one create and nothing else', async () => {
        const c = fakes();
        const out = await recreateSubtree(c.actions, note, [task(1)]);
        expect(c.added).toEqual([['item 1', undefined, undefined]]);
        expect(c.attachments).toEqual([]);
        expect(c.snoozed).toEqual([]);
        expect(c.completed).toEqual([]);
        expect(out).toMatchObject({ missing: 0, unreadableTiming: 0 });
    });
});
