/**
 * v3 recoverable key-custody crypto tests.
 *
 * The server side of the DH proof is re-derived here FROM SCRATCH (independent
 * of e2ee.ts internals), so any drift in the client construction — wrong DH
 * direction, wrong HKDF info, wrong HMAC message order — fails these tests.
 */
import { describe, it, expect } from 'vitest';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import {
    generateIdentitySeed,
    generateRecoveryCode,
    recoveryCodeEntropy,
    makeIdentity,
    buildWrapMaterial,
    unwrapSeedWithPassword,
    unwrapSeedWithRecovery,
    rewrapForNewPassword,
    passwordWrapNeedsUpgrade,
    upgradePasswordWrap,
    __wrapSeedPbkdf2ForTest,
    computeRecoveryProof,
    encodePublicKey,
    decodePublicKey,
    encryptDM,
    decryptDM,
    wrapChannelKeyForMembers,
    unwrapChannelKey,
    generateChannelKey,
} from '../api/e2ee';

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// The three describes below wrap and unwrap seeds for real: Argon2id, or
// PBKDF2 at the 600k-iteration wrap count. Unlike the identity fixtures in
// e2ee.test.ts these cannot be hoisted into a beforeAll — every wrap mints a
// fresh random salt, and the round-trip through that salt IS what is being
// tested. Measured 1.6-5.9s at 2x CPU oversubscription, so the 5s default was
// a coin flip. Give them headroom; the assertions are untouched and a genuine
// hang still fails.
describe('v3 recovery: seed wrapping', { timeout: 30_000 }, () => {
    it('round-trips the seed through the password blob', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, 'hunter2');
        const got = await unwrapSeedWithPassword('hunter2', material.wrapSalt, material.seedWrappedPw, material.pwKdfIterations, material.pwKdf);
        expect(got).not.toBeNull();
        expect(eq(got!, seed)).toBe(true);
    });

    it('round-trips the seed through the recovery blob', async () => {
        const seed = generateIdentitySeed();
        const { material, recoveryCode } = await buildWrapMaterial(seed, 'hunter2');
        const got = await unwrapSeedWithRecovery(recoveryCode, material.recoverySalt, material.seedWrappedRc);
        expect(got).not.toBeNull();
        expect(eq(got!, seed)).toBe(true);
    });

    it('fails closed on the wrong password', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, 'correct');
        expect(await unwrapSeedWithPassword('WRONG', material.wrapSalt, material.seedWrappedPw, material.pwKdfIterations, material.pwKdf)).toBeNull();
    });

    it('fails closed on the wrong recovery code', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, 'pw');
        const other = generateRecoveryCode();
        expect(await unwrapSeedWithRecovery(other, material.recoverySalt, material.seedWrappedRc)).toBeNull();
    });

    it('rejects an invalid recovery mnemonic (bad checksum / not words)', async () => {
        expect(recoveryCodeEntropy('not a real bip39 phrase at all zzz zzz zzz zzz')).toBeNull();
        expect(recoveryCodeEntropy('')).toBeNull();
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, 'pw');
        expect(await unwrapSeedWithRecovery('totally invalid words here', material.recoverySalt, material.seedWrappedRc)).toBeNull();
    });

    it('normalizes casing/whitespace in the recovery code', async () => {
        const seed = generateIdentitySeed();
        const { material, recoveryCode } = await buildWrapMaterial(seed, 'pw');
        const messy = '  ' + recoveryCode.toUpperCase().replace(/ /g, '   ') + '  ';
        const got = await unwrapSeedWithRecovery(messy, material.recoverySalt, material.seedWrappedRc);
        expect(got).not.toBeNull();
        expect(eq(got!, seed)).toBe(true);
    });

    it('generates a 12-word valid recovery phrase', () => {
        const code = generateRecoveryCode();
        expect(code.trim().split(/\s+/).length).toBe(12);
        expect(recoveryCodeEntropy(code)).not.toBeNull();
    });
});

