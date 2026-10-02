/**
 * The sealed on-device cache (notes/model/notesCache.ts) and the offline
 * worker it relies on (scripts/notes-sw.mjs).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

/** The token's account: 7, until a test signs it out. The keys the page
 *  holds, for the tests that call with the page's own defaults. */
const auth = vi.hoisted(() => ({ sub: 7 as number | null, identity: null as Identity | null }));
vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => auth.sub }));
vi.mock('../api/e2ee', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/e2ee')>()),
    seedMatchesCurrentAccount: () => auth.identity !== null,
    getActiveIdentity: () => auth.identity,
}));

import { makeIdentity, sealLocal, openLocal, type Identity } from '../api/e2ee';
import { TASK_IDENTITY_LOCKED, ENC_KEY_UNAVAILABLE } from '../api/decryptMarkers';
const { hydrateNotesCache, startNotesCachePersistence, memoryStore, safeToPersist, idbStore, NOTES_DB_VERSION } = await import('../notes/model/notesCache');
const { notesCacheDbName } = await import('../api/notesCacheScrub');
const { makeFakeIndexedDB } = await import('./fixtures/fakeIndexedDB');
// A plain .mjs build script; scripts/notes-sw.d.mts types it.
const { renderNotesServiceWorker } = await import('../../scripts/notes-sw.mjs');
const { cryptoInFlight, trackCrypto } = await import('./fixtures/cryptoInFlight');

const me = makeIdentity(new Uint8Array(32).fill(2));
const other = makeIdentity(new Uint8Array(32).fill(3));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };
let untrackCrypto: () => void = () => {};
beforeEach(() => { untrackCrypto = trackCrypto(); });
afterEach(() => { untrackCrypto(); });
/** Real time until `done()` holds. Bounded inside vitest's 5 s, so what
 *  never happens fails here and says what it was. */
async function until(done: () => boolean | Promise<boolean>, what: () => string | Promise<string>) {
    const giveUp = performance.now() + 3_000;
    while (!(await done())) {
        if (performance.now() > giveUp) throw new Error(`gave up after 3 s waiting for ${await what()}`);
        await new Promise(r => setTimeout(r, 5));
    }
}
/** Turns until no WebCrypto call is out (fixtures/cryptoInFlight.ts) for a
 *  few in a row: a seal that was running, and the write after it, landed. */
async function quiet() {
    await until(async () => {
        for (let calm = 0; calm < 3; calm++) {
            if (cryptoInFlight() !== 0) return false;
            await new Promise(r => setTimeout(r, 0));
        }
        return cryptoInFlight() === 0;
    }, () => `${cryptoInFlight()} WebCrypto calls to finish`);
    await settle();
}
/**
 * Real time until `store` holds `n` records, and then until nothing is
 * still being sealed, so a record past the n-th, were one written, would be
 * there too. Each is sealed for real (WebCrypto, settling from Node's thread
 * pool) and written one after another, so how long that takes is the
 * machine's business: a fixed 30 ms and ten turns held 2 of 3 with a real
 * 20 ms added to each encrypt/importKey (2026-10-02).
 */
async function persisted(store: { all(): Promise<unknown[]> }, n: number) {
    await until(async () => (await store.all()).length >= n, async () => `${n} records (the store holds ${(await store.all()).length})`);
    await quiet();
}
/**
 * The persistence's deps, counting its write passes: each asks for the
 * identity first. A test that asserts a write did NOT happen waits for the
 * pass that would have made it, then for its sealing to finish, not for a
 * guess at how long that takes: after a fixed 30 ms, a seal slowed to 150 ms
 * had not landed, and both refusals below passed with their guard deleted.
 */
function counted(currentSub: () => number) {
    let n = 0;
    return {
        deps: { sub: 7, currentSub, identity: () => { n++; return me; } },
        passes: () => n,
    };
}

const tasks = [{ id: 1, description: 'Buy oat milk', attachments: null }];

