/**
 * Deleting an item in the open note offers Undo, and the item's uploads live
 * or die with that Undo.
 *
 * Before this, the trash icon in an item's row was an irreversible cascade
 * with nothing between it and a finger — the row is 30px on a phone and the
 * icon is permanently visible there — and every picture the deleted items
 * named was orphaned on the server against the owner's quota, with no code
 * path that could ever name it again.
 *
 * The cleanup asks what the note holds AT THAT MOMENT and never deletes a
 * file a live item still names, so these drive the editor the way the app
 * does: the delete empties the note's task cache and the editor re-renders
 * without those items before the window runs out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { del } = vi.hoisted(() => ({ del: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: del, put: vi.fn() } };
});
const { shownTasks } = vi.hoisted(() => ({ shownTasks: { current: [] as unknown[] } }));
vi.mock('../notes/model/notesQueries', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesQueries')>();
    return { ...real, useNoteTasks: () => ({ data: shownTasks.current, isPending: false, isFetching: false }) };
});
vi.mock('../api/taskFeatures', async (orig) => ({
    ...(await orig<typeof import('../api/taskFeatures')>()), useTaskFeature: () => true,
}));

import { NoteEditor } from '../notes/components/NoteEditor';
import { TaskTree } from '../components/TaskTree';
import { UNDO_WINDOW_MS } from '../notes/components/UndoBar';
import { type Task } from '../api/tasks';
import { type NoteCard } from '../notes/model/notesModel';
import { type NoteActions } from '../notes/model/notesQueries';

const fileRef = (id: string) => ({ href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent('image/png')}`, name: `${id}.png` });
function task(id: number, o: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 5, parent_id: null, description: `item ${id}`, is_completed: false,
        position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
    };
}
const MILK = task(1, { description: 'Milk', attachments: JSON.stringify([fileRef('f1')]) });
const SEMI = task(2, { description: 'Semi-skimmed', parent_id: 1, attachments: JSON.stringify([fileRef('f2')]) });
const EGGS = task(3, { description: 'Eggs', attachments: JSON.stringify([fileRef('f3')]) });
const ALL = [MILK, SEMI, EGGS];

const card = {
    ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Groceries', body: null, noteAttachments: null,
    tasks: ALL, pinned: false, color: 'default', labels: [], archived: false, total: 3, completed: 0,
} as unknown as NoteCard;

function fakeActions() {
    let next = 900;
    return {
        content: {
            features: { body: true, attachments: false, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 },
            setBody: vi.fn(async () => true),
        },
        deleteTaskFrom: vi.fn(async () => true),
        addTask: vi.fn(async (_r: unknown, text: string, parentId?: number) => task(next++, { description: text, parent_id: parentId ?? null })),
        setAttachments: vi.fn(async () => undefined),
        snoozeTask: vi.fn(async () => undefined),
        restoreCompleted: vi.fn(async () => undefined),
        toggleTask: vi.fn(async () => undefined),
        editTask: vi.fn(), moveTaskIn: vi.fn(), reorderTaskIn: vi.fn(), setDue: vi.fn(), setSchedule: vi.fn(),
        togglePin: vi.fn(), refreshNote: vi.fn(), renameNote: vi.fn(),
    } as unknown as NoteActions;
}

let root: Root;
let container: HTMLDivElement;
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const fileDeletes = () => del.mock.calls.map(c => c[0] as string).filter(p => p.startsWith('/files/')).sort();
const noop = () => { /* the editor's chrome is not under test */ };

function render(actions: NoteActions) {
    act(() => {
        root.render(
            <NoteEditor
                card={card} actions={actions} onClose={noop} onMenu={noop} onPickColor={noop}
                onPickLabels={noop} onArchive={noop} pucaHref={null}
            />,
        );
    });
}
const rowButton = (text: string, title: string) => {
    const row = [...document.querySelectorAll('.tt-item')].find(li => li.textContent?.includes(text));
    expect(row, `the row for ${text}`).toBeTruthy();
    return [...row!.querySelectorAll('button')].find(b => b.title === title) as HTMLButtonElement;
};
const undoButton = () => [...document.querySelectorAll('.notes-undo button')][0] as HTMLButtonElement | undefined;

