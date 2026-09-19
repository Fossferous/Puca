/**
 * Signing out revokes THIS browser's device enrolment — from Púca Notes too,
 * which never opens the socket and so never learns an attested id.
 *
 * The id is derived from the web key (deviceIdentity/identity.ts), so logout()
 * can name the row without the socket. The key is scrubbed ONLY when the
 * server confirms the revoke (2xx): a 404 means the key is not this account's
 * enrolment (another account on a shared browser). Anything else — offline,
 * the tab closed, the answer lost after the server COMMITTED — keeps the key
 * and a local marker (deviceIdentity/pendingRevoke.ts), and the next sign-in
 * finishes the revoke instead of being refused as a revoked device for good.
 * And no key is ever CREATED to sign out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/client', async (orig) => {
    const real = await orig<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, post: vi.fn() } };
});
vi.mock('../api/websocket', () => ({ wsClient: { on: vi.fn(), send: vi.fn(), off: vi.fn() } }));
vi.mock('../api/e2ee', async (orig) => {
    const real = await orig<typeof import('../api/e2ee')>();
    return { ...real, getActiveIdentity: vi.fn(() => ({ fake: true })) };
});
vi.mock('../api/deviceIdentity/identity', async (orig) => {
    const real = await orig<typeof import('../api/deviceIdentity/identity')>();
    return { ...real, signAuthRecord: vi.fn(() => 'sig') };
});

import { logout, pendingDeviceRevoke, SESSION_REVOKE_MAX_WAIT_MS } from '../api/auth';
import { apiClient } from '../api/client';
import { WEB_KEY_STORAGE, ensureDeviceKey } from '../api/deviceIdentity/deviceKey';
import { deriveDeviceId } from '../api/deviceIdentity/identity';
import {
    DEVICE_REVOKE_LOCK, PENDING_REVOKE_KEY, settlePendingDeviceRevoke, storedWebDeviceId, withDeviceRevokeLock,
} from '../api/deviceIdentity/pendingRevoke';
import { enrolThisDevice } from '../api/deviceIdentity/attest';

const store: Record<string, string> = {};
function useBackingStore(initial: Record<string, string>) {
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, initial);
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
}

function webKey(seed = 7): string {
    const bytes = new Uint8Array(64).map((_, i) => (i * seed + 3) & 0xff);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

/** A token whose payload names the user (signature is irrelevant here).
 *  Deterministic — a fixed far-future expiry — so two calls compare equal
 *  even across a second boundary. */
