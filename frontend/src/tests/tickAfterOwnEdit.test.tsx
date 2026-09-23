/**
 * "Set a date on an item, then tick it" in the two Púca views that keep their
 * rows in component state and never re-read them after their own writes: the
 * Tasks tab's list editor (TasksView) and a personal list's ChecklistBody.
 *
 * With the freshness stamp (finding 8) that ordinary one-device flow was
 * refused: the view still held the item's pre-edit `updated_at`, the server
 * had moved it for the edit, and the tick came back 409 "changed on another
 * device". Neither view re-read on that 409 either, so every retry was
 * refused the same way until the user switched lists.
 *
 * Driven through the real views, the real completion plan and the real API
 * layer, with only the HTTP client mocked and the rows reduced to their
 * writing callbacks — so what is asserted is the PATCH that leaves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: () => ({ state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} }),
}));
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/websocket', () => ({ wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} } }));

interface TreeProps {
    tasks: Task[];
    onToggle: (task: Task, completed: boolean) => void | Promise<void>;
    onSetDue: (task: Task, dueAt: string | null) => void | Promise<void>;
    onEdit: (task: Task, description: string) => void | Promise<void>;
}
const trees: TreeProps[] = [];
vi.mock('../components/TaskTree', () => ({
    TaskTree: (p: TreeProps) => { trees.push(p); return null; },
}));

import { ApiError } from '../api/client';
import { clearActiveIdentity, generateIdentitySeed, makeIdentity, setActiveIdentity } from '../api/e2ee';
import { setMessageToastSink } from '../components/messageToastBus';
import { TasksView } from '../components/TasksView';
import { ChecklistBody } from '../components/ChecklistBody';
import type { Task } from '../api/tasks';

const T0 = '2030-10-01T09:00:00.123456Z';
const T1 = '2030-10-01T09:05:00.5Z';
const LIST = 1;

let item: Task;
const TASKS_PATH = `/task-lists/${LIST}/tasks`;
let taskReads = 0;
let nextId = 500;

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, note_reminders: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [{ id: LIST, title: 'List 1', created_at: '2026-09-01T00:00:00Z', total_tasks: 1, completed_tasks: 0, body: null, attachments: null, trashed_at: null, due_at: null, schedule: null, is_self: false }];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (path === TASKS_PATH) { taskReads++; return [{ ...item }]; }
        throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({});
    patch.mockResolvedValue({});
}

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

let root: Root;
let container: HTMLDivElement;

async function openTasksView(): Promise<void> {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
    const tab = [...container.querySelectorAll<HTMLElement>('.tasks-tab')].find(t => t.textContent?.includes('List 1'));
    expect(tab, 'the tab for List 1 is rendered').toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
}

async function openChecklist(): Promise<void> {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><ChecklistBody listId={LIST} /></QueryClientProvider>); });
    await settle();
}

const rows = () => {
    const t = trees.at(-1);
    expect(t, 'the rows never rendered, so nothing could be driven').toBeTruthy();
    return t!;
};
const shown = () => rows().tasks.find(t => t.id === item.id)!;
/** The body of the last PATCH that ticked the item. */
const lastTick = () => {
    const c = patch.mock.calls.filter(([p, b]) => p === `/tasks/${item.id}` && (b as { is_completed?: boolean }).is_completed === true).at(-1);
    expect(c, 'a tick was sent').toBeTruthy();
    return c![1] as Record<string, unknown>;
};

beforeEach(() => {
    trees.length = 0;
    taskReads = 0;
    // Its own id per test: the write tracker is the session's.
    item = {
        id: nextId++, channel_id: null, list_id: LIST, parent_id: null, description: 'Bins out', is_completed: false,
        position: 1, created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null,
        due_at: '2030-10-07T09:00:00.000Z', updated_at: T0,
    };
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    setMessageToastSink(() => {});
    // Text edits are sealed to self before they leave.
    setActiveIdentity(makeIdentity(generateIdentitySeed()));
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    setMessageToastSink(null);
    clearActiveIdentity();
    delete (window as { matchMedia?: unknown }).matchMedia;
});

for (const [name, open] of [['the Tasks tab', openTasksView], ['a personal list’s checklist', openChecklist]] as const) {
    describe(`${name}: the user’s own edit, then a tick`, () => {
        it('a date set here, then a tick, sends no stamp the edit outdated', async () => {
            await open();
            expect(shown().updated_at).toBe(T0);
            await act(async () => { await rows().onSetDue(shown(), '2030-10-09T09:00:00.000Z'); });
            item = { ...item, due_at: '2030-10-09T09:00:00.000Z', updated_at: T1 };   // the trigger moved it
            await act(async () => { await rows().onToggle(shown(), true); });
            expect(lastTick().expect_schedules_as_of, 'T0 is older than the server’s copy of OUR edit').toBeUndefined();
        });

        it('text edited here, then a tick, likewise', async () => {
            await open();
            await act(async () => { await rows().onEdit(shown(), 'Bins out tonight'); });
            expect(patch, 'the edit really went out').toHaveBeenCalledWith(`/tasks/${item.id}`, expect.objectContaining({ description: expect.any(String) }));
            expect(shown().description, 'and was not rolled back').toBe('Bins out tonight');
            item = { ...item, description: 'Bins out tonight', updated_at: T1 };
            await act(async () => { await rows().onToggle(shown(), true); });
            expect(lastTick().expect_schedules_as_of).toBeUndefined();
        });

        it('POSITIVE CONTROL: with no edit here, the tick carries the stamp it read', async () => {
            await open();
            await act(async () => { await rows().onToggle(shown(), true); });
            expect(lastTick().expect_schedules_as_of).toBe(T0);
        });

        it('a refused tick re-reads the list, so the retry is judged on what the server holds now', async () => {
            await open();
            const readsBefore = taskReads;
            // Another device really did change it: the server says so.
            item = { ...item, updated_at: T1 };
            patch.mockRejectedValueOnce(new ApiError('A date or repeat on this item changed on another device', 409));
            await act(async () => { await rows().onToggle(shown(), true); });
            await settle();
            expect(taskReads, 'the view re-read after the 409').toBeGreaterThan(readsBefore);
            expect(shown().updated_at, 'and shows the server’s copy').toBe(T1);
            expect(shown().is_completed).toBe(false);
            await act(async () => { await rows().onToggle(shown(), true); });
            expect(lastTick().expect_schedules_as_of, 'the retry is current').toBe(T1);
        });
    });
}
