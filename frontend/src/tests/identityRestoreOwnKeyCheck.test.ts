// @vitest-environment jsdom
/**
 * Audit 2026-10 (docs/AUDIT_2026-10.md, finding on the missing own-key check).
 *
 * docs/E2EE_RECOVERY.md §8, "Login (v3)": "... seed = dec(seedWrappedPw) ->
 * setActiveIdentity. Sanity: X25519.getPublicKey(seed) must equal the stored
 * public_key." auth.ts restoreIdentityAfterLogin performs no such check: GET
 * /keys/wrap does not return `public_key`, and nothing fetches
 * /users/:id/public-key for the signed-in account. So a device cannot tell
 * that the identity key the server hands OTHER people for this account is not
 * the one its own seed derives — the symptom is only that channel keys and
 * DMs wrapped to the served key fail to open here.
 *
 * The first test DEMONSTRATES the gap against the current code (no request
 * for the account's own served key is ever made). The second is the check the
 * doc describes, skipped until the product decision in the audit document is
 * made: what the client should DO on a mismatch (refuse the session, or sign
 * in and warn, and in which words).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateIdentitySeed, buildWrapMaterial, makeIdentity, getActiveIdentity, clearActiveIdentity } from '../api/e2ee';

const wire = vi.hoisted(() => ({
    wrap: null as null | Record<string, unknown>,
    /** What /users/:id/public-key answers for the signed-in account. */
    servedOwnKey: null as null | string,
    gets: [] as string[],
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: {
            get: vi.fn(async (url: string) => {
                wire.gets.push(url);
                if (url === '/keys/wrap') return wire.wrap;
                if (/^\/users\/\d+\/public-key$/.test(url)) return { public_key: wire.servedOwnKey };
                throw new Error('unexpected GET ' + url);
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

/** An unsigned token whose payload names account 1 — enough for the client's
 *  own `sub` reads (the server verifies tokens; the client only decodes). */
function tokenFor(sub: number): string {
    const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub, username: 'mick' }))}.sig`;
}

const PASSWORD = 'hunter2hunter2';
let store: Record<string, string>;

beforeEach(() => {
    store = backingStore();
    wire.gets = [];
    clearActiveIdentity();
});

describe('restoreIdentityAfterLogin and the account\'s own served identity key', () => {
    it('DEMONSTRATES the gap: the seed unwraps and becomes the identity without the served key ever being asked for', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, PASSWORD);
        store['auth_token'] = tokenFor(1);
        wire.wrap = { key_version: 3, wrap_salt: material.wrapSalt, seed_wrapped_pw: material.seedWrappedPw, pw_kdf_iterations: material.pwKdfIterations, pw_kdf: material.pwKdf };
        // The server tells everyone else this account's key is some OTHER key.
        wire.servedOwnKey = makeIdentity(generateIdentitySeed()).publicKeyEncoded;

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
        expect(wire.gets.filter((u) => u.startsWith('/users/'))).toEqual([]);
    }, 60_000);

    // The check docs/E2EE_RECOVERY.md §8 describes. Skipped, not failing: the
    // response to a mismatch is a product decision (docs/AUDIT_2026-10.md §6).
    it.skip('EXPECTED once fixed: a served identity key that is not the seed\'s is detected at login', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, PASSWORD);
        store['auth_token'] = tokenFor(1);
        wire.wrap = { key_version: 3, wrap_salt: material.wrapSalt, seed_wrapped_pw: material.seedWrappedPw, pw_kdf_iterations: material.pwKdfIterations, pw_kdf: material.pwKdf };
        wire.servedOwnKey = makeIdentity(generateIdentitySeed()).publicKeyEncoded;

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(wire.gets.some((u) => u.startsWith('/users/1/public-key'))).toBe(true);
        // Whatever the decision, "fully signed in, nothing to show for it" is
        // not it: the mismatch has to leave a mark the UI can act on.
        expect(auth.identityRestoreFailed()).toBe(true);
    }, 60_000);
});
