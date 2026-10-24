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
 * screen. docs/SECURITY_MODEL.md, "Notifications while the web app is closed".
 *
 * PER ACCOUNT. The opt-in belongs to the account that tapped the switch
 * (api/webPushLocal.ts), never to the browser: whoever signs in next on a
 * shared browser is not opted in by someone else, and the server moves a
 * browser's push address to another account only on that account's own tap.
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
import { currentUserIdFromToken } from './auth';
import { getMutedServers, getServerNotifyLevel } from '../components/mutedServersStore';
import { getMutedChannels } from '../components/mutedChannelsStore';
import { getBlockedIds } from '../components/blockStore';
import {
    SW_SCOPE,
    dropLocalWebPush,
    readWorkerConfig,
    setWebPushOptIn,
    signOutWebPush,
    webPushOptedIn,
    writeWorkerConfig,
} from './webPushLocal';

export { readWorkerConfig, type WorkerConfig } from './webPushLocal';
export { PUSH_DB, PUSH_STORE, PUSH_KEY, SW_SCOPE, OPT_IN_EVENT } from './webPushLocal';
export const SW_URL = '/sw.js';

/** Chat.tsx's notification-tap targets; the same pattern as sw.js. */
export const NAV_RE = /^(dm|server|clip):[A-Za-z0-9_-]{1,80}$/;

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

/** Has the signed-in account turned on notifications on this browser? */
export function webPushEnabledHere(): boolean {
    return webPushOptedIn(currentUserIdFromToken());
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

/** The browser's subscription for `key`, made if missing or made with an old
 *  key. With permission already granted no tap is needed. */
async function browserSubscription(key: string): Promise<PushSubscription> {
    const reg = await registration();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !subscribedWithKey(sub, key)) {
        await sub.unsubscribe().catch(() => false);
        sub = null;
    }
    return sub ?? reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
}

/** Hand the server this browser's subscription and keep what the worker
 *  needs. `takeover` only from a tap: without it the server refuses (409) to
 *  move a push address that belongs to another account. Every registration
 *  mints a new secret. */
async function registerWithServer(sub: PushSubscription, key: string, takeover: boolean): Promise<void> {
    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const res = await apiClient.post<{ id: number; secret: string }>('/push/web/subscription', {
        endpoint: sub.endpoint,
        p256dh: json.keys?.p256dh ?? '',
        auth: json.keys?.auth ?? '',
        gates: currentGates(),
        takeover,
    });
    await writeWorkerConfig({ api: API_BASE_URL, id: res.id, secret: res.secret, endpoint: sub.endpoint, key });
}

export type EnableResult =
    | { ok: true }
    | { ok: false; reason: 'environment' | 'not-configured' | 'denied' | 'failed'; detail?: string };

/**
 * Turn notifications on for this device and the signed-in account. CALL ONLY
 * FROM A TAP: the permission request is the first thing it does, before any
 * await, because iOS ties the prompt to the gesture and a fetch first would
 * lose it. The tap is also what entitles it to take this browser's push
 * address over from another account.
 */
export async function enableWebPush(): Promise<EnableResult> {
    if (webPushEnvironment() !== 'ok') return { ok: false, reason: 'environment' };
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return { ok: false, reason: 'denied' };
    const key = await fetchServerKey();
    if (!key) return { ok: false, reason: 'not-configured' };
    const uid = currentUserIdFromToken();
    try {
        const sub = await browserSubscription(key);
        await registerWithServer(sub, key, true);
        setWebPushOptIn(uid, true);
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
}

/** Stop being addressable: the server row (while the session can still say
 *  so), then the browser's subscription and the worker's secret. */
async function dropSubscription(): Promise<void> {
    const endpoint = await dropLocalWebPush();
    if (endpoint) {
        try {
            await apiClient.delete('/push/web/subscription', { body: JSON.stringify({ endpoint }) });
        } catch { /* the worker's 410/404 and the session check are the backstop */ }
    }
}

/** Turn notifications off for this device and the signed-in account. */
export async function disableWebPush(): Promise<void> {
    setWebPushOptIn(currentUserIdFromToken(), false);
    if (webPushEnvironment() !== 'ok') return;
    await dropSubscription();
}

/**
 * Make this browser agree with the signed-in account's choice, at sign-in and
 * app start. Never asks for permission and never takes a push address over
 * from another account (no tap here). A row this session did not make — the
 * user signed in again, so the old session's row is dead — is replaced by a
 * fresh registration with a new secret; one another account holds means that
 * account tapped the switch since, so this one's opt-in is cleared.
 */
export async function reconcileWebPush(): Promise<void> {
    if (webPushEnvironment() !== 'ok') return;
    const uid = currentUserIdFromToken();
    if (!webPushOptedIn(uid)) return;
    if (Notification.permission !== 'granted') return;
    const key = await fetchServerKey();
    if (!key) return;
    try {
        const sub = await browserSubscription(key);
        const cfg = await readWorkerConfig();
        if (cfg && cfg.endpoint === sub.endpoint && cfg.key === key && cfg.api === API_BASE_URL) {
            // Known: refresh the mutes, which also proves the row is this
            // session's and still exists.
            if (await patchGates(cfg)) return;
        }
        await registerWithServer(sub, key, false);
    } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
            setWebPushOptIn(uid, false);
            return;
        }
        console.warn('[web-push] could not restore the subscription:', err);
    }
}

/** Re-send this device's mutes and blocks. False when the server has no such
 *  row for THIS session (then the caller registers afresh). */
async function patchGates(cfg: { id: number }): Promise<boolean> {
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
            if (!webPushEnabledHere()) return;
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
 * Explicit sign-out, BEFORE the session token is dropped (deleting the server
 * row needs it): this account is opted out on this browser and the browser
 * stops being addressable. The server also deletes the signed-out session's
 * row, and stops pushing to any session that has ended or lapsed.
 */
export async function teardownWebPush(): Promise<void> {
    teardownListeners?.();
    teardownListeners = null;
    if (webPushEnvironment() !== 'ok') return;
    const uid = currentUserIdFromToken();
    const endpoint = await signOutWebPush(uid);
    if (endpoint) {
        try {
            await apiClient.delete('/push/web/subscription', { body: JSON.stringify({ endpoint }) });
        } catch { /* /auth/logout-session deletes it too */ }
    }
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
