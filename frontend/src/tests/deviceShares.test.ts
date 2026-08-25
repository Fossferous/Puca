/**
 * The cross-user share grant — the crypto gate a friend's session stands on.
 *
 * `shareAuthorises` is what the HOST checks before accepting a session from
 * another account, so every test here is really a claim about what a forged,
 * replayed or stale grant can do. The FIRST test is the positive control: a
 * rig that rejects everything would pass every negative assertion below, so
 * the genuine round-trip must be proven to pass before any refusal counts.
 */
import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
    buildShareRecord,
    shareAuthorises,
    DEVICE_SHARE_TYPE,
} from '../api/devices/shares';
import { verifyWithAccountKey, canonicalJson } from '../api/e2ee';

function toB64(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
}

/** A deterministic device keypair and its signer, mirroring deviceKey.ts. */
function testKey(seedByte: number) {
    const seed = new Uint8Array(32).fill(seedByte);
    const pub = ed25519.getPublicKey(seed);
    return {
        signPub: `ed25519:${toB64(pub)}`,
        sign: (msg: string) => toB64(ed25519.sign(new TextEncoder().encode(msg), seed)),
    };
}

const HOST = 'host-device-id-000000';
const CTX = { hostDevice: HOST, ownerUser: 7, granteeUser: 42, capabilities: ['control', 'files'] };

function signedGrant(key = testKey(1), overrides?: Partial<Parameters<typeof buildShareRecord>[0]>) {
    const { canonical } = buildShareRecord({
        hostDevice: HOST,
        ownerUser: 7,
        granteeUser: 42,
        capabilities: ['control', 'files'],
        timestamp: 1_700_000_000,
        ...overrides,
    });
    return { grant_record: canonical, grant_sig: key.sign(canonical) };
}

describe('shareAuthorises', () => {
    const key = testKey(1);
    const verify = (record: string, sig: string) => verifyWithAccountKey(key.signPub, record, sig);

    it('POSITIVE CONTROL: a genuine grant over the exact context verifies', async () => {
        expect(await shareAuthorises(signedGrant(), CTX, verify)).toBe(true);
    });

    it('binds the host device: a grant for another machine is refused', async () => {
        const grant = signedGrant(key, { hostDevice: 'some-other-device-000' });
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });

    it('binds the grantee: a grant for another user is refused', async () => {
        const grant = signedGrant(key, { granteeUser: 43 });
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });

    it('binds the owner', async () => {
        const grant = signedGrant(key, { ownerUser: 8 });
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });

    it('binds capabilities EXACTLY: a stale narrower grant cannot ride a widened invite', async () => {
        // The signature is genuine — over view_only — but the invite context
        // claims control. Accepting it would hand out what was never signed.
        const grant = signedGrant(key, { capabilities: ['view_only'] });
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });

    it('capability ORDER does not matter (canonical sort on both sides)', async () => {
        const grant = signedGrant(key, { capabilities: ['files', 'control'] });
        expect(await shareAuthorises(grant, CTX, verify)).toBe(true);
    });

    it('a signature by a DIFFERENT key is refused', async () => {
        const grant = signedGrant(testKey(2));
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });

    it('non-canonical stored bytes are refused even with a valid signature over them', async () => {
        // Same fields, different byte order: the record verifies as bytes but
        // is NOT the canonical serialisation, so a re-serialising consumer
        // would validate different bytes than were signed.
        const { record } = buildShareRecord({
            hostDevice: HOST, ownerUser: 7, granteeUser: 42,
            capabilities: ['control', 'files'], timestamp: 1_700_000_000,
        });
        const reordered = JSON.stringify({ v: record.v, typ: record.typ, host: record.host, owner: record.owner, grantee: record.grantee, caps: record.caps, ts: record.ts });
        expect(reordered).not.toBe(canonicalJson(record));
        const grant = { grant_record: reordered, grant_sig: key.sign(reordered) };
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });

    it('garbage records refuse rather than throw', async () => {
        expect(await shareAuthorises({ grant_record: 'not json', grant_sig: 'x' }, CTX, verify)).toBe(false);
        expect(await shareAuthorises({ grant_record: '{}', grant_sig: 'x' }, CTX, verify)).toBe(false);
    });

    it('a wrong record type is refused', async () => {
        const rec = { typ: 'sovereign-device-grant-v1', v: 1, host: HOST, owner: 7, grantee: 42, caps: ['control', 'files'], ts: 1_700_000_000 };
        const canonical = canonicalJson(rec);
        const grant = { grant_record: canonical, grant_sig: key.sign(canonical) };
        expect(await shareAuthorises(grant, CTX, verify)).toBe(false);
    });
});

describe('buildShareRecord', () => {
    it('sorts capabilities so the same grant always produces the same bytes', () => {
        const a = buildShareRecord({ hostDevice: HOST, ownerUser: 1, granteeUser: 2, capabilities: ['files', 'control'], timestamp: 5 });
        const b = buildShareRecord({ hostDevice: HOST, ownerUser: 1, granteeUser: 2, capabilities: ['control', 'files'], timestamp: 5 });
        expect(a.canonical).toBe(b.canonical);
    });

    it('stamps the pinned record type', () => {
        const { record } = buildShareRecord({ hostDevice: HOST, ownerUser: 1, granteeUser: 2, capabilities: ['files'], timestamp: 5 });
        expect(record.typ).toBe(DEVICE_SHARE_TYPE);
    });
});
