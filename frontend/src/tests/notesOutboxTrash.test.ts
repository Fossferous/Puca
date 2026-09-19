/**
 * The merged outbox against the REAL executor (notesOutbox.ts execOp) and the
 * one trash API (api/listContent.ts):
 *  - a delete whose trash probe cannot reach the server is QUEUED, never made
 *    permanent, and replays as a move to the trash once the server answers;
 *  - an Undo (restore) made while that delete is still queued replays right
 *    behind it, so the note ends up where the user left it;
 *  - a calendar timing op and a timed create reach patchTaskTiming /
 *    createListTask with the temporary ids rewritten;
 *  - an order saved offline keeps a trashed note's slot when it replays.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../api/client';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return {
        ...real,
        createTaskList: vi.fn(), createListTask: vi.fn(), createTask: vi.fn(), deleteTaskList: vi.fn(),
        patchTaskTiming: vi.fn(), getTaskTabPrefs: vi.fn(), putTaskTabPrefs: vi.fn(),
    };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));

import { apiClient } from '../api/client';
import { makeIdentity } from '../api/e2ee';
import { resetTrashProbe } from '../api/listContent';
import { createListTask, createTaskList, deleteTaskList, getTaskTabPrefs, patchTaskTiming, putTaskTabPrefs, type Task } from '../api/tasks';
const { createOutbox, execOp, ops } = await import('../notes/model/notesOutbox');
const { memoryStore } = await import('../notes/model/notesCache');
const { resetNoteBusy } = await import('../notes/model/noteBusy');
type ReplaySummary = import('../notes/model/notesOutbox').ReplaySummary;

const identity = makeIdentity(new Uint8Array(32).fill(9));
const task = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `item ${id}`, is_completed: false, position: 1,
    created_at: '', created_by: 7, attachments: null, due_at: null, ...over,
});

/** A server that can be unreachable, and remembers what it was asked. */
function server() {
    let reachable = true;
    const trashed: number[] = [];
    const restored: number[] = [];
    vi.mocked(apiClient.get).mockImplementation(async (path: string) => {
        if (!reachable) throw new TypeError('Failed to fetch');
        if (path === '/task-lists/features') return { body: true, attachments: true, trash: true, trash_retention_days: 30, max_body_len: 65536 };
        throw new Error(`unexpected GET ${path}`);
    });
    vi.mocked(apiClient.post).mockImplementation(async (path: string) => {
        if (!reachable) throw new TypeError('Failed to fetch');
        const m = /^\/task-lists\/(\d+)\/(trash|restore)$/.exec(path);
        if (!m) throw new ApiError('Not Found', 404);
        (m[2] === 'trash' ? trashed : restored).push(Number(m[1]));
        return { trashed_at: m[2] === 'trash' ? '2026-09-19T00:00:00Z' : null };
    });
    const summaries: ReplaySummary[] = [];
    const ob = createOutbox({
        sub: () => 7,
        identity: () => identity,
        store: (() => { const s = memoryStore(); return () => s; })(),
        exec: execOp,
        online: () => reachable,
        lock: (_n, fn) => fn(),
        onReplayed: s => summaries.push(s),
    });
    return { ob, trashed, restored, summaries, setReachable: (v: boolean) => { reachable = v; } };
}

beforeEach(() => {
    vi.clearAllMocks();
    resetTrashProbe();
    resetNoteBusy();
});

