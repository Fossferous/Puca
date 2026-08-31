import { describe, it, expect, beforeAll } from 'vitest';
import { deriveDeviceId, buildAuthRecord, signAuthRecord, attestationMessage, DEVICE_AUTH_TYPE } from '../api/deviceIdentity/identity';
import { verifyAuthRecord } from '../api/devices/identityRc';
import {
    canonicalJson,
    deriveAccountSigningKey,
    signWithAccountKey,
    verifyWithAccountKey,
    type Identity,
} from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const SALT_A = 'a1'.repeat(16);
const SALT_B = 'b2'.repeat(16);

// `alice()` is called by most tests here (directly or via build()), so deriving
// per call meant ~16 PBKDF2 runs at ~380ms each — about 6s of pure KDF in a
// file that is really testing signing and device-id derivation. Warm once.
const ALICE = ['alice', SALT_A] as const;
const BOB = ['bob', SALT_B] as const;

beforeAll(() => warmIdentities([ALICE, BOB]), WARM_TIMEOUT_MS);

const DPUB = 'x25519:AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const SPUB = 'ed25519:HyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/';

async function alice(): Promise<Identity> {
    return testIdentity(...ALICE);
}

describe('device id derivation', () => {
    it('is deterministic and bound to BOTH keys', () => {
        const id = deriveDeviceId(DPUB, SPUB);
        expect(deriveDeviceId(DPUB, SPUB)).toBe(id);
        expect(deriveDeviceId(DPUB, 'ed25519:AAAA')).not.toBe(id);
        expect(deriveDeviceId('x25519:AAAA', SPUB)).not.toBe(id);
    });

    it('is 21 URL-safe characters', () => {
        // Ids travel in URL paths (DELETE /devices/:id) — standard base64 would
        // put '/' and '+' in there and break routing for some devices.
        for (let i = 0; i < 200; i++) {
            const id = deriveDeviceId(`x25519:${i}`, `ed25519:${i}`);
            expect(id).toHaveLength(21);
            expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
        }
    });

    /**
     * CROSS-LANGUAGE CONTRACT. The server recomputes this id and rejects a
     * mismatch, so if JS and Rust ever disagree, enrolment fails with a 400 that
     * reads like a client bug. The same literal is asserted by
     * `js_rust_device_id_agree` in src/device_handlers.rs — change one and the
     * other must change with it.
     */
    it('matches the Rust derivation for a pinned vector', () => {
        expect(deriveDeviceId('x25519:AAA', 'ed25519:BBB')).toBe('-AauJskpoV9fK7rszlGnl');
    });
});

