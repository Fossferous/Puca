// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The SRP verifier derivation upgrade (srp_version, migration 059).
 *
 * Every flow test runs the REAL client exchange — register(), login() — against
 * a fake server that performs the server's half of SRP-6a with the client's
 * own primitives. That is the only way to answer step 2 with a proof the
 * client will accept, and it is what the earlier draft of this suite did not
 * do: it never called login(), so the one path that matters — an existing
 * SHA-256 account still opening, and being upgraded — had no coverage at all.
 *
 * These are tests of the FLOW, not of cross-language agreement. The v1
 * derivation is proven by production; v2 is only ever computed client-side,
 * so "consistent with itself" is the whole contract — and the known-answer
 * block at the bottom pins both derivations so a silent change to either
 * cannot pass here while stranding every affected account.
 */

const wire = {
    posts: [] as Array<{ url: string; body: Record<string, unknown> }>,
};

vi.mock('../api/client', () => ({
    apiClient: {
        post: vi.fn(async (url: string, body: Record<string, unknown>) => {
            wire.posts.push({ url, body });
            return fakeServer.handle(url, body);
        }),
        // login() restores the E2EE identity after the exchange; a failure
        // there is swallowed by design (the session stays). Fail it here so no
        // test depends on wrap material.
        get: vi.fn(async () => { throw new Error('offline: no wrap material in this test'); }),
        patch: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
    },
}));

import { login, register, generateVerifierForReset, __testing as T } from '../api/auth';

type Account = { salt: Uint8Array; v: bigint; srp_version: number };
type Attempt = { A: bigint; B: bigint; b: bigint; user: string };

/** The server's half of SRP-6a, plus exactly the srp_version behaviour the
 *  real server has: unknown field omitted → 1; upgrade material applied only
 *  after the proof verifies, and only to a v1 row. */
const fakeServer = {
    users: new Map<string, Account>(),
    attempts: new Map<string, Attempt>(),
    n: 0,
    /** Pretend to be a server that predates migration 059 (no srp_version in step 1). */
    legacyServer: false,
    reset() { this.users.clear(); this.attempts.clear(); this.n = 0; this.legacyServer = false; },
    async handle(url: string, body: Record<string, unknown>): Promise<unknown> {
        if (url === '/auth/register') {
            this.users.set(String(body.username).toLowerCase(), {
                salt: T.hexToBytes(String(body.salt_hex)),
                v: T.hexToBigInt(String(body.verifier_hex)),
                srp_version: typeof body.srp_version === 'number' ? body.srp_version : 1,
            });
            return {};
        }
        if (url === '/auth/login/step1') {
            const name = String(body.username).toLowerCase();
            const acct = this.users.get(name);
            if (!acct) throw new Error('401');
            const A = T.hexToBigInt(String(body.a_pub_hex));
            const b = BigInt('0x' + T.bytesToHex(crypto.getRandomValues(new Uint8Array(32))));
            const k = await T.getK();
            const B = (k * acct.v + T.modPowPublic(T.g, b, T.N)) % T.N;
            const attempt_id = `att-${++this.n}`;
            this.attempts.set(attempt_id, { A, B, b, user: name });
            const res: Record<string, unknown> = { salt_hex: T.bytesToHex(acct.salt), b_pub_hex: T.bigIntToPaddedHex(B, T.N_BYTES), attempt_id };
            if (!this.legacyServer) res.srp_version = acct.srp_version;
            return res;
        }
        if (url === '/auth/login/step2') {
            const at = this.attempts.get(String(body.attempt_id));
            if (!at) throw new Error('401: no attempt');
            const acct = this.users.get(at.user)!;
            const u = await T.computeU(at.A, at.B);
            const S = T.modPowPublic((at.A * T.modPowPublic(acct.v, u, T.N)) % T.N, at.b, T.N);
            const K = T.bigIntToMinimalBytes(S);
            const M1 = await T.computeM1(at.A, at.B, K);
            if (T.bytesToHex(M1) !== String(body.m_hex).toLowerCase()) throw new Error('401: bad proof');
            if (acct.srp_version === 1 && typeof body.new_salt_hex === 'string' && typeof body.new_verifier_hex === 'string') {
                acct.salt = T.hexToBytes(body.new_salt_hex);
                acct.v = T.hexToBigInt(body.new_verifier_hex);
                acct.srp_version = 2;
            }
            const M2 = await T.computeM2(at.A, M1, K);
            return { hamk_hex: T.bytesToHex(M2), token: `tok-${this.n}` };
        }
        throw new Error(`unexpected POST ${url}`);
    },
};

/** An account exactly as every pre-0.9.3 registration left it. */
async function seedLegacy(username: string, password: string): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const x = await T.computeX(salt, await T.computeIdentityHash(username, password));
    fakeServer.users.set(username.toLowerCase(), { salt, v: T.computeVerifier(x), srp_version: 1 });
    return salt;
}

const step2Bodies = () => wire.posts.filter(p => p.url === '/auth/login/step2').map(p => p.body);

