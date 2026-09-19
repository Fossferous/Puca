/**
 * "Hide checkboxes" turns a note's items into lines of text. Items that
 * carried attachments lose them, and while Undo is offered the uploads stay
 * (Undo re-creates the items with the same refs). Once Undo can no longer
 * happen — the window expires, or the note closes — nothing names those
 * files any more, so they are deleted instead of left on the server counting
 * against the owner's quota. Undo itself deletes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { del } = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: del, put: vi.fn() } };
});

import { NoteContentSection } from '../notes/components/NoteContentSection';
import { UNDO_WINDOW_MS } from '../notes/components/UndoBar';
import { type Task } from '../api/tasks';
import { type NoteCard } from '../notes/model/notesModel';
import { type NoteActions } from '../notes/model/notesQueries';

const ref = (id: string) => ({ href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent('image/png')}`, name: `${id}.png` });
function task(id: number, o: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 5, parent_id: null, description: `item ${id}`, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
    };
}
const TASKS = [task(1, { attachments: JSON.stringify([ref('f1'), ref('f2')]) }), task(2)];
const card = { ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Packing', body: null, noteAttachments: null } as unknown as NoteCard;

function fakeActions() {
    return {
        content: {
            features: { body: true, attachments: false, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 },
            setBody: vi.fn(async () => true),
        },
        deleteTaskFrom: vi.fn(async () => true),
        addTask: vi.fn(async (_ref: unknown, text: string) => task(100, { description: text })),
        setDue: vi.fn(async () => true),
        setAttachments: vi.fn(async () => true),
        toggleTask: vi.fn(async () => true),
    } as unknown as NoteActions;
}

let root: Root;
let container: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const fileDeletes = () => del.mock.calls.map(c => c[0] as string).filter(p => p.startsWith('/files/')).sort();

async function hideCheckboxes(actions: NoteActions) {
    act(() => { root.render(<NoteContentSection card={card} actions={actions} tasks={TASKS} tasksLoaded />); });
    const btn = [...container.querySelectorAll('button')].find(b => b.textContent === 'Hide checkboxes') as HTMLButtonElement;
    expect(btn, 'the Hide checkboxes control').toBeTruthy();
    await act(async () => { btn.click(); });
    await flush();
    expect(document.body.textContent).toMatch(/Turned the checklist into text/);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    del.mockReset();
    del.mockResolvedValue({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Hide checkboxes and the dropped items’ files', () => {
    it('keeps the files while Undo is offered, and deletes them when the window expires', async () => {
        await hideCheckboxes(fakeActions());
        expect(fileDeletes()).toEqual([]);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS); });
        await flush();
        expect(fileDeletes()).toEqual(['/files/f1', '/files/f2']);
    });

    it('closing the note ends the Undo too, and deletes them', async () => {
        await hideCheckboxes(fakeActions());
        act(() => { root.render(<></>); });
        await flush();
        expect(fileDeletes()).toEqual(['/files/f1', '/files/f2']);
    });

    it('POSITIVE CONTROL: Undo deletes nothing — the re-created item gets the same files back', async () => {
        const actions = fakeActions();
        await hideCheckboxes(actions);
        const undo = [...document.querySelectorAll('button')].find(b => b.textContent === 'Undo') as HTMLButtonElement;
        await act(async () => { undo.click(); });
        await flush();
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        act(() => { root.render(<></>); });
        await flush();
        expect(fileDeletes()).toEqual([]);
        expect(actions.setAttachments).toHaveBeenCalledWith(card.ref, expect.anything(), [ref('f1'), ref('f2')]);
    });
});
