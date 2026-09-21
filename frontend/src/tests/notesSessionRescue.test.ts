/**
 * The Android app's page can sleep in a cached process for more than a day
 * while the background job keeps renewing the session. When it resumes, its
 * own token has expired, and its first request 401s. That 401 must NOT end
 * the session while the job holds a renewed token of the same account: the
 * page adopts it and carries on (and the sign-out path, which would also have
 * deleted the job's good token, never runs). Only with nothing to adopt does
 * it expire. Also: adoption runs again whenever the page becomes visible.
 *
 * The native plugin is a fake behind a mocked @capacitor/core; the token
 * store is the real one (localStorage), so "adopted" means the page's token
 * really changed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let pluginPresent = true;
const fake = {
    takeRenewedToken: vi.fn(async (): Promise<{ token: string | null; account: string | null }> => ({ token: null, account: null })),
};
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => (pluginPresent ? 'android' : 'web'),
        isPluginAvailable: (name: string) => pluginPresent && name === 'NotesNative',
        isNativePlatform: () => pluginPresent,
    },
    registerPlugin: () => fake,
}));

const { rescueOrExpire, rescueWhenOnline, adoptFromNative, adoptOnResume } = await import('../notes/native/nativeSessionRescue');

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jwt(payload: Record<string, unknown>): string {
    return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}
const nowS = () => Math.floor(Date.now() / 1000);
const EXPIRED = () => jwt({ sub: 7, exp: nowS() - 3600 });
const RENEWED = () => jwt({ sub: 7, exp: nowS() + 20 * 3600 });

// The shared setup stubs localStorage with bare vi.fn()s; give it a real
// backing store here so the token swap is observable.
const store = new Map<string, string>();
beforeEach(() => {
    pluginPresent = true;
    fake.takeRenewedToken.mockReset();
    store.clear();
    vi.mocked(localStorage.getItem).mockImplementation(k => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => { store.set(k, String(v)); });
    vi.mocked(localStorage.removeItem).mockImplementation(k => { store.delete(k); });
});

describe('a 401 after a long background stay (rescueOrExpire with the real adoption)', () => {
    it('the job renewed the session: the page adopts it and does NOT expire', async () => {
        const stale = EXPIRED();
        const renewed = RENEWED();
        localStorage.setItem('auth_token', stale);
        fake.takeRenewedToken.mockResolvedValue({ token: renewed, account: '7' });
        const expire = vi.fn();
        const onAdopted = vi.fn();
        expect(await rescueOrExpire({ adopt: adoptFromNative, onAdopted, expire })).toBe('adopted');
        expect(expire).not.toHaveBeenCalled();
        expect(onAdopted).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('auth_token')).toBe(renewed);
    });

    it('nothing renewed (the job saw the 401 too and dropped its copy): the page expires (control)', async () => {
        localStorage.setItem('auth_token', EXPIRED());
        fake.takeRenewedToken.mockResolvedValue({ token: null, account: null });
        const expire = vi.fn();
        expect(await rescueOrExpire({ adopt: adoptFromNative, onAdopted: vi.fn(), expire })).toBe('expired');
        expect(expire).toHaveBeenCalledTimes(1);
    });

    it('the job holds ANOTHER account\'s token: never adopted, the page expires', async () => {
        localStorage.setItem('auth_token', EXPIRED());
        fake.takeRenewedToken.mockResolvedValue({ token: jwt({ sub: 8, exp: nowS() + 9999 }), account: '8' });
        const expire = vi.fn();
        expect(await rescueOrExpire({ adopt: adoptFromNative, onAdopted: vi.fn(), expire })).toBe('expired');
        expect(localStorage.getItem('auth_token')).not.toContain(b64url('{"sub":8'));
    });

    it('the adopted token is refused too: the second 401 expires (no loop)', async () => {
        const renewed = RENEWED();
        localStorage.setItem('auth_token', renewed);
        fake.takeRenewedToken.mockResolvedValue({ token: renewed, account: '7' });
        const expire = vi.fn();
        expect(await rescueOrExpire({ adopt: adoptFromNative, onAdopted: vi.fn(), expire })).toBe('expired');
    });

    it('in the browser (no plugin) a 401 expires exactly as before', async () => {
        pluginPresent = false;
        localStorage.setItem('auth_token', EXPIRED());
        fake.takeRenewedToken.mockResolvedValue({ token: RENEWED(), account: '7' });
        const expire = vi.fn();
        expect(await rescueOrExpire({ adopt: adoptFromNative, onAdopted: vi.fn(), expire })).toBe('expired');
        expect(fake.takeRenewedToken).not.toHaveBeenCalled();
    });

    it('a throwing adoption is not a rescue', async () => {
        const expire = vi.fn();
        await rescueOrExpire({ adopt: async () => { throw new Error('bridge'); }, onAdopted: vi.fn(), expire });
        expect(expire).toHaveBeenCalledTimes(1);
    });
});

describe('adoption on resume', () => {
    const setVisibility = (v: 'visible' | 'hidden') =>
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });

    it('becoming visible adopts before the next poll; hidden does nothing', async () => {
        const stale = EXPIRED();
        const renewed = RENEWED();
        localStorage.setItem('auth_token', stale);
        fake.takeRenewedToken.mockResolvedValue({ token: renewed, account: '7' });
        const onAdopted = vi.fn();
        const off = adoptOnResume(adoptFromNative, onAdopted);
        try {
            setVisibility('hidden');
            document.dispatchEvent(new Event('visibilitychange'));
            await new Promise(r => setTimeout(r, 0));
            expect(fake.takeRenewedToken).not.toHaveBeenCalled();

            setVisibility('visible');
            document.dispatchEvent(new Event('visibilitychange'));
            await vi.waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1));
            expect(localStorage.getItem('auth_token')).toBe(renewed);
        } finally {
            off();
        }
    });
});

describe('the token expired while offline, then the network came back', () => {
    it('the job renewed it meanwhile: adopted, NOT expired', async () => {
        const renewed = RENEWED();
        localStorage.setItem('auth_token', EXPIRED());
        fake.takeRenewedToken.mockResolvedValue({ token: renewed, account: '7' });
        const expire = vi.fn();
        const onAdopted = vi.fn();
        const off = rescueWhenOnline({ adopt: adoptFromNative, onAdopted, expire });
        try {
            expect(fake.takeRenewedToken).not.toHaveBeenCalled();   // nothing until online
            window.dispatchEvent(new Event('online'));
            await vi.waitFor(() => expect(onAdopted).toHaveBeenCalledTimes(1));
            expect(expire).not.toHaveBeenCalled();
            expect(localStorage.getItem('auth_token')).toBe(renewed);
            window.dispatchEvent(new Event('online'));             // one shot
            await new Promise(r => setTimeout(r, 0));
            expect(fake.takeRenewedToken).toHaveBeenCalledTimes(1);
        } finally {
            off();
        }
    });

    it('nothing to adopt: expires once online (control)', async () => {
        localStorage.setItem('auth_token', EXPIRED());
        fake.takeRenewedToken.mockResolvedValue({ token: null, account: null });
        const expire = vi.fn();
        const off = rescueWhenOnline({ adopt: adoptFromNative, onAdopted: vi.fn(), expire });
        try {
            window.dispatchEvent(new Event('online'));
            await vi.waitFor(() => expect(expire).toHaveBeenCalledTimes(1));
        } finally {
            off();
        }
    });

    it('unsubscribed before the network returns: nothing runs', async () => {
        const expire = vi.fn();
        const off = rescueWhenOnline({ adopt: adoptFromNative, onAdopted: vi.fn(), expire });
        off();
        window.dispatchEvent(new Event('online'));
        await new Promise(r => setTimeout(r, 0));
        expect(expire).not.toHaveBeenCalled();
        expect(fake.takeRenewedToken).not.toHaveBeenCalled();
    });
});
