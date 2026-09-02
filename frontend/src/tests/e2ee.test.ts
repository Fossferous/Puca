import { describe, it, expect, beforeAll } from 'vitest';
import {
    deriveIdentity,
    encryptDM,
    decryptDM,
    generateChannelKey,
    wrapChannelKeyForMembers,
    unwrapChannelKey,
    encryptChannelMessage,
    decryptChannelMessage,
    serializeEnvelope,
    parseEnvelope,
    isEncrypted,
    encodePublicKey,
    decodePublicKey,
} from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const SALT_A = 'a1'.repeat(16);
const SALT_B = 'b2'.repeat(16);

// Identities below the `identity derivation` block are fixtures — the tests
// there are about DM/channel crypto, not about the KDF — and each costs a
// 210k-iteration PBKDF2 (~380ms). Warm them once so no single test carries that
// cost and flakes past the 5s default under load.
//
// `identity derivation` itself deliberately keeps calling the real
// `deriveIdentity`: those tests assert that it is deterministic and that a
// different password or salt yields a different key. Run against the cache they
// would only be testing a Map.
const ALICE_DM = ['alice-pw', SALT_A] as const;
const BOB_DM = ['bob-pw', SALT_B] as const;
const EVE = ['eve-pw', 'cc'.repeat(16)] as const;
const ADMIN = ['admin', SALT_A] as const;
const M1 = ['m1', SALT_B] as const;
const M2 = ['m2', 'dd'.repeat(16)] as const;
const ALICE_CH = ['alice', SALT_B] as const;
const BOB_CH = ['bob', 'dd'.repeat(16)] as const;
const CAROL_CH = ['carol', 'ee'.repeat(16)] as const;

beforeAll(
    () => warmIdentities([ALICE_DM, BOB_DM, EVE, ADMIN, M1, M2, ALICE_CH, BOB_CH, CAROL_CH]),
    WARM_TIMEOUT_MS,
);

// These four cannot use the cache — they assert properties OF the KDF, so each
// runs the real 210k-iteration PBKDF2 two or three times (~0.8s idle, measured
// >5s at 2x CPU oversubscription). The cost is inherent to what they test, so
// they get headroom rather than a shortcut. 30s is ~30x the idle cost, so a
// genuine hang still fails.
// Every seal/open now takes its context. v2 ignores it, but the flip will not:
// keep these in step so the suite still runs the day EMIT_ENVELOPE_V3 turns on.
const DM = { senderId: 1, recipientId: 2 };
const CH = { kind: 'chan-msg' as const, channelId: 1, senderId: 1 };

describe('identity derivation', { timeout: 30_000 }, () => {
    it('is deterministic for the same password + salt', async () => {
        const i1 = await deriveIdentity('hunter2', SALT_A);
        const i2 = await deriveIdentity('hunter2', SALT_A);
        expect(i1.publicKeyEncoded).toBe(i2.publicKeyEncoded);
        expect(Buffer.from(i1.privateKey)).toEqual(Buffer.from(i2.privateKey));
    });

    it('differs for a different password', async () => {
        const i1 = await deriveIdentity('hunter2', SALT_A);
        const i2 = await deriveIdentity('other', SALT_A);
        expect(i1.publicKeyEncoded).not.toBe(i2.publicKeyEncoded);
    });

    it('differs for a different salt (per-user)', async () => {
        const i1 = await deriveIdentity('hunter2', SALT_A);
        const i2 = await deriveIdentity('hunter2', SALT_B);
        expect(i1.publicKeyEncoded).not.toBe(i2.publicKeyEncoded);
    });

    it('round-trips public key encoding', async () => {
        const id = await deriveIdentity('hunter2', SALT_A);
        const decoded = decodePublicKey(id.publicKeyEncoded)!;
        expect(encodePublicKey(decoded)).toBe(id.publicKeyEncoded);
        expect(decodePublicKey('spki-legacy-key')).toBeNull();
    });
});

describe('DM encryption (pairwise)', () => {
    it('lets the recipient decrypt what the sender wrote', async () => {
        const alice = await testIdentity(...ALICE_DM);
        const bob = await testIdentity(...BOB_DM);

        const env = (await encryptDM(alice, bob.publicKeyEncoded, 'hi bob', DM))!;
        expect(env.ct).not.toContain('hi bob');

        // Bob decrypts using Alice's public key.
        const plain = await decryptDM(bob, alice.publicKeyEncoded, env, DM);
        expect(plain).toBe('hi bob');
    });

    it('does not let a third party decrypt', async () => {
        const alice = await testIdentity(...ALICE_DM);
        const bob = await testIdentity(...BOB_DM);
        const eve = await testIdentity(...EVE);

        const env = (await encryptDM(alice, bob.publicKeyEncoded, 'secret', DM))!;
        const asEve = await decryptDM(eve, alice.publicKeyEncoded, env, DM);
        expect(asEve).toBeNull();
    });
});

