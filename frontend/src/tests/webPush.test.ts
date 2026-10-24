// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeIndexedDb } from './fakeIndexedDb';

/**
 * api/webPush.ts (and its leaf, api/webPushLocal.ts) — the web app's half of
 * Web Push.
 *
 * The duties pinned here are the ones that fail SILENTLY: a second
 * notification path switched on inside the desktop or Android app (everyone
 * notified twice), a permission prompt that is not the first thing a tap
 * does (iOS drops it), mutes that never reach the server (a muted channel
 * still rings the phone), a sign-out that leaves this browser addressable,
 * and one person's opt-in carried to the next account on a shared browser.
 */

// A real localStorage: the shared setup installs stubs that store nothing,
// and the opt-in and the mute stores live there.
const backing = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
        removeItem: (k: string) => { backing.delete(k); },
        clear: () => { backing.clear(); },
    },
});

const order = vi.hoisted(() => [] as string[]);
const api = vi.hoisted(() => ({
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
}));
const platform = vi.hoisted(() => ({ tauri: false, mobile: false, embedded: false }));
const nav = vi.hoisted(() => ({ deferNav: vi.fn() }));
const blocks = vi.hoisted(() => ({ ids: new Set<number>() }));
const who = vi.hoisted(() => ({ uid: 7 as number | null }));

vi.mock('../api/client', () => {
    class ApiError extends Error {
        status: number;
        // The real signature (api/client.ts): message first, then status.
        constructor(message: string, status: number) {
            super(message);
            this.status = status;
        }
    }
    return {
        ApiError,
        apiClient: {
            post: (...a: unknown[]) => { order.push(`post ${String(a[0])}`); return api.post(...a); },
            patch: (...a: unknown[]) => { order.push(`patch ${String(a[0])}`); return api.patch(...a); },
            delete: (...a: unknown[]) => { order.push(`delete ${String(a[0])}`); return api.delete(...a); },
        },
    };
});
vi.mock('../api/config', () => ({ API_BASE_URL: 'https://chat.example.com' }));
vi.mock('../api/platform', () => ({ isTauri: () => platform.tauri, isMobile: () => platform.mobile }));
vi.mock('../api/embedHost', () => ({ hostShowsNotifications: () => platform.embedded }));
vi.mock('../api/mobileApp', () => ({ deferNav: nav.deferNav }));
vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => who.uid }));
vi.mock('../components/blockStore', () => ({ getBlockedIds: () => blocks.ids }));

import * as webPush from '../api/webPush';
import { signOutWebPush, webPushOptedIn, setWebPushOptIn } from '../api/webPushLocal';
import { ApiError } from '../api/client';

const KEY = 'BKEY' + 'A'.repeat(83);   // 87 chars = 65 bytes, as a real key
const OTHER_KEY = 'BOLD' + 'B'.repeat(83);

function b64urlBytes(s: string): Uint8Array {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A PushSubscription as the browser hands one out. */
function subscription(endpoint: string, key: string) {
    return {
        endpoint,
        options: { applicationServerKey: b64urlBytes(key).buffer },
        toJSON: () => ({ endpoint, keys: { p256dh: 'P256DH', auth: 'AUTH' } }),
        unsubscribe: vi.fn(async () => { order.push(`unsubscribe ${endpoint}`); return true; }),
    };
}

let current: ReturnType<typeof subscription> | null;
const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (opts: { applicationServerKey: Uint8Array }) => {
        order.push('subscribe');
        const key = btoa(String.fromCharCode(...opts.applicationServerKey)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        current = subscription('https://fcm.googleapis.com/fcm/send/new', key);
        return current;
    }),
};
const reg = { pushManager };
const swListeners: ((e: MessageEvent) => void)[] = [];
const serviceWorker = {
    register: vi.fn(async (url: string, opts: unknown) => { order.push(`register ${url} ${JSON.stringify(opts)}`); return reg; }),
    ready: Promise.resolve(reg),
    getRegistration: vi.fn(async () => reg),
    addEventListener: vi.fn((t: string, fn: (e: MessageEvent) => void) => { if (t === 'message') swListeners.push(fn); }),
    startMessages: vi.fn(),
};