describe('v3 recovery: password change preserves the identity', { timeout: 30_000 }, () => {
    it('same seed + same public key after a reset, recoverable with the new password', async () => {
        const seed = generateIdentitySeed();
        const pub0 = makeIdentity(seed).publicKeyEncoded;

        // Build under old password, then simulate: forgot password -> recover via code -> re-wrap under new password.
        const { material, recoveryCode } = await buildWrapMaterial(seed, 'oldpass');
        const recovered = await unwrapSeedWithRecovery(recoveryCode, material.recoverySalt, material.seedWrappedRc);
        expect(recovered).not.toBeNull();

        const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(recovered!, 'newpass');
        const afterReset = await unwrapSeedWithPassword('newpass', wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf);

        expect(afterReset).not.toBeNull();
        expect(eq(afterReset!, seed)).toBe(true);
        expect(makeIdentity(afterReset!).publicKeyEncoded).toBe(pub0); // identity unchanged
    });

    it('real DM history survives a reset (same keys decrypt)', async () => {
        // Alice (will reset) and Bob.
        const aliceSeed = generateIdentitySeed();
        const bob = makeIdentity(generateIdentitySeed());
        const aliceBefore = makeIdentity(aliceSeed);

        // Bob sends Alice a DM under Alice's pre-reset identity.
        const env = await encryptDM(bob, aliceBefore.publicKeyEncoded, 'secret history', { senderId: 2, recipientId: 1 });
        expect(env).not.toBeNull();

        // Alice resets her password (recover seed via code, re-wrap under new pw).
        const { material, recoveryCode } = await buildWrapMaterial(aliceSeed, 'old');
        const recovered = await unwrapSeedWithRecovery(recoveryCode, material.recoverySalt, material.seedWrappedRc);
        const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(recovered!, 'new');
        const aliceAfterSeed = await unwrapSeedWithPassword('new', wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf);
        const aliceAfter = makeIdentity(aliceAfterSeed!);

        // The post-reset identity still decrypts the pre-reset message.
        const pt = await decryptDM(aliceAfter, bob.publicKeyEncoded, env!, { senderId: 2, recipientId: 1 });
        expect(pt).toBe('secret history');
    });

    it('channel key wrapped to the pre-reset identity still unwraps after reset', async () => {
        const distributor = makeIdentity(generateIdentitySeed());
        const memberSeed = generateIdentitySeed();
        const memberBefore = makeIdentity(memberSeed);
        const ck = generateChannelKey();

        const wrapped = await wrapChannelKeyForMembers(distributor, ck, [
            { userId: 1, publicKey: memberBefore.publicKeyEncoded },
        ]);
        expect(wrapped.length).toBe(1);

        // Member resets password; seed (and pubkey) unchanged.
        const { material, recoveryCode } = await buildWrapMaterial(memberSeed, 'old');
        const seed = await unwrapSeedWithRecovery(recoveryCode, material.recoverySalt, material.seedWrappedRc);
        const { wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf } = await rewrapForNewPassword(seed!, 'new');
        const after = makeIdentity((await unwrapSeedWithPassword('new', wrapSalt, seedWrappedPw, pwKdfIterations, pwKdf))!);

        const unwrapped = await unwrapChannelKey(after, wrapped[0]);
        expect(unwrapped).not.toBeNull();
        expect(eq(unwrapped!, ck)).toBe(true);
    });
});