describe('channel (group) encryption', () => {
    it('shares a channel key with members via wrapping', async () => {
        const admin = await testIdentity(...ADMIN);
        const m1 = await testIdentity(...M1);
        const m2 = await testIdentity(...M2);

        const ck = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(admin, ck, [
            { userId: 1, publicKey: m1.publicKeyEncoded },
            { userId: 2, publicKey: m2.publicKeyEncoded },
        ]);
        expect(wrapped).toHaveLength(2);

        // Member 1 unwraps and can decrypt a message.
        const ckForM1 = (await unwrapChannelKey(m1, wrapped[0]))!;
        expect(Buffer.from(ckForM1)).toEqual(Buffer.from(ck));

        const env = await encryptChannelMessage(ck, 1, 'gm everyone', CH);
        const plain = await decryptChannelMessage(ckForM1, env, CH);
        expect(plain).toBe('gm everyone');
    });

    it('skips members without a v2 key', async () => {
        const admin = await testIdentity(...ADMIN);
        const m1 = await testIdentity(...M1);
        const ck = generateChannelKey();
        const wrapped = await wrapChannelKeyForMembers(admin, ck, [
            { userId: 1, publicKey: m1.publicKeyEncoded },
            { userId: 2, publicKey: 'legacy-p256-key-no-prefix' },
        ]);
        expect(wrapped.map((w) => w.recipientId)).toEqual([1]);
    });

    it('a wrong channel key cannot decrypt', async () => {
        const ck = generateChannelKey();
        const wrong = generateChannelKey();
        const env = await encryptChannelMessage(ck, 3, 'topsecret', CH);
        expect(await decryptChannelMessage(wrong, env, CH)).toBeNull();
    });

    it('rejects tampered ciphertext (GCM auth)', async () => {
        const ck = generateChannelKey();
        const env = await encryptChannelMessage(ck, 1, 'integrity', CH);
        env.ct = env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
        expect(await decryptChannelMessage(ck, env, CH)).toBeNull();
    });

    // This used to carry { timeout: 30000 } because its 4 deriveIdentity calls
    // needed ~6s. The KDFs now happen once in beforeAll, so the test itself is
    // wrapping and AES-GCM only — back on the default timeout, where a genuine
    // regression that made it take 6s again would go red instead of hiding.
    it('rotation gives forward secrecy: a removed member cannot read the new epoch', async () => {
        const admin = await testIdentity(...ADMIN);
        const alice = await testIdentity(...ALICE_CH);
        const bob = await testIdentity(...BOB_CH);
        const carol = await testIdentity(...CAROL_CH);

        // Epoch 1: members {alice, bob}.
        const ck1 = generateChannelKey();
        const wrapped1 = await wrapChannelKeyForMembers(admin, ck1, [
            { userId: 1, publicKey: alice.publicKeyEncoded },
            { userId: 2, publicKey: bob.publicKeyEncoded },
        ]);
        const bobEpoch1 = (await unwrapChannelKey(bob, wrapped1[1]))!;
        expect(Buffer.from(bobEpoch1)).toEqual(Buffer.from(ck1));

        // Bob is removed, Carol joins. Alice (a holder) rotates to epoch 2 for
        // the new member set {alice, carol}.
        const ck2 = generateChannelKey();
        const wrapped2 = await wrapChannelKeyForMembers(alice, ck2, [
            { userId: 1, publicKey: alice.publicKeyEncoded },
            { userId: 3, publicKey: carol.publicKeyEncoded },
        ]);
        const msg = await encryptChannelMessage(ck2, 2, 'post-rotation secret', CH);

        // Carol (new member) can read epoch 2.
        const carolWrap = wrapped2.find((w) => w.recipientId === 3)!;
        const carolCk2 = (await unwrapChannelKey(carol, carolWrap))!;
        expect(await decryptChannelMessage(carolCk2, msg, CH)).toBe('post-rotation secret');

        // Bob (removed) was not wrapped a key for epoch 2 and cannot read it.
        expect(wrapped2.some((w) => w.recipientId === 2)).toBe(false);
        expect(await decryptChannelMessage(bobEpoch1, msg, CH)).toBeNull();
    });
});

describe('envelope parsing', () => {
    it('round-trips and detects encryption', async () => {
        const ck = generateChannelKey();
        const env = await encryptChannelMessage(ck, 5, 'x', CH);
        const s = serializeEnvelope(env);
        expect(isEncrypted(s)).toBe(true);
        expect(parseEnvelope(s)).toMatchObject({ v: 3, t: 'ch', epoch: 5 });
    });

    it('treats plaintext as not encrypted', () => {
        expect(isEncrypted('just a normal message')).toBe(false);
        expect(isEncrypted('{"not":"an envelope"}')).toBe(false);
        expect(parseEnvelope('hello world')).toBeNull();
    });
});
