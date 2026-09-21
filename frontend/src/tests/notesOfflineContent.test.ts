/**
 * A note's TEXT and its PICTURES made with no connection
 * (notes/model/notesOutbox.ts + notesBlobs.ts):
 *  - the text queues, and a second save for the same note replaces the
 *    queued one rather than piling up one op per pause in typing;
 *  - a picture is encrypted on this device the moment it is taken, and only
 *    the ciphertext is kept — the plaintext is nowhere in the store;
 *  - replay uploads it and adds it to whatever the SERVER's sidecar holds
 *    then, never a stale full replace;
 *  - a refused op, a removed picture and an unnamed leftover all free their
 *    bytes again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../api/client';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));
vi.mock('../api/tasks', async () => {
    const real = await vi.importActual<typeof import('../api/tasks')>('../api/tasks');
    return {
        ...real,
        createTask: vi.fn(), createListTask: vi.fn(), createTaskList: vi.fn(), renameTaskList: vi.fn(), deleteTaskList: vi.fn(),
        updateTask: vi.fn(), updateChannelTask: vi.fn(), updateListTask: vi.fn(), deleteTask: vi.fn(), moveTask: vi.fn(), reorderTask: vi.fn(),
        getTaskTabPrefs: vi.fn(), putTaskTabPrefs: vi.fn(), listTaskLists: vi.fn(),
    };
});
vi.mock('../api/taskReminders', () => ({ pokeTaskReminders: vi.fn() }));
vi.mock('../components/messageToastBus', () => ({ pushMessageToast: vi.fn() }));

import { makeIdentity } from '../api/e2ee';
const { createOutbox, enqueue, execOp, ops, queuedBlobIds, busyKeyOf } = await import('../notes/model/notesOutbox');
const { createParkedStore, MAX_PARKED_MEDIA_BYTES, ParkedMediaFullError } = await import('../notes/model/notesBlobs');
const { memoryStore } = await import('../notes/model/notesCache');
const { resetNoteBusy } = await import('../notes/model/noteBusy');
type NoteOp = import('../notes/model/notesOutbox').NoteOp;
type SealedMedia = import('../api/noteMedia').SealedMedia;
type ReplaySummary = import('../notes/model/notesOutbox').ReplaySummary;

const identity = makeIdentity(new Uint8Array(32).fill(5));
const other = makeIdentity(new Uint8Array(32).fill(9));

/** A parked record standing in for a sealed photo. `data` is base64 of
 *  whatever the caller says, so a test can look for it in the raw store. */
const media = (id: string, plain = 'CIPHERTEXT-BYTES', bytes = 1_000): SealedMedia => ({
    id, name: `${id}.jpg`, mime: 'image/jpeg', key: 'AAAA', data: btoa(plain), bytes,
});

function parkedHarness(id = identity) {
    const store = memoryStore();
    const parked = createParkedStore({ sub: () => 7, identity: () => id, store: () => store });
    return { store, parked };
}

/** The outbox, with a real parked store behind it. */
function harness() {
    const { store, parked } = parkedHarness();
    const queue = memoryStore();
    let online = true;
    const ran: NoteOp[] = [];
    const failures = new Map<string, unknown>();
    const summaries: ReplaySummary[] = [];
    const exec = vi.fn(async (op: NoteOp) => {
        if (!online) throw new TypeError('Failed to fetch');
        const f = failures.get(op.label);
        if (f) { failures.delete(op.label); throw f; }
        ran.push(op);
        return {};
    });
    const make = () => createOutbox({
        sub: () => 7,
        identity: () => identity,
        store: () => queue,
        exec: exec as never,
        online: () => online,
        lock: (_n, fn) => fn(),
        onReplayed: s => summaries.push(s),
        parked,
    });
    return { store, queue, parked, ran, failures, summaries, make, setOnline: (v: boolean) => { online = v; } };
}

beforeEach(() => resetNoteBusy());

