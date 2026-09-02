import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { argon2id } from '@noble/hashes/argon2.js';
import kat from '../../tests/fixtures/unattended-ua-kat.json';
import {
    buildUaRecord,
    challengeMessage,
    clearRememberedUaSeeds,
    confirmUaSeed,
    passphraseMatches,
    rememberUaSeed,
    rememberedUaSeed,
    signUaChallenge,
    UA_REMEMBER_MS,
} from './unattended';

/** Which shell this rig plays. The remembered-seed store is written ONLY
 *  inside the native shells, so the web case has to be drivable too. */
let nativeShell = true;
// A fake DPAPI for the desktop path: reversible, so the tests can assert that
// storage holds a sealed form and that recall goes back through the primitive.
vi.mock('../deviceIdentity/deviceKey', async (orig) => ({
    ...(await orig<typeof import('../deviceIdentity/deviceKey')>()),
    invokeTauri: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'ua_seed_protect') return 'SEALED(' + String(args?.seedB64) + ')';
        if (cmd === 'ua_seed_unprotect') {
            const b = String(args?.blobB64);
            if (!b.startsWith('SEALED(')) throw new Error('not a blob sealed here');
            return b.slice(7, -1);
        }
        throw new Error('unexpected command ' + cmd);
    },
}));
const flush = () => new Promise(r => setTimeout(r, 0));
vi.mock('../platform', () => ({
    isTauri: () => nativeShell,
    isMobile: () => false,
}));

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

describe('unattended passphrase — controller side', () => {
    // The cross-language contract. If any of these break, the Rust host
    // (crates/puca-ua) will reject this controller's signatures, so the
    // fixture is the same one crates/puca-ua/tests/kat.rs asserts.
    // Both describes below derive an Ed25519 key from a passphrase for real, at
    // the deliberately slow production cost (measured 1.4-7.3s at 2x CPU
    // oversubscription, versus the 5s default). The derivation is the contract
    // under test — the KAT pins it against the Rust host, and the arming tests
    // turn on a fresh random salt per call — so it cannot be hoisted or cached.
    describe('KAT (shared with the Rust host)', { timeout: 30_000 }, () => {
        const salt = unhex(kat.salt_hex);
        const nonce = unhex(kat.nonce_hex);

        it('frames the challenge message exactly as the host expects', () => {
            expect(hex(challengeMessage(kat.context, nonce))).toBe(kat.message_hex);
        });

        it('derives the same public key from the passphrase', () => {
            const seed = argon2id(new TextEncoder().encode(kat.passphrase), salt, {
                m: kat.argon2.m,
                t: kat.argon2.t,
                p: kat.argon2.p,
                dkLen: kat.argon2.dkLen,
            });
            expect(hex(ed25519.getPublicKey(seed))).toBe(kat.verifying_key_hex);
        });

        it('produces the fixture signature (Ed25519 is deterministic)', () => {
            const sig = signUaChallenge(kat.passphrase, salt, kat.context, nonce);
            expect(hex(sig)).toBe(kat.signature_hex);
        });

        it('the produced signature verifies under the fixture key', () => {
            const sig = signUaChallenge(kat.passphrase, salt, kat.context, nonce);
            expect(ed25519.verify(sig, challengeMessage(kat.context, nonce), unhex(kat.verifying_key_hex))).toBe(true);
        });
    });

    describe('arming and local confirmation', { timeout: 30_000 }, () => {
        it('a record round-trips: the same passphrase matches, a different one does not', () => {
            const record = buildUaRecord('hunter2-correct');
            expect(record.version).toBe(1);
            expect(record.salt).toHaveLength(16);
            expect(record.verifying_key).toHaveLength(32);
            expect(passphraseMatches('hunter2-correct', record)).toBe(true);
            expect(passphraseMatches('hunter2-wrong', record)).toBe(false);
        });

        it('two armings of the same passphrase differ (random salt) yet both match', () => {
            // Distinct salts must yield distinct public keys — otherwise the salt
            // is doing nothing and two users with the same passphrase collide.
            const a = buildUaRecord('same pass');
            const b = buildUaRecord('same pass');
            expect(a.salt).not.toEqual(b.salt);
            expect(a.verifying_key).not.toEqual(b.verifying_key);
            expect(passphraseMatches('same pass', a)).toBe(true);
            expect(passphraseMatches('same pass', b)).toBe(true);
        });

        it('a signature made for one salt does not verify against another record', () => {
            // Proves the salt genuinely binds the derivation: a response derived
            // under record A must fail for record B even with the same passphrase.
            const a = buildUaRecord('pw');
            const b = buildUaRecord('pw');
            const nonce = unhex(kat.nonce_hex);
            const sigA = signUaChallenge('pw', Uint8Array.from(a.salt), 'ctx', nonce);
            expect(
                ed25519.verify(sigA, challengeMessage('ctx', nonce), Uint8Array.from(b.verifying_key)),
            ).toBe(false);
        });
    });

    it('rejects a nonce that is not 32 bytes rather than framing garbage', () => {
        expect(() => challengeMessage('ctx', new Uint8Array(31))).toThrow(/32 bytes/);
    });
});

