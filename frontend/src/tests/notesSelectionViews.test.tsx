/**
 * Bulk selection exists only on the note GRID (useNoteSelection.tsx).
 *
 * Reminders, Trash and Calendar fall back to the "all notes" filter under
 * the hood, so the grid's order still holds every live note there: Ctrl+A on
 * the Trash view used to select every live note, off screen, and the bar's
 * Delete then moved them all to the trash in one click. These drive the real
 * hook and the real SelectionBar through the routes the shell passes in.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { isGridPath, useBulkPending, useNoteSelection } from '../notes/components/useNoteSelection';
import { UNDO_WINDOW_MS } from '../notes/components/UndoBar';
import type { NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';

const card = (id: number): NoteCard => ({ key: `list:${id}`, ref: { kind: 'list', id }, title: `Note ${id}`, pinned: false, archived: false, color: 'default', labels: [] }) as unknown as NoteCard;
const CARDS = [card(1), card(2), card(3)];

function fakeActions() {
    const deleteNote = vi.fn(async () => true);
    const actions = {
        deleteNote,
        content: { trashEnabled: true, isSelfList: () => false },
    } as unknown as NoteActions;
    return { actions, deleteNote };
}

let setPath: (p: string) => void = () => {};
let selectedSize = -1;

function Shell({ actions, initial, noteOpen = false }: { actions: NoteActions; initial: string; noteOpen?: boolean }) {
    const [path, set] = useState(initial);
    setPath = set;
    const bulk = useBulkPending(actions);
    const selection = useNoteSelection({ visible: CARDS, actions, labels: [], bulk, grid: isGridPath(path), enabled: !noteOpen });
    selectedSize = selection.selected.size;
    return (
        <div>
            {CARDS.map(c => <button key={c.key} data-key={c.key} onClick={() => selection.onSelect(c)}>{c.key}</button>)}
            {selection.bar}
            {selection.undo}
        </div>
    );
}

let root: Root | null = null;
function mount(ui: React.ReactElement) {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root!.render(ui); });
}
const ctrlA = () => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })); });
const bar = () => document.querySelector('.notes-selectbar');
const deleteButton = () => document.querySelector<HTMLButtonElement>('.notes-selectbar button[aria-label="Delete selected"]');

afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('which routes are the grid', () => {
    it('Reminders, Trash and Calendar are not; the note views are', () => {
        expect(isGridPath('/trash')).toBe(false);
        expect(isGridPath('/calendar')).toBe(false);
        expect(isGridPath('/reminders')).toBe(false);
        for (const p of ['/', '/archive', '/label/Home']) expect(isGridPath(p), p).toBe(true);
    });
});

describe('Ctrl+A selects nothing off the grid', () => {
    for (const path of ['/trash', '/calendar', '/reminders']) {
        it(`on ${path}: no selection, no bar, no Delete`, () => {
            const { actions } = fakeActions();
            mount(<Shell actions={actions} initial={path} />);
            ctrlA();
            expect(selectedSize).toBe(0);
            expect(bar()).toBeNull();
            expect(deleteButton()).toBeNull();
        });
    }

    it('POSITIVE CONTROL: on the grid, Ctrl+A selects every visible note and the bar offers Delete', () => {
        const { actions } = fakeActions();
        mount(<Shell actions={actions} initial="/" />);
        ctrlA();
        expect(selectedSize).toBe(3);
        expect(bar()?.textContent).toMatch(/3 selected/);
        expect(deleteButton()).not.toBeNull();
    });

    it('with a note open the keyboard does not select either (the grid is behind it)', () => {
        const { actions } = fakeActions();
        mount(<Shell actions={actions} initial="/" noteOpen />);
        ctrlA();
        expect(selectedSize).toBe(0);
    });
});

describe('leaving the grid', () => {
    it('drops a selection made there — the bar does not follow into the Trash, and does not come back', () => {
        const { actions } = fakeActions();
        mount(<Shell actions={actions} initial="/" />);
        act(() => { document.querySelector<HTMLButtonElement>('[data-key="list:2"]')!.click(); });
        expect(bar()?.textContent).toMatch(/1 selected/);   // positive control: it was selected
        act(() => { setPath('/trash'); });
        expect(bar()).toBeNull();
        expect(deleteButton()).toBeNull();
        act(() => { setPath('/'); });
        expect(selectedSize).toBe(0);
        expect(bar()).toBeNull();
    });

    it('commits a bulk delete still waiting out its Undo, and shows no Undo off the grid', async () => {
        vi.useFakeTimers();
        const { actions, deleteNote } = fakeActions();
        mount(<Shell actions={actions} initial="/" />);
        ctrlA();
        act(() => { deleteButton()!.click(); });
        expect(document.querySelector('.notes-undo')?.textContent).toMatch(/Moving 3 notes to the trash/);
        expect(deleteNote).not.toHaveBeenCalled();          // still in its Undo window
        await act(async () => { setPath('/calendar'); });
        expect(document.querySelector('.notes-undo')).toBeNull();
        expect(deleteNote).toHaveBeenCalledTimes(3);
        // ...exactly once: the Undo's own timer is gone with it.
        await act(async () => { vi.advanceTimersByTime(UNDO_WINDOW_MS * 2); });
        expect(deleteNote).toHaveBeenCalledTimes(3);
    });
});