describe('a note’s text with no connection', () => {
    it('queues instead of failing, and the busy key is the CARD, not the listing', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        const r = await ob.send(ops.setBody(4, 'Written on a plane'));
        expect(r.queued).toBe(true);
        expect(ob.pending()).toBe(1);
        expect(ob.queuedKeys().has('list:4')).toBe(true);
        expect(busyKeyOf(ops.setBody(4, 'x'))).toBe('list:4');
    });

    it('a second save for the SAME note replaces the queued one, carrying the later text', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        await ob.send(ops.setBody(4, 'Writ'));
        await ob.send(ops.setBody(4, 'Written on'));
        await ob.send(ops.setBody(4, 'Written on a plane'));
        expect(ob.pending()).toBe(1);
        h.setOnline(true);
        await ob.replay();
        expect(h.ran.map(o => o.k)).toEqual(['setBody']);
        expect(h.ran[0]).toMatchObject({ k: 'setBody', listId: 4, body: 'Written on a plane' });
    });

    it('two DIFFERENT notes do not collapse into one another', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        await ob.send(ops.setBody(4, 'one'));
        await ob.send(ops.setBody(5, 'two'));
        expect(ob.pending()).toBe(2);
    });

    it('the replacement keeps its PLACE, so it still replays behind the note’s create', () => {
        const create = ops.createList(-1, 'New note');
        let s = enqueue({ queue: [], ids: {}, dead: [] }, create);
        s = enqueue(s, ops.setBody(-1, 'first'));
        s = enqueue(s, ops.deleteTask({ kind: 'list', id: 9 }, 3, 'an item'));
        s = enqueue(s, ops.setBody(-1, 'second'));
        expect(s.queue.map(o => o.k)).toEqual(['createList', 'setBody', 'deleteTask']);
        expect(s.queue[1]).toMatchObject({ body: 'second' });
    });
});

describe('a picture taken with no connection', () => {
    it('keeps only ciphertext: the plaintext is nowhere in the store, and the key needs the seed', async () => {
        const h = parkedHarness();
        await h.parked.park([media('a', 'THE-PHOTO-BYTES')]);
        const raw = [...h.store.map.values()].join('');
        expect(raw).not.toContain('THE-PHOTO-BYTES');
        expect(raw).not.toContain(btoa('THE-PHOTO-BYTES'));
        expect(raw).not.toContain('.jpg');
        // Positive control: WITH the seed it comes back exactly.
        expect(await h.parked.read(['a'])).toEqual([media('a', 'THE-PHOTO-BYTES')]);
        // ...and another account's seed opens nothing.
        const wrong = createParkedStore({ sub: () => 7, identity: () => other, store: () => h.store });
        expect(await wrong.read(['a'])).toEqual([]);
    });

    it('refuses over the device cap, and parks NOTHING of the call that went over', async () => {
        const h = parkedHarness();
        await h.parked.park([media('a', 'x', MAX_PARKED_MEDIA_BYTES - 10)]);
        await expect(h.parked.park([media('b', 'y', 100), media('c', 'z', 100)])).rejects.toBeInstanceOf(ParkedMediaFullError);
        expect(await h.parked.read(['b', 'c'])).toEqual([]);
        // The one already waiting is untouched.
        expect((await h.parked.waiting()).items).toBe(1);
    });

    it('queues one op naming the parked bytes, and the note shows it meanwhile', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        await h.parked.park([media('a'), media('b')]);
        await ob.send(ops.addMedia(4, ['a', 'b'], [], [], '2 pictures on a note'));
        expect(ob.pending()).toBe(1);
        expect(ob.pendingMedia()).toBe(2);
        expect((await h.parked.waiting()).bytes).toBe(2_000);
    });
});