const notification = {
    permission: 'default' as NotificationPermission,
    answer: 'granted' as NotificationPermission,
    requestPermission: vi.fn(async () => {
        order.push('requestPermission');
        notification.permission = notification.answer;
        return notification.answer;
    }),
};

function setUa(ua: string, opts: { standalone?: boolean; touch?: number } = {}) {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => ua });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => opts.touch ?? 0 });
    Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => opts.standalone });
}

const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP_SITE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

beforeEach(() => {
    backing.clear();
    order.length = 0;
    current = null;
    who.uid = 7;
    Object.assign(platform, { tauri: false, mobile: false, embedded: false });
    blocks.ids = new Set();
    vi.clearAllMocks();
    api.post.mockResolvedValue({ id: 7, secret: 'the-secret' });
    api.patch.mockResolvedValue({ updated: true });
    api.delete.mockResolvedValue({ removed: true });
    notification.permission = 'default';
    notification.answer = 'granted';
    Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: serviceWorker });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: makeFakeIndexedDb() });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        order.push(`fetch ${url}`);
        return new Response(JSON.stringify({ key: KEY }), { status: 200 });
    }));
    setUa(DESKTOP_CHROME);
});

describe('where Web Push applies', () => {
    const base: webPush.EnvProbe = {
        tauri: false, capacitor: false, embedded: false, userAgent: DESKTOP_CHROME, maxTouchPoints: 0,
        standalone: false, serviceWorker: true, pushManager: true, notification: true,
    };
    it.each([
        ['desktop Chrome', base, 'ok'],
        ['the desktop app', { ...base, tauri: true }, 'native-app'],
        ['the Android app', { ...base, capacitor: true }, 'native-app'],
        ['an embedding host', { ...base, embedded: true }, 'embedded'],
        ['an iPhone Safari tab', { ...base, userAgent: IPHONE, maxTouchPoints: 5 }, 'ios-needs-home-screen'],
        ['an iPad asking for the desktop site, in a tab', { ...base, userAgent: IPAD_DESKTOP_SITE, maxTouchPoints: 5 }, 'ios-needs-home-screen'],
        ['an iPhone Home Screen app', { ...base, userAgent: IPHONE, maxTouchPoints: 5, standalone: true }, 'ok'],
        ['an old iPhone Home Screen app (no Push API)', { ...base, userAgent: IPHONE, standalone: true, pushManager: false }, 'unsupported'],
        ['a plain Mac (no touch)', { ...base, userAgent: IPAD_DESKTOP_SITE }, 'ok'],
        ['a browser with no service workers', { ...base, serviceWorker: false }, 'unsupported'],
    ] as const)('%s → %s', (_name, probe, want) => {
        expect(webPush.webPushEnvironment(probe)).toBe(want);
    });
});

