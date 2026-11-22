/**
 * Deleting the account, and Settings' Clear Local Storage & Reload, take the
 * account's notifications away (review of fix-signout-left).
 *
 * Neither is a sign-out: both wipe this device's storage (localStorage.clear())
 * and reload, so logout() and its sign-out hooks never ran, and a reload
 * unmounts nothing, so Chat's clearAllConversationNotifications never ran
 * either. The toasts in Windows' notification centre, the Android shade and
 * the push worker's list stayed, and the clear also wiped the mark that says
 * whose they are (pucaNotificationsAccount), so the next account to sign in
 * (notificationsAreFor) saw nobody's and took nothing away: "alice sent you a
 * message" from a DELETED account was there for them, a click on it opening
 * that account's conversation key in their session.
 *
 * Each case drives the REAL Settings buttons, with the desktop shell, Android's
 * plugin and the push worker replaced by recorders, and ends where the report
 * does: the page reloads (its memory of its notifications goes) and somebody
 * else signs in.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const env = vi.hoisted(() => ({
    tauri: false,
    mobile: false,
    mobileNative: false,
    /** In order: each native call as it ANSWERED, and the storage wipe. */
    events: [] as string[],
    invokes: [] as { cmd: string; args: Record<string, unknown> | undefined }[],
    /** Native commands that never answer (a wedged toast thread). */
    hang: new Set<string>(),
    androidCleared: [] as (string | undefined)[],
    androidPosted: [] as unknown[][],
    deleted: [] as string[][],
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
    clearMobileNotifications: async (key?: string) => { env.androidCleared.push(key); env.events.push('android-clear'); },
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
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (env.hang.has(cmd)) return new Promise(() => { });
        if (!cmd.startsWith('toast_')) return undefined;
        env.invokes.push({ cmd, args });
        env.events.push(cmd);
        return 'shown';
    },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => { } }));
vi.mock('../api/profile', async (orig) => ({
    ...(await orig<typeof import('../api/profile')>()),
    getProfile: async () => ({ id: 7, username: 'me', display_name: null, email: null }),
}));
vi.mock('../components/blockStore', async (orig) => ({
    ...(await orig<typeof import('../components/blockStore')>()),
    fetchBlockedUsers: async () => [],
}));
vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: async () => ({}) } };
});
vi.mock('../api/auth', async (orig) => ({
    ...(await orig<typeof import('../api/auth')>()),
    deleteAccount: async (username: string, password: string) => { env.deleted.push([username, password]); },
}));
// The RTC config fetches it at import: no network here.
vi.mock('../api/iceConfig', async (orig) => ({
    ...(await orig<typeof import('../api/iceConfig')>()),
    fetchIceConfig: async () => ({ iceServers: [], iceTransportPolicy: 'all' }),
}));
vi.mock('../api/appDialogs', async (orig) => ({
    ...(await orig<typeof import('../api/appDialogs')>()),
    askConfirm: async () => true,
}));

const notify = await import('../api/desktopNotify');
const { SettingsModal } = await import('../components/SettingsModal');

const settle = async () => {
    await act(async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); });
};

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

/** What the push worker has up (public/sw.js shows them; the page can only list and close them). */
let workerShown: { title: string; closed: boolean; close(): void }[] = [];
const workerOpen = () => workerShown.filter(n => !n.closed).map(n => n.title);
function workerShows(title: string) {
    const n = { title, closed: false, close() { n.closed = true; env.events.push('worker-close'); } };
    workerShown.push(n);
}

const token = (sub: number) => `h.${btoa(JSON.stringify({ sub, username: 'me', exp: 4_000_000_000 })).replace(/=+$/, '')}.s`;

let store: Record<string, string>;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    env.tauri = false;
    env.mobile = false;
    env.mobileNative = false;
    env.events = [];
    env.invokes = [];
    env.hang = new Set();
    env.androidCleared = [];
    env.androidPosted = [];
    env.deleted = [];
    store = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    vi.mocked(window.localStorage.clear).mockImplementation(() => { store = {}; env.events.push('storage-wiped'); });
    workerShown = [];
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { getRegistration: async (scope?: string) => (scope === '/' ? { getNotifications: async () => [...workerShown] } : undefined) },
    });
    notify.resetConversationNotificationsForTests();
    // jsdom has no navigation: its reload() only reports "Not implemented".
    vi.spyOn(console, 'error').mockImplementation(() => { });
    vi.spyOn(console, 'warn').mockImplementation(() => { });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (navigator as { serviceWorker?: unknown }).serviceWorker;
    vi.mocked(window.localStorage.getItem).mockReset();
    vi.mocked(window.localStorage.setItem).mockReset();
    vi.mocked(window.localStorage.removeItem).mockReset();
    vi.mocked(window.localStorage.clear).mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Account 7 is signed in (as App marks it) and alice's DM is up wherever this platform shows it. */
async function sevenIsSignedInWithANotificationUp() {
    store.auth_token = token(7);
    notify.notificationsAreFor(7);
    notify.notifyNewMessage({
        title: 'alice sent you a message',
        isOwn: false,
        isMuted: false,
        notifyKey: 'dm:c-alice',
        nav: 'dm:c-alice',
        group: { key: 'dm:c-alice', kind: 'dm', where: 'alice', author: 'alice', messageId: 'm1' },
    });
    workerShows('alice sent you a message');
    await settle();
}

