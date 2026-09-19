/**
 * Púca Notes' trash, through the real data layer (useNoteCards +
 * useNoteActions) against a fake server:
 *
 *  - trashing a note must NOT erase its device-local colour and labels (the
 *    prune treats trashed notes as live), and a restore brings them back;
 *  - a pin or a move while a note is in the trash keeps its slot in the
 *    saved order (the tab prefs are a full replace);
 *  - against a server older than the trash, "delete" stays today's
 *    permanent delete, and against a new one it never calls DELETE;
 *  - a note trashed ELSEWHERE (Púca's Tasks view, another device) keeps its
 *    colour when only the listing is refetched: the prune asks the trash first;
 *  - pins and moves wait for the trash to be read; the client purge of
 *    expired trash runs on the server's clock; Notes to self is never trashed;
 *    a failed trash says so once; a trash waits for the text still saving.
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
import { registerBodyFlush } from '../api/listContent';
import { setMessageToastSink } from '../components/messageToastBus';
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
    /** The server's clock as the features route reports it (null: not sent). */
    nowMs: number | null;
    selfId: number | null;
    /** Holds the trash listing until released (a trash not read yet). */
    trashGate: Promise<void> | null;
}
let server: ServerState;
const row = (id: number, trashed = false) => ({
    id, title: `Note ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    ...(server.trashSupported ? { body: null, attachments: null, trashed_at: trashed ? '2026-09-10T00:00:00Z' : null, is_self: id === server.selfId } : {}),
});
let toasts: string[] = [];

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (path === '/task-lists/features') {
            if (!server.trashSupported) throw new ApiError('Method Not Allowed', 405);
            return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, ...(server.nowMs !== null ? { server_now_ms: server.nowMs } : {}) };
        }
        if (path === '/task-lists?trashed=true') {
            if (server.trashGate) await server.trashGate;
            return server.trashSupported ? server.trashed.map(id => row(id, true)) : server.live.map(id => row(id));
        }
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

async function mount(): Promise<QueryClient> {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    await act(async () => { root.render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>); });
    await settle();
    return qc;
}
const trashReads = () => get.mock.calls.filter(c => c[0] === '/task-lists?trashed=true').length;

beforeEach(() => {
    localStorage.clear();
    invalidateNotesPrefs();
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    server = {
        live: [1, 2, 3],
        trashed: [],
        prefs: [1, 2, 3].map(id => ({ kind: 'list', ref_id: id, is_favorite: false })),
        trashSupported: true,
        nowMs: Date.now(),
        selfId: null,
        trashGate: null,
    };
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
    latest = null;
    setMessageToastSink(null);
    vi.useRealTimers();
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

describe('a note trashed ELSEWHERE keeps its device-local state', () => {
    // Trashed in Púca's Tasks view (or on another device) while this Notes
    // has a trash read from before: only the listing refetches (focus, the
    // 30-second staleness), and the note is missing from BOTH caches.
    it('the prune asks the trash again before it prunes, and keeps the colour', async () => {
        setNoteColor('list:2', 'mint');
        setNoteLabels('list:2', ['Errands']);
        const qc = await mount();
        const readsBefore = trashReads();
        server.live = [1, 3];
        server.trashed = [2];
        await act(async () => { await qc.refetchQueries({ queryKey: ['notes', 'lists'], exact: true }); });
        await settle();
        expect(latest!.keys).toEqual(['list:1', 'list:3']);
        expect(trashReads()).toBeGreaterThan(readsBefore);
        expect(getNotesPrefs().colors['list:2']).toBe('mint');
        expect(getNotesPrefs().labels['list:2']).toEqual(['Errands']);
    });

    it('POSITIVE CONTROL: deleted elsewhere (not trashed), the same refetch does prune it', async () => {
        setNoteColor('list:2', 'mint');
        const qc = await mount();
        server.live = [1, 3];   // gone for good
        await act(async () => { await qc.refetchQueries({ queryKey: ['notes', 'lists'], exact: true }); });
        await settle();
        expect(getNotesPrefs().colors['list:2']).toBeUndefined();
    });
});

describe('pins and moves wait for the trash to be read', () => {
    it('a pin before the trash has loaded saves nothing; after, it keeps the trashed slot', async () => {
        server.live = [1, 3];
        server.trashed = [2];
        let release!: () => void;
        server.trashGate = new Promise<void>(r => { release = r; });
        await mount();
        await act(async () => { latest!.actions.togglePin({ kind: 'list', id: 3 }); });
        await settle();
        expect(put).not.toHaveBeenCalled();
        expect(toasts).toEqual(['Still loading the trash — try again in a moment']);
        await act(async () => { release(); server.trashGate = null; });
        await settle();
        await act(async () => { latest!.actions.togglePin({ kind: 'list', id: 3 }); });
        await settle();
        expect(server.prefs.map(p => p.ref_id)).toEqual([3, 2, 1]);
    });
});

describe('the client purge of expired trash runs on the SERVER’s clock', () => {
    // Trashed 2026-09-10 with a 30-day window. This device's clock says
    // 2026-10-20 — long expired by its own reckoning.
    const LOCAL = new Date('2026-10-20T00:00:00Z');
    const deletes = () => del.mock.calls.map(c => c[0]);

    it('a device clock running ahead purges nothing while the server says it is early', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(LOCAL);
        server.live = [1];
        server.trashed = [7];
        server.nowMs = Date.parse('2026-09-12T00:00:00Z');
        await mount();
        expect(deletes()).not.toContain('/task-lists/7');
    });

    it('a server that does not say its time gets no purge at all', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(LOCAL);
        server.live = [1];
        server.trashed = [9];
        server.nowMs = null;
        await mount();
        expect(deletes()).not.toContain('/task-lists/9');
    });

    it('POSITIVE CONTROL: when the server’s clock says it expired, it is purged, files first', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(LOCAL);
        server.live = [1];
        server.trashed = [8];
        server.nowMs = LOCAL.getTime();
        await mount();
        expect(get).toHaveBeenCalledWith('/task-lists/8/tasks');
        expect(deletes()).toContain('/task-lists/8');
    });
});

describe('Notes to self', () => {
    it('is never sent to the trash (the server refuses it): no request, one toast', async () => {
        server.selfId = 1;
        await mount();
        let ok: boolean | undefined;
        await act(async () => { ok = await latest!.actions.deleteNote({ kind: 'list', id: 1 }); });
        await settle();
        expect(ok).toBe(false);
        expect(post).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
        expect(toasts).toEqual(['Notes to self can’t be moved to the trash']);
        expect(latest!.actions.content.isSelfList(1)).toBe(true);
        expect(latest!.actions.content.isSelfList(2)).toBe(false);
    });
});

describe('a failed trash is reported ONCE, in the right words', () => {
    it('offline: one toast, and the note stays', async () => {
        await mount();
        post.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await act(async () => { await latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(toasts).toEqual(['Couldn’t move the note to the trash — check your connection']);
        expect(latest!.keys).toContain('list:2');
    });

    it('the server’s reason (409, 400) is shown instead, alone', async () => {
        await mount();
        post.mockRejectedValueOnce(new ApiError('This note is in the trash — restore it to change it', 409));
        await act(async () => { await latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(toasts).toEqual(['This note is in the trash — restore it to change it']);
    });
});

describe('a trash waits for the text still being saved', () => {
    it('the pending save lands BEFORE the trash request goes', async () => {
        await mount();
        const order: string[] = [];
        let finish!: () => void;
        const unregister = registerBodyFlush(2, () => new Promise<void>(r => { finish = () => { order.push('text saved'); r(); }; }));
        post.mockImplementation(async (path: string) => { order.push(path); return { trashed_at: '2026-09-19T00:00:00Z' }; });
        let done: Promise<boolean> | undefined;
        await act(async () => { done = latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(order).toEqual([]);   // still waiting on the text
        await act(async () => { finish(); await done; });
        expect(order).toEqual(['text saved', '/task-lists/2/trash']);
        unregister();
    });
});

describe('Empty trash', () => {
    it('one note that cannot go does not keep the rest, and it is reported once', async () => {
        server.live = [1];
        server.trashed = [4, 5, 6];
        const base = get.getMockImplementation()!;
        get.mockImplementation(async (path: string) => {
            if (path === '/task-lists/4/tasks') throw new TypeError('Failed to fetch');   // its files cannot be named
            return base(path);
        });
        await mount();
        await act(async () => { await latest!.actions.content.emptyTrash(); });
        await settle();
        const deleted = del.mock.calls.map(c => c[0]);
        expect(deleted).not.toContain('/task-lists/4');
        expect(deleted).toEqual(expect.arrayContaining(['/task-lists/5', '/task-lists/6']));
        expect(toasts).toHaveLength(1);
        expect(toasts[0]).toMatch(/can’t be read here yet/);
    });
});

describe('when the server cannot be reached', () => {
    it('a delete does NOTHING — it is never mistaken for an old server and made permanent', async () => {
        const base = get.getMockImplementation()!;
        get.mockImplementation(async (path: string) => {
            if (path === '/task-lists/features') throw new TypeError('Failed to fetch');
            return base(path);
        });
        await mount();
        let ok: boolean | undefined;
        await act(async () => { ok = await latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(ok).toBe(false);
        expect(del).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(latest!.keys).toContain('list:2');
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