/**
 * THE REMEMBERED SEED — a signing key in cleartext localStorage (L8-NATIVE-8).
 *
 * What is stored is the Argon2id-stretched Ed25519 SEED, which IS the
 * unattended capability for that host until it is re-armed. These pin the three
 * things that bound it: it is never written outside a native shell, it expires,
 * and it dies when the host's salt changes.
 */
describe('remembering a proved unattended seed', () => {
    const SEED = new Uint8Array(32).fill(5);
    const SALT = 'c2FsdA==';

    /**
     * A REAL localStorage for this file.
     *
     * `src/tests/setup.ts` replaces window.localStorage with bare `vi.fn()`s
     * that store nothing and return `undefined` — so a test written against it
     * would assert "nothing was stored" in a world where nothing CAN be
     * stored, and would pass just as happily with the native-shell gate
     * deleted. Backing it with a Map is what makes the assertions mean
     * something.
     */
    const store = new Map<string, string>();
    beforeEach(() => {
        store.clear();
        const ls = localStorage as unknown as {
            getItem: Mock; setItem: Mock; removeItem: Mock;
        };
        ls.getItem.mockImplementation((k: string) => store.get(k) ?? null);
        ls.setItem.mockImplementation((k: string, v: string) => { store.set(k, v); });
        ls.removeItem.mockImplementation((k: string) => { store.delete(k); });
        nativeShell = true;
        clearRememberedUaSeeds();
    });

    afterEach(() => {
        const ls = localStorage as unknown as {
            getItem: Mock; setItem: Mock; removeItem: Mock;
        };
        ls.getItem.mockReset();
        ls.setItem.mockReset();
        ls.removeItem.mockReset();
    });

    it('is NOT written in a shared browser', async () => {
        // A later user of the same profile would otherwise hold unattended
        // control of someone else's machine.
        nativeShell = false;
        rememberUaSeed('dev-host', SALT, SEED);
        expect(await rememberedUaSeed('dev-host', SALT)).toBeNull();
        expect(
            localStorage.getItem('sovereign-ua-remember'),
            'nothing at all may be written outside a native shell',
        ).toBeNull();

        // POSITIVE CONTROL: the same call in a native shell DOES write, so the
        // assertion above is about the shell and not about a broken rig.
        nativeShell = true;
        rememberUaSeed('dev-host', SALT, SEED); await flush();
        expect(await rememberedUaSeed('dev-host', SALT)).toEqual(SEED);
        // ...and what the desktop stores is the SEALED form, never the seed itself.
        const stored = JSON.parse(String(localStorage.setItem.mock.calls.at(-1)?.[1] ?? '{}')) as Record<string, { seed?: string }>;
        expect(stored['dev-host']?.seed?.startsWith('dpapi:')).toBe(true);
    });

    it('lives for seven days, not thirty, and the expiry slides on use', async () => {
        // The TTL is client-side housekeeping rather than a security bound, but
        // a month is a long time for a cleartext signing key to sit unused. It
        // costs an active user nothing because confirmUaSeed renews it.
        expect(UA_REMEMBER_MS).toBe(7 * 24 * 60 * 60 * 1000);

        const t0 = 1_700_000_000_000;
        rememberUaSeed('dev-host', SALT, SEED, t0); await flush();
        expect(await rememberedUaSeed('dev-host', SALT, t0 + UA_REMEMBER_MS - 1)).toEqual(SEED);
        expect(await rememberedUaSeed('dev-host', SALT, t0 + UA_REMEMBER_MS)).toBeNull();

        // Sliding: a host that accepted the signature renews the entry.
        rememberUaSeed('dev-host', SALT, SEED, t0); await flush();
        confirmUaSeed('dev-host', t0 + UA_REMEMBER_MS - 1);
        expect(
            await rememberedUaSeed('dev-host', SALT, t0 + UA_REMEMBER_MS + 1),
            'an actively used machine never notices the shorter window',
        ).toEqual(SEED);
    });
});