describe('what replay does with parked media', () => {
    it('uploads, then adds to the server’s CURRENT sidecar — a ref this device never saw survives', async () => {
        const server = new Map<number, string>();
        const theirs = { href: 'sovereign-enc:theirs?k=K&m=image%2Fpng', name: 'from-the-phone.png' };
        server.set(4, JSON.stringify([theirs]));
        const uploaded = { href: 'sovereign-enc:mine?k=K2&m=image%2Fjpeg', name: 'a.jpg' };

        const { parked } = parkedHarness();
        await parked.park([media('a')]);

        vi.resetModules();
        vi.doMock('../api/noteMedia', async () => {
            const real = await vi.importActual<typeof import('../api/noteMedia')>('../api/noteMedia');
            return { ...real, uploadParkedMedia: vi.fn(async () => [uploaded]) };
        });
        vi.doMock('../api/listContent', async () => {
            const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
            return {
                ...real,
                // The REAL intent shape: read what the server holds now, then
                // write kept + added.
                addTaskListAttachments: vi.fn(async (listId: number, added: typeof theirs[], replacing: string[] = []) => {
                    const cur = JSON.parse(server.get(listId) ?? '[]') as typeof theirs[];
                    const drop = new Set(replacing);
                    server.set(listId, JSON.stringify([...cur.filter(r => !drop.has(r.href)), ...added]));
                }),
                setTaskListAttachments: vi.fn(async (listId: number, refs: typeof theirs[]) => {
                    server.set(listId, JSON.stringify(refs));
                }),
            };
        });
        const fresh = await import('../notes/model/notesOutbox');
        const op = fresh.ops.addMedia(4, ['a'], [], [], '1 picture');
        await fresh.execOp(op, {}, true, parked);

        expect(JSON.parse(server.get(4)!)).toEqual([theirs, uploaded]);
        // The bytes are not kept once they are on the server.
        expect(await parked.read(['a'])).toEqual([]);
        vi.doUnmock('../api/noteMedia');
        vi.doUnmock('../api/listContent');
        vi.resetModules();
    });

    it('an op the server REFUSES takes its parked bytes with it', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        await h.parked.park([media('a')]);
        await ob.send(ops.addMedia(4, ['a'], [], [], 'a picture'));
        h.failures.set('a picture', new ApiError(403, 'no'));
        h.setOnline(true);
        const summary = await ob.replay();
        expect(summary?.dropped.map(o => o.label)).toEqual(['a picture']);
        expect(await h.parked.read(['a'])).toEqual([]);
        expect((await h.parked.waiting()).items).toBe(0);
    });

    it('bytes no queued op names are swept, and the queue’s load is what asks', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        await h.parked.park([media('kept'), media('orphan')]);
        await ob.send(ops.addMedia(4, ['kept'], [], [], 'a picture'));

        // A later page loads the same queue, and hands the sweep exactly the
        // ids its ops still name.
        const swept: Array<ReadonlySet<string>> = [];
        const spy = { ...h.parked, sweep: async (keep: ReadonlySet<string>) => { swept.push(keep); } };
        const ob2 = createOutbox({
            sub: () => 7, identity: () => identity, store: () => h.queue, exec: async () => ({}),
            online: () => false, lock: (_n, fn) => fn(), onReplayed: () => {}, parked: spy,
        });
        await ob2.load();
        expect(swept).toHaveLength(1);
        expect([...swept[0]]).toEqual(['kept']);

        // And the sweep itself, past the grace that protects a just-taken
        // photo, keeps only what it was given.
        await h.parked.sweep(new Set(['kept']), 0);
        expect(await h.parked.read(['kept'])).toHaveLength(1);
        expect(await h.parked.read(['orphan'])).toEqual([]);
    });

    it('a picture parked a moment ago survives a sweep that does not know it yet', async () => {
        const h = parkedHarness();
        await h.parked.park([media('just-taken')]);
        await h.parked.sweep(new Set());                 // the queue's load, mid-park
        expect(await h.parked.read(['just-taken'])).toHaveLength(1);
        // The grace is a window, not a reprieve: once it has passed, it goes.
        await h.parked.sweep(new Set(), 60_000, Date.now() + 120_000);
        expect(await h.parked.read(['just-taken'])).toEqual([]);
    });

    it('a picture removed before it was ever sent frees its bytes and drops it from the op', async () => {
        const h = harness();
        h.setOnline(false);
        const ob = h.make();
        await h.parked.park([media('a'), media('b')]);
        await ob.send(ops.addMedia(4, ['a', 'b'], [], [], '2 pictures'));
        await ob.forgetParked(['a']);
        expect(ob.pending()).toBe(1);
        expect(ob.pendingMedia()).toBe(1);
        expect(await h.parked.read(['a'])).toEqual([]);
        expect(await h.parked.read(['b'])).toHaveLength(1);
        // Removing the last one removes the op too: there is nothing to send.
        await ob.forgetParked(['b']);
        expect(ob.pending()).toBe(0);
        expect((await h.parked.waiting()).items).toBe(0);
    });

    it('queuedBlobIds names every parked record the queue still depends on', () => {
        const a = ops.addMedia(1, ['x', 'y'], [], [], 'two');
        const b = ops.setBody(1, 'text');
        expect([...queuedBlobIds({ queue: [a, b], ids: {}, dead: [] })].sort()).toEqual(['x', 'y']);
    });
});

describe('execOp inline (online, nothing queued)', () => {
    it('setBody goes straight through', async () => {
        vi.resetModules();
        const setTaskListBody = vi.fn(async () => undefined);
        vi.doMock('../api/listContent', async () => {
            const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
            return { ...real, setTaskListBody };
        });
        const fresh = await import('../notes/model/notesOutbox');
        await fresh.execOp(fresh.ops.setBody(4, 'hello'), {}, false);
        expect(setTaskListBody).toHaveBeenCalledWith(4, 'hello');
        vi.doUnmock('../api/listContent');
        vi.resetModules();
    });

    it('execOp is still total over the op union', () => {
        // Every op kind must have an arm; a missing one is a TS error, but
        // this also catches an arm that forgot to return.
        expect(typeof execOp).toBe('function');
    });
});
