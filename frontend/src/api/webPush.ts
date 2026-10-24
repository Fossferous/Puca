/**
 * Notifications on this device, for the WEB app: standard Web Push.
 *
 * WHO THIS IS FOR. The iPhone/iPad Home Screen app (iOS 16.4+), Android Chrome
 * on the web, and desktop Chrome, Edge and Firefox — a browser tab or an
 * installed web app that is CLOSED, which until now heard nothing at all. The
 * desktop app (Tauri) and the Android app (Capacitor) have their own paths
 * (the tray, the native delivery socket and its FCM doorbell), and an
 * embedding host (Púca for Steam Deck) shows notifications itself: all three
 * are detected and skipped, so nobody is notified twice.
 *
 * WHAT CROSSES THE PUSH SERVICE. Nothing but a wake: the server sends the
 * constant {"w":"1"} (src/wake/webpush.rs), and Apple, Google, Mozilla or
 * Microsoft learn that a wake happened and when. The worker (public/sw.js)
 * then asks OUR server what knocked, with a secret that can do nothing else,
 * and shows the Android app's content-free titles ("alice sent you a
 * message" / "New message"). Message content is never shown and never
 * fetched: it is encrypted end to end, and a notification survives on a lock
 * screen. docs/SECURITY_MODEL.md, "Web Push".
 *
 * MUTES AND BLOCKS travel with the subscription (the server applies them
 * BEFORE sending), because the worker cannot stay silent: iOS revokes a
 * subscription whose pushes show nothing. They are re-sent whenever the
 * stores announce a change, exactly as the Android app mirrors them natively.
 *
 * PERMISSION is asked only from a tap on the Settings switch — iOS refuses it
 * otherwise, and a prompt nobody asked for is how permissions get denied for
 * good. In a Safari TAB on iOS there is no Web Push at all; Settings says to
 * add Púca to the Home Screen instead.
 */
import { apiClient, ApiError } from './client';
import { API_BASE_URL } from './config';
import { isMobile, isTauri } from './platform';
import { hostShowsNotifications } from './embedHost';
import { deferNav } from './mobileApp';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { getMutedServers, getServerNotifyLevel } from '../components/mutedServersStore';
import { getMutedChannels } from '../components/mutedChannelsStore';
import { getBlockedIds } from '../components/blockStore';

/** Shared with public/sw.js, which reads the same store. */
export const PUSH_DB = 'puca-push';
export const PUSH_STORE = 'cfg';
export const PUSH_KEY = 'subscription';
export const SW_URL = '/sw.js';
export const SW_SCOPE = '/';

/** Chat.tsx's notification-tap targets; the same pattern as sw.js. */
export const NAV_RE = /^(dm|server|clip):[A-Za-z0-9_-]{1,80}$/;

/** What the worker needs, in IndexedDB. `endpoint` and `key` let a later
 *  start notice that the browser's subscription or the server's key changed. */
export interface WorkerConfig {
    api: string;
    id: number;
    secret: string;
    endpoint: string;
    key: string;
}

export type WebPushEnvironment =
    /** The desktop or Android app: they notify their own way. */
    | 'native-app'
    /** Inside an embedding host that shows notifications itself. */
    | 'embedded'
    /** An iPhone or iPad Safari tab: only a Home Screen app gets Web Push. */
    | 'ios-needs-home-screen'
    /** No service worker, Push API or Notification API here. */
    | 'unsupported'
    | 'ok';

export interface EnvProbe {
    tauri: boolean;
    capacitor: boolean;
    embedded: boolean;
    userAgent: string;
    maxTouchPoints: number;
    /** navigator.standalone — true only in an iOS Home Screen app. */
    standalone: boolean;
    serviceWorker: boolean;
    pushManager: boolean;
    notification: boolean;
}

export function probeEnvironment(): EnvProbe {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;
    return {
        tauri: isTauri(),
        capacitor: isMobile(),
        embedded: hostShowsNotifications(),
        userAgent: nav?.userAgent ?? '',
        maxTouchPoints: nav?.maxTouchPoints ?? 0,
        standalone: (nav as { standalone?: boolean } | undefined)?.standalone === true,
        serviceWorker: !!nav && 'serviceWorker' in nav,
        pushManager: !!win && 'PushManager' in win,
        notification: !!win && 'Notification' in win,
    };
}

/** An iPhone, iPad or iPod — including an iPad that asks for the desktop site
 *  (it says "Macintosh" but has a touchscreen). */
export function isAppleTouchDevice(ua: string, maxTouchPoints: number): boolean {
    return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
}

export function webPushEnvironment(p: EnvProbe = probeEnvironment()): WebPushEnvironment {
    if (p.tauri || p.capacitor) return 'native-app';
    if (p.embedded) return 'embedded';
    if (isAppleTouchDevice(p.userAgent, p.maxTouchPoints) && !p.standalone) return 'ios-needs-home-screen';
    if (!p.serviceWorker || !p.pushManager || !p.notification) return 'unsupported';
    return 'ok';
}

