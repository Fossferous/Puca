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
 * key for this account (new contacts pin it; their DMs and calls go to it),
 * the account's own devices could not tell.
 *
 * THE SECOND REVIEW. The first fix adopted the seed whenever the answer was
 * anything but a different well-formed key: no key, a malformed one, a 404.
 * But the server can answer THIS request differently from the one other
 * clients make, so each of those let it skip the check. Only an account with
 * a v3 seed reaches it, and an honest server always publishes that seed's
 * key, so every definite answer that is not our key is now a mismatch; a
 * first 404 is read again (the endpoint also answers 404 when its own lookup
 * fails). No answer at all — offline, a 5xx — still signs in, and the check
 * is OWED: done at the next start or channel-key mint, not forgotten.
 *
 * The controls are what the owner asked for: no existing user is locked out
 * by a FALSE mismatch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateIdentitySeed, buildWrapMaterial, makeIdentity, getActiveIdentity, clearActiveIdentity, setActiveIdentity } from '../api/e2ee';

type Answer = string | null | (() => never) | { raw: unknown };
const wire = vi.hoisted(() => ({
    wrap: null as null | Record<string, unknown>,
    /** What /users/:id/public-key answers for the signed-in account, one per
     *  request (the last repeats): a key or null as the endpoint's JSON, a
     *  function to fail the request, `{ raw }` for a body that is not it. */
    answers: [] as unknown[],
    gets: [] as string[],
}));
const NOT_FOUND = vi.hoisted(() => ({ make: null as null | (() => never) }));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    NOT_FOUND.make = () => { throw new real.ApiError('User not found', 404); };
    return {
        ...real,
        apiClient: {
            get: vi.fn(async (url: string) => {
                wire.gets.push(url);
                if (url === '/keys/wrap') return wire.wrap;
                if (/^\/users\/\d+\/public-key$/.test(url)) {
                    const a = (wire.answers.length > 1 ? wire.answers.shift() : wire.answers[0]) as Answer;
                    if (typeof a === 'function') return a();
                    if (a && typeof a === 'object' && 'raw' in a) return a.raw;
                    return { user_id: 1, public_key: a ?? null };
                }
                throw new Error('unexpected GET ' + url);
            }),
            post: vi.fn(async () => ({})),
            delete: vi.fn(),
        },
    };
});

const auth = await import('../api/auth');
const notFound = (): never => NOT_FOUND.make!();
const badGateway = (): never => { throw new Error('502 from the proxy'); };

// setup.ts replaces localStorage with vi.fn() stubs; back them with a store.
function backingStore() {
    const store: Record<string, string> = {};
    vi.mocked(window.localStorage.getItem).mockImplementation((k: string) => (k in store ? store[k] : null));
    vi.mocked(window.localStorage.setItem).mockImplementation((k: string, v: string) => { store[k] = v; });
    vi.mocked(window.localStorage.removeItem).mockImplementation((k: string) => { delete store[k]; });
    return store;
}

/** An unsigned token whose payload names account `sub` — enough for the
 *  client's own `sub` reads (the server verifies tokens; the client only decodes). */