describe('sealLocal', () => {
    it('round-trips, and refuses another account, another seed and another slot', async () => {
        const sealed = await sealLocal(me, 7, 'q:x', 'Buy oat milk');
        expect(sealed).not.toContain('oat');
        expect(await openLocal(me, 7, 'q:x', sealed)).toBe('Buy oat milk');     // positive control
        expect(await openLocal(me, 8, 'q:x', sealed)).toBeNull();                // another account's slot
        expect(await openLocal(other, 7, 'q:x', sealed)).toBeNull();             // another seed
        expect(await openLocal(me, 7, 'q:y', sealed)).toBeNull();                // moved to another record
    });
});

describe('what may be cached', () => {
    it('never a result holding a decrypt-failure marker', () => {
        expect(safeToPersist(['notes', 'tasks', 'list', 1], tasks)).toBe(true);
        expect(safeToPersist(['notes', 'tasks', 'list', 1], [{ id: 1, description: TASK_IDENTITY_LOCKED, attachments: null }])).toBe(false);
        expect(safeToPersist(['notes', 'lists'], [{ id: 1, title: ENC_KEY_UNAVAILABLE }])).toBe(false);
        expect(safeToPersist(['other'], tasks)).toBe(false);
    });
});

describe('persist, then hydrate on a cold start', () => {
    it('what one page showed comes back sealed on the next', async () => {
        const store = memoryStore();
        const a = new QueryClient();
        const stop = startNotesCachePersistence(a, { sub: 7, currentSub: () => 7, identity: () => me, store }, 5);
        a.setQueryData(['notes', 'tasks', 'list', 1], tasks);
        a.setQueryData(['notes', 'lists'], [{ id: 1, title: 'Groceries' }]);
        await persisted(store, 2);
        stop();
        expect(store.map.size).toBe(2);
        expect([...store.map.values()].join('')).not.toContain('oat');           // sealed at rest

        const b = new QueryClient();
        expect(await hydrateNotesCache(b, { sub: 7, identity: me, store })).toBe(2);
        expect(b.getQueryData(['notes', 'tasks', 'list', 1])).toEqual(tasks);
        expect(b.getQueryData(['notes', 'lists'])).toEqual([{ id: 1, title: 'Groceries' }]);
        // Shown, but not trusted: stale, so each query refetches as it mounts
        // (events raised while the page was closed never arrived).
        expect(b.getQueryState(['notes', 'lists'])?.isInvalidated).toBe(true);
        expect(b.getQueryState(['notes', 'tasks', 'list', 1])?.isInvalidated).toBe(true);
        // Positive control: data written by the page itself is not.
        a.setQueryData(['notes', 'x'], 1);
        expect(a.getQueryState(['notes', 'x'])?.isInvalidated).toBe(false);

        // Another account's seed on this browser opens nothing.
        const c = new QueryClient();
        expect(await hydrateNotesCache(c, { sub: 7, identity: other, store })).toBe(0);
    });

    it('a read-back still opening rows when the account signs out stops, and adds no more', async () => {
        const store = memoryStore();
        const a = new QueryClient();
        const stop = startNotesCachePersistence(a, { sub: 7, currentSub: () => 7, identity: () => me, store }, 5);
        for (let i = 1; i <= 3; i++) a.setQueryData(['notes', 'tasks', 'list', i], tasks);
        await persisted(store, 3);
        stop();
        expect(store.map.size).toBe(3);

        // POSITIVE CONTROL: signed in throughout, all three come back.
        const whole = new QueryClient();
        expect(await hydrateNotesCache(whole, { sub: 7, identity: me, store, currentSub: () => 7 })).toBe(3);

        // Signed out as the first row lands (the token goes; the identity
        // this read captured still opens rows).
        let current: number | null = 7;
        const b = new QueryClient();
        b.getQueryCache().subscribe(e => { if (e.type === 'added') current = null; });
        expect(await hydrateNotesCache(b, { sub: 7, identity: me, store, currentSub: () => current })).toBe(1);
        expect(b.getQueryCache().getAll()).toHaveLength(1);
    });

    // As the desktop view and Notes' own page call it: with no deps, so the
    // account it keeps asking about is the token's.
    it('called with its own defaults, it stops at a sign-out too', async () => {
        const idb = makeFakeIndexedDB();
        const real = globalThis.indexedDB;
        Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true });
        auth.identity = me;
        try {
            const store = idbStore(7, 'q')!;
            const a = new QueryClient();
            const stop = startNotesCachePersistence(a, { sub: 7, currentSub: () => 7, identity: () => me, store }, 5);
            for (let i = 1; i <= 3; i++) a.setQueryData(['notes', 'tasks', 'list', i], tasks);
            await persisted(store, 3);
            stop();

            // POSITIVE CONTROL: signed in throughout, the defaults bring all three back.
            expect(await hydrateNotesCache(new QueryClient())).toBe(3);

            const b = new QueryClient();
            b.getQueryCache().subscribe(e => { if (e.type === 'added') auth.sub = null; });
            expect(await hydrateNotesCache(b)).toBe(1);
        } finally {
            auth.sub = 7;
            auth.identity = null;
            if (real === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
            else Object.defineProperty(globalThis, 'indexedDB', { value: real, configurable: true });
        }
    });

    it('writes nothing once a different account is signed in', async () => {
        const store = memoryStore();
        let current = 7;
        const qc = new QueryClient();
        const w = counted(() => current);
        const stop = startNotesCachePersistence(qc, { ...w.deps, store }, 5);
        current = 8;
        qc.setQueryData(['notes', 'lists'], [{ id: 1, title: 'Theirs' }]);
        await until(() => w.passes() >= 1, () => 'the debounced write to run');
        await quiet();
        stop();
        expect(store.map.size).toBe(0);
    });

    it('a locked result never overwrites the last good copy', async () => {
        const store = memoryStore();
        const qc = new QueryClient();
        const w = counted(() => 7);
        const stop = startNotesCachePersistence(qc, { ...w.deps, store }, 5);
        qc.setQueryData(['notes', 'tasks', 'list', 1], tasks);
        await persisted(store, 1);
        const before = w.passes();
        qc.setQueryData(['notes', 'tasks', 'list', 1], [{ id: 1, description: TASK_IDENTITY_LOCKED, attachments: null }]);
        await until(() => w.passes() > before, () => 'the debounced write of the locked result to run');
        await quiet();
        stop();
        const b = new QueryClient();
        await hydrateNotesCache(b, { sub: 7, identity: me, store });
        expect(b.getQueryData(['notes', 'tasks', 'list', 1])).toEqual(tasks);
    });
});