describe('turning it on', () => {
    it('asks for permission FIRST, then subscribes with the server key, takes the browser over, and hands the server its mutes', async () => {
        backing.set('sovereign_muted_servers', JSON.stringify({ 'srv-all': 'all', 'srv-off': true, 'srv-mentions': 'mentions' }));
        backing.set('sovereign_muted_channels', JSON.stringify({ '77': true, '78': false }));
        blocks.ids = new Set([13]);

        const r = await webPush.enableWebPush();
        expect(r).toEqual({ ok: true });
        // The prompt is the first thing a tap does: nothing awaited before it.
        expect(order[0]).toBe('requestPermission');
        expect(order).toContain('register /sw.js {"scope":"/"}');
        expect(order.indexOf('subscribe')).toBeGreaterThan(order.indexOf('requestPermission'));
        const subscribeKey = pushManager.subscribe.mock.calls[0][0].applicationServerKey;
        expect([...subscribeKey]).toEqual([...b64urlBytes(KEY)]);
        expect(pushManager.subscribe.mock.calls[0][0]).toMatchObject({ userVisibleOnly: true });

        expect(api.post).toHaveBeenCalledWith('/push/web/subscription', {
            endpoint: 'https://fcm.googleapis.com/fcm/send/new',
            p256dh: 'P256DH',
            auth: 'AUTH',
            gates: { muted_servers: ['srv-off', 'srv-mentions'], muted_channels: [77], blocked_ids: [13] },
            takeover: true,   // a tap may move the browser to this account
        });
        // What the worker will read.
        expect(await webPush.readWorkerConfig()).toEqual({
            api: 'https://chat.example.com', id: 7, secret: 'the-secret',
            endpoint: 'https://fcm.googleapis.com/fcm/send/new', key: KEY,
        });
        expect(webPushOptedIn(7)).toBe(true);
        expect(webPushOptedIn(8)).toBe(false);
    });

    it.each([
        ['the desktop app', () => { platform.tauri = true; }],
        ['the Android app', () => { platform.mobile = true; }],
        ['an embedding host', () => { platform.embedded = true; }],
        ['an iPhone Safari tab', () => { setUa(IPHONE, { touch: 5 }); }],
    ])('in %s: no prompt, no worker, no subscription', async (_name, arrange) => {
        arrange();
        expect(await webPush.enableWebPush()).toEqual({ ok: false, reason: 'environment' });
        expect(notification.requestPermission).not.toHaveBeenCalled();
        expect(serviceWorker.register).not.toHaveBeenCalled();
        expect(api.post).not.toHaveBeenCalled();
    });

    it('a refused permission subscribes nothing and opts nobody in', async () => {
        notification.answer = 'denied';
        expect(await webPush.enableWebPush()).toEqual({ ok: false, reason: 'denied' });
        expect(serviceWorker.register).not.toHaveBeenCalled();
        expect(webPushOptedIn(7)).toBe(false);
    });

    it('a server with no VAPID key subscribes nothing', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ key: null }), { status: 200 })));
        expect(await webPush.enableWebPush()).toEqual({ ok: false, reason: 'not-configured' });
        expect(pushManager.subscribe).not.toHaveBeenCalled();
        expect(api.post).not.toHaveBeenCalled();
    });
});

describe('signing out', () => {
    it('deletes the server row with the token still held, unsubscribes, forgets the secret, and opts this account out', async () => {
        await webPush.enableWebPush();
        order.length = 0;
        await webPush.teardownWebPush();
        expect(api.delete).toHaveBeenCalledWith('/push/web/subscription', {
            body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/new' }),
        });
        expect(order).toContain('unsubscribe https://fcm.googleapis.com/fcm/send/new');
        expect(await webPush.readWorkerConfig()).toBeNull();
        expect(webPushOptedIn(7)).toBe(false);
    });

    it('still unsubscribes the browser when the server cannot be reached', async () => {
        await webPush.enableWebPush();
        const sub = current!;
        api.delete.mockRejectedValue(new Error('offline'));
        await webPush.teardownWebPush();
        expect(sub.unsubscribe).toHaveBeenCalled();
        expect(await webPush.readWorkerConfig()).toBeNull();
    });

    it('Púca Notes’ sign-out (the leaf alone) opts out and unsubscribes too, and only that account', async () => {
        await webPush.enableWebPush();
        setWebPushOptIn(9, true);   // another account opted in on this browser earlier
        const sub = current!;
        await signOutWebPush(7);
        expect(sub.unsubscribe).toHaveBeenCalled();
        expect(await webPush.readWorkerConfig()).toBeNull();
        expect(webPushOptedIn(7)).toBe(false);
        expect(webPushOptedIn(9)).toBe(true);
    });
});

