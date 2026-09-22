/**
 * The open note's two conversions (NoteContentSection.tsx) against the
 * offline outbox and a server that can refuse part-way.
 *
 * "Show checkboxes" used to add every item first and clear the text last.
 * Offline the items queued as temporary ones, the text clear then failed, and
 * the note kept its text AND a queued duplicate of every line — with no
 * message. It is now refused while offline or while anything is queued, and
 * it clears the text first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/listContent', async (orig) => {
    const real = await orig<typeof import('../api/listContent')>();
    return { ...real, deleteFiles: vi.fn(async () => {}) };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, pendingOutboxCount: vi.fn(() => 0) };
});

import { NoteContentSection } from '../notes/components/NoteContentSection';
import { pendingOutboxCount } from '../notes/model/notesOutbox';
import { deleteFiles } from '../api/listContent';
import { UNDO_WINDOW_MS } from '../notes/components/UndoBar';
import { setMessageToastSink } from '../components/messageToastBus';
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';
import type { Task } from '../api/tasks';

const LIST = { kind: 'list' as const, id: 1 };
const card = { key: 'list:1', ref: LIST, title: 'Shopping', body: 'milk\neggs\nbread', noteAttachments: null } as unknown as NoteCard;
const made = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false, position: id,
    created_at: '', created_by: 7, attachments: null, due_at: null,
});

let log: string[];
let toasts: string[];
function fakeActions(opts: { setBodyOk?: (body: string) => boolean; refuseItem?: string } = {}) {
    let next = 100;
    // The real setBody is tri-state now (useListContent.ts SaveOutcome): a
    // save that only QUEUED is not a failure, and only 'failed' is.
    const setBody = vi.fn(async (_id: number, body: string) => { log.push(`setBody(${JSON.stringify(body)})`); return (opts.setBodyOk ? opts.setBodyOk(body) : true) ? 'saved' as const : 'failed' as const; });
    const addTask = vi.fn(async (_n: unknown, text: string) => { log.push(`addTask(${text})`); return text === opts.refuseItem ? null : made(next++, text); });
    const deleteTaskFrom = vi.fn(async (_n: unknown, id: number) => { log.push(`delete(${id})`); return true; });
    const actions = {
        addTask, deleteTaskFrom,
        content: { features: { body: true, attachments: false }, setBody },
    } as unknown as NoteActions;
    return { actions, setBody, addTask, deleteTaskFrom };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let onLine = true;
let spy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
    log = [];
    toasts = [];
    onLine = true;
    vi.mocked(pendingOutboxCount).mockReturnValue(0);
    spy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => onLine);
    setMessageToastSink(t => { toasts.push(t.title); });
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    setMessageToastSink(null);
    spy?.mockRestore();
});

async function convert(actions: NoteActions) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(<NoteContentSection card={card} actions={actions} tasks={[]} tasksLoaded />); });
    const btn = [...host!.querySelectorAll('button')].find(b => b.textContent === 'Show checkboxes')!;
    expect(btn).toBeTruthy();
    await act(async () => { btn.click(); });
    for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
}

describe('Show checkboxes never half-applies', () => {
    it('offline: refused with a message — no item queued, the text untouched', async () => {
        onLine = false;
        const f = fakeActions();
        await convert(f.actions);
        expect(f.addTask).not.toHaveBeenCalled();
        expect(f.setBody).not.toHaveBeenCalled();
        expect(toasts).toEqual([expect.stringMatching(/needs a connection, and nothing waiting to sync/)]);
    });

    it('with changes still queued: refused the same way (every item would queue behind them)', async () => {
        vi.mocked(pendingOutboxCount).mockReturnValue(2);
        const f = fakeActions();
        await convert(f.actions);
        expect(f.addTask).not.toHaveBeenCalled();
        expect(f.setBody).not.toHaveBeenCalled();
        expect(toasts).toHaveLength(1);
    });

    it('POSITIVE CONTROL: online with nothing queued, the text is cleared FIRST, then every line becomes an item', async () => {
        const f = fakeActions();
        await convert(f.actions);
        expect(log).toEqual(['setBody("")', 'addTask(milk)', 'addTask(eggs)', 'addTask(bread)']);
        expect(toasts).toEqual([]);
        expect(document.querySelector('.notes-undo')?.textContent).toMatch(/Turned the text into a checklist/);
    });

    it('the text cannot be cleared: nothing else happens, and it says so', async () => {
        const f = fakeActions({ setBodyOk: () => false });
        await convert(f.actions);
        expect(f.addTask).not.toHaveBeenCalled();
        expect(toasts).toEqual(['Couldn’t turn the text into a checklist — the text is kept']);
    });

    it('an item refused part-way: the text comes back and the items made so far are removed', async () => {
        const f = fakeActions({ refuseItem: 'eggs' });
        await convert(f.actions);
        expect(log).toEqual(['setBody("")', 'addTask(milk)', 'addTask(eggs)', 'setBody("milk\\neggs\\nbread")', 'delete(100)']);
        expect(toasts).toEqual(['Not every line became an item — the text is kept']);
        expect(document.querySelector('.notes-undo')).toBeNull();
    });
});

describe('Hide checkboxes deletes only the files of items that actually left', () => {
    const file = (id: string) => JSON.stringify([{ href: `sovereign-enc:${id}?k=KEY&m=image%2Fpng`, name: `${id}.png` }]);
    const items = [
        made(1, 'milk'), { ...made(2, 'eggs'), attachments: file('eggsfile') },
        { ...made(3, 'bread'), attachments: file('breadfile') },
    ];

    function mountHide(actions: NoteActions, tasks: Task[]) {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const noText = { ...card, body: null } as unknown as NoteCard;
        act(() => { root!.render(<NoteContentSection card={noText} actions={actions} tasks={tasks} tasksLoaded />); });
        return (next: Task[]) => act(() => { root!.render(<NoteContentSection card={noText} actions={actions} tasks={next} tasksLoaded />); });
    }
    async function hide() {
        const btn = [...host!.querySelectorAll('button')].find(b => b.textContent === 'Hide checkboxes')!;
        await act(async () => { btn.click(); });
        for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
    }

    beforeEach(() => { vi.mocked(deleteFiles).mockClear(); vi.spyOn(window, 'confirm').mockReturnValue(true); });

    it('one delete fails: that item keeps its file, stays an item, and the text gets only the others', async () => {
        vi.useFakeTimers();
        const f = fakeActions();
        f.deleteTaskFrom.mockImplementation(async (_n: unknown, id: number) => { log.push(`delete(${id})`); return id !== 3; });
        const rerender = mountHide(f.actions, items);
        await hide();
        expect(log.filter(l => l.startsWith('delete'))).toEqual(['delete(1)', 'delete(2)', 'delete(3)']);
        expect(f.setBody.mock.calls.map(c => c[1]).at(-1)).toBe('milk\neggs');     // not "bread": it is still an item
        expect(toasts).toEqual(['Not every item became text — the rest are still items']);
        // What the editor shows by then does not matter here: even with no
        // live item naming it, bread's file is not the conversion's to delete.
        rerender([]);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 10); });
        expect(deleteFiles).toHaveBeenCalledTimes(1);
        expect(vi.mocked(deleteFiles).mock.calls[0][0]).toEqual(['eggsfile']);
        vi.useRealTimers();
    });

    it('a file a live item names again by the time the Undo closes is never deleted', async () => {
        vi.useFakeTimers();
        const f = fakeActions();
        const rerender = mountHide(f.actions, items);
        await hide();
        // e.g. a refetch brought an item back that still names eggs' picture
        rerender([{ ...made(9, 'eggs again'), attachments: file('eggsfile') }]);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 10); });
        expect(vi.mocked(deleteFiles).mock.calls.map(c => c[0])).toEqual([['breadfile']]);
        vi.useRealTimers();
    });

    it('POSITIVE CONTROL: every delete succeeds — every dropped file is deleted once the Undo closes', async () => {
        vi.useFakeTimers();
        const f = fakeActions();
        const rerender = mountHide(f.actions, items);
        await hide();
        expect(f.setBody.mock.calls.map(c => c[1])).toEqual(['milk\neggs\nbread']);
        expect(deleteFiles).not.toHaveBeenCalled();                                   // kept for the Undo
        rerender([]);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 10); });
        expect(vi.mocked(deleteFiles).mock.calls.map(c => [...c[0]].sort())).toEqual([['breadfile', 'eggsfile']]);
        vi.useRealTimers();
    });
});
