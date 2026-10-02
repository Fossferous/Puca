/**
 * The Tasks view shares `keys.members(serverId)` with the member list, so its
 * fetch of that key must feed the presence store too.
 *
 * Every other fetcher of the key goes through fetchMembersWithPresence
 * (hooks/queries.ts), which hands the rows to ingestPresenceSnapshot. TasksView
 * called listMembersWithRoles directly: a snapshot React Query ran through its
 * queryFn (the first load while Tasks is the only observer, or an invalidate
 * that picks its options) reached the cache and never the store, so presence
 * stayed stale until Chat's own 10 s poll came round.
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
// Not under test, and they pull in far more than the view's data layer.
vi.mock('../components/ChecklistBody', () => ({ ChecklistBody: () => null }));
vi.mock('../components/TaskTree', () => ({ TaskTree: () => null }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: () => ({ state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} }),
}));

import { setMessageToastSink } from '../components/messageToastBus';
import { TasksView } from '../components/TasksView';
import { __resetPresenceForTests, presenceOf } from '../api/presenceStore';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

const SERVER = { id: 'srv-1', name: 'Friends', owner_id: 1, icon_file_id: null, created_at: '2026-09-01T00:00:00Z' };
const MEMBER = { id: 4242, username: 'idler', is_online: true, status: 'idle', roles: [], server_nickname: null, avatar_file_id: null };

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    __resetPresenceForTests();
    window.matchMedia = ((q: string) => ({
        matches: false, media: q, onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    setMessageToastSink(() => {});
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, note_reminders: true };
        if (path === '/task-lists?trashed=true') return [];
        if (path === '/task-lists') return [];
        if (path === '/task-tab-prefs') return [];
        if (path === '/servers') return [SERVER];
        if (path === `/servers/${SERVER.id}/channels`) return [];
        if (path === `/servers/${SERVER.id}/members-with-roles`) return [MEMBER];
        return [];
    });
    put.mockResolvedValue({});
    patch.mockResolvedValue({});
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    setMessageToastSink(null);
    __resetPresenceForTests();
    delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('Tasks view member fetch', () => {
    it('feeds the presence store, like every other fetch of keys.members', async () => {
        // Control: the store knows nothing of this user before the view mounts.
        expect(presenceOf(MEMBER.id)).toBe('offline');
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
        await act(async () => { root.render(<QueryClientProvider client={qc}><TasksView /></QueryClientProvider>); });
        await settle();
        // The view did fetch the member list (else the assertion below proves nothing)...
        expect(get.mock.calls.map(c => c[0])).toContain(`/servers/${SERVER.id}/members-with-roles`);
        // ...and its rows reached the store: no REST fallback passed here.
        expect(presenceOf(MEMBER.id)).toBe('idle');
    });
});
