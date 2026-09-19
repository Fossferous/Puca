/**
 * Offline edits (notes/model/notesOutbox.ts): what queues, what rolls back,
 * the replay order, temporary ids, and what a refusal does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../api/client';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));
vi.mock('../api/tasks', async () => {
    // The pure helpers are the real ones; the network calls are never reached
    // (the harness injects its own executor).
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return {
        ...real,
        createTask: vi.fn(), createListTask: vi.fn(), createTaskList: vi.fn(), renameTaskList: vi.fn(), deleteTaskList: vi.fn(),
        updateTask: vi.fn(), updateChannelTask: vi.fn(), updateListTask: vi.fn(), deleteTask: vi.fn(), moveTask: vi.fn(), reorderTask: vi.fn(),
        getTaskTabPrefs: vi.fn(), putTaskTabPrefs: vi.fn(),
    };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));

import { makeIdentity } from '../api/e2ee';
const { createOutbox, ops, applyPrefsIntent, referencesTemp } = await import('../notes/model/notesOutbox');
const { memoryStore } = await import('../notes/model/notesCache');
const { isNoteBusy, resetNoteBusy } = await import('../notes/model/noteBusy');
type NoteOp = import('../notes/model/notesOutbox').NoteOp;
type ReplaySummary = import('../notes/model/notesOutbox').ReplaySummary;

const identity = makeIdentity(new Uint8Array(32).fill(5));
const task = (id: number, description = `item ${id}`) => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false, position: 1,
    created_at: '', created_by: 7, attachments: null, due_at: null,
});
const LIST = { kind: 'list' as const, id: 1 };

/** A fake server: records what ran, assigns real ids, and fails on demand. */
function harness() {
    const store = memoryStore();
    let online = true;
    const ran: Array<{ k: string; ids: unknown }> = [];
    const failures = new Map<string, unknown>();   // op label -> error to throw once
    let nextId = 100;
    const summaries: ReplaySummary[] = [];
    const exec = vi.fn(async (op: NoteOp, ids: Record<string, number>) => {
        if (!online) throw new TypeError('Failed to fetch');
        const f = failures.get(op.label);
        if (f) { failures.delete(op.label); throw f; }
        const r = (id: number) => { if (id >= 0) return id; const real = ids[String(id)]; if (real === undefined) throw new Error('unresolved'); return real; };
        switch (op.k) {
            case 'createList': ids[String(op.tempId)] = nextId++; ran.push({ k: op.k, ids: ids[String(op.tempId)] }); return {};
            case 'createTask': ids[String(op.tempId)] = nextId++; ran.push({ k: op.k, ids: [r(op.note.id), op.parentId === undefined ? null : r(op.parentId)] }); return {};
            case 'updateTask': case 'deleteTask': case 'moveTask': case 'editTask': ran.push({ k: op.k, ids: [r(op.note.id), r(op.taskId)] }); return {};
            default: ran.push({ k: op.k, ids: null }); return {};
        }
    });
    const make = (id = identity) => createOutbox({
        sub: () => 7,
        identity: () => id,
        store: () => store,
        exec: exec as never,
        online: () => online,
        lock: (_n, fn) => fn(),
        onReplayed: s => summaries.push(s),
    });
    return { store, exec, ran, failures, summaries, make, setOnline: (v: boolean) => { online = v; } };
}

beforeEach(() => resetNoteBusy());

describe('sending', () => {
    it('online with nothing queued: runs the op, queues nothing', async () => {
        const h = harness();
        const ob = h.make();
        const r = await ob.send(ops.toggle(LIST, task(5), true));
        expect(r.queued).toBe(false);
        expect(h.ran).toEqual([{ k: 'updateTask', ids: [1, 5] }]);
        expect(ob.pending()).toBe(0);
    });

    it('a network failure queues the op instead of rolling back, sealed at rest', async () => {
        const h = harness();
        const ob = h.make();
        h.failures.set(ops.toggle(LIST, task(5, 'Buy milk'), true).label, new TypeError('Failed to fetch'));
        const r = await ob.send(ops.toggle(LIST, task(5, 'Buy milk'), true));
        expect(r.queued).toBe(true);
        expect(ob.pending()).toBe(1);
        expect(isNoteBusy('list:1')).toBe(true);           // refetches of this note wait
        const stored = [...h.store.map.values()].join('');
        expect(stored).not.toContain('Buy milk');          // the queue is sealed on the device
        expect(stored.length).toBeGreaterThan(0);
    });

    it('a server refusal is thrown, so the caller rolls back as before', async () => {
        const h = harness();
        const ob = h.make();
        const op = ops.toggle(LIST, task(5), true);
        h.failures.set(op.label, new ApiError('Forbidden', 403));
        await expect(ob.send(op)).rejects.toBeInstanceOf(ApiError);
        expect(ob.pending()).toBe(0);
    });

    it('offline: queues without trying, and later ops queue behind earlier ones', async () => {
        const h = harness();
        const ob = h.make();
        h.setOnline(false);
        await ob.send(ops.toggle(LIST, task(5), true));
        h.setOnline(true);
        // Online again, but something is queued: this one must not overtake it.
        const r = await ob.send(ops.toggle(LIST, task(5), false));
        expect(r.queued).toBe(true);
        expect(h.exec).not.toHaveBeenCalled();
        expect(ob.pending()).toBe(2);
    });

    it('an op naming a temporary id always queues', () => {
        expect(referencesTemp(ops.toggle({ kind: 'list', id: -3 }, task(5), true))).toBe(true);
        expect(referencesTemp(ops.toggle(LIST, task(-9), true))).toBe(true);
        expect(referencesTemp(ops.toggle(LIST, task(9), true))).toBe(false);
    });
});

