/**
 * Session-expiry handling (bug: expired 24h JWT made every screen fail
 * SILENTLY — empty lists, looping 401 polls — with no re-login prompt).
 * The API client must dispatch exactly ONE 'auth-expired' event when an
 * authenticated request 401s, and never for tokenless 401s (wrong password).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, resetAuthExpiredFlag } from '../api/client';
import { isTokenExpired } from '../api/auth';

const jwt = (payload: object) =>
    `eyJhbGciOiJIUzI1NiJ9.${btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.sig`;

// setup.ts replaces localStorage with vi.fn() stubs — drive getItem directly.
const setStoredToken = (token: string | null) => {
    vi.mocked(window.localStorage.getItem).mockImplementation(
        (key: string) => (key === 'auth_token' ? token : null),
    );
};

describe('auth expiry signalling', () => {
    let events: number;
    const onExpired = () => { events++; };

    beforeEach(() => {
        events = 0;
        resetAuthExpiredFlag();
        window.addEventListener('auth-expired', onExpired);
    });

    afterEach(() => {
        window.removeEventListener('auth-expired', onExpired);
        vi.mocked(window.localStorage.getItem).mockReset();
        vi.unstubAllGlobals();
    });

    it('dispatches exactly one auth-expired across parallel authed 401s', async () => {
        setStoredToken(jwt({ sub: 1, exp: 0 }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Invalid token', { status: 401 })));

        await Promise.allSettled([
            apiClient.get('/servers/x/unread'),
            apiClient.get('/servers/x/members-with-roles'),
            apiClient.get('/profile'),
        ]);

        expect(events).toBe(1); // the 401 flood must not spam the app
    });

    it('does NOT signal expiry for a tokenless 401 (wrong password)', async () => {
        setStoredToken(null);
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad credentials', { status: 401 })));

        await Promise.allSettled([apiClient.post('/auth/login/step2', { u: 'x' })]);

        expect(events).toBe(0);
    });

    it('does NOT signal on non-401 failures', async () => {
        setStoredToken(jwt({ sub: 1, exp: 9999999999 }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Forbidden', { status: 403 })));

        await Promise.allSettled([apiClient.get('/servers/x/unread')]);

        expect(events).toBe(0); // 403 = permission denial, not expiry
    });

    it('re-arms after resetAuthExpiredFlag (next expiry signals again)', async () => {
        setStoredToken(jwt({ sub: 1, exp: 0 }));
        vi.stubGlobal('fetch', vi.fn(async () => new Response('Invalid token', { status: 401 })));

        await Promise.allSettled([apiClient.get('/a')]);
        resetAuthExpiredFlag(); // = successful re-login
        await Promise.allSettled([apiClient.get('/b')]);

        expect(events).toBe(2);
    });
});

describe('isTokenExpired', () => {
    it('detects an expired JWT', () => {
        expect(isTokenExpired(jwt({ exp: Math.floor(Date.now() / 1000) - 3600 }))).toBe(true);
    });

    it('accepts a live JWT', () => {
        expect(isTokenExpired(jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }))).toBe(false);
    });

    it('never claims expiry for unparseable/absent tokens (server decides)', () => {
        expect(isTokenExpired('garbage')).toBe(false);
        expect(isTokenExpired(null)).toBe(false);
        expect(isTokenExpired(jwt({ noExp: true }))).toBe(false);
    });
});