function typeInto(el: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(text: string): HTMLButtonElement {
    const b = Array.from(container.querySelectorAll('button')).find(x => x.textContent?.trim() === text);
    expect(b, `the "${text}" button`).toBeTruthy();
    return b as HTMLButtonElement;
}

async function deleteTheAccount() {
    await act(async () => { root.render(<SettingsModal isOpen onClose={() => { }} onLogout={() => { }} />); });
    await settle();
    await act(async () => { button('Delete Account').click(); });
    await act(async () => {
        typeInto(container.querySelector<HTMLInputElement>('.delete-account-form input[type="password"]')!, 'pw');
        typeInto(container.querySelector<HTMLInputElement>('.delete-account-form input[type="text"]')!, 'me');
    });
    await act(async () => { button('Permanently delete my account').click(); });
    await settle();
    // Positive control: the delete really ran and the device was wiped.
    expect(env.deleted).toEqual([['me', 'pw']]);
    expect(env.events).toContain('storage-wiped');
}

/** The page reloads (its memory of what it showed goes; the OS keeps the
 *  notifications), and somebody else signs in, as App does. */
async function reloadAndEightSignsIn() {
    notify.resetConversationNotificationsForTests();
    store.auth_token = token(8);
    notify.notificationsAreFor(8);
    await settle();
}

describe('deleting the account takes its notifications away', () => {
    it('in the desktop app: Windows\' notification centre, cleared before the wipe and reload', async () => {
        env.tauri = true;
        await sevenIsSignedInWithANotificationUp();
        expect([...windowsCentre().values()], 'positive control: shown').toEqual(['alice']);
        await deleteTheAccount();
        // The shell had the clear before the page went: a reload can drop a call still on its way.
        expect(env.events.indexOf('toast_clear_all')).toBeGreaterThan(-1);
        expect(env.events.indexOf('toast_clear_all')).toBeLessThan(env.events.indexOf('storage-wiped'));
        await reloadAndEightSignsIn();
        expect(windowsCentre().size).toBe(0);
    });

    it('on Android: the shade', async () => {
        env.mobile = true;
        env.mobileNative = true;
        await sevenIsSignedInWithANotificationUp();
        expect(env.androidPosted.length, 'positive control: posted').toBe(1);
        await deleteTheAccount();
        expect(env.androidCleared).toEqual([undefined]);
        expect(env.events.indexOf('android-clear')).toBeLessThan(env.events.indexOf('storage-wiped'));
    });

    it('in a browser: the push worker\'s', async () => {
        await sevenIsSignedInWithANotificationUp();
        expect(workerOpen(), 'positive control: left there').toEqual(['alice sent you a message']);
        await deleteTheAccount();
        expect(workerOpen()).toEqual([]);
        expect(env.events.indexOf('worker-close')).toBeLessThan(env.events.indexOf('storage-wiped'));
        await reloadAndEightSignsIn();
        expect(workerOpen()).toEqual([]);
    });

    it('a shell that does not answer in time: the wipe still goes ahead, and the next account to sign in takes them away', async () => {
        env.tauri = true;
        await sevenIsSignedInWithANotificationUp();
        // The toast thread is wedged: the clear never reaches Windows, and the reload loses it.
        env.hang.add('toast_clear_all');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const wiped = notify.wipeLocalStorageTakingNotificationsAway();
        await vi.advanceTimersByTimeAsync(notify.WIPE_NOTIFICATIONS_WAIT_MS);
        await wiped;
        vi.useRealTimers();
        expect(env.events).toContain('storage-wiped');
        expect(store.auth_token, 'the session is wiped').toBeUndefined();
        expect([...windowsCentre().values()], 'still up after the reload').toEqual(['alice']);
        env.hang.clear();
        await reloadAndEightSignsIn();
        expect(windowsCentre().size).toBe(0);
    });

    it('CONTROL: a shell that answers leaves no mark behind the wipe', async () => {
        env.tauri = true;
        await sevenIsSignedInWithANotificationUp();
        await notify.wipeLocalStorageTakingNotificationsAway();
        expect(store).toEqual({});
    });
});

describe('Clear Local Storage & Reload takes them away too', () => {
    it('in the desktop app', async () => {
        env.tauri = true;
        await sevenIsSignedInWithANotificationUp();
        await act(async () => { root.render(<SettingsModal isOpen onClose={() => { }} onLogout={() => { }} />); });
        await settle();
        const nav = Array.from(container.querySelectorAll('.settings-nav-item')).find(b => b.textContent?.includes('Advanced'));
        expect(nav, 'the Advanced section').toBeTruthy();
        await act(async () => { nav!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await settle();
        await act(async () => { button('Clear Local Storage & Reload').click(); });
        await settle();
        expect(env.events).toContain('storage-wiped');
        expect(env.events.indexOf('toast_clear_all')).toBeGreaterThan(-1);
        expect(env.events.indexOf('toast_clear_all')).toBeLessThan(env.events.indexOf('storage-wiped'));
        await reloadAndEightSignsIn();
        expect(windowsCentre().size).toBe(0);
    });
});
