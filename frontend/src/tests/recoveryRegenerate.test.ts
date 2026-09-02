/**
 * "Regenerate recovery code" (auth.ts regenerateRecoveryCode).
 *
 * The rig holds a real v3 custody row for a known seed, built by the same
 * e2ee.ts code the server-side row comes from, so what is asserted is the
 * real crypto: the NEW phrase unwraps the posted blob to the SAME seed, the
 * OLD phrase no longer does, and nothing is written before the password has
 * been proven both locally (seed unwrap) and to the server (the SRP proof,
 * stubbed through the module's test seam because a unit test cannot answer
 * step2 with a valid server proof).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    generateIdentitySeed,
    buildWrapMaterial,
    unwrapSeedWithRecovery,
    unwrapSeedWithPassword,
} from '../api/e2ee';

const wire = vi.hoisted(() => ({
    wrap: null as null | Record<string, unknown>,
    posts: [] as Array<{ url: string; body: unknown }>,
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return {
        ...real,
        apiClient: {
            get: vi.fn(async (url: string) => {
                if (url === '/keys/wrap') return wire.wrap;
                throw new Error('unexpected GET ' + url);
            }),
            post: vi.fn(async (url: string, body: unknown) => {
                wire.posts.push({ url, body });
                return {};
            }),
            delete: vi.fn(),
        },
    };
});

const auth = await import('../api/auth');

const PASSWORD = 'correct horse battery staple';
let seed: Uint8Array;
let oldCode: string;
const proved: string[] = [];

beforeEach(async () => {
    seed = generateIdentitySeed();
    const { material, recoveryCode } = await buildWrapMaterial(seed, PASSWORD);
    oldCode = recoveryCode;
    wire.wrap = {
        key_version: 3,
        wrap_salt: material.wrapSalt,
        seed_wrapped_pw: material.seedWrappedPw,
        pw_kdf_iterations: material.pwKdfIterations,
        pw_kdf: material.pwKdf,
    };
    wire.posts.length = 0;
    proved.length = 0;
    auth.__setProofImplForTest(async (u) => { proved.push(u); });
}, 30_000);
afterEach(() => auth.__setProofImplForTest(null));

describe('regenerateRecoveryCode', () => {
    it('rotates the recovery blob for the SAME seed and posts the whole custody row', async () => {
        const newCode = await auth.regenerateRecoveryCode('mick', PASSWORD);
        expect(newCode.trim().split(/\s+/)).toHaveLength(12);
        expect(newCode).not.toBe(oldCode);

        // The server was asked with the password PROVEN first…
        expect(proved).toEqual(['mick']);
        // …and exactly one write landed, on the proof-gated route.
        expect(wire.posts.map(p => p.url)).toEqual(['/keys/rewrap']);
        const body = wire.posts[0].body as Record<string, string>;
        for (const k of ['wrap_salt', 'recovery_salt', 'seed_wrapped_pw', 'seed_wrapped_rc', 'pw_kdf']) {
            expect(typeof body[k]).toBe('string');
        }

        // The NEW phrase unwraps the posted blob to the identity seed;
        // history stays readable because the seed did not change.
        const viaNew = await unwrapSeedWithRecovery(newCode, body.recovery_salt, body.seed_wrapped_rc);
        expect(viaNew && Buffer.from(viaNew).equals(Buffer.from(seed))).toBe(true);
        // The OLD phrase is retired the instant the row is replaced.
        expect(await unwrapSeedWithRecovery(oldCode, body.recovery_salt, body.seed_wrapped_rc)).toBeNull();
        // The password wrap in the same row still opens with the same password.
        const viaPw = await unwrapSeedWithPassword(PASSWORD, body.wrap_salt, body.seed_wrapped_pw, undefined, 'argon2id');
        expect(viaPw && Buffer.from(viaPw).equals(Buffer.from(seed))).toBe(true);
    }, 60_000);

    it('a wrong password is refused LOCALLY: no SRP exchange, no write', async () => {
        await expect(auth.regenerateRecoveryCode('mick', 'not the password')).rejects.toThrow(/Current password is incorrect/);
        expect(proved).toEqual([]);
        expect(wire.posts).toEqual([]);
    }, 60_000);

    it('a failed server-side proof stops everything before the write', async () => {
        auth.__setProofImplForTest(async () => { throw new Error('srp refused'); });
        await expect(auth.regenerateRecoveryCode('mick', PASSWORD)).rejects.toThrow('srp refused');
        expect(wire.posts).toEqual([]);
    }, 60_000);

    it('an account without v3 custody is told so, and nothing is written', async () => {
        wire.wrap = { key_version: 2, wrap_salt: null, seed_wrapped_pw: null, pw_kdf_iterations: null, pw_kdf: null };
        await expect(auth.regenerateRecoveryCode('mick', PASSWORD)).rejects.toThrow(/not set up for recovery codes/);
        expect(wire.posts).toEqual([]);
    });
});
