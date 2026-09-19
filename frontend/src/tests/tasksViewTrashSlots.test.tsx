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
 *
 * The tab DRAG goes through the same rule (the drop handler is captured from
 * useDragReorder and driven directly — the pointer mechanics are that hook's
 * own tests), no save happens before the trash has been read, and the "Notes
 * to self" list is not offered for the trash the server would refuse.
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
// The tab bar's drop handler, as TasksView hands it to the drag hook.
type DropEvent = { key: string; group: string; order: string[]; insertAt: number; crossDelta: number; sameSlot?: boolean };
const drag = vi.hoisted(() => ({ onDrop: null as null | ((e: DropEvent) => void) }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: (opts: { axis: string; onDrop: (e: DropEvent) => void }) => {
        if (opts.axis === 'x') drag.onDrop = opts.onDrop;
        return { state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} };
    },
}));

import { ApiError } from '../api/client';
import { setMessageToastSink } from '../components/messageToastBus';
import { TasksView } from '../components/TasksView';
import { type TaskTabPref } from '../api/tasks';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

let trashSupported = true;
/** Holds the trash listing until released (the trash not read yet). */
let trashGate: Promise<void> | null = null;
let selfId: number | null = null;
let toasts: string[] = [];
// Saved order: list 9 (now in the trash) first, then 1, then 2.
const SAVED: TaskTabPref[] = [9, 1, 2].map(id => ({ kind: 'list', ref_id: id, is_favorite: false }));
const row = (id: number, trashed = false) => ({
    id, title: `List ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: trashed ? '2026-09-10T00:00:00Z' : null, is_self: id === selfId,
});

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') {
            if (!trashSupported) throw new ApiError('Method Not Allowed', 405);
            return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };
        }
        if (path === '/task-lists?trashed=true') {
            if (trashGate) await trashGate;
            return [row(9, true)];
        }
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
    trashGate = null;
    selfId = null;
    drag.onDrop = null;
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    setMessageToastSink(null);
});

const savedOrders = () => put.mock.calls.filter(c => c[0] === '/task-tab-prefs')
    .map(c => (c[1] as { prefs: TaskTabPref[] }).prefs.map(p => `${p.kind}:${p.ref_id}`));

/** Drop list 2's tab in front of list 1's, as the drag hook reports it. */
async function dragList2First() {
    expect(drag.onDrop, 'TasksView wired a drop handler for the tab bar').toBeTruthy();
    await act(async () => { drag.onDrop!({ key: 'list:2', group: '', order: ['list:1'], insertAt: 0, crossDelta: 0 }); });
    await settle();
}

describe('Púca Tasks view: a trashed list keeps its slot', () => {
    it('a favourite toggled while a list is in the trash saves the trashed list back at its index', async () => {
        await mount();
        expect(await favouriteList2()).toEqual(['list:9', 'list:2*', 'list:1']);
    });

    it('a tab DRAG while a list is in the trash keeps the trashed list at its index', async () => {
        await mount();
        await dragList2First();
        expect(savedOrders()).toEqual([['list:9', 'list:2', 'list:1']]);
    });

    it('POSITIVE CONTROL (drag): with no trash, the same drop sends the unknown ref to the tail', async () => {
        trashSupported = false;
        await mount();
        await dragList2First();
        expect(savedOrders()).toEqual([['list:2', 'list:1', 'list:9']]);
    });

    it('nothing is saved before the trash has been read; once it has, the slot is kept', async () => {
        let release!: () => void;
        trashGate = new Promise<void>(r => { release = r; });
        await mount();
        await dragList2First();
        expect(savedOrders()).toEqual([]);
        expect(toasts).toEqual(['Still loading the trash — try again in a moment']);
        await act(async () => { release(); });
        await settle();
        await dragList2First();
        expect(savedOrders()).toEqual([['list:9', 'list:2', 'list:1']]);
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

describe('Púca Tasks view: Notes to self and the trash', () => {
    const menuFor = async (label: string) => {
        const tab = [...container.querySelectorAll<HTMLElement>('.tasks-tab')].find(t => t.textContent?.includes(label));
        expect(tab, `the tab for ${label}`).toBeTruthy();
        await act(async () => { tab!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
        await settle();
        const items = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].map(b => b.textContent?.trim());
        await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        await settle();
        return items;
    };

    it('the self list offers no "Move to trash" (the server would refuse it); an ordinary list does', async () => {
        selfId = 1;
        await mount();
        expect(await menuFor('List 1')).not.toContain('Move to trash');
        expect(await menuFor('List 2')).toContain('Move to trash');
    });
});