/** Delete "Milk" (which has a child) and let the editor re-render without it. */
async function deleteMilk(actions: NoteActions) {
    shownTasks.current = ALL;
    render(actions);
    await act(async () => { rowButton('Milk', 'Delete').click(); });
    await flush();
    shownTasks.current = [EGGS];
    render(actions);
    await flush();
}

beforeEach(() => {
    vi.useFakeTimers();
    del.mockReset();
    del.mockResolvedValue({});
    shownTasks.current = ALL;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('deleting an item in the open note', () => {
    it('deletes it and offers Undo, naming what went', async () => {
        const actions = fakeActions();
        await deleteMilk(actions);
        expect(actions.deleteTaskFrom).toHaveBeenCalledTimes(1);
        expect(actions.deleteTaskFrom).toHaveBeenCalledWith(card.ref, 1);
        expect(document.querySelector('.notes-undo')?.textContent).toMatch(/Deleted .*Milk/);
    });

    it('Undo puts the subtree back, nested, and deletes nothing', async () => {
        const actions = fakeActions();
        await deleteMilk(actions);
        await act(async () => { undoButton()!.click(); });
        await flush();
        expect(vi.mocked(actions.addTask).mock.calls.map(c => [c[1], c[2]]))
            .toEqual([['Milk', undefined], ['Semi-skimmed', 900]]);
        expect(actions.setAttachments).toHaveBeenCalledTimes(2);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        act(() => { root.render(<></>); });
        await flush();
        expect(fileDeletes()).toEqual([]);
    });

    it('Undo of a NESTED item puts it back under the live parent it hung under', async () => {
        const actions = fakeActions();
        shownTasks.current = ALL;
        render(actions);
        await act(async () => { rowButton('Semi-skimmed', 'Delete').click(); });
        await flush();
        shownTasks.current = [MILK, EGGS];
        render(actions);
        await flush();
        expect(actions.deleteTaskFrom).toHaveBeenCalledWith(card.ref, 2);
        await act(async () => { undoButton()!.click(); });
        await flush();
        // Milk is untouched and alive, so the child goes straight back under
        // its id — not dropped for want of a mapping the snapshot never had.
        expect(vi.mocked(actions.addTask).mock.calls.map(c => [c[1], c[2]]))
            .toEqual([['Semi-skimmed', 1]]);
    });

    it('keeps the pictures while Undo is offered, and deletes them once it is gone', async () => {
        await deleteMilk(fakeActions());
        expect(fileDeletes()).toEqual([]);
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS); });
        await flush();
        // f3 belongs to Eggs, which is still there.
        expect(fileDeletes()).toEqual(['/files/f1', '/files/f2']);
    });

    it('closing the note ends the Undo too', async () => {
        await deleteMilk(fakeActions());
        act(() => { root.render(<></>); });
        await flush();
        expect(fileDeletes()).toEqual(['/files/f1', '/files/f2']);
    });

    it('POSITIVE CONTROL: a refused delete offers no Undo and touches no files', async () => {
        const actions = fakeActions();
        vi.mocked(actions.deleteTaskFrom).mockResolvedValue(false);
        shownTasks.current = ALL;
        render(actions);
        await act(async () => { rowButton('Milk', 'Delete').click(); });
        await flush();
        expect(document.querySelector('.notes-undo')).toBeNull();
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        act(() => { root.render(<></>); });
        await flush();
        expect(fileDeletes()).toEqual([]);
    });
});

/**
 * NEGATIVE CONTROL for the shared component. TaskTree is also Púca's Tasks
 * view and its channel checklists, where the Undo snackbar's CSS does not
 * exist; the new prop is optional and those callers must be byte-identical to
 * what they were.
 */
describe('TaskTree without the Notes editor', () => {
    it('deletes through onDelete alone, and shows no undo bar', async () => {
        const onDelete = vi.fn();
        act(() => {
            root.render(
                <TaskTree
                    tasks={ALL} onToggle={() => {}} onDelete={onDelete} onEdit={() => {}}
                    onAddSubtask={() => {}} onMove={() => {}} onSetAttachments={() => {}}
                />,
            );
        });
        await act(async () => { rowButton('Milk', 'Delete').click(); });
        await flush();
        expect(onDelete).toHaveBeenCalledWith(1);
        expect(document.querySelector('.notes-undo')).toBeNull();
    });
});
