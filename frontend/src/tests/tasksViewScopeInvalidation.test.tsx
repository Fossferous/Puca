/**
 * The LIST TAB is the writer the invalidation rule was written for, and the
 * only one of the four with no test of its own.
 *
 * taskScopeInvalidation.test.tsx pins the pure function and the two shared
 * timing setters; checklistScopeInvalidation.test.tsx pins ChecklistBody. The
 * Tasks view's own tab — the one whose staleness started all of this: set a
 * date on an item, tap Reminders, and it was not there for up to half a
 * minute — was covered only by its own source code. Its handlers keep the
 * items in component state and PATCH the API directly, exactly as
 * ChecklistBody's do, so nothing but this tells the dated tabs' cache.
 *
 * Driven through the real view (its tab bar, its editor) with TaskTree
 * reduced to the two callbacks that write, so the assertion is about what the
 * view does after the server answers — not about a function called by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: () => ({ state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} }),
}));
// The completion plan is taskCompletion.test.ts's business; what is under
// test is what the view does AFTER its send resolves.
const { sendToggle } = vi.hoisted(() => ({ sendToggle: vi.fn() }));
vi.mock('../api/taskCompletion', () => ({
    planToggle: (all: Task[]) => ({ next: all, advanced: false, send: sendToggle }),
}));

/** The rows, reduced to the two callbacks that write. */
interface TreeProps {
    onToggle: (task: Task, completed: boolean) => void | Promise<void>;
    onSetDue: (task: Task, dueAt: string | null) => void | Promise<void>;
}
const trees: TreeProps[] = [];
vi.mock('../components/TaskTree', () => ({
    TaskTree: (p: TreeProps) => { trees.push(p); return null; },
}));

import { setMessageToastSink } from '../components/messageToastBus';
import { TasksView } from '../components/TasksView';
import { taskScopeKey } from '../components/taskSources';
import type { Task } from '../api/tasks';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const item: Task = {
    id: 5, channel_id: null, list_id: 1, parent_id: null, description: 'Bins out', is_completed: false,
    position: 1, created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: null,
};

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, note_reminders: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [{ id: 1, title: 'List 1', created_at: '2026-09-01T00:00:00Z', total_tasks: 1, completed_tasks: 0, body: null, attachments: null, trashed_at: null, due_at: null, schedule: null, is_self: false }];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [item];
        throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({});
    patch.mockResolvedValue({});
}

let root: Root;
let container: HTMLDivElement;

/** A client that records what was invalidated, and nothing else. */
function spyClient() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    const real = qc.invalidateQueries.bind(qc);
    const seen: unknown[][] = [];
    qc.invalidateQueries = (async (f?: { queryKey?: unknown[] }) => {
        const key = f?.queryKey ?? [];
        // Only the dated tabs' scope keys: the view invalidates its own
        // listings too, and those are not what this is about.
        if (key[0] === 'tasks-calendar') seen.push(key);
        return real(f as never);
    }) as typeof qc.invalidateQueries;
    return { qc, seen };
}

/** Mount, open List 1, and hand back the rows' two writing callbacks. */
async function openList(qc: QueryClient): Promise<TreeProps> {
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
    const tab = [...container.querySelectorAll<HTMLElement>('.tasks-tab')].find(t => t.textContent?.includes('List 1'));
    expect(tab, 'the tab for List 1 is rendered').toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
    expect(trees.length, 'the rows never rendered, so nothing could be driven').toBeGreaterThan(0);
    return trees.at(-1)!;
}

beforeEach(() => {
    trees.length = 0;
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    sendToggle.mockReset(); sendToggle.mockResolvedValue(undefined);
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    setMessageToastSink(() => {});
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    setMessageToastSink(null);
    delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('the Tasks view’s list tab tells the dated tabs what it wrote', () => {
    it('setting a due time invalidates that list’s scope', async () => {
        const { qc, seen } = spyClient();
        const rows = await openList(qc);
        await act(async () => { await rows.onSetDue(item, '2030-10-08T09:00:00.000Z'); });
        expect(patch).toHaveBeenCalledWith('/tasks/5', expect.objectContaining({ due_at: '2030-10-08T09:00:00.000Z' }));
        expect(seen).toEqual([[...taskScopeKey('list', 1)]]);
    });

    it('ticking an item does too — a ticked item leaves Reminders', async () => {
        const { qc, seen } = spyClient();
        const rows = await openList(qc);
        await act(async () => { await rows.onToggle(item, true); });
        expect(sendToggle).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([[...taskScopeKey('list', 1)]]);
    });

    it('POSITIVE CONTROL: a REFUSED write invalidates nothing — the cache still matches the server', async () => {
        const { qc, seen } = spyClient();
        const rows = await openList(qc);
        patch.mockRejectedValueOnce(new Error('nope'));
        sendToggle.mockRejectedValueOnce(new Error('nope'));
        await act(async () => { await rows.onSetDue(item, '2030-10-08T09:00:00.000Z'); });
        await act(async () => { await rows.onToggle(item, true); });
        expect(patch).toHaveBeenCalledTimes(1);
        expect(sendToggle).toHaveBeenCalledTimes(1);
        expect(seen).toEqual([]);
    });
});