describe('Delete through the outbox, with the one trash API', () => {
    it('a probe that cannot reach the server QUEUES the delete — nothing permanent — and it replays as a trash', async () => {
        const s = server();
        // navigator says online, but the request never arrives: the probe fails.
        vi.mocked(apiClient.get).mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const r = await s.ob.send(ops.deleteList(5, 'Groceries'));
        expect(r.queued).toBe(true);
        expect(deleteTaskList).not.toHaveBeenCalled();
        expect(apiClient.post).not.toHaveBeenCalled();
        expect(s.ob.pending()).toBe(1);
        await s.ob.replay();
        expect(s.trashed).toEqual([5]);
        expect(deleteTaskList).not.toHaveBeenCalled();
        expect(s.ob.pending()).toBe(0);
    });

    it('an Undo made while the delete is still queued replays right behind it', async () => {
        const s = server();
        s.setReachable(false);
        await s.ob.send(ops.deleteList(5, 'Groceries'));
        const undo = await s.ob.send(ops.restoreList(5, 'Groceries'));
        expect(undo.queued).toBe(true);
        s.setReachable(true);
        await s.ob.replay();
        expect(s.trashed).toEqual([5]);
        expect(s.restored).toEqual([5]);
        const order = vi.mocked(apiClient.post).mock.calls.map(c => c[0]);
        expect(order).toEqual(['/task-lists/5/trash', '/task-lists/5/restore']);
    });

    it('POSITIVE CONTROL: a server KNOWN to have no trash gets the permanent delete', async () => {
        const s = server();
        vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError('Method Not Allowed', 405));
        const r = await s.ob.send(ops.deleteList(5, 'Groceries'));
        expect(r).toEqual({ queued: false, value: 'deleted' });
        expect(deleteTaskList).toHaveBeenCalledWith(5);
    });
});

describe('the calendar\'s ops at replay', () => {
    it('a timed item made offline in a note made offline: one create each, ids rewritten, timing carried', async () => {
        const s = server();
        s.setReachable(false);
        const listTemp = -1001;
        const itemTemp = -1002;
        await s.ob.send(ops.createList(listTemp, 'Calendar'));
        const timing = { dueAt: '2026-09-21T09:00:00.000Z', schedule: '{"v":1}' };
        await s.ob.send(ops.createTask({ kind: 'list', id: listTemp }, itemTemp, 'Dentist', undefined, timing));
        await s.ob.send(ops.timing({ kind: 'list', id: listTemp }, task(itemTemp), { is_completed: true }, 'tick'));
        vi.mocked(createTaskList).mockResolvedValue({ id: 40, title: 'Calendar', created_at: '', total_tasks: 0, completed_tasks: 0 });
        vi.mocked(createListTask).mockResolvedValue(task(41));
        s.setReachable(true);
        await s.ob.replay();
        expect(createListTask).toHaveBeenCalledWith(40, 'Dentist', undefined, timing);
        expect(patchTaskTiming).toHaveBeenCalledWith({ id: 41, channel_id: null, created_by: 7 }, { is_completed: true });
        expect(s.summaries.at(-1)!.touchedDue).toBe(true);   // the reminders are poked once it is on the server
    });

    it('a shared checklist item\'s timing op is sealed for THAT channel (scope from the note, not guessed)', async () => {
        await execOp(ops.timing({ kind: 'channel', id: 12 }, task(3, { channel_id: 12, created_by: 99 }), { snooze: null }, 'unsnooze'), {}, true);
        expect(patchTaskTiming).toHaveBeenCalledWith({ id: 3, channel_id: 12, created_by: 99 }, { snooze: null });
    });
});

describe('an order saved offline keeps a trashed note\'s slot', () => {
    it('replayed against the server\'s current set, the note the order does not name stays at its index', async () => {
        const P = (id: number, fav = false) => ({ kind: 'list' as const, ref_id: id, is_favorite: fav });
        vi.mocked(getTaskTabPrefs).mockResolvedValue([P(1), P(2, true), P(3)]);   // 2 is in the trash
        await execOp(ops.prefs([], { type: 'order', keys: ['list:3', 'list:1'] }), {}, true);
        expect(vi.mocked(putTaskTabPrefs).mock.calls[0][0].map(p => p.ref_id)).toEqual([3, 2, 1]);
        expect(vi.mocked(putTaskTabPrefs).mock.calls[0][0].find(p => p.ref_id === 2)?.is_favorite).toBe(true);
    });
});
