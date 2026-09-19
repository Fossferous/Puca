/**
 * The bulk paths through the REAL action surface (notes/model/notesQueries.ts
 * useNoteActions), not only the pure helpers behind it:
 *  - a bulk pin is ONE prefs save over the full order (actions.setPinnedMany);
 *  - a failed delete in a concurrent batch puts back ONLY its own note;
 *  - delete goes to the trash where the server has one, feature-detected
 *    (notes/model/listTrash.ts), and forgets the note's colour and labels
 *    only on a permanent delete;
 *  - the settled-absence prune (notes/model/notesPrune.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../api/client';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), currentUserIdFromToken: () => 7 }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: vi.fn(), post: vi.fn() } };
});
vi.mock('../api/tasks', async (orig) => {
    const real = await orig<typeof import('../api/tasks')>();
    return { ...real, deleteTaskList: vi.fn() };
});
vi.mock('../notes/model/notesOutbox', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesOutbox')>();
    return { ...real, sendNoteOp: vi.fn() };
});
vi.mock('../notes/model/notesPrefs', async (orig) => {
    const real = await orig<typeof import('../notes/model/notesPrefs')>();
    return { ...real, forgetNoteKeys: vi.fn() };
});

import { apiClient } from '../api/client';
import { deleteTaskList, type TaskList, type TaskTabPref } from '../api/tasks';
import { execOp, ops, sendNoteOp, type NoteOp } from '../notes/model/notesOutbox';
import { forgetNoteKeys } from '../notes/model/notesPrefs';
import { confirmGone, notesKeys, useNoteActions, type NoteActions } from '../notes/model/notesQueries';
import type { NoteCard } from '../notes/model/notesModel';
import { resetListTrashProbe } from '../notes/model/listTrash';
import { newPruneState, pruneStep, PRUNE_GRACE_MS } from '../notes/model/notesPrune';

const list = (id: number): TaskList => ({ id, title: `n${id}`, created_at: '', total_tasks: 0, completed_tasks: 0 });
const card = (id: number) => ({ key: `list:${id}`, ref: { kind: 'list' as const, id } }) as unknown as NoteCard;
const pref = (id: number, fav = false): TaskTabPref => ({ kind: 'list', ref_id: id, is_favorite: fav });

function mountActions(qc: QueryClient, cards: NoteCard[], prefs: TaskTabPref[]): () => NoteActions {
    let current: NoteActions | null = null;
    function Probe() {
        current = useNoteActions(cards, prefs, true);
        return null;
    }
    const host = document.createElement('div');
    document.body.appendChild(host);
    act(() => { createRoot(host).render(<QueryClientProvider client={qc}><Probe /></QueryClientProvider>); });
    return () => current!;
}

beforeEach(() => { vi.clearAllMocks(); resetListTrashProbe(); });
afterEach(() => { document.body.innerHTML = ''; });

describe('actions.setPinnedMany', () => {
    it('pins several notes in ONE save, over the full order, keeping hidden notes’ slots', async () => {
        vi.mocked(sendNoteOp).mockResolvedValue({ queued: false, value: undefined });
        const qc = new QueryClient();
        // list:2 is hidden from the grid (archived) but is in the saved order as a favourite.
        const cards = [card(1), card(2), card(3), card(4)];
        const prefs = [pref(1), pref(2, true), pref(3), pref(4)];
        qc.setQueryData(notesKeys.prefs, prefs);
        const actions = mountActions(qc, cards, prefs);
        act(() => { actions().setPinnedMany([{ kind: 'list', id: 3 }, { kind: 'list', id: 4 }], true); });
        expect(sendNoteOp).toHaveBeenCalledTimes(1);                  // not one per note
        const op = vi.mocked(sendNoteOp).mock.calls[0][0] as NoteOp & { k: 'prefs' };
        expect(op.k).toBe('prefs');
        expect(op.intent).toEqual({ type: 'pins', tabs: [{ kind: 'list', id: 3 }, { kind: 'list', id: 4 }], favorite: true });
        expect(op.prefs.map(p => `${p.ref_id}:${p.is_favorite}`)).toEqual(['3:true', '4:true', '1:false', '2:true']);
        expect(qc.getQueryData(notesKeys.prefs)).toEqual(op.prefs);  // optimistic, the same set
    });
});

describe('actions.deleteNote in a concurrent bulk delete', () => {
    it('a failure puts back ONLY its own note, not the snapshot it started from', async () => {
        const qc = new QueryClient();
        qc.setQueryData<TaskList[]>(notesKeys.lists, [list(1), list(2), list(3)]);
        const release: Record<number, (ok: boolean) => void> = {};
        vi.mocked(sendNoteOp).mockImplementation((op: NoteOp) => new Promise((res, rej) => {
            const id = (op as NoteOp & { listId: number }).listId;
            release[id] = ok => (ok ? res({ queued: false, value: 'deleted' }) : rej(new ApiError('boom', 500)));
        }));
        const actions = mountActions(qc, [card(1), card(2), card(3)], []);
        let p1!: Promise<boolean>, p2!: Promise<boolean>;
        await act(async () => {
            p1 = actions().deleteNote({ kind: 'list', id: 1 });
            p2 = actions().deleteNote({ kind: 'list', id: 2 });   // started while 1 is still out
        });
        expect(qc.getQueryData<TaskList[]>(notesKeys.lists)!.map(l => l.id)).toEqual([3]);
        await act(async () => { release[2](true); await p2; });   // 2 is deleted on the server
        await act(async () => { release[1](false); await p1; });  // 1 fails
        expect(await p1).toBe(false);
        // 1 is back, in its old place; 2 stays gone.
        expect(qc.getQueryData<TaskList[]>(notesKeys.lists)!.map(l => l.id)).toEqual([1, 3]);
    });

    it('forgets colour and labels only on a PERMANENT delete, never on a trash or a queued one', async () => {
        const qc = new QueryClient();
        qc.setQueryData<TaskList[]>(notesKeys.lists, [list(1), list(2), list(3)]);
        const actions = mountActions(qc, [card(1), card(2), card(3)], []);
        vi.mocked(sendNoteOp).mockResolvedValueOnce({ queued: false, value: 'trashed' });
        await act(async () => { await actions().deleteNote({ kind: 'list', id: 1 }); });
        vi.mocked(sendNoteOp).mockResolvedValueOnce({ queued: true });
        await act(async () => { await actions().deleteNote({ kind: 'list', id: 2 }); });
        expect(forgetNoteKeys).not.toHaveBeenCalled();
        vi.mocked(sendNoteOp).mockResolvedValueOnce({ queued: false, value: 'deleted' });
        await act(async () => { await actions().deleteNote({ kind: 'list', id: 3 }); });
        expect(forgetNoteKeys).toHaveBeenCalledWith(['list:3']);
    });
});

describe('delete goes to the trash where the server has one', () => {
    const del = ops.deleteList(5, 'Groceries');

    it('a server with a trash: POST /task-lists/:id/trash, and never the permanent delete', async () => {
        vi.mocked(apiClient.get).mockResolvedValue({ body: true, trash: true, trash_retention_days: 30 });
        vi.mocked(apiClient.post).mockResolvedValue({ trashed_at: 'now' });
        expect(await execOp(del, {}, true)).toBe('trashed');
        expect(apiClient.get).toHaveBeenCalledWith('/task-lists/features');
        expect(apiClient.post).toHaveBeenCalledWith('/task-lists/5/trash', {});
        expect(deleteTaskList).not.toHaveBeenCalled();
    });

    it('an older server (404/405 on the probe): today’s delete', async () => {
        for (const status of [404, 405]) {
            resetListTrashProbe();
            vi.clearAllMocks();
            vi.mocked(apiClient.get).mockRejectedValue(new ApiError('Not Found', status));
            expect(await execOp(del, {}, true)).toBe('deleted');
            expect(deleteTaskList).toHaveBeenCalledWith(5);
            expect(apiClient.post).not.toHaveBeenCalled();
        }
    });

    it('a server that says trash: false gets today’s delete too', async () => {
        vi.mocked(apiClient.get).mockResolvedValue({ trash: false });
        expect(await execOp(del, {}, true)).toBe('deleted');
        expect(deleteTaskList).toHaveBeenCalledWith(5);
    });

    it('a probe that fails any other way deletes NOTHING (a bad moment is not an old server)', async () => {
        vi.mocked(apiClient.get).mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(execOp(del, {}, true)).rejects.toBeInstanceOf(TypeError);   // network: the outbox queues it
        vi.mocked(apiClient.get).mockRejectedValue(new ApiError('Bad Gateway', 502));
        await expect(execOp(del, {}, true)).rejects.toBeInstanceOf(ApiError);
        expect(deleteTaskList).not.toHaveBeenCalled();
        expect(apiClient.post).not.toHaveBeenCalled();
    });
});

describe('the settled-absence prune', () => {
    const stored = new Set(['list:1', 'list:2', 'channel:9']);
    const present = new Set(['list:1']);

    it('never on the first sighting, nor on a second view of the SAME fetch', () => {
        const s = newPruneState();
        expect(pruneStep(s, { list: 100, channel: 100 }, 0, present, stored)).toEqual([]);
        expect(pruneStep(s, { list: 100, channel: 100 }, PRUNE_GRACE_MS * 5, present, stored)).toEqual([]);
    });

    it('never within the grace period, even across two fetches', () => {
        const s = newPruneState();
        pruneStep(s, { list: 100, channel: 100 }, 0, present, stored);
        expect(pruneStep(s, { list: 200, channel: 200 }, PRUNE_GRACE_MS - 1, present, stored)).toEqual([]);
    });

    it('missing across two fetches a grace period apart: forgotten, per kind of fetch', () => {
        const s = newPruneState();
        pruneStep(s, { list: 100, channel: 100 }, 0, present, stored);
        // A new LIST fetch only: the list is due, the checklist waits for a channel fetch.
        expect(pruneStep(s, { list: 200, channel: 100 }, PRUNE_GRACE_MS, present, stored)).toEqual(['list:2']);
        expect(pruneStep(s, { list: 200, channel: 300 }, PRUNE_GRACE_MS, present, stored).sort()).toEqual(['channel:9', 'list:2']);
    });

    it('a note that reappears (created elsewhere, restored) loses its strike', () => {
        const s = newPruneState();
        pruneStep(s, { list: 100, channel: 100 }, 0, present, stored);
        pruneStep(s, { list: 150, channel: 100 }, 10, new Set(['list:1', 'list:2']), stored);   // back
        expect(pruneStep(s, { list: 200, channel: 100 }, PRUNE_GRACE_MS * 2, present, stored)).toEqual([]);
    });
});

describe('a personal list is forgotten only once the trash has been asked', () => {
    it('a list in the trash keeps its colour and labels; a checklist is not a trash matter', async () => {
        vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
            if (path === '/task-lists/features') return { trash: true };
            if (path === '/task-lists?trashed=true') return [{ id: 2, trashed_at: '2026-09-19T10:00:00Z' }, { id: 4, trashed_at: null }];
            throw new Error('unexpected ' + path);
        });
        const got = await confirmGone(new QueryClient(), ['list:2', 'list:4', 'channel:9']);
        expect(got.sort()).toEqual(['channel:9', 'list:4']);
    });

    it('when the trash cannot be asked, no personal list is forgotten', async () => {
        vi.mocked(apiClient.get).mockRejectedValue(new TypeError('Failed to fetch'));
        expect(await confirmGone(new QueryClient(), ['list:2', 'channel:9'])).toEqual(['channel:9']);
    });

    it('positive control: a server with no trash confirms straight away', async () => {
        vi.mocked(apiClient.get).mockRejectedValue(new ApiError('Not Found', 404));
        expect(await confirmGone(new QueryClient(), ['list:2'])).toEqual(['list:2']);
    });
});