function tokenFor(sub: number): string {
    const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url(JSON.stringify({ sub, username: 'mick' }))}.sig`;
}

const PASSWORD = 'hunter2hunter2';
const OWED = 'e2ee_own_key_check_owed_v1';
let store: Record<string, string>;

/** A v3 account whose password unwraps `seed`. */
async function accountWith(seed: Uint8Array) {
    const { material } = await buildWrapMaterial(seed, PASSWORD);
    wire.wrap = { key_version: 3, wrap_salt: material.wrapSalt, seed_wrapped_pw: material.seedWrappedPw, pw_kdf_iterations: material.pwKdfIterations, pw_kdf: material.pwKdf };
}
const ownKeyReads = () => wire.gets.filter((u) => u === '/users/1/public-key').length;
const otherKey = () => makeIdentity(generateIdentitySeed()).publicKeyEncoded;

beforeEach(() => {
    store = backingStore();
    store['auth_token'] = tokenFor(1);
    wire.gets = [];
    wire.answers = [null];
    clearActiveIdentity();
});

describe('restoreIdentityAfterLogin checks the identity key the server publishes for you', () => {
    it('SECURITY: a served key that is not the seed\'s stops the restore, and says why', async () => {
        await accountWith(generateIdentitySeed());
        // The server tells everyone else this account's key is some OTHER key.
        wire.answers = [otherKey()];

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(ownKeyReads(), 'the served key was never asked for').toBe(1);
        expect(getActiveIdentity(), 'a key the server does not publish for us was adopted').toBeNull();
        expect(auth.identityRestoreFailed()).toBe(true);
        expect(auth.identityRestoreReason()).toBe('key-mismatch');
    }, 60_000);

    it('SECURITY: a seed cached by an earlier session does not stand in for the refused one', async () => {
        const seed = generateIdentitySeed();
        setActiveIdentity(makeIdentity(seed)); // this device's earlier session
        await accountWith(seed);
        wire.answers = [otherKey()];

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(getActiveIdentity()).toBeNull();
    }, 60_000);

    it('SECURITY: retrying with the password refuses it too, and says so', async () => {
        await accountWith(generateIdentitySeed());
        wire.answers = [otherKey()];
        store['e2ee_identity_missing_v1'] = 'mick';

        await expect(auth.retryIdentityRestore(PASSWORD)).rejects.toThrow(/not the one this server publishes/);
        expect(getActiveIdentity()).toBeNull();
        expect(auth.identityRestoreReason()).toBe('key-mismatch');
    }, 60_000);

    // The server answering THIS request with something unusable must not be a
    // way past the check: every one of these is a definite answer that is not
    // our key, for an account an honest server always publishes a key for.
    for (const [label, answers] of [
        ['no key at all (null)', [null]],
        ['a value in another format', ['p256:BH3rN0tAnX25519KeyAtAllJustSomethingOld=']],
        ['an x25519: value of the wrong length', ['x25519:AAAA']],
        ['"not found", twice', [notFound]],
    ] as const) {
        it(`SECURITY: ${label} stops the restore`, async () => {
            await accountWith(generateIdentitySeed());
            wire.answers = [...answers];

            await auth.restoreIdentityAfterLogin('mick', PASSWORD);

            expect(getActiveIdentity(), 'adopted on an answer that is not our key').toBeNull();
            expect(auth.identityRestoreReason()).toBe('key-mismatch');
        }, 60_000);
    }

    it('CONTROL: the key it publishes IS the seed\'s — adopted, nothing flagged, nothing owed', async () => {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.answers = [makeIdentity(seed).publicKeyEncoded];

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(ownKeyReads()).toBe(1);
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
        expect(store[OWED]).toBeUndefined();
    }, 60_000);

    it('CONTROL: retry clears a mismatch once the server publishes the right key', async () => {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.answers = [makeIdentity(seed).publicKeyEncoded];
        store['e2ee_identity_missing_v1'] = 'mick';
        store['e2ee_identity_missing_reason_v1'] = 'key-mismatch';

        await auth.retryIdentityRestore(PASSWORD);

        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
        expect(auth.identityRestoreReason()).toBeNull();
    }, 60_000);

    it('CONTROL: one 404 is read again (the endpoint answers 404 when its own lookup fails) — the right key then signs in', async () => {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.answers = [notFound, makeIdentity(seed).publicKeyEncoded];

        await auth.restoreIdentityAfterLogin('mick', PASSWORD);

        expect(ownKeyReads()).toBe(2);
        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
    }, 60_000);

    // No answer from the endpoint is not evidence of anything: signed in,
    // nothing flagged, and the check is owed.
    for (const [label, answer] of [
        ['a lookup that fails (a 502 from a proxy)', badGateway],
        ['a body that is not the endpoint\'s JSON (a portal page)', { raw: '<html>sign in to the wifi</html>' }],
    ] as const) {
        it(`CONTROL: ${label} — adopted, nothing flagged, and the check is owed`, async () => {
            const seed = generateIdentitySeed();
            await accountWith(seed);
            wire.answers = [answer];

            await auth.restoreIdentityAfterLogin('mick', PASSWORD);

            expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
            expect(auth.identityRestoreFailed()).toBe(false);
            expect(store[OWED], 'a check with no answer was forgotten').toBe('1');
        }, 60_000);
    }
});

describe('an own-key check that got no answer is done later, not forgotten', () => {
    async function signedInUnchecked() {
        const seed = generateIdentitySeed();
        await accountWith(seed);
        wire.answers = [badGateway];
        await auth.restoreIdentityAfterLogin('mick', PASSWORD);
        expect(store[OWED]).toBe('1');
        wire.gets = [];
        return seed;
    }

    it('SECURITY: the next check meets a key that is not ours — the identity is put away, and the banner says why', async () => {
        await signedInUnchecked();
        wire.answers = [otherKey()];

        expect(await auth.settleOwedOwnKeyCheck()).toBe(false);

        expect(getActiveIdentity()).toBeNull();
        expect(auth.identityRestoreReason()).toBe('key-mismatch');
        expect(store[OWED]).toBeUndefined();
    }, 60_000);

    it('CONTROL: the next check meets our key — kept, and nothing is owed any more', async () => {
        const seed = await signedInUnchecked();
        wire.answers = [makeIdentity(seed).publicKeyEncoded];

        expect(await auth.settleOwedOwnKeyCheck()).toBe(true);

        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(auth.identityRestoreFailed()).toBe(false);
        expect(store[OWED]).toBeUndefined();
    }, 60_000);

    it('CONTROL: still no answer — kept, and still owed', async () => {
        const seed = await signedInUnchecked();
        wire.answers = [badGateway];

        expect(await auth.settleOwedOwnKeyCheck()).toBe(true);

        expect(getActiveIdentity()?.publicKeyEncoded).toBe(makeIdentity(seed).publicKeyEncoded);
        expect(store[OWED]).toBe('1');
    }, 60_000);

    it('CONTROL: nothing owed sends nothing; a check owed to another account is dropped unasked', async () => {
        setActiveIdentity(makeIdentity(generateIdentitySeed()));
        expect(await auth.settleOwedOwnKeyCheck()).toBe(true);
        store[OWED] = '2'; // signed in here now: account 1
        expect(await auth.settleOwedOwnKeyCheck()).toBe(true);
        expect(ownKeyReads()).toBe(0);
        expect(store[OWED]).toBeUndefined();
    });
});