/** This device's mutes and blocks, in the shape the server stores. A server
 *  set to anything but "all" is muted for a push: the server cannot see an
 *  @mention inside ciphertext, so "mentions only" is silence here, exactly as
 *  on Android (PushGate.java). */
export function currentGates(): { muted_servers: string[]; muted_channels: number[]; blocked_ids: number[] } {
    const muted_servers = Object.keys(getMutedServers()).filter((id) => getServerNotifyLevel(id) !== 'all');
    const muted_channels = Object.entries(getMutedChannels())
        .filter(([, v]) => v === true)
        .map(([k]) => Number(k))
        .filter((n) => Number.isSafeInteger(n));
    const blocked_ids = [...getBlockedIds()].filter((n) => Number.isSafeInteger(n));
    return { muted_servers, muted_channels, blocked_ids };
}

// ---- IndexedDB (the worker's half lives in public/sw.js) -------------------

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(PUSH_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(PUSH_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function readWorkerConfig(): Promise<WorkerConfig | null> {
    try {
        const db = await openDb();
        try {
            return await new Promise((resolve) => {
                const get = db.transaction(PUSH_STORE, 'readonly').objectStore(PUSH_STORE).get(PUSH_KEY);
                get.onsuccess = () => resolve((get.result as WorkerConfig | undefined) ?? null);
                get.onerror = () => resolve(null);
            });
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

async function writeWorkerConfig(cfg: WorkerConfig | null): Promise<void> {
    try {
        const db = await openDb();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(PUSH_STORE, 'readwrite');
                if (cfg) tx.objectStore(PUSH_STORE).put(cfg, PUSH_KEY);
                else tx.objectStore(PUSH_STORE).delete(PUSH_KEY);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    } catch {
        /* a browser with storage off: the worker shows the generic text */
    }
}

// ---- server ----------------------------------------------------------------

/** The server's VAPID public key, or null when it has none (or is too old to
 *  know about Web Push). Public route: no session needed. */
export async function fetchServerKey(): Promise<string | null> {
    try {
        const res = await fetch(`${API_BASE_URL}/push/web/key`, { credentials: 'omit', cache: 'no-store' });
        if (!res.ok) return null;
        const body = (await res.json()) as { key?: unknown };
        return typeof body.key === 'string' && body.key.length > 0 ? body.key : null;
    } catch {
        return null;
    }
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64url(buf: ArrayBuffer | null): string {
    if (!buf) return '';
    let bin = '';
    for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Was this subscription made with this key? (A rotated server key strands
 *  every old subscription: the push services refuse its signature.) */
export function subscribedWithKey(sub: PushSubscription, key: string): boolean {
    const used = sub.options?.applicationServerKey ?? null;
    return used !== null && bytesToB64url(used) === key;
}

async function registration(): Promise<ServiceWorkerRegistration> {
    await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    return navigator.serviceWorker.ready;
}

/** Hand the server this browser's subscription and keep what the worker
 *  needs. */
async function registerWithServer(sub: PushSubscription, key: string): Promise<void> {
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const res = await apiClient.post<{ id: number; secret: string }>('/push/web/subscription', {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        gates: currentGates(),
    });
    await writeWorkerConfig({ api: API_BASE_URL, id: res.id, secret: res.secret, endpoint: sub.endpoint, key });
}

export type EnableResult =
    | { ok: true }
    | { ok: false; reason: 'environment' | 'not-configured' | 'denied' | 'failed'; detail?: string };

/**
 * Turn notifications on for this device. CALL ONLY FROM A TAP: the permission
 * request is the first thing it does, before any await, because iOS ties the
 * prompt to the gesture and a fetch first would lose it.
 */
export async function enableWebPush(): Promise<EnableResult> {
    if (webPushEnvironment() !== 'ok') return { ok: false, reason: 'environment' };
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };
    const key = await fetchServerKey();
    if (!key) return { ok: false, reason: 'not-configured' };
    try {
        const reg = await registration();
        let sub = await reg.pushManager.getSubscription();
        if (sub && !subscribedWithKey(sub, key)) {
            await sub.unsubscribe().catch(() => false);
            sub = null;
        }
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
        await registerWithServer(sub, key);
        saveSettings({ ...loadSettings(), webPushEnabled: true });
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
}

/** Stop being addressable: the server row, the browser's subscription, the
 *  worker's secret. Each step is attempted whatever the others do. */
async function dropSubscription(): Promise<void> {
    let sub: PushSubscription | null = null;
    try {
        const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
        sub = (await reg?.pushManager.getSubscription()) ?? null;
    } catch { /* no worker: nothing subscribed */ }
    const cfg = await readWorkerConfig();
    const endpoint = sub?.endpoint ?? cfg?.endpoint;
    if (endpoint) {
        try {
            await apiClient.delete('/push/web/subscription', { body: JSON.stringify({ endpoint }) });
        } catch { /* the worker's 410/404 and the session check are the backstop */ }
    }
    try { await sub?.unsubscribe(); } catch { /* best effort */ }
    await writeWorkerConfig(null);
}

/** Turn notifications off for this device. */
export async function disableWebPush(): Promise<void> {
    saveSettings({ ...loadSettings(), webPushEnabled: false });
    if (webPushEnvironment() !== 'ok') return;
    await dropSubscription();
}

/**
 * Make this browser agree with the setting, at sign-in and app start. Never
 * asks for permission (no tap here): with it already granted, a subscription
 * that went missing or was made with an old server key is replaced; with it
 * revoked in the browser, the setting is left on and Settings says why.
 */
export async function reconcileWebPush(): Promise<void> {
    if (webPushEnvironment() !== 'ok') return;
    if (!loadSettings().webPushEnabled) return;
    if (Notification.permission !== 'granted') return;
    const key = await fetchServerKey();
    if (!key) return;
    try {
        const reg = await registration();
        let sub = await reg.pushManager.getSubscription();
        if (sub && !subscribedWithKey(sub, key)) {
            await sub.unsubscribe().catch(() => false);
            sub = null;
        }
        sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
        const cfg = await readWorkerConfig();
        if (cfg && cfg.endpoint === sub.endpoint && cfg.key === key && cfg.api === API_BASE_URL) {
            // Known: refresh the mutes, which also proves the row still exists.
            if (await patchGates(cfg)) return;
        }
        await registerWithServer(sub, key);
    } catch (err) {
        console.warn('[web-push] could not restore the subscription:', err);
    }
}

/** Re-send this device's mutes and blocks. False when the server no longer
 *  has the row (then the caller subscribes again). */
async function patchGates(cfg: WorkerConfig): Promise<boolean> {
    try {
        await apiClient.patch('/push/web/subscription', { id: cfg.id, gates: currentGates() });
        return true;
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return false;
        return true; // offline or a server hiccup: the next change re-sends
    }
}

let teardownListeners: (() => void) | null = null;

/** Sign-in and app start: restore the subscription and keep the mirrored
 *  mutes fresh. No-op where Web Push does not apply. */
export async function initWebPush(): Promise<void> {
    if (webPushEnvironment() !== 'ok') return;
    await reconcileWebPush();
    if (teardownListeners) return;
    const onGates = () => {
        void (async () => {
            if (!loadSettings().webPushEnabled) return;
            const cfg = await readWorkerConfig();
            if (cfg && !(await patchGates(cfg))) await reconcileWebPush();
        })();
    };
    window.addEventListener('serverMuteChanged', onGates);
    window.addEventListener('channelMuteChanged', onGates);
    window.addEventListener('blockedUsersChanged', onGates);
    teardownListeners = () => {
        window.removeEventListener('serverMuteChanged', onGates);
        window.removeEventListener('channelMuteChanged', onGates);
        window.removeEventListener('blockedUsersChanged', onGates);
    };
}

/**
 * Sign-out, BEFORE the session token is dropped (deleting the server row
 * needs it). The setting goes off too: whoever signs in next on this browser
 * chooses for themselves. The server also deletes the row when the session is
 * signed out, and stops pushing to any session that has ended.
 */
export async function teardownWebPush(): Promise<void> {
    teardownListeners?.();
    teardownListeners = null;
    if (webPushEnvironment() !== 'ok') return;
    if (loadSettings().webPushEnabled) saveSettings({ ...loadSettings(), webPushEnabled: false });
    await dropSubscription();
}

/** Ask the server to push to this browser now. */
export async function sendTestPush(): Promise<void> {
    await apiClient.post('/push/web/test');
}

// ---- notification taps -----------------------------------------------------

function takeNav(target: unknown): void {
    if (typeof target !== 'string' || !NAV_RE.test(target)) return;
    deferNav(target);
    window.dispatchEvent(new CustomEvent('sovereign-navigate'));
}

/**
 * Boot-time (main.tsx): a tap on a notification lands here. With a Púca
 * window open, the worker focuses it and posts the target; with none, it
 * opens `/?nav=<target>`. Either way the target joins the same pending-nav
 * slot the Android app's taps use, and Chat applies it once its data loads.
 */
export function installWebPushNav(win: Window = window): void {
    if (webPushEnvironment() !== 'ok') return;
    try {
        const url = new URL(win.location.href);
        const nav = url.searchParams.get('nav');
        if (nav !== null) {
            takeNav(nav);
            url.searchParams.delete('nav');
            win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
        }
    } catch { /* a URL we cannot parse carries no target */ }
    const sw = win.navigator.serviceWorker;
    sw.addEventListener('message', (e: MessageEvent) => {
        const data = e.data as { type?: unknown; nav?: unknown } | null;
        if (data && data.type === 'puca-nav') takeNav(data.nav);
    });
    // Messages queued while the page was loading are held until this.
    sw.startMessages();
}
