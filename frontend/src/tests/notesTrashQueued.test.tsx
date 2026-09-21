/**
 * The Trash view and a move to the trash that is still QUEUED.
 *
 * deleteNote lists a note in the cached trash the moment it is moved, even
 * while the move waits in the offline outbox. The Trash view's Restore used
 * to be a direct API call: with a queue waiting (offline, or a replay backing
 * off after a 5xx) it ran FIRST, the queued trash replayed after it, and the
 * note the user restored went back to the trash without a word.
 *
 *  - Restore is NoteActions.restoreNote (the outbox's restoreList op), and it
 *    queues behind the trash: the real app outbox replays trash, then restore;
 *  - Restore and Delete forever are off for a note whose move is queued, and
 *    Empty trash leaves it alone;
 *  - the outbox reports exactly which notes' moves are queued.
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
// An identity to queue under (the outbox seals its queue at rest).
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    const id = real.makeIdentity(new Uint8Array(32).fill(6));
    return { ...real, getActiveIdentity: () => id, seedMatchesCurrentAccount: () => true };
});

import { resetTrashProbe } from '../api/listContent';
import { setMessageToastSink } from '../components/messageToastBus';
import { TrashView } from '../notes/components/TrashView';
import { resetNotesPrune, useNoteActions, useNoteCards, type NoteActions } from '../notes/model/notesQueries';
import { invalidateNotesPrefs } from '../notes/model/notesPrefs';
import { resetNoteBusy } from '../notes/model/noteBusy';
import { appOutbox, useQueuedListDeletes } from '../notes/model/notesOutbox';
import { listContentKeys, type ListContentActions } from '../notes/model/useListContent';

const settle = async (n = 12) => {
    for (let i = 0; i < n; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); });
};

let live: number[];
let trashed: number[];
let online = true;
const row = (id: number, isTrashed = false) => ({
    id, title: `Note ${id}`, created_at: '2026-09-01T00:00:00Z', total_tasks: 0, completed_tasks: 0,
    body: null, attachments: null, trashed_at: isTrashed ? '2026-09-10T00:00:00Z' : null, is_self: false,
});
const offline = () => new TypeError('Failed to fetch');

function installServer() {
    get.mockImplementation(async (path: string) => {
        if (!online) throw offline();
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536, server_now_ms: Date.now() };
        if (path === '/task-lists?trashed=true') return trashed.map(id => row(id, true));
        if (path === '/task-lists') return live.map(id => row(id));
        if (path === '/task-tab-prefs') return live.map(id => ({ kind: 'list', ref_id: id, is_favorite: false }));
        if (path === '/servers') return [];
        if (/^\/task-lists\/\d+\/tasks$/.test(path)) return [];
        throw new Error(`unexpected GET ${path}`);
    });
    post.mockImplementation(async (path: string) => {
        if (!online) throw offline();
        const m = /^\/task-lists\/(\d+)\/(trash|restore)$/.exec(path);
        if (!m) throw new Error(`unexpected POST ${path}`);
        const id = Number(m[1]);
        if (m[2] === 'trash') { live = live.filter(x => x !== id); trashed = [id, ...trashed.filter(x => x !== id)]; return { trashed_at: '2026-09-19T00:00:00Z' }; }
        trashed = trashed.filter(x => x !== id); live = [...live.filter(x => x !== id), id].sort(); return { trashed_at: null };
    });
    put.mockResolvedValue({});
    del.mockResolvedValue({});
}

let root: Root;
let container: HTMLDivElement;
let latest: { actions: NoteActions; keys: string[]; queued: ReadonlySet<number> } | null = null;

function Harness() {
    const { cards, prefs, prefsReady } = useNoteCards();
    const actions = useNoteActions(cards, prefs, prefsReady);
    const queued = useQueuedListDeletes();
    useEffect(() => { latest = { actions, keys: cards.map(c => c.key), queued }; });
    return null;
}

let onLineSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
    localStorage.clear();
    invalidateNotesPrefs();
    resetTrashProbe();
    resetNotesPrune();
    resetNoteBusy();
    get.mockReset(); post.mockReset(); patch.mockReset(); del.mockReset(); put.mockReset();
    live = [1, 2, 3];
    trashed = [];
    online = true;
    onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    setMessageToastSink(() => {});
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
    onLineSpy?.mockRestore();
});

describe('a Restore of a note whose move to the trash is still queued', () => {
    it('queues behind the move, and the replay sends trash THEN restore — the note ends up live', async () => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
        await act(async () => { root.render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>); });
        await settle();
        await act(async () => { await appOutbox.load(); });
        expect(latest!.keys).toEqual(['list:1', 'list:2', 'list:3']);

        online = false;
        let moved: boolean | undefined;
        await act(async () => { moved = await latest!.actions.deleteNote({ kind: 'list', id: 2 }); });
        await settle();
        expect(moved).toBe(true);
        expect(post).not.toHaveBeenCalled();
        expect(latest!.queued.has(2)).toBe(true);                         // the Trash view's rows read this
        expect(qc.getQueryData<{ id: number }[]>(listContentKeys.trash)?.map(l => l.id)).toEqual([2]);

        // Back online, the replay not yet run (it backs off): the user restores.
        online = true;
        await act(async () => { await latest!.actions.restoreNote({ kind: 'list', id: 2 }); });
        await settle(40);
        const order = post.mock.calls.map(c => c[0]);
        expect(order).toEqual(['/task-lists/2/trash', '/task-lists/2/restore']);
        expect(live).toContain(2);
        expect(trashed).not.toContain(2);
        expect(latest!.queued.size).toBe(0);
    });
});

describe('the Trash view', () => {
    const features = { body: true, attachments: true, trash: true, trashRetentionDays: 30, maxBodyLen: 65536, serverClockOffsetMs: 0 };
    function renderTrash(queuedDeletes: ReadonlySet<number>) {
        trashed = [5, 6];
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
        qc.setQueryData(listContentKeys.features, features);
        qc.setQueryData(listContentKeys.trash, trashed.map(id => row(id, true)));
        const restoreNote = vi.fn(async () => true);
        const content = { features, trashEnabled: true, deleteForever: vi.fn(async () => true), emptyTrash: vi.fn(async () => {}) } as unknown as ListContentActions;
        act(() => { root.render(<QueryClientProvider client={qc}><TrashView content={content} restoreNote={restoreNote} queuedDeletes={queuedDeletes} /></QueryClientProvider>); });
        const button = (id: number, name: string) => [...container.querySelectorAll<HTMLButtonElement>(`.notes-trash-row[data-list-id="${id}"] button`)].find(b => b.textContent === name)!;
        const empty = () => [...container.querySelectorAll<HTMLButtonElement>('.notes-trash-head button')].find(b => b.textContent === 'Empty trash')!;
        return { restoreNote, content, button, empty };
    }

    it('Restore goes through restoreNote (the outbox), never a direct call', () => {
        const { restoreNote, button } = renderTrash(new Set());
        act(() => { button(6, 'Restore').click(); });
        expect(restoreNote).toHaveBeenCalledWith({ kind: 'list', id: 6 });
        expect(post).not.toHaveBeenCalled();
    });

    it('a queued move: its Restore and Delete forever are off; the other note’s are on', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const { restoreNote, content, button } = renderTrash(new Set([5]));
        expect(button(5, 'Restore').disabled).toBe(true);
        expect(button(5, 'Delete forever').disabled).toBe(true);
        expect(button(6, 'Restore').disabled).toBe(false);                // positive control
        expect(button(6, 'Delete forever').disabled).toBe(false);
        act(() => { button(5, 'Restore').click(); button(5, 'Delete forever').click(); });
        expect(restoreNote).not.toHaveBeenCalled();
        expect(content.deleteForever).not.toHaveBeenCalled();
        act(() => { button(6, 'Delete forever').click(); });
        expect(content.deleteForever).toHaveBeenCalledWith(expect.objectContaining({ id: 6 }));
        confirm.mockRestore();
    });

    it('Empty trash leaves a queued note alone, and says so; with only queued notes it is off', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const queued = new Set([5]);
        const { content, empty } = renderTrash(queued);
        act(() => { empty().click(); });
        expect(confirm.mock.calls[0][0]).toMatch(/Delete 1 note in the trash forever\? Notes still being moved there are left alone/);
        expect(content.emptyTrash).toHaveBeenCalledWith(queued);
        confirm.mockRestore();
        const all = renderTrash(new Set([5, 6]));
        expect(all.empty().disabled).toBe(true);
    });
});

describe('Empty trash skips what it is told to keep', () => {
    it('deletes every other trashed note and never the kept one', async () => {
        live = [1];
        trashed = [4, 5];
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
        await act(async () => { root.render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>); });
        await settle();
        await act(async () => { await latest!.actions.content.emptyTrash(new Set([4])); });
        await settle();
        const deleted = del.mock.calls.map(c => c[0]);
        expect(deleted).toContain('/task-lists/5');
        expect(deleted).not.toContain('/task-lists/4');
    });
});

describe('the outbox names the queued moves', () => {
    it('a queued delete is listed until it replays; the Set is stable while nothing about it changes', async () => {
        const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
        await act(async () => { root.render(<QueryClientProvider client={qc}><Harness /></QueryClientProvider>); });
        await settle();
        await act(async () => { await appOutbox.load(); });
        const empty = appOutbox.queuedListDeletes();
        expect(empty.size).toBe(0);
        online = false;
        await act(async () => { await latest!.actions.deleteNote({ kind: 'list', id: 3 }); });
        const one = appOutbox.queuedListDeletes();
        expect([...one]).toEqual([3]);
        await act(async () => { await latest!.actions.renameNote({ kind: 'list', id: 1 }, 'Renamed'); });   // another queued op
        expect(appOutbox.queuedListDeletes()).toBe(one);
        online = true;
        await act(async () => { await appOutbox.replay(); });
        await settle();
        expect(appOutbox.queuedListDeletes().size).toBe(0);
    });
});