/** Run the generated worker against a fake worker global. */
function loadWorker() {
    const handlers: Record<string, (e: unknown) => void> = {};
    const cache = new Map<string, Response>();
    const net = vi.fn(async (req: Request | string) => new Response(`net:${typeof req === 'string' ? req : req.url}`, { status: 200 }));
    const self = {
        location: { origin: 'https://app.example.com' },
        addEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = h; },
        skipWaiting: vi.fn(), clients: { claim: vi.fn() },
    };
    const caches = {
        open: async () => ({
            match: async (r: Request | string) => cache.get(typeof r === 'string' ? r : new URL(r.url).pathname),
            put: async (r: Request | string, res: Response) => { cache.set(typeof r === 'string' ? r : new URL(r.url).pathname, res); },
            addAll: async () => {},
        }),
        keys: async () => [], delete: async () => true,
    };
    const src = renderNotesServiceWorker('b1', ['/notes/index.html', '/notes/assets/index-abc.js']);
    new Function('self', 'caches', 'fetch', src)(self, caches, net);
    const fetchEvent = (url: string, init: { mode?: string; method?: string } = {}) => {
        let answered: Promise<Response> | null = null;
        handlers.fetch({
            request: { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' },
            respondWith: (p: Promise<Response>) => { answered = p; },
        });
        return answered as Promise<Response> | null;
    };
    return { fetchEvent, cache, net, src };
}

