/**
 * "Uncheck all" and "Delete checked" (notes/model/noteItemBulk.ts and
 * notes/components/ListActionsMenu.tsx).
 *
 * The three things worth pinning, because the server's own rules make the
 * naive version wrong:
 *  - a delete names only the TOP of each completed branch (the server
 *    cascades), so deleting every completed id would race its own cascade;
 *  - unticking goes parents-first, because un-completing a parent reopens its
 *    ancestors;
 *  - a ticked repeating to-do whose series has ENDED is warned about, because
 *    unticking it reopens a repeat with no next time — and nothing in
 *    taskCompletion.ts guards that (both of its refusals are gated on
 *    `completed === true`, so un-ticking walks straight past them).
 *
 * The offline case is the positive control: revert that guard and it goes red
 * while everything else stays green.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, deleteFiles: vi.fn(async () => {}) };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, pendingOutboxCount: vi.fn(() => 0) };
});

import { ListActionsMenu } from '../notes/components/ListActionsMenu';
import { checkedRoots, deadSeriesAmong, describeUncheckWarning, uncheckOrder } from '../notes/model/noteItemBulk';
import { pendingOutboxCount } from '../notes/model/notesOutbox';
import { deleteFiles } from '../api/listContent';
import { serializeSchedule, type EventSchedule } from '../api/taskSchedule';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteActions } from '../notes/model/notesQueries';
import type { Task } from '../api/tasks';

const LIST = { kind: 'list' as const, id: 1 };

function task(id: number, o: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
    };
}
const repeat = (o: Partial<EventSchedule>): string => serializeSchedule({
    v: 1, kind: 'task', uid: `u${Math.random().toString(36).slice(2, 8)}`, allDay: true, start: '2026-09-01', ...o,
} as EventSchedule, {});

describe('which items each action touches', () => {
    it('a delete names only the TOP of each completed branch — the server cascades', () => {
        const tasks = [
            task(1, { is_completed: true }),
            task(2, { parent_id: 1, is_completed: true }),
            task(3, { parent_id: 2, is_completed: true }),
            task(4, { is_completed: false }),
        ];
        expect(checkedRoots(tasks).map(t => t.id)).toEqual([1]);
    });

    it('…but a completed item under an OPEN parent is a top of its own', () => {
        const tasks = [task(1), task(2, { parent_id: 1, is_completed: true }), task(3, { is_completed: true })];
        expect(checkedRoots(tasks).map(t => t.id)).toEqual([2, 3]);
    });

    it('unticking goes parents-first, because un-completing a parent reopens its ancestors', () => {
        const tasks = [
            task(1, { is_completed: true }),
            task(2, { parent_id: 1, is_completed: true }),
            task(3, { is_completed: false }),
            task(4, { is_completed: true }),
        ];
        expect(uncheckOrder(tasks).map(t => t.id)).toEqual([1, 2, 4]);
    });
});

describe('a ticked repeat whose series has ended', () => {
    it('is flagged; a plain ticked item and a LIVE repeat are not', () => {
        const ended = task(1, { is_completed: true, schedule: repeat({ rrule: 'FREQ=DAILY;COUNT=2', doneThrough: '2026-09-02' }) });
        const live = task(2, { is_completed: true, schedule: repeat({ rrule: 'FREQ=DAILY' }) });
        const plain = task(3, { is_completed: true });
        const open = task(4, { schedule: repeat({ rrule: 'FREQ=DAILY;COUNT=2', doneThrough: '2026-09-02' }) });
        expect(deadSeriesAmong([ended, live, plain, open]).map(t => t.id)).toEqual([1]);
    });

    it('is described, and nothing is described when there is nothing to say', () => {
        expect(describeUncheckWarning([])).toBeNull();
        const one = describeUncheckWarning([task(1, { description: 'Water the plants' })]);
        expect(one).toContain('Water the plants');
        expect(one).toContain('no next time');
        expect(describeUncheckWarning([task(1), task(2)])).toContain('2 of these');
    });
});

// --- The menu -----------------------------------------------------------------------

let root: Root;
let host: HTMLDivElement;
let toasts: string[];
let onLine = true;
let onLineSpy: ReturnType<typeof vi.spyOn> | null = null;

const settle = async (ms = 260) => { await act(async () => { await new Promise(r => setTimeout(r, ms)); }); };
const menuButton = (name: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('.notes-list-actions button')]
    .find(b => name.test(b.textContent ?? ''))!;

function fakeActions(tasks: Task[], opts: { deleteOk?: (id: number) => boolean; untickOk?: (id: number) => boolean } = {}) {
    const log: string[] = [];
    let live = [...tasks];
    let nextId = 900;
    const listeners = new Set<() => void>();
    const changed = () => { for (const l of [...listeners]) l(); };
    const actions = {
        toggleTask: vi.fn(async (_n: unknown, t: Task, completed: boolean) => {
            log.push(`toggle(${t.id},${completed})`);
            if (opts.untickOk && !opts.untickOk(t.id)) return;
            live = live.map(x => (x.id === t.id ? { ...x, is_completed: completed } : x));
            changed();
        }),
        deleteTaskFrom: vi.fn(async (_n: unknown, id: number) => {
            log.push(`delete(${id})`);
            if (opts.deleteOk && !opts.deleteOk(id)) return false;
            live = live.filter(x => x.id !== id && x.parent_id !== id);
            changed();
            return true;
        }),
        addTask: vi.fn(async (_n: unknown, description: string, parentId?: number) => {
            log.push(`add(${description},${parentId ?? '-'})`);
            const made = task(++nextId, { description, parent_id: parentId ?? null });
            live = [...live, made];
            changed();
            return made;
        }),
        setDue: vi.fn(async (_n: unknown, t: Task, due: string | null) => { log.push(`due(${t.id},${due})`); }),
        setSchedule: vi.fn(async (_n: unknown, t: Task, sched: string | null) => { log.push(`schedule(${t.id},${sched ? 'set' : 'null'})`); }),
        setAttachments: vi.fn(async (_n: unknown, t: Task) => { log.push(`attach(${t.id})`); }),
    } as unknown as NoteActions;
    return {
        actions, log,
        current: () => live,
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
}

/** Mount the menu under a Probe that re-renders on every write, the way the
 *  editor's own live query does — the component must see the truth its
 *  actions just produced, not the snapshot it was clicked with. */
