/**
 * Púca Notes' trash, through the real data layer (useNoteCards +
 * useNoteActions) against a fake server:
 *
 *  - trashing a note must NOT erase its device-local colour and labels (the
 *    prune treats trashed notes as live), and a restore brings them back;
 *  - a pin or a move while a note is in the trash keeps its slot in the
 *    saved order (the tab prefs are a full replace);
 *  - against a server older than the trash, "delete" stays today's
 *    permanent delete, and against a new one it never calls DELETE.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { get, post, patch, del, put } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn(), put: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get, post, patch, delete: del, put } };
});
vi.mock('../api/auth', async () => {
    const real = await vi.importActual<typeof import('../api/auth')>('../api/auth');
    return { ...real, currentUserIdFromToken: () => 4242 };
});

import { ApiError } from '../api/client';
import { useNoteActions, useNoteCards, type NoteActions } from '../notes/model/notesQueries';
import { getNotesPrefs, invalidateNotesPrefs, setNoteColor, setNoteLabels } from '../notes/model/notesPrefs';
import { type TaskTabPref } from '../api/tasks';

const settle = async () => {
    for (let i = 0; i < 12; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

interface ServerState {
    live: number[];
    trashed: number[];
    prefs: TaskTabPref[];
    trashSupported: boolean;
}
let server: ServerState;
const row = (id: number, trashed = false) => ({
    id, title: `Note ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    ...(server.trashSupported ? { body: null, attachments: null, trashed_at: trashed ? '2026-09-10T00:00:00Z' : null } : {}),
});

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') {
            if (!server.trashSupported) throw new ApiError('Method Not Allowed', 405);
            return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };
        }
        if (path === '/task-lists?trashed=true') return server.trashSupported ? server.trashed.map(id => row(id, true)) : server.live.map(id => row(id));
        if (path === '/task-lists') return server.live.map(id => row(id));
        if (path === '/task-tab-prefs') return server.prefs;
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string) => {
        const m = /^\/task-lists\/(\d+)\/(trash|restore)$/.exec(path);
        if (!m || !server.trashSupported) throw new ApiError('Not Found', 404);
        const id = Number(m[1]);
        if (m[2] === 'trash') { server.live = server.live.filter(x => x !== id); server.trashed = [id, ...server.trashed]; return { trashed_at: '2026-09-19T00:00:00Z' }; }
        server.trashed = server.trashed.filter(x => x !== id); server.live = [...server.live, id].sort(); return { trashed_at: null };
    });
    put.mockImplementation(async (path: string, body: { prefs: TaskTabPref[] }) => {
        if (path === '/task-tab-prefs') server.prefs = body.prefs;
        return {};
    });
    del.mockImplementation(async (path: string) => {
        const m = /^\/task-lists\/(\d+)$/.exec(path);
        if (m) server.live = server.live.filter(x => x !== Number(m[1]));
        return {};
    });
}

let root: Root;
let container: HTMLDivElement;
let latest: { actions: NoteActions; keys: string[] } | null = null;

function Harness() {
    const { cards, prefs, prefsReady } = useNoteCards();
    const actions = useNoteActions(cards, prefs, prefsReady);
    useEffect(() => { latest = { actions, keys: cards.map(c => c.key) }; });
    return null;
}

async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>); });
    await settle();
}

beforeEach(() => {
    localStorage.clear();
    invalidateNotesPrefs();
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    server = {
        live: [1, 2, 3],
        trashed: [],
        prefs: [1, 2, 3].map(id => ({ kind: 'list', ref_id: id, is_favorite: false })),
        trashSupported: true,
    };
    installServer();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => { root.unmount(); });
    container.remove();
    latest = null;
});

describe('the trash keeps a note whole', () => {
    it('trashing keeps its colour and labels, and restoring brings the note back with them', async () => {
        setNoteColor('list:2', 'mint');
        setNoteLabels('list:2', ['Errands']);
        await mount();
        expect(latest!.keys).toEqual(['list:1', 'list:2', 'list:3']);

        await act(async () => { await latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(latest!.keys).toEqual(['list:1', 'list:3']);
        expect(post).toHaveBeenCalledWith('/task-lists/2/trash', {});
        expect(del).not.toHaveBeenCalled();
        // The prune has run against the live set by now — and kept list:2.
        expect(getNotesPrefs().colors['list:2']).toBe('mint');
        expect(getNotesPrefs().labels['list:2']).toEqual(['Errands']);

        await act(async () => { await latest!.actions.restoreNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(latest!.keys).toContain('list:2');
        expect(getNotesPrefs().colors['list:2']).toBe('mint');
    });

    it('POSITIVE CONTROL: a note that is really gone does lose its device-local state', async () => {
        setNoteColor('list:2', 'mint');
        server.live = [1, 3];   // deleted elsewhere, not trashed
        server.prefs = server.prefs.filter(p => p.ref_id !== 2);
        await mount();
        expect(getNotesPrefs().colors['list:2']).toBeUndefined();
    });

    it('a move while a note is in the trash keeps its slot in the saved order', async () => {
        server.live = [1, 3];
        server.trashed = [2];
        server.prefs = [
            { kind: 'list', ref_id: 1, is_favorite: false },
            { kind: 'list', ref_id: 2, is_favorite: true },
            { kind: 'list', ref_id: 3, is_favorite: false },
        ];
        await mount();
        await act(async () => { latest!.actions.reorderNotes(['list:3', 'list:1']); });
        await settle();
        expect(server.prefs.map(p => p.ref_id)).toEqual([3, 2, 1]);
        expect(server.prefs.find(p => p.ref_id === 2)?.is_favorite).toBe(true);
    });

    it('a pin while a note is in the trash keeps its slot too', async () => {
        server.live = [1, 3];
        server.trashed = [2];
        await mount();
        await act(async () => { latest!.actions.togglePin({ kind: 'list', id: 3 }); });
        await settle();
        // Pinned note 3 leads; trashed note 2 is still at index 1.
        expect(server.prefs.map(p => p.ref_id)).toEqual([3, 2, 1]);
    });
});

describe('against a server older than the trash', () => {
    it('delete stays the permanent delete (no /trash request that could 404 mid-way)', async () => {
        server.trashSupported = false;
        await mount();
        await act(async () => { await latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(del).toHaveBeenCalledWith('/task-lists/2');
        expect(post).not.toHaveBeenCalled();
        expect(latest!.actions.content.trashEnabled).toBe(false);
        expect(latest!.actions.content.features.body).toBe(false);
    });
});
