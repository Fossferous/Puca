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

import { makeIdentity, sealLocal } from '../api/e2ee';
const { createOutbox, enqueue, ops, queuedBlobIds, busyKeyOf } = await import('../notes/model/notesOutbox');
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

/** A lock that behaves like the real one: `ifAvailable` gives up rather than
 *  waiting, so a scheduled replay cannot run beside the one in flight. */
const lockChains = new Map<string, Promise<unknown>>();
function realLock<T>(name: string, fn: () => Promise<T>, opts?: { ifAvailable?: boolean }): Promise<T | undefined> {
    if (lockChains.has(name) && opts?.ifAvailable) return Promise.resolve(undefined);
    const prev = lockChains.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    lockChains.set(name, tail);
    void tail.then(() => { if (lockChains.get(name) === tail) lockChains.delete(name); });
    return next;
}

/** Wait for a condition, with a deadline rather than a hang. */
async function until(ok: () => boolean, ms = 2_000): Promise<void> {
    const end = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > end) throw new Error('timed out waiting');
        await new Promise(res => setTimeout(res, 1));
    }
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

    it('the replacement carries its OWN op id, so it is not mistaken for the one in flight', () => {
        let s = enqueue({ queue: [], ids: {}, dead: [] }, ops.setBody(4, 'first'));
        const firstOid = s.queue[0].oid;
        s = enqueue(s, ops.setBody(4, 'second'));
        expect(s.queue[0].body).toBe('second');
        expect(s.queue[0].oid).not.toBe(firstOid);
    });

    it('a word typed WHILE the queued save is in flight is not swallowed by it', async () => {
        // `replay` awaits exec OUTSIDE the queue lock, so a save can collapse
        // into the op being sent. Reusing the queued op's id made the
        // success filter (`oid !== head.oid`) delete the NEWER text, while
        // the editor said "Kept on this device".
        const { parked } = parkedHarness();
        const queue = memoryStore();
        const ran: string[] = [];
        let release: (() => void) | null = null;
        let online = false;
        const exec = vi.fn(async (op: NoteOp) => {
            ran.push(op.k === 'setBody' ? op.body : op.k);
            if (ran.length === 1) await new Promise<void>(res => { release = res; });
            return {};
        });
        const ob = createOutbox({
            sub: () => 7, identity: () => identity, store: () => queue, exec: exec as never,
            online: () => online, lock: realLock, onReplayed: () => {}, parked,
        });
        await ob.send(ops.setBody(4, 'abc'));                 // offline: queued
        expect(ob.pending()).toBe(1);
        online = true;
        const replaying = ob.replay();
        await until(() => release !== null);
        await ob.send(ops.setBody(4, 'abc def'));             // collapses into the op in flight
        release!();
        await replaying;
        expect(ran).toEqual(['abc', 'abc def']);
        expect(ob.pending()).toBe(0);
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

    it('refuses when the BROWSER says the origin has no room, before it writes anything', async () => {
        const h = parkedHarness();
        const estimate = vi.fn(async () => ({ quota: 1_000_000, usage: 999_000 }));
        Object.defineProperty(navigator, 'storage', { value: { estimate }, configurable: true });
        try {
            await expect(h.parked.park([media('a', 'x', 10_000)])).rejects.toBeInstanceOf(ParkedMediaFullError);
            expect(await h.parked.read(['a'])).toEqual([]);
            expect(estimate).toHaveBeenCalled();
            // Positive control: with room, the same call parks.
            estimate.mockResolvedValue({ quota: 1_000_000, usage: 0 });
            await h.parked.park([media('a', 'x', 10_000)]);
            expect(await h.parked.read(['a'])).toHaveLength(1);
        } finally {
            Reflect.deleteProperty(navigator, 'storage');
        }
    });

    it('a record the queue still names, whose index entry was lost, is re-indexed with a real size', async () => {
        const h = parkedHarness();
        await h.parked.park([media('a', 'x', 1_000)]);
        expect((await h.parked.waiting()).bytes).toBe(1_000);   // positive control
        // A page that died mid-write, or an index from an older version: the
        // RECORD is on disk and an op still names it, but the index forgot it.
        h.store.map.set('index', await sealLocal(identity, 7, 'm:index', JSON.stringify({ items: {} })));
        await h.parked.sweep(new Set(['a']), 0);
        expect(await h.parked.read(['a'])).toHaveLength(1);     // kept: an op names it
        // Counted as 0 it would sit on the device charging nothing, and
        // enough of them would stop the cap biting at all. What it counts
        // instead is what the record takes on disk.
        const onDisk = h.store.map.get('b:a')!.length;
        expect(onDisk).toBeGreaterThan(0);
        expect((await h.parked.waiting()).bytes).toBe(onDisk);
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
            return {
                ...real,
                uploadParkedMedia: vi.fn(async () => [uploaded]),
                // The REAL intent shape: read what the server holds now, then
                // write kept + added. (What it frees is its own test.)
                addNoteRefs: vi.fn(async (listId: number, added: typeof theirs[], replacing: string[] = []) => {
                    const cur = JSON.parse(server.get(listId) ?? '[]') as typeof theirs[];
                    const drop = new Set(replacing);
                    server.set(listId, JSON.stringify([...cur.filter(r => !drop.has(r.href)), ...added]));
                }),
            };
        });
        vi.doMock('../api/listContent', async () => {
            const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
            return {
                ...real,
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

    it('execOp answers each uploaded ref PAIRED with the record it came from', async () => {
        // What `removeForgotten` above maps by. `uploadParkedMedia` answers
        // one ref per record in order, and a bare list of refs would make
        // "which of these two was the one the user removed" a guess.
        const up = (n: string) => ({ href: `sovereign-enc:${n}?k=K&m=image%2Fjpeg`, name: `${n}.jpg` });

        const { parked } = parkedHarness();
        await parked.park([media('first'), media('second')]);

        vi.resetModules();
        vi.doMock('../api/noteMedia', async () => {
            const real = await vi.importActual<typeof import('../api/noteMedia')>('../api/noteMedia');
            return {
                ...real,
                uploadParkedMedia: vi.fn(async (records: SealedMedia[]) => records.map(r => up(r.id))),
                addNoteRefs: vi.fn(async () => undefined),
            };
        });
        // The unmock in a finally: a red assertion here must not leave
        // '../api/noteMedia' mocked for every test after it.
        try {
            const fresh = await import('../notes/model/notesOutbox');
            const answer = await fresh.execOp(fresh.ops.addMedia(4, ['first', 'second'], [], [], '2 pictures'), {}, true, parked);
            expect(answer).toEqual([
                { id: 'first', ref: up('first') },
                { id: 'second', ref: up('second') },
            ]);
        } finally {
            vi.doUnmock('../api/noteMedia');
            vi.resetModules();
        }
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

    /**
     * A Remove that lands WHILE the upload is out.
     *
     * `replay` awaits `exec` outside the queue lock, and `execOp`'s addMedia
     * arm has read the ciphertext and uploaded it before it writes the note's
     * sidecar. `forgetParked` in that window rewrites a queued op that is
     * about to be dropped by oid anyway, so without the in-flight bookkeeping
     * the ref reaches the server with nothing left to take it out again: the
     * removed picture comes back on the next fetch, and its upload is charged
     * to the owner's quota for good.
     *
     * The gate is the upload: `exec` says it has started, waits, and only
     * then answers with the refs — exactly the window the real one has.
     */
    function gatedHarness() {
        const { parked } = parkedHarness();
        const queue = memoryStore();
        const ran: NoteOp[] = [];
        let startedResolve = () => {};
        const started = new Promise<void>(res => { startedResolve = res; });
        let release = () => {};
        const gate = new Promise<void>(res => { release = res; });
        const uploads: Record<string, { href: string; name: string }> = {
            a: { href: 'sovereign-enc:up-a?k=K&m=image%2Fjpeg', name: 'a.jpg' },
            b: { href: 'sovereign-enc:up-b?k=K&m=image%2Fjpeg', name: 'b.jpg' },
        };
        let online = false;                   // the picture was added with no connection
        const exec = vi.fn(async (op: NoteOp) => {
            ran.push(op);
            if (op.k !== 'addMedia') return {};
            startedResolve();
            await gate;                       // the upload is out; the sidecar is not written yet
            return op.blobIds.map(id => ({ id, ref: uploads[id] }));
        });
        const ob = createOutbox({
            sub: () => 7,
            identity: () => identity,
            store: () => queue,
            exec: exec as never,
            online: () => online,
            lock: realLock,
            onReplayed: () => {},
            parked,
        });
        return { parked, ran, ob, started, release, uploads, goOnline: () => { online = true; } };
    }

    it('a picture removed while its upload is IN FLIGHT is taken back off the server', async () => {
        const h = gatedHarness();
        await h.parked.park([media('a'), media('b')]);
        await h.ob.load();
        await h.ob.send(ops.addMedia(4, ['a', 'b'], [], [], '2 pictures'));
        expect(h.ob.pending()).toBe(1);        // queued, so replay is what runs it

        h.goOnline();
        const replayed = h.ob.replay();
        await h.started;                       // the upload is out
        await h.ob.forgetParked(['a']);        // the user removes that picture now
        h.release();
        await replayed;

        const removals = h.ran.filter(o => o.k === 'removeMedia');
        expect(removals).toHaveLength(1);
        expect(removals[0]).toMatchObject({ k: 'removeMedia', listId: 4, removing: [h.uploads.a.href] });
        // The one the user KEPT is not named by it, the queue is empty, and
        // the removed picture's bytes are off this device. (`b` is still
        // parked only because this fake `exec` is not the real `execOp`,
        // which is what clears a sent record.)
        expect(h.ob.pending()).toBe(0);
        expect(await h.parked.read(['a'])).toEqual([]);
    });

    it('...and a picture nobody removed queues no such removal (positive control)', async () => {
        const h = gatedHarness();
        await h.parked.park([media('a'), media('b')]);
        await h.ob.load();
        await h.ob.send(ops.addMedia(4, ['a', 'b'], [], [], '2 pictures'));

        h.goOnline();
        const replayed = h.ob.replay();
        await h.started;
        h.release();
        await replayed;

        expect(h.ran.filter(o => o.k === 'removeMedia')).toEqual([]);
        expect(h.ob.pending()).toBe(0);
    });

    it('a picture removed AFTER its upload landed, before the refetch, is taken back off too', async () => {
        // The second window. `onReplayed` invalidates the queries only when
        // the whole run ends, and the refetch is a request: until it answers
        // the editor still knows the picture by its `puca-parked:` name, so
        // `setNoteAttachments` queues nothing server-side and would leave the
        // ref on the server for good.
        const h = gatedHarness();
        await h.parked.park([media('a'), media('b')]);
        await h.ob.load();
        await h.ob.send(ops.addMedia(4, ['a', 'b'], [], [], '2 pictures'));

        h.goOnline();
        const replayed = h.ob.replay();
        await h.started;
        h.release();
        await replayed;
        expect(h.ran.filter(o => o.k === 'removeMedia')).toEqual([]);   // nothing removed yet

        await h.ob.forgetParked(['b']);      // the editor still shows the parked name
        await until(() => h.ran.some(o => o.k === 'removeMedia'));

        const removals = h.ran.filter(o => o.k === 'removeMedia');
        expect(removals).toHaveLength(1);
        expect(removals[0]).toMatchObject({ k: 'removeMedia', listId: 4, removing: [h.uploads.b.href] });
        // And only once: asking again names a ref the editor now knows by its
        // real href, which is the ordinary removal path.
        await h.ob.forgetParked(['b']);
        expect(h.ran.filter(o => o.k === 'removeMedia')).toHaveLength(1);
    });

    it('an add whose sidecar write was LOST keeps its uploads; one REFUSED frees them (finding 4)', async () => {
        const up = { href: 'sovereign-enc:upfile?k=K&m=image%2Fjpeg', name: 'a.jpg' };
        const deleteFiles = vi.fn(async (_ids: string[]) => undefined);
        const addNoteRefs = vi.fn();
        const { parked } = parkedHarness();
        await parked.park([media('a')]);
        vi.resetModules();
        vi.doMock('../api/noteMedia', async () => {
            const real = await vi.importActual<typeof import('../api/noteMedia')>('../api/noteMedia');
            return { ...real, uploadParkedMedia: vi.fn(async () => [up]), addNoteRefs };
        });
        vi.doMock('../api/listContent', async () => {
            const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
            return { ...real, deleteFiles };
        });
        try {
            const fresh = await import('../notes/model/notesOutbox');
            // The answer never came back: the server may hold the sidecar
            // that names this upload, so deleting it would break the note.
            addNoteRefs.mockRejectedValueOnce(new TypeError('Failed to fetch'));
            await expect(fresh.execOp(fresh.ops.addMedia(4, ['a'], [], [], '1 picture'), {}, true, parked)).rejects.toBeInstanceOf(TypeError);
            expect(deleteFiles).not.toHaveBeenCalled();
            // POSITIVE CONTROL: a definite refusal wrote nothing, so the
            // upload is nobody's and goes.
            addNoteRefs.mockRejectedValueOnce(new ApiError('Forbidden', 403));
            await expect(fresh.execOp(fresh.ops.addMedia(4, ['a'], [], [], '1 picture'), {}, true, parked)).rejects.toBeInstanceOf(ApiError);
            expect(deleteFiles.mock.calls.map(c => c[0])).toEqual([['upfile']]);
        } finally {
            vi.doUnmock('../api/noteMedia');
            vi.doUnmock('../api/listContent');
            vi.resetModules();
        }
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
        // Inline (fromQueue false), the base revision the field started from
        // rides along — undefined here because this op names none.
        expect(setTaskListBody).toHaveBeenCalledWith(4, 'hello', undefined);
        // ...and a REPLAY drops it, so work done offline is never refused.
        await fresh.execOp(fresh.ops.setBody(4, 'hello', 7), {}, true);
        expect(setTaskListBody).toHaveBeenLastCalledWith(4, 'hello', undefined);
        await fresh.execOp(fresh.ops.setBody(4, 'hello', 7), {}, false);
        expect(setTaskListBody).toHaveBeenLastCalledWith(4, 'hello', 7);
        vi.doUnmock('../api/listContent');
        vi.resetModules();
    });

    it('a queued removal frees the upload behind it, and a no-op removal frees nothing', async () => {
        // The rule itself (api/noteMedia.ts), against the intent form's real
        // answer: what it ACTUALLY took out of the sidecar the server holds.
        const a = { href: 'sovereign-enc:afile?k=K&m=image%2Fpng', name: 'a.png' };
        const b = { href: 'sovereign-enc:bfile?k=K&m=image%2Fpng', name: 'b.png' };
        const deleteFiles = vi.fn(async (_ids: string[]) => undefined);
        let server = [a, b];

        vi.resetModules();
        vi.doMock('../api/listContent', () => ({
            deleteFiles,
            removeTaskListAttachments: vi.fn(async (_id: number, removing: string[]) => {
                const drop = new Set(removing);
                const gone = server.filter(r => drop.has(r.href));
                server = server.filter(r => !drop.has(r.href));
                return gone;
            }),
            addTaskListAttachments: vi.fn(async () => []),
        }));
        const nm = await import('../api/noteMedia');

        await nm.removeNoteRefs(4, [b.href]);
        expect(server).toEqual([a]);
        expect(deleteFiles.mock.calls.map(c => c[0])).toEqual([['bfile']]);

        // Gone already — that ref may be one another device still names.
        deleteFiles.mockClear();
        await nm.removeNoteRefs(4, [b.href]);
        expect(deleteFiles).not.toHaveBeenCalled();

        vi.doUnmock('../api/listContent');
        vi.resetModules();
    });

    it('replacing a picture (a re-drawn drawing) frees the one it replaced', async () => {
        const old = { href: 'sovereign-enc:oldfile?k=K&m=image%2Fpng', name: 'drawing-1.png' };
        const fresh = { href: 'sovereign-enc:newfile?k=K2&m=image%2Fpng', name: 'drawing-1.png' };
        const deleteFiles = vi.fn(async (_ids: string[]) => undefined);
        let server = [old];

        vi.resetModules();
        vi.doMock('../api/listContent', () => ({
            deleteFiles,
            removeTaskListAttachments: vi.fn(async () => []),
            addTaskListAttachments: vi.fn(async (_id: number, added: typeof old[], replacing: string[] = []) => {
                const drop = new Set(replacing);
                const gone = server.filter(r => drop.has(r.href));
                server = [...server.filter(r => !drop.has(r.href)), ...added];
                return gone;
            }),
        }));
        const nm = await import('../api/noteMedia');

        await nm.addNoteRefs(4, [fresh], [old.href]);
        expect(server).toEqual([fresh]);
        expect(deleteFiles.mock.calls.map(c => c[0])).toEqual([['oldfile']]);

        // An add that replaces nothing deletes nothing.
        deleteFiles.mockClear();
        await nm.addNoteRefs(4, [fresh]);
        expect(deleteFiles).not.toHaveBeenCalled();

        vi.doUnmock('../api/listContent');
        vi.resetModules();
    });

    it('replay puts a removal through that rule instead of leaving the files behind', async () => {
        const removeNoteRefs = vi.fn(async () => undefined);
        const addNoteRefs = vi.fn(async () => undefined);
        vi.resetModules();
        vi.doMock('../api/noteMedia', async () => {
            const real = await vi.importActual<typeof import('../api/noteMedia')>('../api/noteMedia');
            return { ...real, removeNoteRefs, addNoteRefs, uploadParkedMedia: vi.fn(async () => [{ href: 'sovereign-enc:up?k=K&m=image%2Fpng', name: 'u.png' }]) };
        });
        const outbox = await import('../notes/model/notesOutbox');
        const { parked } = parkedHarness();
        await parked.park([media('a')]);

        await outbox.execOp(outbox.ops.removeMedia(4, ['sovereign-enc:gone?k=K&m=image%2Fpng'], [], 'remove 1 picture'), {}, true);
        expect(removeNoteRefs).toHaveBeenCalledWith(4, ['sovereign-enc:gone?k=K&m=image%2Fpng']);

        await outbox.execOp(outbox.ops.addMedia(4, ['a'], ['sovereign-enc:old?k=K&m=image%2Fpng'], [], '1 picture'), {}, true, parked);
        expect(addNoteRefs).toHaveBeenCalledWith(4, [{ href: 'sovereign-enc:up?k=K&m=image%2Fpng', name: 'u.png' }], ['sovereign-enc:old?k=K&m=image%2Fpng']);

        vi.doUnmock('../api/noteMedia');
        vi.resetModules();
    });

    it('the SAME rule inline: online with nothing queued, a removal still frees its upload', async () => {
        const gone = { href: 'sovereign-enc:gonefile?k=K&m=image%2Fpng', name: 'b.png' };
        const kept = { href: 'sovereign-enc:keptfile?k=K&m=image%2Fpng', name: 'a.png' };
        const deleteFiles = vi.fn(async (_ids: string[]) => undefined);
        const setTaskListAttachments = vi.fn(async () => undefined);

        vi.resetModules();
        vi.doMock('../api/listContent', async () => {
            const real = await vi.importActual<typeof import('../api/listContent')>('../api/listContent');
            return { ...real, deleteFiles, setTaskListAttachments };
        });
        const outbox = await import('../notes/model/notesOutbox');

        await outbox.execOp(outbox.ops.removeMedia(4, [gone.href], [kept], 'remove 1 picture'), {}, false);
        expect(setTaskListAttachments).toHaveBeenCalledWith(4, [kept]);
        expect(deleteFiles.mock.calls.map(c => c[0])).toEqual([['gonefile']]);

        vi.doUnmock('../api/listContent');
        vi.resetModules();
    });
});