describe('restoring at sign-in and app start', () => {
    it('never prompts', async () => {
        setWebPushOptIn(7, true);
        notification.permission = 'default';
        await webPush.reconcileWebPush();
        expect(notification.requestPermission).not.toHaveBeenCalled();
        expect(serviceWorker.register).not.toHaveBeenCalled();
    });

    it('a known subscription only refreshes its mutes', async () => {
        await webPush.enableWebPush();
        api.post.mockClear();
        await webPush.reconcileWebPush();
        expect(api.patch).toHaveBeenCalledWith('/push/web/subscription', expect.objectContaining({ id: 7 }));
        expect(api.post).not.toHaveBeenCalled();
    });

    it('a row this session did not make is registered afresh — never taken over', async () => {
        await webPush.enableWebPush();
        api.post.mockClear();
        api.patch.mockRejectedValue(new ApiError('No such subscription', 404));
        await webPush.reconcileWebPush();
        expect(api.post).toHaveBeenCalledWith('/push/web/subscription', expect.objectContaining({ takeover: false }));
    });

    it('a browser another account took over clears this account’s opt-in', async () => {
        await webPush.enableWebPush();
        api.patch.mockRejectedValue(new ApiError('No such subscription', 404));
        api.post.mockRejectedValue(new ApiError('another account', 409));
        await webPush.reconcileWebPush();
        expect(webPushOptedIn(7)).toBe(false);
    });

    it('SHARED BROWSER: the next account is not opted in by the previous one', async () => {
        await webPush.enableWebPush();     // account 7 taps the switch
        api.post.mockClear();
        api.patch.mockClear();
        who.uid = 8;                       // account 8 signs in on the same browser
        await webPush.reconcileWebPush();
        await webPush.initWebPush();
        expect(api.post).not.toHaveBeenCalled();
        expect(api.patch).not.toHaveBeenCalled();
        expect(webPush.webPushEnabledHere()).toBe(false);
        // Control: account 7 back, its own choice stands.
        who.uid = 7;
        expect(webPush.webPushEnabledHere()).toBe(true);
    });

    it('a subscription made with an old server key is replaced', async () => {
        setWebPushOptIn(7, true);
        notification.permission = 'granted';
        const old = subscription('https://fcm.googleapis.com/fcm/send/old', OTHER_KEY);
        current = old;
        await webPush.reconcileWebPush();
        expect(old.unsubscribe).toHaveBeenCalled();
        expect(pushManager.subscribe).toHaveBeenCalled();
        expect(api.post).toHaveBeenCalledWith('/push/web/subscription', expect.objectContaining({
            endpoint: 'https://fcm.googleapis.com/fcm/send/new',
            takeover: false,
        }));
    });

    it('a changed mute reaches the server', async () => {
        await webPush.enableWebPush();
        await webPush.initWebPush();
        api.patch.mockClear();
        backing.set('sovereign_muted_channels', JSON.stringify({ '5': true }));
        window.dispatchEvent(new CustomEvent('channelMuteChanged'));
        await vi.waitFor(() => expect(api.patch).toHaveBeenCalledWith('/push/web/subscription', {
            id: 7,
            gates: { muted_servers: [], muted_channels: [5], blocked_ids: [] },
        }));
    });
});

describe('a tap on a notification', () => {
    it('?nav= joins the pending-nav slot and is removed from the address bar', () => {
        window.history.replaceState(null, '', '/?nav=dm%3Aconv-1&x=1');
        webPush.installWebPushNav(window);
        expect(nav.deferNav).toHaveBeenCalledWith('dm:conv-1');
        expect(window.location.search).toBe('?x=1');
        expect(serviceWorker.startMessages).toHaveBeenCalled();
    });

    it('a target that is not a conversation, server or clip is ignored', () => {
        window.history.replaceState(null, '', '/?nav=settings');
        webPush.installWebPushNav(window);
        expect(nav.deferNav).not.toHaveBeenCalled();
        expect(window.location.search).toBe('');
    });

    it('the worker\'s message to an open window is taken the same way', () => {
        window.history.replaceState(null, '', '/');
        webPush.installWebPushNav(window);
        const listener = swListeners[swListeners.length - 1];
        listener(new MessageEvent('message', { data: { type: 'puca-nav', nav: 'server:srv-1' } }));
        listener(new MessageEvent('message', { data: { type: 'puca-nav', nav: 'https://evil.example' } }));
        listener(new MessageEvent('message', { data: { type: 'other', nav: 'dm:x' } }));
        expect(nav.deferNav.mock.calls).toEqual([['server:srv-1']]);
    });

    it('is not installed in the desktop or Android app', () => {
        platform.tauri = true;
        window.history.replaceState(null, '', '/?nav=dm%3Aconv-1');
        webPush.installWebPushNav(window);
        expect(nav.deferNav).not.toHaveBeenCalled();
    });
});
