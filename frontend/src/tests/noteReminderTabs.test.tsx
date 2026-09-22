/**
 * A NOTE'S OWN reminder (migration 068) in PÚCA — not in Púca Notes.
 *
 * The control that SETS one is in Púca's Tasks view, beside the list title,
 * and the server serves the row in GET /task-reminders under the negative id
 * `-list_id`. But the two pinned tabs that show dated things read
 * useTaskSources, which built its CalendarSources from channel_tasks rows
 * only — so the thing you had just set had nowhere to appear, and every
 * `isNote` branch written for it (the bell, "This note itself" and Clear in
 * RemindersList, the bell and the missing tick/drag/snooze in Calendar) was
 * unreachable from Púca. Neither feature branch could see it alone: the one
 * that added note reminders had no Reminders tab to feed, and the one that
 * added the tabs had no note reminders to project.
 *
 * So these pin the projection at the SOURCE — which is what both tabs read —
 * and then the row itself. Every case has its opposite number: the same list
 * with the feature off, and a dated ITEM in the same list that must keep
 * rendering either way, so "no note row" can never mean "nothing rendered".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { listListTasks, listTasks } = vi.hoisted(() => ({
    listListTasks: vi.fn(async () => [] as unknown[]),
    listTasks: vi.fn(async () => [] as unknown[]),
}));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, listListTasks, listTasks };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', async (orig) => ({
    ...(await orig<typeof import('../api/taskFeatures')>()), useTaskFeature: () => true,
}));

import { useTaskSources } from '../components/taskSources';
import { TasksReminders } from '../components/reminders/TasksReminders';
import { type CalendarSource } from '../api/taskCalendar';
import { groupReminderSources } from '../api/reminderGroups';
import type { Task, TaskList } from '../api/tasks';

/** Far enough ahead to land in "Upcoming" whenever this suite runs. */
const SOON = '2030-10-07T09:00:00.000Z';

const vetList = { id: 7, title: 'Call the vet', created_at: '2030-09-01T00:00:00Z', total_tasks: 1, completed_tasks: 0, due_at: SOON } as TaskList;
const plainList = { id: 8, title: 'Shopping', created_at: '2030-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0 } as TaskList;
const vetItem = {
    id: 5, channel_id: null, list_id: 7, parent_id: null, description: 'Book the appointment', is_completed: false,
    position: 1, created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: SOON,
} as Task;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    listListTasks.mockReset();
    listListTasks.mockResolvedValue([]);
    vi.clearAllMocks();
});

function mount(ui: React.ReactNode) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>));
}

/** Settle the two useQueries reads the hook makes AND the render they cause:
 *  a microtask loop alone let a run land between the two, which is how a
 *  first cut of this file "passed" 5 tests in one run and 6 in the next. */
async function flush() {
    for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => { setTimeout(r, 0); }); });
}

// ---- the shared projection, which is what BOTH tabs read --------------------

/** The hook's answer, rendered so the test can read it without writing to a
 *  prop or a module slot from inside a render (react-hooks/immutability and
 *  react-hooks/globals both refuse that, rightly). */
function Probe({ lists, noteReminders }: { lists: TaskList[]; noteReminders: boolean }) {
    const { sources } = useTaskSources(lists, [], 2, { noteReminders });
    return <i data-sources={JSON.stringify(sources)} />;
}

async function sourcesFor(lists: TaskList[], noteReminders: boolean): Promise<CalendarSource[]> {
    mount(<Probe lists={lists} noteReminders={noteReminders} />);
    await flush();
    const el = document.querySelector('[data-sources]');
    expect(el, 'the probe never rendered').not.toBeNull();
    return JSON.parse(el!.getAttribute('data-sources')!) as CalendarSource[];
}

