/**
 * Púca's Tasks view keeps a trashed list's slot in the saved tab order.
 *
 * The saved order is a full replace (PUT /task-tab-prefs) of every tab the
 * view knows. A trashed list is not among the tabs, so without
 * `keepHiddenSlots` a favourite toggled while a list sits in the trash would
 * push it to the end of the saved order, and restoring it would bring it back
 * last instead of where it was. The
 * rule itself is unit-tested in listContent.test.ts; this proves the view
 * actually routes its save through it (and the positive control proves the
 * fixture can tell the difference: against a server with no trash nothing is
 * known to be hidden, and the same saved ref drifts to the tail).
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
// The view's children are not under test and pull in far more than a tab bar.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));

import { ApiError } from '../api/client';
import { TasksView } from '../components/TasksView';
import { type TaskTabPref } from '../api/tasks';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

let trashSupported = true;
// Saved order: list 9 (now in the trash) first, then 1, then 2.
const SAVED: TaskTabPref[] = [9, 1, 2].map(id => ({ kind: 'list', ref_id: id, is_favorite: false }));
const row = (id: number, trashed = false) => ({
    id, title: `List ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: trashed ? '2026-09-10T00:00:00Z' : null,
});

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') {
            if (!trashSupported) throw new ApiError('Method Not Allowed', 405);
            return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };
        }
        if (path === '/task-lists?trashed=true') return [row(9, true)];
        if (path === '/task-lists') return [row(1), row(2)];
        if (path === '/task-tab-prefs') return SAVED;
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    put.mockResolvedValue({});
}

let root: Root;
let container: HTMLDivElement;

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
    await settle();
}

/** Favourite list 2 through its tab's context menu; returns the saved order. */
async function favouriteList2(): Promise<string[]> {
    const tab = [...container.querySelectorAll<HTMLElement>('.tasks-tab')].find(t => t.textContent?.includes('List 2'));
    expect(tab, 'the tab for list 2 is rendered').toBeTruthy();
    await act(async () => { tab!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    await settle();
    const item = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(b => b.textContent?.trim() === 'Favourite');
    expect(item, 'the Favourite menu item is offered').toBeTruthy();
    await act(async () => { item!.click(); });
    await settle();
    const puts = put.mock.calls.filter(c => c[0] === '/task-tab-prefs');
    expect(puts.length).toBe(1);
    return (puts[0][1] as { prefs: TaskTabPref[] }).prefs.map(p => `${p.kind}:${p.ref_id}${p.is_favorite ? '*' : ''}`);
}

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    trashSupported = true;
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

describe('Púca Tasks view: a trashed list keeps its slot', () => {
    it('a favourite toggled while a list is in the trash saves the trashed list back at its index', async () => {
        await mount();
        expect(await favouriteList2()).toEqual(['list:9', 'list:2*', 'list:1']);
    });

    it('POSITIVE CONTROL: with nothing known to be hidden, an unknown saved ref drifts to the tail', async () => {
        // No trash on this server, so list 9 is just a saved ref the view has
        // no tab for: buildPrefsForOrder keeps it but moves it to the end.
        // That drift is what a trashed list would suffer without the rule.
        trashSupported = false;
        await mount();
        expect(await favouriteList2()).toEqual(['list:2*', 'list:1', 'list:9']);
    });
});
