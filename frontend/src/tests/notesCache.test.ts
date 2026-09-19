/**
 * The sealed on-device cache (notes/model/notesCache.ts) and the offline
 * worker it relies on (scripts/notes-sw.mjs).
 */
import { describe, it, expect, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));

import { makeIdentity, sealLocal, openLocal } from '../api/e2ee';
import { TASK_IDENTITY_LOCKED, ENC_KEY_UNAVAILABLE } from '../api/decryptMarkers';
const { hydrateNotesCache, startNotesCachePersistence, memoryStore, safeToPersist } = await import('../notes/model/notesCache');
// @ts-expect-error -- a plain .mjs build script, typed by notes-sw.d.mts for the vite config only
const { renderNotesServiceWorker } = await import('../../scripts/notes-sw.mjs');

const me = makeIdentity(new Uint8Array(32).fill(2));
const other = makeIdentity(new Uint8Array(32).fill(3));
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); };

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
        await new Promise(r => setTimeout(r, 30));
        await settle();
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

    it('writes nothing once a different account is signed in', async () => {
        const store = memoryStore();
        let current = 7;
        const qc = new QueryClient();
        const stop = startNotesCachePersistence(qc, { sub: 7, currentSub: () => current, identity: () => me, store }, 5);
        current = 8;
        qc.setQueryData(['notes', 'lists'], [{ id: 1, title: 'Theirs' }]);
        await new Promise(r => setTimeout(r, 30));
        await settle();
        stop();
        expect(store.map.size).toBe(0);
    });

    it('a locked result never overwrites the last good copy', async () => {
        const store = memoryStore();
        const qc = new QueryClient();
        const stop = startNotesCachePersistence(qc, { sub: 7, currentSub: () => 7, identity: () => me, store }, 5);
        qc.setQueryData(['notes', 'tasks', 'list', 1], tasks);
        await new Promise(r => setTimeout(r, 30));
        qc.setQueryData(['notes', 'tasks', 'list', 1], [{ id: 1, description: TASK_IDENTITY_LOCKED, attachments: null }]);
        await new Promise(r => setTimeout(r, 30));
        await settle();
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
