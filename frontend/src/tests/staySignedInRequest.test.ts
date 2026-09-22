// @vitest-environment jsdom
/**
 * "Stay signed in on this device" on the WIRE: `login()` asks for a long
 * session by putting `stay_signed_in: true` in the step-2 body, and asks for
 * nothing when it was not told to.
 *
 * The negative case is the one that matters and it is asserted on the KEY, not
 * on its value: a body carrying `stay_signed_in: false` would be harmless
 * against the new server (serde reads it as false) but it is not what an
 * ordinary sign-in has ever sent, and "absent unless asked" is what lets this
 * client ship before the backend does. `toHaveProperty` would pass on an
 * explicit `false`; `'stay_signed_in' in body` does not.
 *
 * Like authSrpV2.test.ts, this runs the REAL exchange against a fake server
 * that performs the server's half of SRP-6a with the client's own primitives —
 * the only way to answer step 2 with an M2 the client will accept, and the
 * only way to reach the step-2 body at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const wire = { posts: [] as Array<{ url: string; body: Record<string, unknown> }> };

vi.mock('../api/client', () => ({
    apiClient: {
        post: vi.fn(async (url: string, body: Record<string, unknown>) => {
            wire.posts.push({ url, body });
            return fakeServer.handle(url, body);
        }),
        // login() restores the E2EE identity after the exchange; a failure
        // there is swallowed by design (the session stays), so no test here
        // depends on wrap material.
        get: vi.fn(async () => { throw new Error('offline: no wrap material in this test'); }),
        patch: vi.fn(async () => ({})),
        delete: vi.fn(async () => ({})),
    },
}));

import { login, __testing as T } from '../api/auth';

type Account = { salt: Uint8Array; v: bigint };
type Attempt = { A: bigint; B: bigint; b: bigint; user: string };

const fakeServer = {
    users: new Map<string, Account>(),
    attempts: new Map<string, Attempt>(),
    n: 0,
    reset() { this.users.clear(); this.attempts.clear(); this.n = 0; },
    async handle(url: string, body: Record<string, unknown>): Promise<unknown> {
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
            return {
                salt_hex: T.bytesToHex(acct.salt),
                b_pub_hex: T.bigIntToPaddedHex(B, T.N_BYTES),
                attempt_id,
                srp_version: T.SRP_VERSION_CURRENT,
            };
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
            const M2 = await T.computeM2(at.A, M1, K);
            return { hamk_hex: T.bytesToHex(M2), token: `tok-${this.n}` };
        }
        throw new Error(`unexpected POST ${url}`);
    },
};

/** An account exactly as a current registration leaves it. */
async function seed(username: string, password: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const x = await T.computeXFor(T.SRP_VERSION_CURRENT, salt, username, password);
    fakeServer.users.set(username.toLowerCase(), { salt, v: T.computeVerifier(x) });
}

const step2Body = () => {
    const bodies = wire.posts.filter(p => p.url === '/auth/login/step2').map(p => p.body);
    expect(bodies).toHaveLength(1); // a test that never reached step 2 proves nothing
    return bodies[0];
};

describe('login(): the long-session request', { timeout: 60_000 }, () => {
    beforeEach(() => { fakeServer.reset(); wire.posts.length = 0; localStorage.clear(); });
    afterEach(() => { vi.clearAllMocks(); });

    it('asks for a long session when told to', async () => {
        await seed('stayer', 'Password123!');
        await login('stayer', 'Password123!', { staySignedIn: true });
        expect(step2Body().stay_signed_in).toBe(true);
    });

    it('sends NO stay_signed_in field at all for an ordinary sign-in', async () => {
        await seed('visitor', 'Password123!');
        await login('visitor', 'Password123!');
        expect('stay_signed_in' in step2Body()).toBe(false);
    });

    it('and none when the option is present but false', async () => {
        // The Notes form passes the checkbox straight through, so `false`
        // reaches here on every unticked sign-in. It must produce the same
        // body as no option at all — not a `false` on the wire.
        await seed('untick', 'Password123!');
        await login('untick', 'Password123!', { staySignedIn: false });
        expect('stay_signed_in' in step2Body()).toBe(false);
    });

    it('changes nothing else about the body', async () => {
        // The long session is one added key. If asking for it perturbed the
        // proof, the username or the attempt id, the fake server would have
        // refused the login above — but pin the shape too, so a future
        // "while we are here" edit to this body has to be deliberate.
        await seed('shape', 'Password123!');
        await login('shape', 'Password123!', { staySignedIn: true });
        expect(Object.keys(step2Body()).sort()).toEqual(['attempt_id', 'm_hex', 'stay_signed_in', 'username']);
    });
});
