/**
 * Checklist HEADINGS in Púca Notes' OPEN NOTE (NoteEditor): the real editor,
 * which hands TaskTree its own renderer (links + search marks), so a heading
 * must come through THAT path as its label — and its add row makes one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/openExternal', () => ({ openExternalUrl: vi.fn(), isExternalHref: () => true }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
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
import { type Task } from '../api/tasks';
import { type NoteCard } from '../notes/model/notesModel';
import { type NoteActions } from '../notes/model/notesQueries';

const task = (id: number, description: string): Task => ({
    id, channel_id: null, list_id: 5, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null,
});

const card = {
    ref: { kind: 'list', id: 5 }, key: 'list:5', title: 'Test checklist', body: null, noteAttachments: null,
    tasks: [], pinned: false, color: 'default', labels: [], archived: false, total: 1, completed: 0,
} as unknown as NoteCard;

const addTask = vi.fn(async (_ref: unknown, text: string) => task(99, text));
const actions = {
    content: {
        features: { body: true, attachments: false, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 },
        setBody: vi.fn(async () => true),
    },
    deleteTaskFrom: vi.fn(), addTask, setAttachments: vi.fn(), snoozeTask: vi.fn(),
    restoreCompleted: vi.fn(), toggleTask: vi.fn(), editTask: vi.fn(), moveTaskIn: vi.fn(),
    reorderTaskIn: vi.fn(), setDue: vi.fn(), setSchedule: vi.fn(), togglePin: vi.fn(),
    refreshNote: vi.fn(), renameNote: vi.fn(),
} as unknown as NoteActions;

let root: Root;
let container: HTMLDivElement;
const noop = () => { /* the editor's chrome is not under test */ };

function render(tasks: Task[], query?: string) {
    shownTasks.current = tasks;
    act(() => {
        root.render(
            <NoteEditor
                card={card} actions={actions} onClose={noop} onMenu={noop} onPickColor={noop}
                onPickLabels={noop} onArchive={noop} onSendToPuca={noop} pucaHref={null} query={query}
            />,
        );
    });
}

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    addTask.mockClear();
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
});

describe('a heading in the open note', () => {
    it('shows its label, no checkbox, and a search marks the label', () => {
        render([task(1, '## Calendar'), task(2, 'Snooze an item from the calendar')], 'calendar');
        const heading = document.querySelector('li.tt-item.tt-heading')!;
        expect(heading.querySelector('.tt-description')?.textContent).toBe('Calendar');
        expect(heading.querySelector('input[type="checkbox"]')).toBeNull();
        expect(heading.querySelector('mark.notes-hl')?.textContent).toBe('Calendar');
        // POSITIVE CONTROL: the item keeps its box, and its mark.
        const item = [...document.querySelectorAll('li.tt-item')].find(l => !l.classList.contains('tt-heading'))!;
        expect(item.querySelector('input[type="checkbox"]')).not.toBeNull();
        expect(item.querySelector('mark.notes-hl')?.textContent).toBe('calendar');
    });

    it('"# Groceries" in "Add an item…" adds a heading, stored as "## Groceries"; an item as typed', async () => {
        render([]);
        const input = document.querySelector<HTMLInputElement>('input[aria-label="New item"]')!;
        const add = async (text: string) => {
            await act(async () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await act(async () => { input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        };
        await add('# Groceries');
        expect(addTask).toHaveBeenLastCalledWith({ kind: 'list', id: 5 }, '## Groceries');
        await add('Milk');
        expect(addTask).toHaveBeenLastCalledWith({ kind: 'list', id: 5 }, 'Milk');
    });

    it('deleting a heading names it by its label in the Undo bar, never by its "## "', async () => {
        vi.mocked(actions.deleteTaskFrom).mockResolvedValue(true);
        render([task(1, '## Before you start'), task(2, 'Update the app')]);
        const del = async (text: string) => {
            const row = [...document.querySelectorAll('li.tt-item')].find(l => l.querySelector('.tt-description')?.textContent === text)!;
            await act(async () => { ([...row.querySelectorAll('button')].find(b => b.getAttribute('title') === 'Delete') as HTMLButtonElement).click(); });
        };
        await del('Before you start');
        expect(document.querySelector('.notes-undo')?.textContent).toContain('Deleted “Before you start”');
        expect(document.body.textContent).not.toContain('##');
        // POSITIVE CONTROL: an item is named as it is.
        await del('Update the app');
        expect(document.querySelector('.notes-undo')?.textContent).toContain('Deleted “Update the app”');
    });
});
