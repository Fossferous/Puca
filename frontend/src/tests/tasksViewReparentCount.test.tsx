/**
 * Púca's Tasks view re-counts a list's tab when a drag changes a row's
 * PARENT. A heading is a top-level row (api/taskHeading.ts), so a "## Setup"
 * nested under an item (only an older client nests one) is an ordinary
 * sub-item and a step — and dragged out to the top level it is a heading,
 * which is not. The row renderer is reduced to its props here, so the drop
 * can be handed to the view exactly as TaskTree hands it one.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/calendar/TasksCalendar', () => ({ TasksCalendar: () => null }));
type TreeProps = { tasks: Task[]; onReorder?: (task: Task, afterId: number | null, reparent?: { parentId: number | null }) => void };
const trees: TreeProps[] = [];
vi.mock('../components/TaskTree', () => ({ TaskTree: (p: TreeProps) => { trees.push(p); return null; } }));

import { TasksView } from '../components/TasksView';
import { type Task } from '../api/tasks';
import { setActiveIdentity } from '../api/e2ee';
import { setMessageToastSink } from '../components/messageToastBus';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const ME = ['tasks-reparent-pw', 'ab'.repeat(16)] as const;

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};
const row = (total: number) => ({
    id: 1, title: 'Test list', created_at: '2026-09-01T00:00:00Z', total_tasks: total, completed_tasks: 0,
    body: null, attachments: null, trashed_at: null, is_self: false,
});
const item = (id: number, description: string, parent_id: number | null = null) => ({
    id, list_id: 1, channel_id: null, parent_id, description, is_completed: false,
    created_at: '2026-09-01T00:00:00Z', created_by: 1, position: id, attachments: null, due_at: null,
});

let stored: Array<ReturnType<typeof item>>;
/** Does the fake server apply a reparent? (An old one answers 200 and does not.) */
let appliesReparent: boolean;
/** Holds the list's re-read after the drop until released. */
let held: Promise<void> | null;
let root: Root;
let container: HTMLDivElement;

beforeAll(async () => {
    await warmIdentities([ME]);
    setActiveIdentity(await testIdentity(...ME));
}, WARM_TIMEOUT_MS);

beforeEach(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((q: string) => ({
            matches: false, media: q, onchange: null,
            addEventListener: () => {}, removeEventListener: () => {},
            addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
    trees.length = 0;
    stored = [item(10, 'Parent'), item(11, '## Setup', 10), item(12, 'Other')];
    appliesReparent = true;
    held = null;
    setMessageToastSink(() => {});
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, content_rev: true, idempotent_creates: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [row(stored.length)];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [];
        if (path === '/task-lists/1/tasks') {
            if (held) await held;
            return stored.map(t => ({ ...t }));
        }
        throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string, body: { reparent?: boolean; parent_id?: number | null }) => {
        const m = /^\/tasks\/(\d+)\/reorder$/.exec(path);
        if (!m) throw new Error(`unexpected POST ${path}`);
        if (body.reparent && appliesReparent) stored = stored.map(t => (t.id === Number(m[1]) ? { ...t, parent_id: body.parent_id ?? null } : t));
        return {};
    });
    put.mockResolvedValue({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    document.body.innerHTML = '';
    setMessageToastSink(null);
});

async function mountAndOpen() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
    const tab = [...container.querySelectorAll<HTMLButtonElement>('.tasks-tab')].find(b => b.textContent?.includes('Test list'));
    expect(tab, 'the list tab').toBeTruthy();
    await act(async () => { tab!.click(); });
    await settle();
}
const tabCount = () => [...container.querySelectorAll('.tasks-tab')].find(b => b.textContent?.includes('Test list'))?.querySelector('.tasks-tab-count')?.textContent;
/** Drop the nested "## Setup" out to the top level, as TaskTree reports it. */
async function unNest() {
    const tree = trees.at(-1)!;
    const sub = tree.tasks.find(t => t.id === 11)!;
    await act(async () => { tree.onReorder!(sub, 10, { parentId: null }); });
}

describe('a drag that un-nests a "## x" sub-item', () => {
    it('takes it off the tab at once: at the top level it is a heading, not a step', async () => {
        await mountAndOpen();
        // Nested, "## Setup" is an ordinary sub-item: three steps.
        expect(tabCount()).toBe('0/3');
        let release!: () => void;
        held = new Promise<void>(r => { release = r; });
        await unNest();
        await settle();
        expect(tabCount(), 'while the re-read is out').toBe('0/2');
        release();
        held = null;
        await settle();
        expect(tabCount()).toBe('0/2');
    });

    it('a refused drop puts it back on the tab with the row', async () => {
        await mountAndOpen();
        post.mockRejectedValueOnce(new Error('offline'));
        await unNest();
        await settle();
        expect(trees.at(-1)!.tasks.find(t => t.id === 11)?.parent_id).toBe(10);
        expect(tabCount()).toBe('0/3');
    });

    it('and counts what the re-read says: a server that did not move it keeps it a step', async () => {
        appliesReparent = false;
        await mountAndOpen();
        await unNest();
        await settle();
        expect(trees.at(-1)!.tasks.find(t => t.id === 11)?.parent_id).toBe(10);
        expect(tabCount()).toBe('0/3');
    });
});
