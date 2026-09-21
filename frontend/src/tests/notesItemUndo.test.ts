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
    /** Every call in the order it was made, for the ordering check below. */
    order: string[];
}

/** A fake data layer. `fail` names the descriptions whose create is refused. */
function fakes(fail: string[] = []): Calls {
    const c: Partial<Calls> = { added: [], attachments: [], snoozed: [], completed: [], toggled: [], order: [] };
    let next = 900;
    c.actions = {
        addTask: vi.fn(async (_n: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming) => {
            c.added!.push([description, parentId, timing]);
            c.order!.push(`add ${description}`);
            if (fail.includes(description)) return null;
            return task(next++, { description, parent_id: parentId ?? null, due_at: timing?.dueAt ?? null, schedule: timing?.schedule ?? null });
        }),
        setAttachments: vi.fn(async (_n: NoteRef, t: Task, refs: TaskAttachmentRef[]) => { c.attachments!.push([t.id, refs]); }),
        snoozeTask: vi.fn(async (_n: NoteRef, t: Task, until: number | null) => { c.snoozed!.push([t.id, until]); }),
        restoreCompleted: vi.fn(async (_n: NoteRef, t: Task) => { c.completed!.push(t.id); c.order!.push(`done ${t.description}`); }),
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

    it('marks only the top of a completed branch, and only once the branch EXISTS', async () => {
        const c = fakes();
        await recreateSubtree(c.actions, note, [
            task(2, { description: 'Milk', is_completed: true }),
            task(3, { description: 'Semi-skimmed', parent_id: 2, is_completed: true }),
        ]);
        expect(c.completed).toEqual([900]);
        // The server sweeps the subtree AS IT STANDS when the parent is
        // marked (task_handlers.rs, the recursive UPDATE). Marking the parent
        // before its child was created would put the branch back with the
        // parent done and everything under it open.
        expect(c.order).toEqual(['add Milk', 'add Semi-skimmed', 'done Milk']);
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

    it('puts a deleted SUBTREE back under the live item it hung under', async () => {
        const c = fakes();
        // What the editor hands it when a NESTED item is deleted: the root of
        // the snapshot still names its parent, which is alive and untouched.
        const out = await recreateSubtree(c.actions, note, [
            task(3, { parent_id: 2 }), task(4, { parent_id: 3 }),
        ]);
        expect(c.added.map(a => [a[0], a[1]])).toEqual([['item 3', 2], ['item 4', 900]]);
        expect(out.missing).toBe(0);
        expect(out.idMap.get(3)).toBe(900);
    });

    it('drops the children of an item that could not be put back, rather than raising them to the top', async () => {
        const c = fakes(['item 2']);
        // POSITIVE CONTROL for the case above: this parent WAS in the
        // snapshot and did not come back, so its child is not put back under
        // the old id either — that id is gone.
        const out = await recreateSubtree(c.actions, note, [task(2), task(3, { parent_id: 2 }), task(4)]);
        expect(c.added.map(a => a[0])).toEqual(['item 2', 'item 4']);
        expect(out.missing).toBe(2);
        expect(out.idMap.has(3)).toBe(false);
    });

    it('marks a done parent BEFORE an open child exists, so the sweep cannot tick it', async () => {
        const c = fakes();
        // Reachable: an item added under a parent that was already ticked.
        // The server's sweep ticks the subtree as it stands, and re-opening
        // the child afterwards would un-tick the parent, so the only order
        // that reproduces this is mark-then-create.
        await recreateSubtree(c.actions, note, [
            task(2, { description: 'Milk', is_completed: true }),
            task(3, { description: 'Semi-skimmed', parent_id: 2 }),
        ]);
        expect(c.order).toEqual(['add Milk', 'done Milk', 'add Semi-skimmed']);
        expect(c.completed).toEqual([900]);
    });

    it('waits for the done half of a mixed branch, then marks, then adds the open half', async () => {
        const c = fakes();
        await recreateSubtree(c.actions, note, [
            task(2, { description: 'Milk', is_completed: true }),
            task(3, { description: 'Semi-skimmed', parent_id: 2, is_completed: true }),
            task(4, { description: 'One pint', parent_id: 3 }),
            task(5, { description: 'Bread', parent_id: 2 }),
        ]);
        expect(c.order).toEqual([
            'add Milk', 'add Semi-skimmed', 'done Milk', 'add One pint', 'add Bread',
        ]);
        // Only the top of the completed branch is marked; the sweep does the rest.
        expect(c.completed).toEqual([900]);
    });

    it('marks a done item under an open one on its own, after everything', async () => {
        const c = fakes();
        await recreateSubtree(c.actions, note, [
            task(2, { description: 'Milk', is_completed: true }),
            task(3, { description: 'Semi-skimmed', parent_id: 2 }),
            task(4, { description: 'One pint', parent_id: 3, is_completed: true }),
        ]);
        // Marking 'One pint' sweeps downwards only, so it cannot un-tick Milk.
        expect(c.order).toEqual(['add Milk', 'done Milk', 'add Semi-skimmed', 'add One pint', 'done One pint']);
        expect(c.completed).toEqual([900, 902]);
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
