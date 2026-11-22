// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The account's notifications go with its session (review of fix-signout-left).
 *
 * Before: the only thing that took them away was Chat's unmount
 * (clearAllConversationNotifications), so
 *  - a sign-out where Chat never opened (Púca Notes' page signs out through
 *    logout() alone) left the page's own reminder and conversation
 *    notifications up, with their counts;
 *  - nothing at all, anywhere, cleared Android's message notifications in the
 *    shade or what the web app's push worker (public/sw.js) had shown, so
 *    "alice sent you a message" stayed in the browser's list and on a phone's
 *    lock screen after the sign-out;
 *  - an account whose session ran out, or whose app closed, without a
 *    sign-out left all of them for whoever signed in next, and a click on one
 *    opened that account's conversation in the new one.
 * Now logout() takes them all away (its sign-out hook in api/desktopNotify.ts),
 * and a sign-in as somebody else does (notificationsAreFor). Each case below
 * goes through the REAL logout() / notificationsAreFor and the REAL
 * notifyNewMessage / notifyTasksDue, with the desktop shell, Android's plugin,
 * the page's Notification and the push worker replaced by recorders.
 */

const env = vi.hoisted(() => ({
    tauri: false,
    mobile: false,
    mobileNative: false,
    invokes: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
    androidCleared: [] as (string | undefined)[],
    androidPosted: [] as unknown[][],
}));

vi.mock('../api/platform', async (orig) => ({
    ...(await orig<typeof import('../api/platform')>()),
    isTauri: () => env.tauri,
    isMobile: () => env.mobile,
    appIsForeground: () => false,
}));
vi.mock('../api/mobileApp', async (orig) => ({
    ...(await orig<typeof import('../api/mobileApp')>()),
    mobileAppAvailable: () => env.mobileNative,
    postMobileNotification: async (...a: unknown[]) => { env.androidPosted.push(a); },
    clearMobileNotifications: async (key?: string) => { env.androidCleared.push(key); },
}));
vi.mock('../components/settingsStore', async (orig) => {
    const real = await orig<typeof import('../components/settingsStore')>();
    return {
        ...real,
        loadSettings: () => ({ ...real.defaultSettings, desktopNotifications: true, mobileNotifications: true }),
        saveSettings: vi.fn(),
    };
});
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: Record<string, unknown>) => { env.invokes.push({ cmd, args }); return 'shown'; },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => { } }));

const notify = await import('../api/desktopNotify');
const embed = await import('../api/embedHost');
const { logout } = await import('../api/auth');
const { installSessionSync } = await import('../api/sessionSync');
await import('@tauri-apps/api/core');

async function settle() {
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
}

/** Windows' notification centre, by toasts.rs's contract. */
function windowsCentre(): Map<string, string> {
    const centre = new Map<string, string>();
    for (const { cmd, args } of env.invokes) {
        if (cmd === 'toast_show') centre.set(String(args?.key), String(args?.title));
        else if (cmd === 'toast_clear') centre.delete(String(args?.key));
        else if (cmd === 'toast_clear_all') centre.clear();
    }
    return centre;
}

/** The page's own notifications. */
class PageNotification {
    static permission: NotificationPermission = 'granted';
    static made: PageNotification[] = [];
    onclick: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    title: string;
    constructor(title: string) {
        this.title = title;
        PageNotification.made.push(this);
    }
    close() { this.closed = true; this.onclose?.(); }
    static open() { return PageNotification.made.filter(n => !n.closed).map(n => n.title); }
}
Object.defineProperty(PageNotification.prototype, 'renotify', { get() { return false; }, configurable: true });

/** What the push worker has up (public/sw.js shows them; the page can only list and close them). */
let workerShown: { title: string; closed: boolean; close(): void }[] = [];
const workerOpen = () => workerShown.filter(n => !n.closed).map(n => n.title);
function workerShows(title: string) {
    const n = { title, closed: false, close() { n.closed = true; } };
    workerShown.push(n);
}

let store: Record<string, string>;
beforeEach(() => {
    env.tauri = false;
    env.mobile = false;
    env.mobileNative = false;
    env.invokes = [];
    env.androidCleared = [];
    env.androidPosted = [];
    store = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    PageNotification.made = [];
    (globalThis as { Notification?: unknown }).Notification = PageNotification;
    workerShown = [];
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistration: async (scope?: string) => (scope === '/' ? { getNotifications: async () => [...workerShown] } : undefined) },
    });
    notify.resetConversationNotificationsForTests();
});
afterEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
});

function dmFrom(author: string, id: string, conversation = 'c-alice') {
    return notify.notifyNewMessage({
        title: `${author} sent you a message`,
        isOwn: false,
        isMuted: false,
        notifyKey: `dm:${conversation}`,
        nav: `dm:${conversation}`,
        group: { key: `dm:${conversation}`, kind: 'dm', where: author, author, messageId: id },
    });
}

