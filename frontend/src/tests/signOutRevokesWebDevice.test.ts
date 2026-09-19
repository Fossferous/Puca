/**
 * Signing out revokes THIS browser's device enrolment — from Púca Notes too,
 * which never opens the socket and so never learns an attested id.
 *
 * The id is derived from the web key (deviceIdentity/identity.ts), so logout()
 * can name the row without the socket. The key is scrubbed ONLY when the
 * server confirms the revoke (2xx): a 404 means the key is not this account's
 * enrolment (another account on a shared browser) and a network failure means
 * the row is still there — in both, dropping the key would strand a row.
 * And no key is ever CREATED to sign out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logout, pendingDeviceRevoke } from '../api/auth';
import { WEB_KEY_STORAGE, ensureDeviceKey } from '../api/deviceIdentity/deviceKey';
import { deriveDeviceId } from '../api/deviceIdentity/identity';

const store: Record<string, string> = {};
function useBackingStore(initial: Record<string, string>) {
    for (const k of Object.keys(store)) delete store[k];
    Object.assign(store, initial);
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
}

function webKey(): string {
    const bytes = new Uint8Array(64).map((_, i) => (i * 7 + 3) & 0xff);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

let calls: { url: string; method: string; auth: string | null }[] = [];
function stubFetch(deviceAnswer: 'ok' | '404' | 'offline') {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(url), method: init?.method ?? 'GET', auth: headers.Authorization ?? null });
        if (String(url).includes('/devices/')) {
            if (deviceAnswer === 'offline') throw new TypeError('Failed to fetch');
            return new Response('', { status: deviceAnswer === 'ok' ? 200 : 404 });
        }
        return new Response('', { status: 200 });
    }));
}

describe('sign-out revokes the web device without the socket', () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('derives the id from the stored key, revokes it, and scrubs the key only after a 2xx', async () => {
        const key = webKey();
        useBackingStore({ auth_token: 'jwt-A', [WEB_KEY_STORAGE]: key });
        const pub = await ensureDeviceKey();                     // same stored key, no new one
        const expectedId = deriveDeviceId(pub.device_pub, pub.sign_pub);
        stubFetch('ok');

        logout();
        // Not yet confirmed: the key is still there on this line.
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        await pendingDeviceRevoke();
        await settle();

        const del = calls.find(c => c.method === 'DELETE');
        expect(del?.url).toContain(`/devices/${expectedId}`);
        expect(del?.auth).toBe('Bearer jwt-A');                 // the token captured before logout dropped it
        expect(store[WEB_KEY_STORAGE]).toBeUndefined();
        // The session revoke goes AFTER the device revoke (it needs the session alive).
        const order = calls.map(c => (c.url.includes('/devices/') ? 'device' : c.url.includes('logout-session') ? 'session' : 'other'));
        expect(order.indexOf('device')).toBeLessThan(order.indexOf('session'));
    });

    it('keeps the key on a 404 (not this account’s enrolment)', async () => {
        const key = webKey();
        useBackingStore({ auth_token: 'jwt-B', [WEB_KEY_STORAGE]: key });
        stubFetch('404');
        logout();
        await pendingDeviceRevoke();
        await settle();
        expect(calls.some(c => c.method === 'DELETE')).toBe(true);
        expect(store[WEB_KEY_STORAGE]).toBe(key);
    });

    it('keeps the key when the revoke never reached the server', async () => {
        const key = webKey();
        useBackingStore({ auth_token: 'jwt-C', [WEB_KEY_STORAGE]: key });
        stubFetch('offline');
        logout();
        await pendingDeviceRevoke();
        await settle();
        expect(store[WEB_KEY_STORAGE]).toBe(key);
        // Still signed out locally, and the session revoke was still attempted.
        expect(store.auth_token).toBeUndefined();
        expect(calls.some(c => c.url.includes('logout-session'))).toBe(true);
    });

    it('creates no key and sends no revoke when this browser never had one', async () => {
        useBackingStore({ auth_token: 'jwt-D' });
        stubFetch('ok');
        logout();
        await pendingDeviceRevoke();
        await settle();
        expect(calls.some(c => c.method === 'DELETE')).toBe(false);
        expect(store[WEB_KEY_STORAGE]).toBeUndefined();
        expect(window.localStorage.setItem).not.toHaveBeenCalledWith(WEB_KEY_STORAGE, expect.anything());
    });
});
