import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeIndexedDb, type FakeIndexedDb } from './fakeIndexedDb';

/**
 * public/sw.js — the web app's push worker — run against a fake worker scope.
 *
 * What must never regress:
 *  - EVERY push shows a notification (iOS revokes a subscription whose pushes
 *    show nothing), including when the server cannot be asked;
 *  - the push's own payload is never read (it is a constant, and the worker
 *    has no business with it);
 *  - what is shown is what the user's own server said, filtered to the
 *    fields a lock screen may carry, and a tap opens only a conversation,
 *    a server or a clip prompt;
 *  - there is no fetch listener (the worker caches nothing, serves nothing).
 *
 * The real-browser half (a real Chromium registering it and showing a
 * notification for a real push) is e2e/web-push-real-browser.mjs.
 */

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'sw.js'), 'utf8');

type Listener = (e: unknown) => void;

interface Win {
    url: string;
    focused?: boolean;
    focus: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
}

function win(url: string, focused = false): Win {
    return { url, focused, focus: vi.fn().mockResolvedValue(undefined), postMessage: vi.fn() };
}

function loadWorker(opts: {
    idb?: FakeIndexedDb;
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
    windows?: Win[];
} = {}) {
    const listeners = new Map<string, Listener>();
    const shown: { title: string; options: NotificationOptions & { data?: { nav: string | null } } }[] = [];
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const idb = opts.idb ?? makeFakeIndexedDb();
    const fetchFn = vi.fn(opts.fetch ?? (async () => { throw new Error('offline'); }));
    const self = {
        addEventListener: (t: string, fn: Listener) => listeners.set(t, fn),
        skipWaiting: vi.fn(),
        location: { origin: 'https://app.example.com' },
        clients: {
            claim: vi.fn().mockResolvedValue(undefined),
            matchAll: vi.fn().mockResolvedValue(opts.windows ?? []),
            openWindow: vi.fn().mockResolvedValue(null),
        },
        registration: {
            showNotification: vi.fn(async (title: string, options: NotificationOptions) => {
                shown.push({ title, options: options as never });
            }),
            pushManager: { getSubscription: vi.fn().mockResolvedValue({ unsubscribe }) },
        },
    };
    new Function('self', 'indexedDB', 'fetch', SRC)(self, idb, fetchFn);

    let payloadRead = false;
    const push = async () => {
        let waited: Promise<unknown> | undefined;
        listeners.get('push')!({
            get data() {
                payloadRead = true;
                return { json: () => ({ w: '1' }), text: () => '{"w":"1"}' };
            },
            waitUntil: (p: Promise<unknown>) => { waited = p; },
        });
        await waited;
    };
    const click = async (nav: unknown) => {
        let waited: Promise<unknown> | undefined;
        const close = vi.fn();
        listeners.get('notificationclick')!({
            notification: { data: { nav }, close },
            waitUntil: (p: Promise<unknown>) => { waited = p; },
        });
        await waited;
        return close;
    };
    return { self, listeners, shown, fetchFn, unsubscribe, idb, push, click, payloadRead: () => payloadRead };
}

/** Write the config the page would write (api/webPush.ts). */
async function seed(idb: FakeIndexedDb, cfg: Record<string, unknown>) {
    await new Promise<void>((resolve) => {
        const req = idb.open('puca-push', 1) as {
            result: { createObjectStore(s: string): void; transaction(s: string): { objectStore(): { put(v: unknown, k: string): void }; oncomplete?: () => void } };
            onupgradeneeded?: () => void;
            onsuccess?: () => void;
        };
        req.onupgradeneeded = () => req.result.createObjectStore('cfg');
        req.onsuccess = () => {
            const tx = req.result.transaction('cfg');
            tx.objectStore().put(cfg, 'subscription');
            tx.oncomplete = () => resolve();
        };
    });
}

const CFG = { api: 'https://chat.example.com/', id: 42, secret: 'sek-ret', endpoint: 'https://fcm.googleapis.com/x', key: 'K' };

