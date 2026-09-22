/**
 * The calendar's add sheet holds ONE create key per intent — and the intent
 * has to be everything the sheet can still change.
 *
 * CalendarAddSheet keeps all of its state when onSubmit resolves false (it
 * only clears `busy`), so after a failed add the day, the time, all-day and
 * event/to-do are still on screen and editable. While the held intent was
 * only `target + title`, adjusting the time and pressing Add again re-used
 * the SAME key: against a create the server had committed but could not
 * answer (a 502 over a successful write), migration 070's replay
 * short-circuit re-served the original row at its ORIGINAL timing and
 * answered 200 — submitAdd returned true, the sheet closed as a success, and
 * the entry sat at the time the user had just moved it away from, with
 * nothing said.
 *
 * The other four held-key sites are unaffected: their intent strings already
 * cover every field their form has. This is the one form that collects more
 * than it named.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { createListTask, createTask } = vi.hoisted(() => ({
    createListTask: vi.fn(), createTask: vi.fn(),
}));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, createListTask, createTask };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../components/calendar/calendarGate', () => ({ useCoarseCalendar: () => false }));
vi.mock('../api/taskFeatures', () => ({
    useTaskFeature: () => true,
    hasTaskFeature: () => true,
}));
// No rows and no socket: the grid is not what is under test.
vi.mock('../components/taskSources', () => ({
    taskScopeKey: (kind: string, id: number) => ['tasks-calendar', kind, id],
    useTaskSources: () => ({ sources: [], tasksIn: () => [], refetch: async () => {} }),
}));

/** The grid, reduced to the one prop that opens the add sheet. */
interface GridProps { onAdd: (dayKey: string, time?: string) => void }
const grids: GridProps[] = [];
vi.mock('../components/calendar/Calendar', () => ({
    Calendar: (p: GridProps) => { grids.push(p); return null; },
}));
/** The sheet, reduced to the callback TasksCalendar hands it. */
interface SheetProps { onSubmit: (r: AddSheetResult) => Promise<boolean> }
const sheets: SheetProps[] = [];
vi.mock('../components/calendar/CalendarAddSheet', () => ({
    CalendarAddSheet: (p: SheetProps) => { sheets.push(p); return null; },
}));

import { ApiError } from '../api/client';
import { TasksCalendar } from '../components/calendar/TasksCalendar';
import { type AddSheetResult } from '../components/calendar/CalendarAddSheet';
import { OP_KEY_SHAPE } from '../api/opKey';
import { setMessageToastSink } from '../components/messageToastBus';
import type { TaskList } from '../api/tasks';

const LIST = { id: 7, title: 'Bins', created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0 } as unknown as TaskList;

/** What the sheet hands back when the user presses Add. */
const filled = (over: Partial<AddSheetResult> = {}): AddSheetResult => ({
    title: 'Bins out', dayKey: '2030-10-07', time: '09:00', allDay: false, kind: 'task', target: 'list:7', ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let toasts: string[] = [];

beforeEach(() => {
    grids.length = 0;
    sheets.length = 0;
    toasts = [];
    createListTask.mockReset();
    createTask.mockReset();
    createListTask.mockResolvedValue({ id: 1, description: 'x', is_completed: false, created_at: '', created_by: 1, position: 1 });
    setMessageToastSink(t => { toasts.push(t.title); });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    setMessageToastSink(null);
});

/** Mount the tab and open the add sheet on a day, as a tap on it does. */
function openSheet() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => root!.render(
        <QueryClientProvider client={qc}>
            <TasksCalendar lists={[LIST]} channels={[]} currentUserId={3} onOpen={() => {}} />
        </QueryClientProvider>,
    ));
    act(() => { grids.at(-1)!.onAdd('2030-10-07', '09:00'); });
    expect(sheets.length, 'the add sheet never opened').toBeGreaterThan(0);
}

/** Press Add with `r`, and say whether the sheet was told it succeeded. */
async function add(r: AddSheetResult): Promise<boolean> {
    let ok = false;
    await act(async () => { ok = await sheets.at(-1)!.onSubmit(r); });
    return ok;
}

const keys = () => createListTask.mock.calls.map(c => c[4] as string | undefined);

describe('the calendar add sheet: one key per intent, and the intent is the whole form', () => {
    it('a retry of the SAME add replays the same key', async () => {
        openSheet();
        createListTask.mockRejectedValueOnce(new ApiError('gateway', 502));
        expect(await add(filled()), 'a failed add must not report success').toBe(false);
        expect(toasts.length, 'the failure was not reported to the user').toBe(1);
        // Everything typed is still on screen; the user presses Add again.
        expect(await add(filled())).toBe(true);

        expect(keys().length).toBe(2);
        expect(keys()[0]).toMatch(OP_KEY_SHAPE);
        expect(keys()[1]).toBe(keys()[0]);
    });

    it('changing only the TIME after a failure is a new intent, not that replay', async () => {
        openSheet();
        createListTask.mockRejectedValueOnce(new ApiError('gateway', 502));
        expect(await add(filled())).toBe(false);
        // The user moves it an hour later and presses Add again. This is a
        // DIFFERENT create: replaying the first one would serve back the row
        // the server already has, at 09:00, and call it a success.
        expect(await add(filled({ time: '10:00' }))).toBe(true);

        expect(keys().length).toBe(2);
        expect(keys()[1]).toMatch(OP_KEY_SHAPE);
        expect(keys()[1], 'an edited time replayed the original create').not.toBe(keys()[0]);
        // ...and the timing that went with it really did move.
        const timing = createListTask.mock.calls[1][3] as { schedule?: string };
        expect(JSON.stringify(timing)).toContain('2030-10-07T10:00');
    });

    it('the day, all-day and event/to-do count too', async () => {
        openSheet();
        createListTask.mockRejectedValue(new ApiError('gateway', 502));
        await add(filled());
        await add(filled({ dayKey: '2030-10-08' }));
        await add(filled({ allDay: true }));
        await add(filled({ kind: 'event' }));
        await add(filled({ target: 'list:7', title: 'Recycling out' }));
        const seen = keys();
        expect(seen.length).toBe(5);
        expect(new Set(seen).size, 'two of the five forms shared a key').toBe(5);
    });

    it('POSITIVE CONTROL: once a create LANDS, the same form again is a new item', async () => {
        openSheet();
        expect(await add(filled())).toBe(true);
        expect(await add(filled())).toBe(true);
        expect(keys().length).toBe(2);
        expect(keys()[1], 'the second add replayed the one already on the server').not.toBe(keys()[0]);
    });
});