describe('v3 recovery: versioned password-wrap KDF', { timeout: 30_000 }, () => {
    it('native WebCrypto PBKDF2 == pure-JS PBKDF2 (blobs made by old clients still unwrap)', async () => {
        // The KEK derivation moved from noble (pure JS) to crypto.subtle for speed.
        // If the two disagreed, every existing 210k blob would fail to unwrap on
        // upgrade. Prove byte-for-byte equality for the same params.
        const secret = new TextEncoder().encode('correct horse battery staple');
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iters = 210_000;
        const jsKek = pbkdf2(sha256, secret, salt, { c: iters, dkLen: 32 });
        const material = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits']);
        const nativeBits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' }, material, 256,
        );
        expect(eq(new Uint8Array(nativeBits), jsKek)).toBe(true);
    });

    it('new wrap material uses Argon2id (the current KDF)', async () => {
        const { material } = await buildWrapMaterial(generateIdentitySeed(), 'pw');
        expect(material.pwKdf).toBe('argon2id');
    });

    it('argon2id round-trip: right password recovers, wrong password fails', async () => {
        const seed = generateIdentitySeed();
        const { material } = await buildWrapMaterial(seed, 'pw');
        const ok = await unwrapSeedWithPassword('pw', material.wrapSalt, material.seedWrappedPw, material.pwKdfIterations, material.pwKdf);
        expect(ok).not.toBeNull();
        expect(eq(ok!, seed)).toBe(true);
        const bad = await unwrapSeedWithPassword('WRONG', material.wrapSalt, material.seedWrappedPw, material.pwKdfIterations, material.pwKdf);
        expect(bad).toBeNull();
    });

    it('BACKWARD COMPAT: a legacy PBKDF2 blob still unwraps (existing accounts keep working)', async () => {
        // Shaped exactly like a pre-argon2 account's stored blob.
        const seed = generateIdentitySeed();
        const legacy = await __wrapSeedPbkdf2ForTest(seed, 'pw', 210_000);
        // Explicit pbkdf2 algo:
        const got = await unwrapSeedWithPassword('pw', legacy.wrapSalt, legacy.seedWrappedPw, 210_000, 'pbkdf2');
        expect(eq(got!, seed)).toBe(true);
        // And the DEFAULT (undefined algo, as a legacy server row returns) is pbkdf2:
        const got2 = await unwrapSeedWithPassword('pw', legacy.wrapSalt, legacy.seedWrappedPw, 210_000);
        expect(eq(got2!, seed)).toBe(true);
        // Wrong PBKDF2 count → different KEK → fails (the count still matters for legacy blobs).
        const wrong = await unwrapSeedWithPassword('pw', legacy.wrapSalt, legacy.seedWrappedPw, 600_000, 'pbkdf2');
        expect(wrong).toBeNull();
    });

    it('clamps a hostile PBKDF2 iteration count (no multi-minute grind on login)', async () => {
        const seed = generateIdentitySeed();
        const legacy = await __wrapSeedPbkdf2ForTest(seed, 'pw', 210_000);
        // 2e9 iterations would hang unclamped; clamped to 10M it returns fast, and
        // since 10M ≠ 210k it just fails the GCM tag → null rather than hanging.
        const got = await unwrapSeedWithPassword('pw', legacy.wrapSalt, legacy.seedWrappedPw, 2_000_000_000, 'pbkdf2');
        expect(got).toBeNull();
    }, 20_000);

    it('passwordWrapNeedsUpgrade: anything not argon2id upgrades, argon2id does not', () => {
        expect(passwordWrapNeedsUpgrade(null, 210_000)).toBe(true);       // pre-column (legacy pbkdf2)
        expect(passwordWrapNeedsUpgrade(undefined, 600_000)).toBe(true);
        expect(passwordWrapNeedsUpgrade('pbkdf2', 600_000)).toBe(true);   // pbkdf2 at any count
        expect(passwordWrapNeedsUpgrade('argon2id', 600_000)).toBe(false); // already current
    });

    it('TRANSPARENT MIGRATION: legacy PBKDF2 blob → argon2id, same seed, no upgrade after', async () => {
        const seed = generateIdentitySeed();
        const pub = makeIdentity(seed).publicKeyEncoded;
        const legacy = await __wrapSeedPbkdf2ForTest(seed, 'pw', 210_000);

        // Login: unwrap the legacy blob, detect it needs upgrade, re-wrap to argon2.
        expect(passwordWrapNeedsUpgrade('pbkdf2', 210_000)).toBe(true);
        const recovered = await unwrapSeedWithPassword('pw', legacy.wrapSalt, legacy.seedWrappedPw, 210_000, 'pbkdf2');
        expect(eq(recovered!, seed)).toBe(true);
        const up = await upgradePasswordWrap(recovered!, 'pw');
        expect(up.pwKdf).toBe('argon2id');

        // The upgraded (argon2) blob recovers the SAME seed → same identity.
        const back = await unwrapSeedWithPassword('pw', up.wrapSalt, up.seedWrappedPw, up.pwKdfIterations, up.pwKdf);
        expect(eq(back!, seed)).toBe(true);
        expect(makeIdentity(back!).publicKeyEncoded).toBe(pub);
        // Next login won't re-upgrade.
        expect(passwordWrapNeedsUpgrade(up.pwKdf, up.pwKdfIterations)).toBe(false);
    });
});