function Probe({ f }: { f: ReturnType<typeof fakeActions> }) {
    const [, force] = useState(0);
    useEffect(() => f.subscribe(() => force(x => x + 1)), [f]);
    return <ListActionsMenu note={LIST} actions={f.actions} tasks={f.current()} />;
}
function mount(f: ReturnType<typeof fakeActions>) {
    act(() => { root.render(<Probe f={f} />); });
}

beforeEach(() => {
    toasts = [];
    onLine = true;
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    vi.mocked(pendingOutboxCount).mockReturnValue(0);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    setMessageToastSink(t => { toasts.push(t.title); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    document.body.innerHTML = '';
    setMessageToastSink(null);
    onLineSpy?.mockRestore();
    vi.restoreAllMocks();
});

const open = () => act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="List actions"]')!.click(); });

describe('Uncheck all', () => {
    it('unticks every ticked item, parents first, and touches no open one', async () => {
        const tasks = [
            task(1, { is_completed: true }),
            task(2, { parent_id: 1, is_completed: true }),
            task(3, { is_completed: false }),
            task(4, { is_completed: true }),
        ];
        const f = fakeActions(tasks);
        mount(f);
        open();
        await act(async () => { menuButton(/Uncheck all/).click(); });
        await settle();
        expect(f.log.filter(l => l.startsWith('toggle'))).toEqual(['toggle(1,false)', 'toggle(2,false)', 'toggle(4,false)']);
        expect(f.log).not.toContain('toggle(3,false)');
    });

    it('offers an Undo that re-ticks only the TOP of each branch', async () => {
        const tasks = [task(1, { is_completed: true }), task(2, { parent_id: 1, is_completed: true })];
        const f = fakeActions(tasks);
        mount(f);
        open();
        await act(async () => { menuButton(/Uncheck all/).click(); });
        await settle();
        const undo = [...document.querySelectorAll<HTMLButtonElement>('.notes-undo button')][0];
        expect(undo).toBeTruthy();
        await act(async () => { undo.click(); });
        await settle();
        expect(f.log.filter(l => l.includes(',true)'))).toEqual(['toggle(1,true)']);
    });

    it('says how many it could not untick', async () => {
        const tasks = [task(1, { is_completed: true }), task(2, { is_completed: true })];
        const f = fakeActions(tasks, { untickOk: id => id !== 2 });
        mount(f);
        open();
        await act(async () => { menuButton(/Uncheck all/).click(); });
        await settle();
        expect(toasts.join('|')).toMatch(/Couldn.t untick 1 of 2 items/);
    });
});

describe('Delete checked', () => {
    it('sends one delete per checked branch, never one per swept child', async () => {
        const tasks = [
            task(1, { is_completed: true }),
            task(2, { parent_id: 1, is_completed: true }),
            task(3, { is_completed: true }),
            task(4, { is_completed: false }),
        ];
        const f = fakeActions(tasks);
        mount(f);
        open();
        await act(async () => { menuButton(/Delete checked/).click(); });
        await settle();
        expect(f.log.filter(l => l.startsWith('delete'))).toEqual(['delete(1)', 'delete(3)']);
    });

    it('Undo re-creates parents before children, with their dates, repeats and pictures — and re-ticks only the branch top', async () => {
        const sched = repeat({ rrule: 'FREQ=WEEKLY' });
        const tasks = [
            task(1, { description: 'Parent', is_completed: true, attachments: '[{"href":"sovereign-enc:f1?k=K&m=image%2Fpng","name":"a.png"}]' }),
            task(2, { description: 'Child', parent_id: 1, is_completed: true, due_at: '2026-10-01T09:00:00Z' }),
            task(3, { description: 'Repeating', is_completed: true, schedule: sched }),
        ];
        const f = fakeActions(tasks);
        mount(f);
        open();
        await act(async () => { menuButton(/Delete checked/).click(); });
        await settle();
        await act(async () => { document.querySelector<HTMLButtonElement>('.notes-undo button')!.click(); });
        await settle(400);
        const adds = f.log.filter(l => l.startsWith('add('));
        expect(adds).toEqual(['add(Parent,-)', 'add(Child,901)', 'add(Repeating,-)']);
        expect(f.log).toContain('attach(901)');
        expect(f.log).toContain('due(902,2026-10-01T09:00:00Z)');
        expect(f.log).toContain('schedule(903,set)');
        // Completing a parent completes its subtree: the child is not toggled.
        expect(f.log.filter(l => l.includes(',true)'))).toEqual(['toggle(901,true)', 'toggle(903,true)']);
    });

    it('says how many DELETES failed — counted per request, never per swept child', async () => {
        // The two units this must not mix: a delete names a branch TOP, but
        // it sweeps that branch's whole subtree. Counting "swept ids that did
        // not go" against the number of roots is not a count of anything, and
        // goes negative the moment a branch with children succeeds beside a
        // lone item that fails.
        const tasks = [
            task(1, { is_completed: true }),
            task(2, { parent_id: 1, is_completed: true }),
            task(3, { parent_id: 1, is_completed: true }),
            task(4, { is_completed: true }),
        ];
        const f = fakeActions(tasks, { deleteOk: id => id !== 4 });
        mount(f);
        open();
        await act(async () => { menuButton(/Delete checked/).click(); });
        await settle();
        expect(f.log.filter(l => l.startsWith('delete'))).toEqual(['delete(1)', 'delete(4)']);
        expect(toasts.join('|')).toContain('Couldn\u2019t delete 1 of 2 items');
        // POSITIVE CONTROL: with both deletes accepted, nothing is said.
        act(() => { root.unmount(); root = createRoot(host); });
        toasts.length = 0;
        const g = fakeActions(tasks);
        mount(g);
        open();
        await act(async () => { menuButton(/Delete checked/).click(); });
        await settle();
        expect(toasts.join('|')).not.toMatch(/Couldn\u2019t delete/);
    });

    it('once the Undo window closes, the orphaned uploads are deleted — and only those', async () => {
        const tasks = [
            task(1, { is_completed: true, attachments: '[{"href":"sovereign-enc:gone1?k=K&m=image%2Fpng","name":"a.png"}]' }),
            task(2, { is_completed: false, attachments: '[{"href":"sovereign-enc:kept1?k=K&m=image%2Fpng","name":"b.png"}]' }),
        ];
        const f = fakeActions(tasks);
        mount(f);
        open();
        await act(async () => { menuButton(/Delete checked/).click(); });
        await settle();
        expect(deleteFiles).not.toHaveBeenCalled();   // still undoable
        act(() => { root.unmount(); });               // closing the note commits it
        expect(deleteFiles).toHaveBeenCalledWith(['gone1']);
        act(() => { root = createRoot(host); });      // afterEach unmounts something
    });
});

describe('offline', () => {
    it('refuses BOTH actions with a message and issues nothing (POSITIVE CONTROL below)', async () => {
        const tasks = [task(1, { is_completed: true })];
        const f = fakeActions(tasks);
        mount(f);
        onLine = false;
        open();
        await act(async () => { menuButton(/Uncheck all/).click(); });
        open();
        await act(async () => { menuButton(/Delete checked/).click(); });
        await settle(120);
        expect(f.log).toEqual([]);
        expect(toasts.join('|')).toMatch(/offline/);
        // POSITIVE CONTROL: back online, the same click runs.
        onLine = true;
        open();
        await act(async () => { menuButton(/Uncheck all/).click(); });
        await settle();
        expect(f.log).toEqual(['toggle(1,false)']);
    });

    it('is refused just as firmly while the outbox still holds changes', async () => {
        vi.mocked(pendingOutboxCount).mockReturnValue(3);
        const tasks = [task(1, { is_completed: true })];
        const f = fakeActions(tasks);
        mount(f);
        open();
        await act(async () => { menuButton(/Uncheck all/).click(); });
        await settle(120);
        expect(f.log).toEqual([]);
        expect(toasts.join('|')).toMatch(/waiting to sync/);
    });
});

describe('the button itself', () => {
    it('is not there when nothing is ticked', () => {
        const tasks = [task(1), task(2)];
        const f = fakeActions(tasks);
        mount(f);
        expect(document.querySelector('button[aria-label="List actions"]')).toBeNull();
    });
});
