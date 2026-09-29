/**
 * Checklist HEADINGS on two of the surfaces that render items, with their
 * real row renderers: a channel checklist (ChecklistBody — the side panel, a
 * checklist channel, the All-checklists board and the Tasks board's cards all
 * render it) and a Púca Notes card in the grid, which draws its own compact
 * rows instead of TaskTree. (Púca's Tasks view: tasksViewHeadings.test.tsx.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { listTasks, listListTasks, createTask, createListTask } = vi.hoisted(() => ({
    listTasks: vi.fn(), listListTasks: vi.fn(), createTask: vi.fn(), createListTask: vi.fn(),
}));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, listTasks, listListTasks, createTask, createListTask };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({
    wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} },
}));

import { ChecklistBody } from '../components/ChecklistBody';
import { NoteCard } from '../notes/components/NoteCard';
import { buildNoteCards } from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import type { NoteActions } from '../notes/model/notesQueries';
import type { Task } from '../api/tasks';

const task = (id: number, description: string, o: Partial<Task> = {}): Task => ({
    id, channel_id: 9, list_id: null, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01T00:00:00Z', created_by: 7, attachments: null, due_at: null, ...o,
});

let root: Root;
let host: HTMLDivElement;
let nextId: number;
beforeEach(() => {
    nextId = 50;
    listTasks.mockReset(); listListTasks.mockReset(); createTask.mockReset(); createListTask.mockReset();
    createTask.mockImplementation(async (_c: number, text: string) => task(nextId++, text, { position: nextId }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const rowOf = (text: string) => [...host.querySelectorAll('li')].find(l => l.textContent?.includes(text)) ?? null;

describe('a channel checklist (ChecklistBody)', () => {
    async function mount() {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        await act(async () => { root.render(<QueryClientProvider client={qc}><ChecklistBody channelId={9} currentUserId={7} /></QueryClientProvider>); });
        await settle();
    }

    it('renders a heading as a heading: its label, no checkbox; the items keep theirs', async () => {
        listTasks.mockResolvedValue([task(1, '## Before you start'), task(2, 'Update the app')]);
        await mount();
        const heading = rowOf('Before you start')!;
        expect(heading.classList.contains('tt-heading')).toBe(true);
        expect(heading.querySelector('input[type="checkbox"]')).toBeNull();
        expect(host.textContent).not.toContain('## ');
        expect(rowOf('Update the app')!.querySelector('input[type="checkbox"]')).not.toBeNull();
    });

    it('"# Section" typed into "Add an item…" makes a heading, stored as "## Section"', async () => {
        listTasks.mockResolvedValue([]);
        await mount();
        const input = host.querySelector<HTMLInputElement>('.checklist-add input')!;
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '# Section');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { host.querySelector('form.checklist-add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settle();
        expect(createTask).toHaveBeenCalledWith(9, '## Section', undefined, undefined, expect.any(String));
        expect(rowOf('Section')!.classList.contains('tt-heading')).toBe(true);
        // POSITIVE CONTROL: an item is stored as typed.
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#1 thing');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await act(async () => { host.querySelector('form.checklist-add')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
        await settle();
        expect(createTask).toHaveBeenLastCalledWith(9, '#1 thing', undefined, undefined, expect.any(String));
        expect(rowOf('#1 thing')!.querySelector('input[type="checkbox"]')).not.toBeNull();
    });
});

describe('a Púca Notes card in the grid', () => {
    const actions = { togglePin: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions;
    function render(tasks: Task[], query?: string) {
        const card = buildNoteCards([{ ref: { kind: 'list', id: 7 }, title: 'Test checklist' }], new Map([['list:7', tasks]]), [], EMPTY_KEEP_PREFS)[0];
        act(() => {
            root.render(
                <NoteCard
                    card={card} actions={actions} now={Date.parse('2026-09-29T10:00:00Z')} compactTools={false}
                    onOpen={() => {}} onMenu={() => {}} onPickColor={() => {}} onPickLabels={() => {}}
                    onLabelClick={() => {}} onArchive={() => {}} registerEl={() => {}} query={query}
                />,
            );
        });
    }

    it('previews a heading as a heading, no box to tick, and leaves it out of "done/total"', () => {
        render([
            { ...task(1, '## Before you start'), channel_id: null, list_id: 7 },
            { ...task(2, 'Update the app', { is_completed: true }), channel_id: null, list_id: 7 },
            { ...task(3, 'Open each app'), channel_id: null, list_id: 7 },
        ]);
        const heading = host.querySelector('.notes-card-item.heading');
        expect(heading?.textContent).toBe('Before you start');
        expect(heading?.querySelector('input[type="checkbox"]')).toBeNull();
        const item = [...host.querySelectorAll('.notes-card-item')].find(l => l.textContent?.includes('Open each app'));
        expect(item?.querySelector('input[type="checkbox"]')).not.toBeNull();
        expect(host.querySelector('.notes-chip.progress')?.textContent).toBe('1/2');
        expect(host.textContent).not.toContain('## ');
    });

    it('a search hit on a heading the card cannot show says so by its label', () => {
        const eight = Array.from({ length: 8 }, (_, i) => ({ ...task(i + 1, `step ${i + 1}`), channel_id: null, list_id: 7 }));
        render([...eight, { ...task(9, '## Calendar'), channel_id: null, list_id: 7 }], 'calendar');
        const found = [...host.querySelectorAll('.notes-card-found-row')].map(r => r.textContent ?? '');
        expect(found).toEqual(['further downCalendar']);
    });
});