function jwt(sub: number): string {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${b64({ alg: 'HS256' })}.${b64({ sub, exp: 4_102_444_800 })}.sig`;
}

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

/** The server's device rows, by id: what a DELETE really did, answered or not. */
const rows = new Map<string, { uid: number; revoked: boolean }>();
let calls: { url: string; method: string; auth: string | null }[] = [];
type DeviceAnswer = 'ok' | '404' | 'offline' | 'commit-then-lose' | 'hang';
let hung: (() => void) | null = null;
function stubFetch(deviceAnswer: DeviceAnswer) {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(url), method: init?.method ?? 'GET', auth: headers.Authorization ?? null });
        const m = /\/devices\/([^/?]+)$/.exec(String(url));
        if (m && init?.method === 'DELETE') {
            const id = decodeURIComponent(m[1]);
            if (deviceAnswer === 'offline') throw new TypeError('Failed to fetch');
            if (deviceAnswer === 'hang') return new Promise<Response>(res => { hung = () => res(new Response('', { status: 200 })); });
            const row = rows.get(id);
            if (!row || deviceAnswer === '404') return new Response('', { status: 404 });
            row.revoked = true;                       // the server COMMITS the revoke...
            if (deviceAnswer === 'commit-then-lose') throw new TypeError('network changed');   // ...and the answer is lost
            return new Response('', { status: 200 });   // an already-revoked row answers 200 too
        }
        return new Response('', { status: 200 });
    }));
}

/** POST /devices as the server does it: a revoked id stays revoked. */
function stubEnrol(uid: number) {
    vi.mocked(apiClient.post).mockImplementation(async (path: string, body?: unknown) => {
        if (path !== '/devices') throw new Error('unexpected ' + path);
        const b = body as { device_pub: string; sign_pub: string };
        const id = deriveDeviceId(b.device_pub, b.sign_pub);
        const row = rows.get(id);
        if (row?.revoked) throw new Error('device_revoked: this device was signed out; add it again as a new device');
        rows.set(id, { uid, revoked: false });
        return { id } as never;
    });
}

async function keyId(): Promise<string> {
    const pub = await ensureDeviceKey();
    return deriveDeviceId(pub.device_pub, pub.sign_pub);
}

describe('sign-out revokes the web device without the socket', () => {
    beforeEach(() => { vi.clearAllMocks(); rows.clear(); hung = null; });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    it('derives the id from the stored key, revokes it, and scrubs the key and the marker only after a 2xx', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(41), [WEB_KEY_STORAGE]: key });
        const expectedId = await keyId();                        // same stored key, no new one
        rows.set(expectedId, { uid: 41, revoked: false });
        stubFetch('ok');

        logout();
        // Not yet confirmed: the key is still there, and the intent is written down.
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        expect(JSON.parse(store[PENDING_REVOKE_KEY]).devId).toBe(expectedId);
        await pendingDeviceRevoke();
        await settle();

        const del = calls.find(c => c.method === 'DELETE');
        expect(del?.url).toContain(`/devices/${expectedId}`);
        expect(del?.auth).toBe(`Bearer ${jwt(41)}`);             // the token captured before logout dropped it
        expect(store[WEB_KEY_STORAGE]).toBeUndefined();
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
        // The session revoke goes AFTER the device revoke (it needs the session alive).
        const order = calls.map(c => (c.url.includes('/devices/') ? 'device' : c.url.includes('logout-session') ? 'session' : 'other'));
        expect(order.indexOf('device')).toBeLessThan(order.indexOf('session'));
    });

    it('keeps the key on a 404 (not this account’s enrolment), with nothing left to finish', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(42), [WEB_KEY_STORAGE]: key });
        stubFetch('404');
        logout();
        await pendingDeviceRevoke();
        await settle();
        expect(calls.some(c => c.method === 'DELETE')).toBe(true);
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('keeps the key AND the marker when the revoke never reached the server', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(43), [WEB_KEY_STORAGE]: key });
        stubFetch('offline');
        logout();
        await pendingDeviceRevoke();
        await settle();
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        expect(store[PENDING_REVOKE_KEY]).toBeDefined();
        // Still signed out locally, and the session revoke was still attempted.
        expect(store.auth_token).toBeUndefined();
        expect(calls.some(c => c.url.includes('logout-session'))).toBe(true);
    });

    it('creates no key and sends no revoke when this browser never had one', async () => {
        useBackingStore({ auth_token: jwt(44) });
        stubFetch('ok');
        logout();
        await pendingDeviceRevoke();
        await settle();
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
        expect(store[WEB_KEY_STORAGE]).toBeUndefined();
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
        expect(window.localStorage.setItem).not.toHaveBeenCalledWith(WEB_KEY_STORAGE, expect.anything());
    });
});

describe('a revoke the server committed but this page never heard back from', () => {
    beforeEach(() => { vi.clearAllMocks(); rows.clear(); hung = null; });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('is finished at the next sign-in: the DELETE is sent again, answers 200, and the key goes', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(50), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        rows.set(id, { uid: 50, revoked: false });
        stubFetch('commit-then-lose');
        logout();
        await pendingDeviceRevoke();
        await settle();
        // The server revoked the row; this page saw a network error.
        expect(rows.get(id)?.revoked).toBe(true);
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        expect(store[PENDING_REVOKE_KEY]).toBeDefined();

        // Signed in again (same account): the marker is settled with the new token.
        store.auth_token = jwt(50);
        stubFetch('ok');
        expect(await settlePendingDeviceRevoke(store.auth_token, 50)).toBe('revoked');
        expect(calls.filter(c => c.method === 'DELETE').map(c => c.auth)).toEqual([`Bearer ${jwt(50)}`]);
        expect(store[WEB_KEY_STORAGE]).toBeUndefined();
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('enrolment then succeeds as a NEW device instead of device_revoked forever', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(51), [WEB_KEY_STORAGE]: key });
        const oldId = await keyId();
        rows.set(oldId, { uid: 51, revoked: false });
        stubFetch('commit-then-lose');
        logout();
        await pendingDeviceRevoke();
        await settle();

        store.auth_token = jwt(51);
        stubFetch('ok');
        stubEnrol(51);
        const row = await enrolThisDevice(51);
        expect(row).not.toBeNull();
        expect(store[WEB_KEY_STORAGE]).toBeDefined();
        expect(store[WEB_KEY_STORAGE]).not.toBe(key);
        expect(storedWebDeviceId()).not.toBe(oldId);
        expect(rows.get(oldId)?.revoked).toBe(true);
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('a device_revoked refusal forgets the key ONLY when the local marker names that device', async () => {
        const key = webKey();
        // The settle DELETE fails (offline), so enrolment meets the revoked row.
        useBackingStore({ auth_token: jwt(52), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        rows.set(id, { uid: 52, revoked: true });
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: id, uid: 52, at: 1 });
        stubFetch('offline');
        stubEnrol(52);
        const row = await enrolThisDevice(52);
        expect(row).not.toBeNull();                               // re-enrolled with a fresh key
        expect(store[WEB_KEY_STORAGE]).not.toBe(key);
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('positive control: without the marker, the SERVER saying device_revoked never destroys the key', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(53), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        rows.set(id, { uid: 53, revoked: true });
        stubFetch('ok');
        stubEnrol(53);
        expect(await enrolThisDevice(53)).toBeNull();
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        // Nor a marker for ANOTHER device or account. The settle DELETE fails
        // (offline) so the marker SURVIVES into attest's own devId check —
        // answered, it would 404 and clear the marker, and enrolment would
        // never look at it.
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: 'someone-else', uid: 53, at: 1 });
        stubFetch('offline');
        expect(await enrolThisDevice(53)).toBeNull();
        expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/devices/someone-else'))).toBe(true);
        expect(store[PENDING_REVOKE_KEY]).toBeDefined();          // it reached attest
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: id, uid: 99, at: 1 });
        expect(await enrolThisDevice(53)).toBeNull();
        expect(store[WEB_KEY_STORAGE]).toBe(key);
    });

    it('another account’s marker is left alone at sign-in', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(60), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: id, uid: 61, at: 1 });
        stubFetch('ok');
        expect(await settlePendingDeviceRevoke(store.auth_token, 60)).toBe('none');
        expect(calls.length).toBe(0);
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        expect(store[PENDING_REVOKE_KEY]).toBeDefined();
    });
});

describe('the session revoke is never held hostage by the device revoke', () => {
    beforeEach(() => { vi.clearAllMocks(); rows.clear(); hung = null; });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

    const sessionCalls = () => calls.filter(c => c.url.includes('logout-session'));

    it('is sent when the page goes away while the device revoke is still pending', async () => {
        useBackingStore({ auth_token: jwt(70), [WEB_KEY_STORAGE]: webKey() });
        stubFetch('hang');
        logout();
        await settle();
        expect(calls.some(c => c.method === 'DELETE')).toBe(true);
        expect(sessionCalls()).toHaveLength(0);                  // still waiting on the DELETE
        window.dispatchEvent(new Event('pagehide'));
        expect(sessionCalls()).toHaveLength(1);
        expect(sessionCalls()[0].auth).toBe(`Bearer ${jwt(70)}`);
        hung?.();
        await settle();
        expect(sessionCalls()).toHaveLength(1);                  // once, not twice
    });

    it('is sent when the page is hidden (a mobile tab switch never fires pagehide)', async () => {
        useBackingStore({ auth_token: jwt(71), [WEB_KEY_STORAGE]: webKey() });
        stubFetch('hang');
        logout();
        await settle();
        const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        vis.mockRestore();
        expect(sessionCalls()).toHaveLength(1);
        hung?.();
    });

    it('is sent after a capped wait when the device revoke never answers', async () => {
        vi.useFakeTimers();
        useBackingStore({ auth_token: jwt(72), [WEB_KEY_STORAGE]: webKey() });
        stubFetch('hang');
        logout();
        await vi.advanceTimersByTimeAsync(SESSION_REVOKE_MAX_WAIT_MS - 100);
        expect(sessionCalls()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(200);
        expect(sessionCalls()).toHaveLength(1);
        hung?.();
    });
});

/** An exclusive, FIFO Web Locks stand-in (jsdom has none). */
function installLocks(): { uninstall: () => void; requests: string[] } {
    const tails = new Map<string, Promise<unknown>>();
    const requests: string[] = [];
    const locks = {
        request: (name: string, cb: (l: { name: string; mode: string }) => Promise<unknown>) => {
            requests.push(name);
            const prev = tails.get(name) ?? Promise.resolve();
            const run = prev.then(() => cb({ name, mode: 'exclusive' }));
            tails.set(name, run.catch(() => undefined));
            return run;
        },
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    return { uninstall: () => { delete (navigator as unknown as { locks?: unknown }).locks; }, requests };
}

describe('two tabs (Púca and Púca Notes) never both settle one marker', () => {
    let off: (() => void) | null = null;
    beforeEach(() => { vi.clearAllMocks(); rows.clear(); hung = null; });
    afterEach(() => { off?.(); off = null; vi.unstubAllGlobals(); });

    /** DELETEs answer 500 first (Púca's settle fails), then as the server does. */
    function stubFlakyDelete() {
        calls = [];
        let deletes = 0;
        vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
            calls.push({ url: String(url), method: init?.method ?? 'GET', auth: null });
            const m = /\/devices\/([^/?]+)$/.exec(String(url));
            if (m && init?.method === 'DELETE') {
                if (deletes++ === 0) return new Response('', { status: 500 });
                const row = rows.get(decodeURIComponent(m[1]));
                if (!row) return new Response('', { status: 404 });
                row.revoked = true;
                return new Response('', { status: 200 });
            }
            return new Response('', { status: 200 });
        }));
    }
    /** POST /devices held until released, then answered as the server does. */
    function gatedEnrol(uid: number, fail = false): () => void {
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        vi.mocked(apiClient.post).mockImplementation(async (path: string, body?: unknown) => {
            await gate;
            if (fail) throw new TypeError('Failed to fetch');
            const b = body as { device_pub: string; sign_pub: string };
            const id = deriveDeviceId(b.device_pub, b.sign_pub);
            if (rows.get(id)?.revoked) throw new Error('device_revoked');
            rows.set(id, { uid, revoked: false });
            return { id } as never;
        });
        return release;
    }

    it('a Notes settle waits for Púca’s settle-and-enrol, then finds the marker gone: the live session is never revoked', async () => {
        off = installLocks().uninstall;
        const key = webKey();
        useBackingStore({ auth_token: jwt(80), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        rows.set(id, { uid: 80, revoked: false });
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: id, uid: 80, at: 1 });
        stubFlakyDelete();
        const release = gatedEnrol(80);

        const puca = enrolThisDevice(80);                        // settle fails (500), then enrols the old key
        await settle();
        expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
        const notes = settlePendingDeviceRevoke(store.auth_token, 80);   // the Notes tab, meanwhile
        await settle();
        expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);   // waiting for the lock
        release();
        expect(await puca).not.toBeNull();
        expect(await notes).toBe('none');                        // the enrolment cleared the marker
        expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
        expect(rows.get(id)?.revoked).toBe(false);               // the session Púca just proved lives
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('positive control: when Púca’s enrolment fails, the waiting Notes settle then finishes the revoke', async () => {
        off = installLocks().uninstall;
        const key = webKey();
        useBackingStore({ auth_token: jwt(81), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        rows.set(id, { uid: 81, revoked: false });
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: id, uid: 81, at: 1 });
        stubFlakyDelete();
        const release = gatedEnrol(81, true);

        const puca = enrolThisDevice(81).catch(e => e);
        await settle();
        const notes = settlePendingDeviceRevoke(store.auth_token, 81);
        release();
        expect(await puca).toBeInstanceOf(TypeError);
        expect(await notes).toBe('revoked');
        expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(2);
        expect(rows.get(id)?.revoked).toBe(true);
        expect(store[WEB_KEY_STORAGE]).toBeUndefined();
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('without Web Locks, or with a lock manager that refuses, the settle still runs — once', async () => {
        const key = webKey();
        useBackingStore({ auth_token: jwt(82), [WEB_KEY_STORAGE]: key });
        const id = await keyId();
        rows.set(id, { uid: 82, revoked: false });
        store[PENDING_REVOKE_KEY] = JSON.stringify({ devId: id, uid: 82, at: 1 });
        stubFetch('offline');
        expect('locks' in navigator).toBe(false);
        expect(await settlePendingDeviceRevoke(store.auth_token, 82)).toBe('failed');
        expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);

        Object.defineProperty(navigator, 'locks', { value: { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) }, configurable: true });
        off = () => { delete (navigator as unknown as { locks?: unknown }).locks; };
        stubFetch('ok');
        expect(await settlePendingDeviceRevoke(store.auth_token, 82)).toBe('revoked');
        expect(calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
        expect(store[PENDING_REVOKE_KEY]).toBeUndefined();
    });

    it('a failure INSIDE the lock is not retried outside it', async () => {
        const { uninstall, requests } = installLocks();
        off = uninstall;
        const run = vi.fn(async () => { throw new Error('boom'); });
        await expect(withDeviceRevokeLock(run)).rejects.toThrow('boom');
        expect(run).toHaveBeenCalledTimes(1);
        expect(requests).toEqual([DEVICE_REVOKE_LOCK]);
    });
});
