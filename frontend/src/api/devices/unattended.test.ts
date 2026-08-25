import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { argon2id } from '@noble/hashes/argon2.js';
import kat from '../../tests/fixtures/unattended-ua-kat.json';
import {
    buildUaRecord,
    challengeMessage,
    passphraseMatches,
    signUaChallenge,
} from './unattended';

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