describe('v3 recovery: DH proof of possession', () => {
    // Independent re-implementation of the SERVER verification.
    function serverVerify(seed: Uint8Array, ePriv: Uint8Array, challenge: Uint8Array, usernameLower: string): string {
        const P = x25519.getPublicKey(seed);           // account public key the server stores
        const dh = x25519.getSharedSecret(ePriv, P);    // == X25519(seed, E) by DH symmetry
        const proofKey = hkdf(sha256, dh, undefined, new TextEncoder().encode('sovereign-recovery-proof-v1'), 32);
        const msg = new Uint8Array([...challenge, ...new TextEncoder().encode(usernameLower)]);
        return b64(hmac(sha256, proofKey, msg));
    }

    it('client proof matches the server verification', () => {
        const seed = generateIdentitySeed();
        const ePriv = generateIdentitySeed(); // server ephemeral private scalar
        const ePub = x25519.getPublicKey(ePriv);
        const challenge = crypto.getRandomValues(new Uint8Array(32));

        const clientProof = computeRecoveryProof(seed, encodePublicKey(ePub), b64(challenge), 'mick');
        const expected = serverVerify(seed, ePriv, challenge, 'mick');
        expect(clientProof).toBe(expected);
    });

    it('a proof from the wrong seed does NOT verify', () => {
        const realSeed = generateIdentitySeed();
        const attackerSeed = generateIdentitySeed();
        const ePriv = generateIdentitySeed();
        const ePub = x25519.getPublicKey(ePriv);
        const challenge = crypto.getRandomValues(new Uint8Array(32));

        const attackerProof = computeRecoveryProof(attackerSeed, encodePublicKey(ePub), b64(challenge), 'mick');
        const expected = serverVerify(realSeed, ePriv, challenge, 'mick'); // server checks against the REAL account key
        expect(attackerProof).not.toBe(expected);
    });

    it('proof is bound to the challenge (replay of a different challenge fails)', () => {
        const seed = generateIdentitySeed();
        const ePriv = generateIdentitySeed();
        const ePub = x25519.getPublicKey(ePriv);
        const c1 = crypto.getRandomValues(new Uint8Array(32));
        const c2 = crypto.getRandomValues(new Uint8Array(32));

        const proofForC1 = computeRecoveryProof(seed, encodePublicKey(ePub), b64(c1), 'mick');
        const expectedForC2 = serverVerify(seed, ePriv, c2, 'mick');
        expect(proofForC1).not.toBe(expectedForC2);
    });

    it('returns null on a malformed ephemeral key', () => {
        const seed = generateIdentitySeed();
        expect(computeRecoveryProof(seed, 'not-a-key', b64(new Uint8Array(32)), 'mick')).toBeNull();
    });
});

describe('v3 recovery: sanity of encode/decode used above', () => {
    it('public key encode/decode round-trips', () => {
        const seed = generateIdentitySeed();
        const id = makeIdentity(seed);
        expect(decodePublicKey(id.publicKeyEncoded)).not.toBeNull();
        expect(eq(decodePublicKey(id.publicKeyEncoded)!, id.publicKey)).toBe(true);
    });
});
