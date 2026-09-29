/**
 * A calendar imported into "A new note…" makes a note like any other, so it
 * goes first among the unpinned — in BOTH front doors, which each hand the
 * import dialog its own way of making a list:
 *
 *  - Notes' /calendar places it through its own actions (placeNewNote: the
 *    order on screen at once, the save through the offline outbox);
 *  - Púca's Calendar tab has no copy of the order at hand, so it reads the
 *    server's, inserts and writes it back (api/listContent.ts
 *    placeNewListFirst).
 *
 * The dialog is replaced by a stub that keeps the `io` it was handed; what
 * is under test is that io — the wiring at each door, which the placement's
 * own suites (newNoteFirst.test.ts, notesNewNoteFirst.test.tsx) cannot see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ImportIO } from '../api/icsImport';

const h = vi.hoisted(() => ({
    io: [] as ImportIO[],
    createTaskList: vi.fn(async (title: string) => ({ id: 88, title, created_at: '', total_tasks: 0, completed_tasks: 0 })),
    placeNewListFirst: vi.fn(async () => []),
}));
vi.mock('../components/calendar/IcsImportDialog', () => ({
    IcsImportDialog: (p: { io: ImportIO }) => { h.io.push(p.io); return null; },
}));
vi.mock('../api/tasks', async (orig) => ({ ...(await orig<typeof import('../api/tasks')>()), createTaskList: h.createTaskList }));
vi.mock('../api/listContent', async (orig) => ({ ...(await orig<typeof import('../api/listContent')>()), placeNewListFirst: h.placeNewListFirst }));
vi.mock('../api/ics', async (orig) => ({ ...(await orig<typeof import('../api/ics')>()), parseIcs: () => ({ items: [], notes: [] }) }));
vi.mock('../components/calendar/Calendar', () => ({ Calendar: () => null }));
vi.mock('../components/calendar/calendarGate', () => ({ useCoarseCalendar: () => false }));
vi.mock('../components/taskSources', () => ({
    taskScopeKey: (kind: string, id: number) => ['tasks-calendar', kind, id],
    useTaskSources: () => ({ sources: [], tasksIn: () => [], refetch: async () => {} }),
}));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => true, hasTaskFeature: () => true }));

import { CalendarView } from '../notes/components/CalendarView';
import { TasksCalendar } from '../components/calendar/TasksCalendar';
import type { NoteActions } from '../notes/model/notesQueries';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    h.io.length = 0;
    vi.clearAllMocks();
});

function render(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>));
    return host;
}

/** Pick a calendar file and let the dialog open with its io. */
async function openImport(el: HTMLElement): Promise<ImportIO> {
    const input = el.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input, 'the hidden file input').toBeTruthy();
    const file = { name: 'trip.ics', size: 40, text: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' } as unknown as File;
    Object.defineProperty(input, 'files', { value: { 0: file, length: 1, item: () => file }, configurable: true });
    act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
    const io = h.io.at(-1);
    expect(io, 'the import dialog opened').toBeTruthy();
    return io!;
}

describe('a calendar imported into a new note puts that note first among the unpinned', () => {
    it('Notes’ /calendar: through its own placeNewNote, once the list is made', async () => {
        const placeNewNote = vi.fn();
        const actions = { placeNewNote } as unknown as NoteActions;
        const io = await openImport(render(
            <MemoryRouter initialEntries={['/calendar?v=month']}>
                <CalendarView cards={[]} actions={actions} now={Date.parse('2030-10-01T12:00:00Z')} onOpenNote={() => {}} shortcutsEnabled={false} />
            </MemoryRouter>,
        ));
        expect(placeNewNote).not.toHaveBeenCalled();          // nothing is placed before a list exists
        const made = await io.createList('Trip', 'key-1');
        expect(made.id).toBe(88);
        expect(h.createTaskList).toHaveBeenCalledWith('Trip', 'key-1');
        expect(placeNewNote).toHaveBeenCalledWith({ kind: 'list', id: 88 });
        expect(h.placeNewListFirst).not.toHaveBeenCalled();   // Notes has the order at hand
    });

    it('Púca’s Calendar tab: read, insert and write back the server’s order', async () => {
        const io = await openImport(render(<TasksCalendar lists={[]} channels={[]} currentUserId={3} onOpen={() => {}} />));
        expect(h.placeNewListFirst).not.toHaveBeenCalled();
        const made = await io.createList('Trip');
        expect(made.id).toBe(88);
        expect(h.placeNewListFirst).toHaveBeenCalledWith(88);
    });

    it('a list that could not be made places nothing', async () => {
        h.createTaskList.mockRejectedValueOnce(new Error('refused'));
        const io = await openImport(render(<TasksCalendar lists={[]} channels={[]} currentUserId={3} onOpen={() => {}} />));
        await expect(io.createList('Trip')).rejects.toThrow('refused');
        expect(h.placeNewListFirst).not.toHaveBeenCalled();
    });
});
