/**
 * The Tasks view's tab bar and server modes (docs/SERVER_MODES.md): a checklist channel a
 * mode hides leaves the bar, as it leaves All Checklists, and keeps its slot in the saved
 * order, because a save of that order is a full replace and a switch must cost nobody
 * their arrangement.
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
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));

import { TasksView } from '../components/TasksView';
import type { TaskTabPref } from '../api/tasks';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const SERVER = 's1';
let activeMode: number | null = null;
const channel = (id: number, name: string, modeIds: number[], parent?: number) => ({
    id, name, channel_type: 0, server_id: SERVER, has_checklist: true, mode_ids: modeIds, parent_id: parent ?? null, my_permissions: 1 << 10,
});
// Saved order: the hidden one sits between the two that stay.
const SAVED: TaskTabPref[] = [
    { kind: 'channel', ref_id: 1, is_favorite: false },
    { kind: 'channel', ref_id: 2, is_favorite: false },
    { kind: 'channel', ref_id: 3, is_favorite: false },
];

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: false, trash_retention_days: 30, max_body_len: 65536 };
        if (path.startsWith('/task-lists')) return [];
        if (path === '/task-tab-prefs') return SAVED;
        if (path === '/servers') return [{ id: SERVER, name: 'S', owner_id: 1, active_mode_id: activeMode }];
        if (path === `/servers/${SERVER}/channels`) {
            return [
                channel(1, 'Always', []),
                channel(2, 'Game notes', [7]),
                channel(3, 'Also always', []),
                { ...channel(4, 'Rooms', [7]), channel_type: 2, has_checklist: false },
                channel(5, 'Under the collection', [], 4),
            ];
        }
        if (path === `/servers/${SERVER}/members-with-roles`) return [];
        if (/^\/channels\/\d+\/tasks$/.test(path)) return [];
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

const tabNames = () => [...container.querySelectorAll<HTMLElement>('.tasks-tab')].map(t => t.textContent ?? '');
const hasTab = (name: string) => tabNames().some(t => t.includes(name));

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    activeMode = null;
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
});

describe('the Tasks tab bar and a server mode', () => {
    it('leaves out a checklist channel the mode hides, and one under a collection it hides', async () => {
        await mount();
        expect(hasTab('Always')).toBe(true);
        expect(hasTab('Game notes')).toBe(false);
        expect(hasTab('Under the collection')).toBe(false);
    });

    it('CONTROL: with the mode on, they are there', async () => {
        activeMode = 7;
        await mount();
        expect(hasTab('Game notes')).toBe(true);
        expect(hasTab('Under the collection')).toBe(true);
    });

    it('a save of the order keeps a hidden tab in its slot', async () => {
        await mount();
        const tab = [...container.querySelectorAll<HTMLElement>('.tasks-tab')].find(t => t.textContent?.includes('Also always'));
        expect(tab, 'the tab is rendered').toBeTruthy();
        await act(async () => { tab!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
        await settle();
        const item = [...document.querySelectorAll<HTMLElement>('.context-menu-item')].find(b => /favou?rite/i.test(b.textContent ?? ''));
        expect(item, 'the Favourite item is offered').toBeTruthy();
        await act(async () => { item!.click(); });
        await settle();
        const saves = put.mock.calls.filter(c => c[0] === '/task-tab-prefs');
        expect(saves).toHaveLength(1);
        const order = (saves[0][1] as { prefs: TaskTabPref[] }).prefs.map(p => p.ref_id);
        expect(order, 'the tab the mode hides is still saved').toContain(2);
        expect(order.indexOf(2), 'at the slot it held').toBe(SAVED.findIndex(p => p.ref_id === 2));
    });
});
