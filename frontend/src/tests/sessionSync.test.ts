// Cross-document session sync (api/sessionSync.ts): what a `storage` event
// from ANOTHER tab means — sign-out (hard or soft), account switch, sign-in
// — and that the shared per-account caches are cleared on the hard cases.
// Púca Keep is the second document these exist for; two Púca tabs are the
// pre-existing case that had the same hole.
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const cleared = { channel: vi.fn(), dm: vi.fn(), blob: vi.fn(), appearance: vi.fn() };
vi.mock('../api/channelKeys', () => ({ clearChannelKeyCache: () => cleared.channel() }));
vi.mock('../api/dmKeys', () => ({ clearDmKeys: () => cleared.dm() }));
vi.mock('../api/attachments', () => ({ clearBlobCache: () => cleared.blob() }));
vi.mock('../components/settingsStore', () => ({
    applyAppearance: () => cleared.appearance(),
    loadSettings: () => ({}),
}));
vi.mock('../api/auth', () => ({
    decodeJwtPayload: (t: string) => {
        try { return JSON.parse(atob(t.split('.')[1])); } catch { return null; }
    },
}));

const { classifyTokenChange, installSessionSync, seedPresent } = await import('../api/sessionSync');

function jwt(sub: number): string {
    return `h.${btoa(JSON.stringify({ sub, username: `u${sub}` }))}.s`;
}

const backing = new Map<string, string>();
beforeEach(() => {
    backing.clear();
    Object.values(cleared).forEach(f => f.mockClear());
    (localStorage.getItem as Mock).mockImplementation((k: string) => backing.get(k) ?? null);
});

function fire(key: string | null, newValue: string | null) {
    window.dispatchEvent(new StorageEvent('storage', { key, newValue }));
}

describe('classifyTokenChange', () => {
    it('token gone with the seed gone = a real logout; seed kept = a soft expiry', () => {
        expect(classifyTokenChange(1, null, false)).toEqual({ kind: 'signed-out', reason: 'logout' });
        expect(classifyTokenChange(1, null, true)).toEqual({ kind: 'signed-out', reason: 'expired' });
    });
    it('same sub (a sliding renewal) is nothing; a different sub is an account switch', () => {
        expect(classifyTokenChange(1, jwt(1), true)).toEqual({ kind: 'none' });
        expect(classifyTokenChange(1, jwt(2), true)).toEqual({ kind: 'account-changed' });
    });
    it('a token appearing while signed out is a sign-in; nothing to nothing is nothing', () => {
        expect(classifyTokenChange(null, jwt(3), true)).toEqual({ kind: 'signed-in' });
        expect(classifyTokenChange(null, null, false)).toEqual({ kind: 'none' });
        expect(classifyTokenChange(null, 'garbage', false)).toEqual({ kind: 'none' });
    });
});

describe('installSessionSync', () => {
    it('a hard sign-out elsewhere clears the shared caches and reports logout', () => {
        backing.set('auth_token', jwt(1));
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn(), onSignedIn: vi.fn() };
        const off = installSessionSync(h);
        backing.delete('auth_token');   // the other tab's logout() already removed both
        backing.delete('e2ee_seed_v2');
        fire('auth_token', null);
        expect(h.onSignedOut).toHaveBeenCalledWith('logout');
        expect(cleared.channel).toHaveBeenCalledTimes(1);
        expect(cleared.dm).toHaveBeenCalledTimes(1);
        expect(cleared.blob).toHaveBeenCalledTimes(1);
        off();
    });

    it('a soft expiry elsewhere (seed kept) reports expired and keeps the caches', () => {
        backing.set('auth_token', jwt(1));
        backing.set('e2ee_seed_v2', 'seed');
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn() };
        const off = installSessionSync(h);
        backing.delete('auth_token');
        fire('auth_token', null);
        expect(h.onSignedOut).toHaveBeenCalledWith('expired');
        expect(cleared.channel).not.toHaveBeenCalled();
        off();
    });

    it('a different account signing in elsewhere clears the caches and reports the switch', () => {
        backing.set('auth_token', jwt(1));
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn() };
        const off = installSessionSync(h);
        fire('auth_token', jwt(2));
        expect(h.onAccountChanged).toHaveBeenCalledTimes(1);
        expect(h.onSignedOut).not.toHaveBeenCalled();
        expect(cleared.channel).toHaveBeenCalledTimes(1);
        // The new sub is now the known one: its own renewal is not a switch.
        fire('auth_token', jwt(2));
        expect(h.onAccountChanged).toHaveBeenCalledTimes(1);
        off();
    });

    it('a renewal (same sub) is ignored; a sign-in while signed out is reported', () => {
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn(), onSignedIn: vi.fn() };
        const off = installSessionSync(h);   // no token at install: signed out
        fire('auth_token', jwt(5));
        expect(h.onSignedIn).toHaveBeenCalledTimes(1);
        fire('auth_token', jwt(5));
        expect(h.onSignedIn).toHaveBeenCalledTimes(1);
        expect(h.onAccountChanged).not.toHaveBeenCalled();
        off();
    });

    it('localStorage.clear() elsewhere (key null) reads as a hard sign-out', () => {
        backing.set('auth_token', jwt(1));
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn() };
        const off = installSessionSync(h);
        fire(null, null);
        expect(h.onSignedOut).toHaveBeenCalledWith('logout');
        off();
    });

    it('the seed arriving or leaving elsewhere is reported separately from the token', () => {
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn(), onSignedIn: vi.fn(), onSeedChanged: vi.fn() };
        const off = installSessionSync(h);
        expect(seedPresent()).toBe(false);
        // login() elsewhere: token first…
        fire('auth_token', jwt(9));
        expect(h.onSignedIn).toHaveBeenCalledTimes(1);
        expect(h.onSeedChanged).not.toHaveBeenCalled();
        // …seed later, after that tab's /keys/wrap round trip.
        backing.set('e2ee_seed_v2', 'seed');
        fire('e2ee_seed_v2', 'seed');
        expect(h.onSeedChanged).toHaveBeenCalledWith(true);
        expect(seedPresent()).toBe(true);
        backing.delete('e2ee_seed_v2');
        fire('e2ee_seed_v2', null);
        expect(h.onSeedChanged).toHaveBeenLastCalledWith(false);
        expect(h.onSignedOut).not.toHaveBeenCalled();   // the seed alone is not a sign-out
        off();
    });

    it('a settings write elsewhere re-applies the appearance; other keys do nothing', () => {
        const h = { onSignedOut: vi.fn(), onAccountChanged: vi.fn() };
        const off = installSessionSync(h);
        fire('sovereign_settings', '{}');
        expect(cleared.appearance).toHaveBeenCalledTimes(1);
        fire('pucaKeepPrefs:1', '{}');
        expect(h.onSignedOut).not.toHaveBeenCalled();
        off();
        fire('sovereign_settings', '{}');
        expect(cleared.appearance).toHaveBeenCalledTimes(1);   // uninstalled
    });
});