describe('canonical JSON', () => {
    it('is stable across key insertion order', () => {
        // The whole point: two clients building the same record in different
        // field order must produce identical BYTES, or each rejects the other's
        // signature.
        expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
        expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it('sorts nested keys too', () => {
        expect(canonicalJson({ z: { d: 1, c: 2 }, a: [{ y: 1, x: 2 }] }))
            .toBe('{"a":[{"x":2,"y":1}],"z":{"c":2,"d":1}}');
    });

    it('drops undefined members rather than emitting them', () => {
        expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    });

    it('refuses values that cannot round-trip', () => {
        // NaN/Infinity silently become null under JSON.stringify, so the bytes
        // verified would not be the value intended.
        expect(() => canonicalJson({ a: NaN })).toThrow();
        expect(() => canonicalJson({ a: Infinity })).toThrow();
        expect(() => canonicalJson({ a: () => 1 })).toThrow();
    });
});

describe('account signing key', () => {
    it('is deterministic — every device of the account derives the same key', async () => {
        const id = await alice();
        const k1 = deriveAccountSigningKey(id);
        const k2 = deriveAccountSigningKey(id);
        expect(k1.publicKeyEncoded).toBe(k2.publicKeyEncoded);
        expect(k1.publicKeyEncoded.startsWith('ed25519:')).toBe(true);
    });

    it('differs per account', async () => {
        const a = deriveAccountSigningKey(await alice());
        const b = deriveAccountSigningKey(await testIdentity(...BOB));
        expect(a.publicKeyEncoded).not.toBe(b.publicKeyEncoded);
    });

    it('is NOT the X25519 identity key reused', async () => {
        // Handing the same 32 bytes to two algorithms is the classic footgun.
        const id = await alice();
        const signing = deriveAccountSigningKey(id);
        expect(signing.privateKey).not.toEqual(id.privateKey);
    });

    it('round-trips a signature and rejects tampering', async () => {
        const key = deriveAccountSigningKey(await alice());
        const rec = canonicalJson({ hello: 'world' });
        const sig = signWithAccountKey(key, rec);
        expect(verifyWithAccountKey(key.publicKeyEncoded, rec, sig)).toBe(true);
        expect(verifyWithAccountKey(key.publicKeyEncoded, rec + ' ', sig)).toBe(false);
    });

    it('returns false (never throws) on malformed input', () => {
        // Callers use this to decide whether to TRUST data; a throw at a call
        // site missing a try/catch would fail open.
        expect(verifyWithAccountKey('not-a-key', 'x', 'y')).toBe(false);
        expect(verifyWithAccountKey('ed25519:!!!!', 'x', 'y')).toBe(false);
        expect(verifyWithAccountKey('ed25519:AAAA', 'x', 'AAAA')).toBe(false);
    });
});

describe('device auth record', () => {
    const build = async () => {
        const identity = await alice();
        const { canonical, deviceId } = buildAuthRecord({
            devicePub: DPUB,
            signPub: SPUB,
            name: 'Zeus-PC',
            platform: 'windows',
            userId: 42,
            timestamp: 1753_000_000,
        });
        const sig = signAuthRecord(identity, canonical);
        return {
            identity,
            accountKey: deriveAccountSigningKey(identity),
            row: {
                id: deviceId,
                device_pub: DPUB,
                sign_pub: SPUB,
                auth_record: canonical,
                auth_sig: sig,
            },
        };
    };

    it('verifies a well-formed record', async () => {
        const { accountKey, row } = await build();
        expect(verifyAuthRecord(accountKey, row, 42)).toBe(true);
    });

    it('rejects a record signed by a DIFFERENT account', async () => {
        // This is the property that stops the server inventing devices.
        const { row } = await build();
        const other = deriveAccountSigningKey(await testIdentity(...BOB));
        expect(verifyAuthRecord(other, row, 42)).toBe(false);
    });

    it('rejects a record replayed onto a different row id', async () => {
        const { accountKey, row } = await build();
        expect(verifyAuthRecord(accountKey, { ...row, id: 'someoneElsesDeviceId' }, 42)).toBe(false);
    });

    it('rejects a row whose keys do not match the signed record', async () => {
        // Signature still valid; the surrounding row lies about the keys.
        const { accountKey, row } = await build();
        expect(verifyAuthRecord(accountKey, { ...row, device_pub: 'x25519:OTHER' }, 42)).toBe(false);
        expect(verifyAuthRecord(accountKey, { ...row, sign_pub: 'ed25519:OTHER' }, 42)).toBe(false);
    });

    it('rejects a record bound to a different user', async () => {
        const { accountKey, row } = await build();
        expect(verifyAuthRecord(accountKey, row, 43)).toBe(false);
    });

    it('rejects a record whose type tag was swapped', async () => {
        const { identity, accountKey } = await build();
        const forged = canonicalJson({
            typ: 'sovereign-device-grant-v1', // a DIFFERENT record type
            v: 1,
            did: deriveDeviceId(DPUB, SPUB),
            dpub: DPUB,
            spub: SPUB,
            name: 'x',
            plat: 'windows',
            uid: 42,
            ts: 1,
        });
        const sig = signAuthRecord(identity, forged);
        expect(
            verifyAuthRecord(
                accountKey,
                { id: deriveDeviceId(DPUB, SPUB), device_pub: DPUB, sign_pub: SPUB, auth_record: forged, auth_sig: sig },
                42,
            ),
        ).toBe(false);
    });

    it('TOLERATES unknown fields, so a future client can extend the record', async () => {
        // Deliberate: adding a field requires signing with the ACCOUNT key, so
        // only a legitimate device of this account can do it — not the server
        // and not a network attacker. Rejecting unknown fields would buy no
        // security and would make any future field a hard break for old
        // clients. Every field this code actually USES is validated explicitly
        // above; that is where the safety comes from.
        const { identity, accountKey } = await build();
        const extended = canonicalJson({
            typ: DEVICE_AUTH_TYPE,
            v: 1,
            did: deriveDeviceId(DPUB, SPUB),
            dpub: DPUB,
            spub: SPUB,
            name: 'Zeus-PC',
            plat: 'windows',
            uid: 42,
            ts: 1753_000_000,
            futureField: 'added in a later version',
        });
        const sig = signAuthRecord(identity, extended);
        expect(
            verifyAuthRecord(
                accountKey,
                { id: deriveDeviceId(DPUB, SPUB), device_pub: DPUB, sign_pub: SPUB, auth_record: extended, auth_sig: sig },
                42,
            ),
        ).toBe(true);
    });

    it('rejects a NON-canonical blob even when its signature is genuine', async () => {
        // This is what the re-canonicalisation check actually buys: the stored
        // bytes must already be canonical form. A blob that re-serialises
        // differently elsewhere in the codebase would verify here and fail
        // there, which is exactly the kind of split-brain that is impossible to
        // debug from a bug report.
        const { identity, accountKey } = await build();
        const nonCanonical = JSON.stringify({
            // insertion order deliberately not sorted, plus whitespace
            uid: 42, typ: DEVICE_AUTH_TYPE, v: 1,
            did: deriveDeviceId(DPUB, SPUB), dpub: DPUB, spub: SPUB,
            name: 'Zeus-PC', plat: 'windows', ts: 1753_000_000,
        }, null, 1);
        const sig = signAuthRecord(identity, nonCanonical);
        expect(
            verifyAuthRecord(
                accountKey,
                { id: deriveDeviceId(DPUB, SPUB), device_pub: DPUB, sign_pub: SPUB, auth_record: nonCanonical, auth_sig: sig },
                42,
            ),
        ).toBe(false);
    });
});

describe('attestation transcript', () => {
    it('matches the Rust format exactly', () => {
        expect(attestationMessage('bm9uY2U=', 42)).toBe('sovereign-device-attest-v1|bm9uY2U=|42');
    });

    it('is unambiguous across nonce/uid boundaries', () => {
        // Without separators, ("a", 12) and ("a1", 2) would produce the same
        // bytes, letting one signature serve two different challenges.
        expect(attestationMessage('a', 12)).not.toBe(attestationMessage('a1', 2));
    });
});
