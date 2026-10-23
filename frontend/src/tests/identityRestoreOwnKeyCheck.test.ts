// @vitest-environment jsdom
/**
 * Audit 2026-10, F-3: the sign-in sanity check docs/E2EE_RECOVERY.md §8
 * describes — "Sanity: X25519.getPublicKey(seed) must equal the stored
 * public_key" — is done.
 *
 * THE GAP. restoreIdentityAfterLogin unwrapped the seed and adopted it
 * without asking what key the server publishes for the account: GET
 * /keys/wrap carries none, and nothing read /users/:id/public-key for
 * ourselves. So when the server handed EVERYONE ELSE a different identity
 * key for this account (new contacts pin it; their DMs and channel wraps go
 * to it), the account's own devices could not tell.
 *
 * The SECURITY cases go red against that code (the served key is never asked
 * for; the seed is adopted). The controls are what the owner asked for in the
 * same breath: no existing user is locked out by a FALSE mismatch — a key
 * that matches, nothing published, a pre-X25519 value, and a lookup that
 * fails all still sign in with their identity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateIdentitySeed, buildWrapMaterial, makeIdentity, getActiveIdentity, clearActiveIdentity, setActiveIdentity } from '../api/e2ee';

const wire = vi.hoisted(() => ({
    wrap: null as null | Record<string, unknown>,
    /** What /users/:id/public-key answers for the signed-in account; a
     *  function to fail the request. */
    servedOwnKey: null as null | string | (() => never),
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
                if (/^\/users\/\d+\/public-key$/.test(url)) {
                    if (typeof wire.servedOwnKey === 'function') return wire.servedOwnKey();
                    return { user_id: 1, public_key: wire.servedOwnKey };
                }
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

/** A v3 account whose password unwraps `seed`. */
async function accountWith(seed: Uint8Array) {
    const { material } = await buildWrapMaterial(seed, PASSWORD);
    wire.wrap = { key_version: 3, wrap_salt: material.wrapSalt, seed_wrapped_pw: material.seedWrappedPw, pw_kdf_iterations: material.pwKdfIterations, pw_kdf: material.pwKdf };
}
const askedForOwnKey = () => wire.gets.some((u) => u === '/users/1/public-key');

beforeEach(() => {
    store = backingStore();
    store['auth_token'] = tokenFor(1);
    wire.gets = [];
    wire.servedOwnKey = null;
    clearActiveIdentity();
});

describe('restoreIdentityAfterLogin checks the identity key the server publishes for you', () => {
    it('SECURITY: a served key that is not the seed\'s stops the restore, and says why', async () => {
        await accountWith(generateIdentitySeed());
        // The server tells everyone else this account's key is some OTHER key.
        wire.servedOwnKey = makeIdentity(generateIdentitySeed()).publicKeyEncoded;

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(askedForOwnKey(), 'the served key was never asked for').toBe(true);
        expect(getActiveIdentity(), 'a key the server does not publish for us was adopted').toBeNull();
        expect(auth.identityRestoreFailed()).toBe(true);
        expect(auth.identityRestoreReason()).toBe('key-mismatch');
    }, 60_000);

    it('SECURITY: a seed cached by an earlier session does not stand in for the refused one', async () => {
        const seed = generateIdentitySeed();
        setActiveIdentity(makeIdentity(seed)); // this device's earlier session
        await accountWith(seed);
        wire.servedOwnKey = makeIdentity(generateIdentitySeed()).publicKeyEncoded;

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(getActiveIdentity()).toBeNull();
    }, 60_000);

    it('SECURITY: retrying with the password refuses it too, and says so', async () => {
        await accountWith(generateIdentitySeed());
        wire.servedOwnKey = makeIdentity(generateIdentitySeed()).publicKeyEncoded;
        store['e2ee_identity_missing_v1'] = 'mick';

        await expect(auth.retryIdentityRestore(PASSWORD)).rejects.toThrow(/not the one this server publishes/);
        expect(getActiveIdentity()).toBeNull();
        expect(auth.identityRestoreReason()).toBe('key-mismatch');
    }, 60_000);

    it('CONTROL: the key it publishes IS the seed\'s — adopted, nothing flagged', async () => {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.servedOwnKey = makeIdentity(seed).publicKeyEncoded;

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(askedForOwnKey()).toBe(true);
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
    }, 60_000);

    it('CONTROL: retry clears a mismatch once the server publishes the right key', async () => {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.servedOwnKey = makeIdentity(seed).publicKeyEncoded;
        store['e2ee_identity_missing_v1'] = 'mick';
        store['e2ee_identity_missing_reason_v1'] = 'key-mismatch';

        await auth.retryIdentityRestore(PASSWORD);

        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
        expect(auth.identityRestoreReason()).toBeNull();
    }, 60_000);

    // No false lockouts: none of these is a key that differs from ours.
    for (const [label, served] of [
        ['nothing is published (null)', null],
        ['a pre-X25519 value no client could encrypt to', 'p256:BH3rN0tAnX25519KeyAtAllJustSomethingOld='],
        ['an x25519: value of the wrong length', 'x25519:AAAA'],
    ] as const) {
        it(`CONTROL: ${label} — adopted, nothing flagged`, async () => {
            const seed = generateIdentitySeed();
            await accountWith(seed);
            wire.servedOwnKey = served;

            await auth.restoreIdentityAfterLogin('mick', PASSWORD);

            expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
            expect(auth.identityRestoreFailed()).toBe(false);
        }, 60_000);
    }

    it('CONTROL: a lookup that fails is not a mismatch — adopted, nothing flagged', async () => {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.servedOwnKey = () => { throw new Error('502 from the proxy'); };

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
    }, 60_000);
});