describe('replay', () => {
    it('is first-in-first-out and rewrites temporary ids through what the creates returned', async () => {
        const h = harness();
        const ob = h.make();
        h.setOnline(false);
        await ob.send(ops.createList(-1, 'Groceries'));
        await ob.send(ops.createTask({ kind: 'list', id: -1 }, -2, 'Eggs'));
        await ob.send(ops.toggle({ kind: 'list', id: -1 }, task(-2, 'Eggs'), true));
        h.setOnline(true);
        const s = await ob.replay();
        expect(h.ran).toEqual([
            { k: 'createList', ids: 100 },
            { k: 'createTask', ids: [100, null] },
            { k: 'updateTask', ids: [100, 101] },          // never a negative id on the wire
        ]);
        expect(s?.created).toEqual({ '-1': 100, '-2': 101 });
        expect(ob.pending()).toBe(0);
        expect(isNoteBusy('list:-1')).toBe(false);
    });

    it('a refused create drops the ops that depend on it, and says so once', async () => {
        const h = harness();
        const ob = h.make();
        h.setOnline(false);
        const create = ops.createTask(LIST, -5, 'Secret plan');
        await ob.send(create);
        await ob.send(ops.toggle(LIST, task(-5, 'Secret plan'), true));
        await ob.send(ops.toggle(LIST, task(9), true));
        h.setOnline(true);
        h.failures.set(create.label, new ApiError('List not found', 404));
        const s = await ob.replay();
        expect(s?.dropped.map(o => o.k)).toEqual(['createTask', 'updateTask']);
        expect(h.ran).toEqual([{ k: 'updateTask', ids: [1, 9] }]);   // the unrelated one still went
        // The dependant was never even attempted (it would have gone out with a dead id).
        expect(h.exec.mock.calls.map(c => (c[0] as NoteOp).label)).toEqual([create.label, ops.toggle(LIST, task(9), true).label]);
        expect(h.summaries).toHaveLength(1);
    });

    it('a network error stops the replay and keeps the rest; a 5xx retries; a 4xx drops', async () => {
        const h = harness();
        const ob = h.make();
        h.setOnline(false);
        const a = ops.toggle(LIST, task(1), true);
        const b = ops.toggle(LIST, task(2), true);
        await ob.send(a);
        await ob.send(b);
        h.setOnline(true);
        h.failures.set(a.label, new TypeError('Failed to fetch'));
        await ob.replay();
        expect(ob.pending()).toBe(2);                       // stopped at a, kept both
        h.failures.set(a.label, new ApiError('boom', 503));
        await ob.replay();
        expect(ob.pending()).toBe(2);                       // retried later, not dropped
        h.failures.set(a.label, new ApiError('conflict', 409));
        const s = await ob.replay();
        expect(s?.dropped.map(o => o.oid)).toEqual([a.oid]);
        expect(h.ran).toEqual([{ k: 'updateTask', ids: [1, 2] }]);
        expect(ob.pending()).toBe(0);
    });

    it('survives a reload: a fresh instance reads the queue back and replays it', async () => {
        const h = harness();
        const first = h.make();
        h.setOnline(false);
        await first.send(ops.toggle(LIST, task(3), true));
        const second = h.make();                            // the page reloaded
        await second.load();
        expect(second.pending()).toBe(1);
        h.setOnline(true);
        await second.replay();
        expect(h.ran).toEqual([{ k: 'updateTask', ids: [1, 3] }]);
    });

    it('another account’s seed cannot open the queue', async () => {
        const h = harness();
        const mine = h.make();
        h.setOnline(false);
        await mine.send(ops.toggle(LIST, task(3), true));
        const theirs = h.make(makeIdentity(new Uint8Array(32).fill(6)));
        await theirs.load();
        expect(theirs.pending()).toBe(0);
    });
});

describe('pins and order replay as intents against the server’s current set', () => {
    const P = (kind: 'list' | 'channel', ref_id: number, is_favorite = false) => ({ kind, ref_id, is_favorite });

    it('a pin applies to the current set, and is a no-op when already in that state', () => {
        const current = [P('list', 1), P('channel', 2), P('list', 3)];
        const next = applyPrefsIntent(current, { type: 'pin', tab: { kind: 'list', id: 3 }, favorite: true });
        expect(next?.[0]).toEqual(P('list', 3, true));      // favouriting pulls it to the front
        expect(next).toHaveLength(3);                       // nothing another device saved is lost
        expect(applyPrefsIntent(next!, { type: 'pin', tab: { kind: 'list', id: 3 }, favorite: true })).toBeNull();
    });

    it('an order keeps entries this device never saw', () => {
        const current = [P('list', 1), P('list', 2), P('channel', 9, true)];
        const next = applyPrefsIntent(current, { type: 'order', keys: ['list:2', 'list:1'] });
        expect(next).toEqual([P('list', 2), P('list', 1), P('channel', 9, true)]);
    });
});