describe('a sign-out takes the account\'s notifications away', () => {
    it('in a browser, with no Chat (Púca Notes\' page): the page\'s reminder and conversation notifications, and the push worker\'s', async () => {
        dmFrom('alice', 'm1');
        notify.notifyTasksDue(1, [{ id: 5, mark: 'x' }]);
        workerShows('bob sent you a message');
        await settle();
        // POSITIVE CONTROL: all three are up before.
        expect(PageNotification.open()).toEqual(['alice', 'Púca Tasks']);
        expect(workerOpen()).toEqual(['bob sent you a message']);
        logout();
        await settle();
        expect(PageNotification.open()).toEqual([]);
        expect(workerOpen()).toEqual([]);
        // And the count is gone: the next message to that conversation starts again.
        expect(notify.notifyDiag().live.groups).toEqual([]);
    });

    it('on Android: the message notifications in the shade', async () => {
        env.mobile = true;
        env.mobileNative = true;
        dmFrom('alice', 'm1');
        await settle();
        expect(env.androidPosted.length, 'positive control: posted').toBe(1);
        logout();
        await settle();
        // No key: every one of the app's message notifications (SovereignAppPlugin.clearNotifications).
        expect(env.androidCleared).toEqual([undefined]);
    });

    it('inside an embedding host (Púca for Steam Deck): a tap on one it still shows opens nothing', async () => {
        const shownByHost: { id: string; title: string }[] = [];
        (window as unknown as { __PUCA_EMBED_HOST__?: unknown }).__PUCA_EMBED_HOST__ = {
            apiVersion: embed.EMBED_API_VERSION, name: 'a test host', notify: (n: { id: string; title: string }) => { shownByHost.push(n); },
        };
        embed.resetEmbedHostForTest();
        try {
            const opened = vi.fn();
            notify.notifyNewMessage({ title: 'alice sent you a message', isOwn: false, isMuted: false, notifyKey: 'dm:c-alice', onActivate: opened });
            expect(shownByHost.map(n => n.title), 'positive control: the host shows it').toEqual(['alice sent you a message']);
            logout();
            // The host's toast is the host's to keep; a tap on it now does nothing here.
            expect(embed.activateHostNotification(shownByHost[0].id)).toBe(false);
            expect(opened).not.toHaveBeenCalled();
        } finally {
            delete (window as unknown as { __PUCA_EMBED_HOST__?: unknown }).__PUCA_EMBED_HOST__;
            embed.resetEmbedHostForTest();
        }
    });

    it('in the desktop app: the toasts in Windows\' notification centre', async () => {
        env.tauri = true;
        dmFrom('alice', 'm1');
        await settle();
        expect([...windowsCentre().values()], 'positive control: shown').toEqual(['alice']);
        logout();
        await settle();
        expect(windowsCentre().size).toBe(0);
    });
});

describe('a sign-in as somebody else takes the last account\'s away', () => {
    /** Account 7's run ends with nobody signing out (its session ran out, or the
     *  app closed): its notifications stay where the OS keeps them, and the
     *  page's memory of them goes with the page. */
    async function sevensRunEndsWithoutASignOut() {
        notify.notificationsAreFor(7);
        dmFrom('alice', 'm1');
        workerShows('alice sent you a message');
        await settle();
        notify.resetConversationNotificationsForTests();
    }

    it('in the desktop app: Windows\' notification centre', async () => {
        env.tauri = true;
        await sevensRunEndsWithoutASignOut();
        expect(windowsCentre().size, 'positive control: left there').toBe(1);
        notify.notificationsAreFor(8);
        await settle();
        expect(windowsCentre().size).toBe(0);
    });

    it('on Android: the shade', async () => {
        env.mobile = true;
        env.mobileNative = true;
        await sevensRunEndsWithoutASignOut();
        notify.notificationsAreFor(8);
        await settle();
        expect(env.androidCleared).toEqual([undefined]);
    });

    it('in a browser: the push worker\'s', async () => {
        await sevensRunEndsWithoutASignOut();
        expect(workerOpen(), 'positive control: left there').toEqual(['alice sent you a message']);
        notify.notificationsAreFor(8);
        await settle();
        expect(workerOpen()).toEqual([]);
    });

    it('CONTROL: the same account signing back in keeps its own', async () => {
        env.tauri = true;
        await sevensRunEndsWithoutASignOut();
        notify.notificationsAreFor(7);
        await settle();
        expect(windowsCentre().size).toBe(1);
        expect(workerOpen()).toEqual(['alice sent you a message']);
    });

    it('a tab that heard another tab sign in as somebody else keeps the new account\'s mark', async () => {
        const token = (sub: number) => `h.${btoa(JSON.stringify({ sub, username: 'u', exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;
        store.auth_token = token(7);
        notify.notificationsAreFor(7);
        const uninstall = installSessionSync({ onSignedOut: vi.fn(), onAccountChanged: vi.fn() });
        try {
            // The other tab: 8 signs in there, and its App marks the notifications 8's.
            store.auth_token = token(8);
            notify.notificationsAreFor(8);
            window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: store.auth_token }));
        } finally {
            uninstall();
        }
        await settle();
        // 8's push, then 8's session runs out with nobody signing out, and 9 signs in.
        workerShows('erin sent you a message');
        expect(store.pucaNotificationsAccount, 'the mark is still 8\'s').toBe('8');
        delete store.auth_token;
        notify.notificationsAreFor(9);
        await settle();
        expect(workerOpen()).toEqual([]);
    });

    it('CONTROL: after a sign-out there is nothing of anybody\'s left to take', async () => {
        env.tauri = true;
        notify.notificationsAreFor(7);
        logout();
        await settle();
        const asked = env.invokes.length;
        notify.notificationsAreFor(8);
        await settle();
        expect(env.invokes.slice(asked).map(c => c.cmd)).toEqual([]);
    });
});