describe('a list that carries its own reminder reaches the dated tabs', () => {
    it('is projected exactly once, as the note it is', async () => {
        listListTasks.mockResolvedValue([vetItem]);
        const sources = await sourcesFor([vetList], true);
        const notes = sources.filter(s => s.isNote);
        expect(notes.length).toBe(1);
        expect(notes[0].task.id).toBe(-7);                    // the reminder feed's own namespace
        expect(notes[0].task.description).toBe('Call the vet');
        expect(notes[0].task.due_at).toBe(SOON);
        expect(notes[0].noteKey).toBe('list:7');
        // Both tabs read this one array, and canEdit is what opens the
        // calendar's drag, Move, Skip and "Date & repeat…" — each of which
        // would PATCH /tasks/-7, a route that does not exist.
        expect(notes[0].canEdit).toBe(false);
        expect(notes[0].canComplete).toBe(false);
        // And the list's own dated ITEM is still there beside it.
        expect(sources.filter(s => !s.isNote).map(s => s.task.id)).toEqual([5]);
    });

    it('POSITIVE CONTROL: with the feature off the note is not projected — the item still is', async () => {
        listListTasks.mockResolvedValue([vetItem]);
        const sources = await sourcesFor([vetList], false);
        expect(sources.filter(s => s.isNote)).toEqual([]);
        expect(sources.filter(s => !s.isNote).map(s => s.task.id)).toEqual([5]);
    });

    it('POSITIVE CONTROL: a list with no timing of its own projects nothing extra', async () => {
        const sources = await sourcesFor([plainList], true);
        expect(sources).toEqual([]);
    });

    it('makes exactly one Reminders row out of it', async () => {
        listListTasks.mockResolvedValue([]);
        const sources = await sourcesFor([vetList], true);
        const groups = groupReminderSources(sources, Date.parse('2030-10-01T09:00:00.000Z'));
        const rows = [...groups.overdue, ...groups.today, ...groups.upcoming].filter(r => r.source.isNote);
        expect(rows.length).toBe(1);
        expect(rows[0].at).toBe(Date.parse(SOON));
    });
});

// ---- the row Púca's Reminders tab draws for it ------------------------------

const noteRows = () => [...document.querySelectorAll('.notes-reminder-row.note')];
const allRows = () => [...document.querySelectorAll('.notes-reminder-row')];

describe('Púca’s Reminders tab draws the note’s own reminder', () => {
    it('as a bell with "This note itself", no tick box and no snooze', async () => {
        listListTasks.mockResolvedValue([]);
        mount(<TasksReminders lists={[vetList]} channels={[]} currentUserId={2} noteReminders onOpen={() => {}} />);
        await flush();
        expect(noteRows().length).toBe(1);
        const row = noteRows()[0];
        expect(row.textContent).toContain('Call the vet');
        expect(row.textContent).toContain('This note itself');
        expect(row.querySelector('input[type="checkbox"]')).toBeNull();
        expect(row.querySelector('.notes-snooze')).toBeNull();
    });

    it('POSITIVE CONTROL: with the feature off the row is gone, and a dated item still draws one', async () => {
        listListTasks.mockResolvedValue([vetItem]);
        mount(<TasksReminders lists={[vetList]} channels={[]} currentUserId={2} noteReminders={false} onOpen={() => {}} />);
        await flush();
        expect(noteRows()).toEqual([]);
        expect(allRows().length).toBe(1);
        expect(allRows()[0].textContent).toContain('Book the appointment');
        expect(allRows()[0].querySelector('input[type="checkbox"]')).not.toBeNull();
    });

    it('Clear asks the view that owns the lists to clear THAT list', async () => {
        const cleared: number[] = [];
        listListTasks.mockResolvedValue([]);
        mount(<TasksReminders lists={[vetList]} channels={[]} currentUserId={2} noteReminders onOpen={() => {}} onClearNote={id => cleared.push(id)} />);
        await flush();
        const clear = noteRows()[0].querySelector('.notes-reminder-clear') as HTMLButtonElement | null;
        expect(clear).not.toBeNull();
        act(() => { clear!.click(); });
        expect(cleared).toEqual([7]);
    });

    it('POSITIVE CONTROL: a host that offers no Clear gets no Clear button', async () => {
        listListTasks.mockResolvedValue([]);
        mount(<TasksReminders lists={[vetList]} channels={[]} currentUserId={2} noteReminders onOpen={() => {}} />);
        await flush();
        expect(noteRows()[0].querySelector('.notes-reminder-clear')).toBeNull();
    });
});