describe('the /notes/ worker cannot shadow anything else', () => {
    it('never answers for the API host, the main app, its updater, or a non-GET', () => {
        const w = loadWorker();
        expect(w.fetchEvent('https://chat.example.com/task-lists')).toBeNull();          // the API (cross-origin)
        expect(w.fetchEvent('https://chat.example.com/notes/anything')).toBeNull();      // ...whatever its path
        expect(w.fetchEvent('https://app.example.com/', { mode: 'navigate' })).toBeNull(); // Púca itself
        expect(w.fetchEvent('https://app.example.com/assets/index-main.js')).toBeNull();
        expect(w.fetchEvent('https://app.example.com/app-version.json')).toBeNull();
        expect(w.fetchEvent('https://app.example.com/notes/sw.js')).toBeNull();
        expect(w.fetchEvent('https://app.example.com/notes/index.html', { method: 'POST' })).toBeNull();
        // Positive control: its own page and assets it does answer.
        expect(w.fetchEvent('https://app.example.com/notes/', { mode: 'navigate' })).not.toBeNull();
        expect(w.fetchEvent('https://app.example.com/notes/assets/index-abc.js')).not.toBeNull();
    });

    it('a page load goes to the network first, and falls back to the cached page offline', async () => {
        const w = loadWorker();
        const online = await w.fetchEvent('https://app.example.com/notes/', { mode: 'navigate' })!;
        expect(await online.text()).toContain('net:');
        w.net.mockRejectedValueOnce(new TypeError('offline'));
        w.cache.set('/notes/index.html', new Response('cached page'));
        const offline = await w.fetchEvent('https://app.example.com/notes/', { mode: 'navigate' })!;
        expect(await offline.text()).toBe('cached page');
    });
});


describe('the database a shipped version left behind', () => {
    // Version 2 added the store for media sealed on this device
    // (notes/model/notesBlobs.ts). The upgrade must CREATE what is missing
    // and drop nothing: an upgrade that recreated the stores would silently
    // throw away a note typed offline and everything the last page showed.
    it('opens a version-1 database at version 2 with its cache and its queue intact', async () => {
        const idb = makeFakeIndexedDB();
        const sub = 4242;
        const name = notesCacheDbName(sub);
        idb.seed(name, 1, {
            q: { 'hash-1': 'sealed-query' },
            o: { outbox: 'sealed-queue' },
        });
        const real = globalThis.indexedDB;
        Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true });
        try {
            const q = idbStore(sub, 'q')!;
            const o = idbStore(sub, 'o')!;
            const m = idbStore(sub, 'm')!;
            expect(await q.get('hash-1')).toBe('sealed-query');   // the cache survived
            expect(await o.get('outbox')).toBe('sealed-queue');   // the offline queue survived
            // ...and the new store exists and works, on the SAME database.
            await m.put('b:one', 'sealed-photo');
            expect(await m.get('b:one')).toBe('sealed-photo');
            expect(idb.version(name)).toBe(NOTES_DB_VERSION);
            expect(idb.storeNames(name).sort()).toEqual(['m', 'o', 'q']);
        } finally {
            if (real === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
            else Object.defineProperty(globalThis, 'indexedDB', { value: real, configurable: true });
        }
    });

    it('creates all three stores on a database that never existed', async () => {
        const idb = makeFakeIndexedDB();
        const sub = 4343;
        const real = globalThis.indexedDB;
        Object.defineProperty(globalThis, 'indexedDB', { value: idb.factory, configurable: true });
        try {
            await idbStore(sub, 'q')!.put('k', 'v');
            expect(idb.storeNames(notesCacheDbName(sub)).sort()).toEqual(['m', 'o', 'q']);
        } finally {
            if (real === undefined) delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
            else Object.defineProperty(globalThis, 'indexedDB', { value: real, configurable: true });
        }
    });
});