describe('SRP verifier derivation (srp_version)', { timeout: 60_000 }, () => {
    beforeEach(() => { fakeServer.reset(); wire.posts.length = 0; localStorage.clear(); });
    afterEach(() => { vi.clearAllMocks(); });

    it('register derives the verifier with Argon2id and declares srp_version 2', async () => {
        await register('Alice', 'correct horse battery staple');
        const reg = wire.posts.find(p => p.url === '/auth/register')!.body;
        expect(reg.srp_version).toBe(2);
        const acct = fakeServer.users.get('alice')!;
        expect(acct.srp_version).toBe(2);
        // Recomputed independently: the stored v is g^x for the ARGON2 x...
        expect(acct.v).toBe(T.computeVerifier(T.computeXv2(acct.salt, 'Alice', 'correct horse battery staple')));
        // ...and not for the SHA-256 x. POSITIVE CONTROL: the derivations differ,
        // so the line above cannot pass by both sides computing v1.
        const x1 = await T.computeX(acct.salt, await T.computeIdentityHash('Alice', 'correct horse battery staple'));
        expect(acct.v).not.toBe(T.computeVerifier(x1));
    });

    it('an account created before 0.9.3 (SHA-256) still logs in, and is upgraded in that same exchange', async () => {
        // Would go red if: computeXFor ignored the version (M1 mismatch), or the
        // upgrade material were missing from step 2, or it were sent under the
        // wrong salt.
        const oldSalt = await seedLegacy('bob', 'hunter2hunter2');
        await expect(login('bob', 'hunter2hunter2')).resolves.toMatch(/^tok-/);
        const [s2] = step2Bodies();
        expect(typeof s2.new_salt_hex).toBe('string');
        expect(typeof s2.new_verifier_hex).toBe('string');
        const acct = fakeServer.users.get('bob')!;
        expect(acct.srp_version).toBe(2);
        expect(T.bytesToHex(acct.salt)).not.toBe(T.bytesToHex(oldSalt));
        expect(acct.v).toBe(T.computeVerifier(T.computeXv2(acct.salt, 'bob', 'hunter2hunter2')));
    });

    it('after the upgrade the account logs in via Argon2id and sends no upgrade material', async () => {
        await seedLegacy('carol', 'pw-carol-pw');
        await login('carol', 'pw-carol-pw');
        wire.posts.length = 0;
        await expect(login('carol', 'pw-carol-pw')).resolves.toMatch(/^tok-/);
        const [s2] = step2Bodies();
        expect(s2.new_salt_hex).toBeUndefined();
        expect(s2.new_verifier_hex).toBeUndefined();
        expect(fakeServer.users.get('carol')!.srp_version).toBe(2);
    });

    it('a wrong password fails a v1 login WITHOUT touching the row: the upgrade rides only a verified proof', async () => {
        const salt = await seedLegacy('dave', 'right-password');
        await expect(login('dave', 'wrong-password')).rejects.toThrow();
        const acct = fakeServer.users.get('dave')!;
        expect(acct.srp_version).toBe(1);
        expect(T.bytesToHex(acct.salt)).toBe(T.bytesToHex(salt));
    });

    it('username case does not change the derivation: registered as "Erin", signs in as "ERIN"', async () => {
        await register('Erin', 'erin-pass-word');
        wire.posts.length = 0;
        await expect(login('ERIN', 'erin-pass-word')).resolves.toMatch(/^tok-/);
    });

    it('a server that predates migration 059 (no srp_version in step 1) is treated as SHA-256', async () => {
        await seedLegacy('frank', 'frank-pass-word');
        fakeServer.legacyServer = true;
        await expect(login('frank', 'frank-pass-word')).resolves.toMatch(/^tok-/);
        // It still offered the upgrade; an old server ignores unknown fields.
        expect(typeof step2Bodies()[0].new_verifier_hex).toBe('string');
    });

    it('refuses a derivation this build does not know rather than guessing SHA-256', async () => {
        await seedLegacy('grace', 'grace-pass-word');
        fakeServer.users.get('grace')!.srp_version = 3;
        await expect(login('grace', 'grace-pass-word')).rejects.toThrow(/update the app/);
        expect(step2Bodies()).toHaveLength(0);
    });

    it('a password change or reset declares srp_version 2 with the verifier it sends', async () => {
        const { salt, verifier, srp_version } = await generateVerifierForReset('Heidi', 'new-pass-word');
        expect(srp_version).toBe(2);
        expect(T.hexToBigInt(verifier)).toBe(T.computeVerifier(T.computeXv2(T.hexToBytes(salt), 'Heidi', 'new-pass-word')));
    });
});

describe('the derivations are pinned (known-answer)', () => {
    // A silent change to either — the Argon2 cost, the salt layout, the
    // lowercasing — would make every affected account unopenable while every
    // flow test above still passed, because those only check that the client
    // agrees with itself. Computed once; must never move.
    const salt = Uint8Array.from({ length: 32 }, (_, i) => i);

    it('v1: x = SHA-256(salt ‖ SHA-256("alice:correct horse battery staple"))', async () => {
        const x = await T.computeX(salt, await T.computeIdentityHash('Alice', 'correct horse battery staple'));
        expect(x.toString(16)).toBe(KAT_V1);
    });

    it('v2: x = Argon2id(password, salt ‖ "alice"; m=19456, t=2, p=1)', () => {
        const x = T.computeXv2(salt, 'Alice', 'correct horse battery staple');
        expect(x.toString(16)).toBe(KAT_V2);
    });
});

// Filled from an independent computation (node + @noble/hashes / node:crypto),
// not from running the code under test.
const KAT_V1 = '7e82e23a6e00d6a27953523ad8b68896a850b1224b894542f1722ac9d23a913a';
const KAT_V2 = '2835469d7fe7d7441e39584814277ffda861bd7973cda88bc1ccdd100125e83f';
