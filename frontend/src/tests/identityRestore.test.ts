/**
 * "Signed in, but the keys never came back" (auth.ts restoreIdentityAfterLogin
 * + IdentityBanner's contract).
 *
 * login() keeps the session when GET /keys/wrap fails — dropping a sign-in
 * over a flaky request would be worse — but until 0.9.2 it did so SILENTLY.
 * The first assertion of the first test (the call resolves) passes on the old
 * code too, which proves the stub reaches the real branch; the second (the
 * flag) is what the fix adds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateIdentitySeed, buildWrapMaterial, getActiveIdentity, clearActiveIdentity } from '../api/e2ee';

const wire = vi.hoisted(() => ({
    wrap: null as null | Record<string, unknown> | (() => never),
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: {
            get: vi.fn(async (url: string) => {
                if (url !== '/keys/wrap') throw new Error('unexpected GET ' + url);
                if (typeof wire.wrap === 'function') return wire.wrap();
                return wire.wrap;
            }),
            post: vi.fn(async () => ({})),
            delete: vi.fn(),
        },
    };
});

const auth = await import('../api/auth');

// setup.ts replaces localStorage with vi.fn() stubs; back them with a store.
function backingStore() {
    const store: Record<string, string> = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    return store;
}

const PASSWORD = 'hunter2hunter2';
let store: Record<string, string>;

beforeEach(() => {
    store = backingStore();
    clearActiveIdentity();
});

describe('restoreIdentityAfterLogin', () => {
    it('a failed /keys/wrap keeps the session AND records the missing identity', async () => {
        store['auth_token'] = 'tok';
        wire.wrap = () => { throw new Error('502 from the proxy'); };
        let changes = 0;
        const off = auth.onIdentityRestoreChange(() => { changes += 1; });

        await expect(auth.restoreIdentityAfterLogin('mick', PASSWORD)).resolves.toBeUndefined();
        expect(store['auth_token']).toBe('tok');            // still signed in (positive control)
        expect(auth.identityRestoreFailed()).toBe(true);    // …and no longer silently
        expect(changes).toBe(1);
        expect(getActiveIdentity()).toBeNull();
        off();
    });

    it('a seed that does not unwrap (wrong password / poisoned row) is recorded the same way', async () => {
        const { material } = await buildWrapMaterial(generateIdentitySeed(), 'a different password');
        wire.wrap = { key_version: 3, wrap_salt: material.wrapSalt, seed_wrapped_pw: material.seedWrappedPw, pw_kdf_iterations: material.pwKdfIterations, pw_kdf: material.pwKdf };
        await auth.restoreIdentityAfterLogin('mick', PASSWORD);
        expect(auth.identityRestoreFailed()).toBe(true);
    }, 60_000);

    it('a successful restore clears the flag; retry with the password restores the identity', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, PASSWORD);
        const good = { key_version: 3, wrap_salt: material.wrapSalt, seed_wrapped_pw: material.seedWrappedPw, pw_kdf_iterations: material.pwKdfIterations, pw_kdf: material.pwKdf };

        wire.wrap = () => { throw new Error('offline'); };
        await auth.restoreIdentityAfterLogin('mick', PASSWORD);
        expect(auth.identityRestoreFailed()).toBe(true);

        wire.wrap = good;
        await expect(auth.retryIdentityRestore('wrong password')).rejects.toThrow(/did not unlock/);
        expect(auth.identityRestoreFailed()).toBe(true);

        await auth.retryIdentityRestore(PASSWORD);
        expect(auth.identityRestoreFailed()).toBe(false);
        const id = getActiveIdentity();
        expect(id && Buffer.from(id.privateKey).equals(Buffer.from(seed))).toBe(true);
    }, 60_000);

    it('a retired key format is NOT a degraded sign-in: the token is dropped and the error surfaces', async () => {
        store['auth_token'] = 'tok';
        wire.wrap = { key_version: 2, wrap_salt: null, seed_wrapped_pw: null, pw_kdf_iterations: null, pw_kdf: null };
        await expect(auth.restoreIdentityAfterLogin('mick', PASSWORD)).rejects.toBeInstanceOf(auth.RetiredKeyFormatError);
        expect(store['auth_token']).toBeUndefined();
        expect(auth.identityRestoreFailed()).toBe(false);
    });
});
