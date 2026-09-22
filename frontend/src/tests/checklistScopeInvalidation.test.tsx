/**
 * ChecklistBody is the THIRD writer of a task's timing and completion on the
 * Púca page — the channel side panel, a checklist channel's main content, the
 * All-checklists board and the personal "Notes to self" list all render it —
 * and it keeps its items in component state.
 *
 * The pinned Calendar and Reminders tabs read the same rows through
 * useTaskSources, a react-query cache with a 30 s staleTime that this body
 * never writes. Ticking an item or setting a due time here therefore left
 * both tabs showing the old state for up to half a minute, with no spinner
 * and nothing to retry — the same staleness taskScopeInvalidation.test.tsx
 * pins for the list tab and the shared schedule/snooze setters.
 *
 * The socket cannot cover it: broadcast_checklist EXCLUDES the actor
 * (src/task_handlers.rs — "their own client already applied the change"), and
 * a personal list has no channel to broadcast on at all. So the writer has to
 * say so itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { listTasks, listListTasks, updateTask, sendToggle } = vi.hoisted(() => ({
    listTasks: vi.fn(), listListTasks: vi.fn(), updateTask: vi.fn(), sendToggle: vi.fn(),
}));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return { ...real, listTasks, listListTasks, updateTask };
});
// The completion plan itself is taskCompletion.test.ts's business; what is
// under test is what happens AFTER its send resolves.
vi.mock('../api/taskCompletion', () => ({
    planToggle: (all: Task[]) => ({ next: all, advanced: false, send: sendToggle }),
}));
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: () => {} }));
vi.mock('../api/taskFeatures', () => ({ useTaskFeature: () => false, hasTaskFeature: () => false }));
vi.mock('../api/websocket', () => ({ wsClient: { on: () => {}, off: () => {}, joinRoom: () => {}, leaveRoom: () => {} } }));

/** The rows, reduced to the two callbacks that write. */
interface TreeProps {
    onToggle: (task: Task, completed: boolean) => void;
    onSetDue: (task: Task, dueAt: string | null) => void;
}
const trees: TreeProps[] = [];
vi.mock('../components/TaskTree', () => ({
    TaskTree: (p: TreeProps) => { trees.push(p); return null; },
}));

import { ChecklistBody } from '../components/ChecklistBody';
import { taskScopeKey } from '../components/taskSources';
import type { Task } from '../api/tasks';

const listTask = { id: 5, channel_id: null, list_id: 7, parent_id: null, description: 'Bins out', is_completed: false, position: 1, created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: '2030-10-07T09:00:00.000Z' } as Task;
const chanTask = { ...listTask, id: 6, channel_id: 9, list_id: null } as Task;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** A client that records what was invalidated, and nothing else. */
function spyClient() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const seen: unknown[][] = [];
    qc.invalidateQueries = (async (f?: { queryKey?: unknown[] }) => { seen.push(f?.queryKey ?? []); }) as typeof qc.invalidateQueries;
    return { qc, seen };
}

beforeEach(() => {
    trees.length = 0;
    listTasks.mockReset(); listListTasks.mockReset(); updateTask.mockReset(); sendToggle.mockReset();
    listTasks.mockResolvedValue([chanTask]);
    listListTasks.mockResolvedValue([listTask]);
    updateTask.mockResolvedValue(undefined);
    sendToggle.mockResolvedValue(undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

async function mount(qc: QueryClient, props: { listId?: number; channelId?: number }) {
    await act(async () => {
        root!.render(<QueryClientProvider client={qc}><ChecklistBody {...props} /></QueryClientProvider>);
    });
    await act(async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); });
    expect(trees.length, 'the rows never rendered, so nothing could be driven').toBeGreaterThan(0);
    return trees.at(-1)!;
}

describe('ChecklistBody tells the dated tabs what it wrote', () => {
    it('ticking an item in a PERSONAL list invalidates that list', async () => {
        const { qc, seen } = spyClient();
        const rows = await mount(qc, { listId: 7 });
        await act(async () => { await rows.onToggle(listTask, true); });
        expect(sendToggle).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([[...taskScopeKey('list', 7)]]);
    });

    it('setting a due time in a personal list does too', async () => {
        const { qc, seen } = spyClient();
        const rows = await mount(qc, { listId: 7 });
        await act(async () => { await rows.onSetDue(listTask, '2030-10-08T09:00:00.000Z'); });
        expect(updateTask).toHaveBeenCalledWith(5, { due_at: '2030-10-08T09:00:00.000Z' });
        expect(seen).toEqual([[...taskScopeKey('list', 7)]]);
    });

    it('a CHANNEL checklist invalidates its channel — the socket excludes the actor', async () => {
        const { qc, seen } = spyClient();
        const rows = await mount(qc, { channelId: 9 });
        await act(async () => { await rows.onToggle(chanTask, true); });
        await act(async () => { await rows.onSetDue(chanTask, null); });
        expect(seen).toEqual([[...taskScopeKey('channel', 9)], [...taskScopeKey('channel', 9)]]);
    });

    it('POSITIVE CONTROL: a REFUSED write invalidates nothing — the cache still matches the server', async () => {
        const { qc, seen } = spyClient();
        const rows = await mount(qc, { listId: 7 });
        sendToggle.mockRejectedValueOnce(new Error('nope'));
        updateTask.mockRejectedValueOnce(new Error('nope'));
        await act(async () => { await rows.onToggle(listTask, true); });
        await act(async () => { await rows.onSetDue(listTask, '2030-10-08T09:00:00.000Z'); });
        expect(sendToggle).toHaveBeenCalledTimes(1);
        expect(updateTask).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([]);
    });
});