function answering(status: number, body: unknown) {
    return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('public/sw.js — the push worker', () => {
    it('has no fetch listener and nothing that caches', () => {
        const w = loadWorker();
        expect([...w.listeners.keys()].sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
        expect(SRC).not.toMatch(/\bcaches\s*\./); // the Cache API, not the word
    });

    it('shows what the server says knocked, never reading the push payload', async () => {
        const idb = makeFakeIndexedDb();
        await seed(idb, CFG);
        const w = loadWorker({
            idb,
            fetch: answering(200, {
                items: [
                    { tag: 'dm:conv-1', title: 'alice sent you a message', body: 'New message', nav: 'dm:conv-1' },
                    { tag: 'chan:srv-1', title: 'bob sent a message', body: 'New message', nav: 'server:srv-1' },
                ],
            }),
        });
        await w.push();
        expect(w.payloadRead()).toBe(false);
        expect(w.shown.map((s) => [s.title, s.options.body, s.options.tag, s.options.data?.nav])).toEqual([
            ['alice sent you a message', 'New message', 'dm:conv-1', 'dm:conv-1'],
            ['bob sent a message', 'New message', 'chan:srv-1', 'server:srv-1'],
        ]);
        // Asked THIS server, with the subscription's secret, no cookies.
        const [url, init] = w.fetchFn.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://chat.example.com/push/web/pending');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('omit');
        expect(JSON.parse(String(init.body))).toEqual({ id: 42, secret: 'sek-ret' });
    });

    it('shows the generic notification when the server cannot be asked', async () => {
        const idb = makeFakeIndexedDb();
        await seed(idb, CFG);
        const w = loadWorker({ idb }); // fetch rejects: offline
        await w.push();
        expect(w.shown).toHaveLength(1);
        expect(w.shown[0].title).toBe('Púca');
        expect(w.shown[0].options.body).toBe('New activity in Púca');
        expect(w.shown[0].options.tag).toBe('puca-activity');
    });

    it('shows the generic notification with no config, without asking anyone', async () => {
        const w = loadWorker();
        await w.push();
        expect(w.fetchFn).not.toHaveBeenCalled();
        expect(w.shown.map((s) => s.title)).toEqual(['Púca']);
    });

    it('shows the generic notification for an empty answer and for a server error', async () => {
        for (const f of [answering(200, { items: [] }), answering(503, 'down'), answering(200, { nope: 1 })]) {
            const idb = makeFakeIndexedDb();
            await seed(idb, CFG);
            const w = loadWorker({ idb, fetch: f });
            await w.push();
            expect(w.shown.map((s) => s.options.body)).toEqual(['New activity in Púca']);
        }
    });

    it('a 410 (the session that subscribed has ended) forgets the secret and unsubscribes', async () => {
        const idb = makeFakeIndexedDb();
        await seed(idb, CFG);
        const w = loadWorker({ idb, fetch: answering(410, 'gone') });
        await w.push();
        expect(w.unsubscribe).toHaveBeenCalledTimes(1);
        expect(idb.data.get('puca-push')!.get('cfg')!.has('subscription')).toBe(false);
        // ...and still shows something: iOS counts silent pushes.
        expect(w.shown).toHaveLength(1);
        // Control: a 200 does neither.
        const idb2 = makeFakeIndexedDb();
        await seed(idb2, CFG);
        const w2 = loadWorker({ idb: idb2, fetch: answering(200, { items: [] }) });
        await w2.push();
        expect(w2.unsubscribe).not.toHaveBeenCalled();
        expect(idb2.data.get('puca-push')!.get('cfg')!.has('subscription')).toBe(true);
    });

    it('keeps only lock-screen fields, at most four, and refuses a tap target that is not a conversation', async () => {
        const idb = makeFakeIndexedDb();
        await seed(idb, CFG);
        const items = [
            { tag: 't1', title: 'x'.repeat(500), body: 'New message', nav: 'javascript:alert(1)', content: 'SECRET' },
            { tag: 't2', title: 'b', body: 'New message', nav: 'https://evil.example/' },
            { tag: 't3', title: 'c', body: 'New message', nav: 'dm:ok-1' },
            { tag: 't4', title: 'd', body: 'New message', nav: 'settings' },
            { tag: 't5', title: 'e', body: 'New message', nav: 'dm:five' },
            { title: 'no tag' },
        ];
        const w = loadWorker({ idb, fetch: answering(200, { items }) });
        await w.push();
        expect(w.shown).toHaveLength(4);
        expect(w.shown[0].title).toHaveLength(120);
        expect(w.shown.map((s) => s.options.data?.nav)).toEqual([null, null, 'dm:ok-1', null]);
        expect(JSON.stringify(w.shown)).not.toContain('SECRET');
    });

    it('a tap focuses an open Púca window and hands it the target', async () => {
        const app = win('https://app.example.com/', false);
        const notes = win('https://app.example.com/notes/', true);
        const w = loadWorker({ windows: [notes, app] });
        const close = await w.click('dm:conv-1');
        expect(close).toHaveBeenCalled();
        expect(app.focus).toHaveBeenCalled();
        expect(app.postMessage).toHaveBeenCalledWith({ type: 'puca-nav', nav: 'dm:conv-1' });
        expect(notes.postMessage).not.toHaveBeenCalled();
        expect(w.self.clients.openWindow).not.toHaveBeenCalled();
    });

    it('a tap with no Púca window opens one at the target', async () => {
        const w = loadWorker({ windows: [win('https://app.example.com/notes/'), win('https://other.example/')] });
        await w.click('server:srv-1');
        expect(w.self.clients.openWindow).toHaveBeenCalledWith('/?nav=server%3Asrv-1');
    });

    it('a tap with a bad target opens the app and nothing else', async () => {
        const w = loadWorker();
        await w.click('javascript:alert(1)');
        expect(w.self.clients.openWindow).toHaveBeenCalledWith('/');
        const app = win('https://app.example.com/');
        const w2 = loadWorker({ windows: [app] });
        await w2.click({ evil: true });
        expect(app.focus).toHaveBeenCalled();
        expect(app.postMessage).not.toHaveBeenCalled();
    });
});
