/**
 * Known-answer tests for the FROZEN end-to-end-encryption wire format.
 *
 * WHY THIS EXISTS. The HKDF domain strings in `api/e2ee.ts` are not branding.
 * They are the format every message, DM, note and attachment key already in
 * existence was derived under. Change one and nothing fails to compile, no test
 * goes red, every new message encrypts and decrypts perfectly — and every
 * message that already exists becomes permanently unreadable. The damage is
 * invisible on a fresh database and total on a real one.
 *
 * That is exactly what a product rename tried to do to them, and nothing in the
 * suite would have caught it: not one test referenced these constants.
 *
 * These tests decrypt CIPHERTEXT PINNED IN A COMMITTED FIXTURE, minted once
 * from the shipped implementation. That is the property that matters — not
 * "the constant has this spelling" but "data encrypted before your change still
 * opens after it". A text assertion could be satisfied by editing the
 * assertion; this cannot.
 *
 * IF ONE OF THESE FAILS: you have changed the wire format. Do not regenerate
 * the fixture. Regenerating it re-encrypts the sample under your new constants
 * and makes the test pass while every real user's history stays lost. Revert
 * the constant instead. A genuine format migration means a new version tag, a
 * decrypt path for the old one, and a fixture for each.
 */
import { describe, it, expect } from 'vitest';
import {
    makeIdentity,
    decryptDM,
    decryptSelf,
    unwrapChannelKey,
    encryptDM,
} from '../api/e2ee';
import kat from './fixtures/e2ee-wire-format-kat.json';

const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

const identityA = () => makeIdentity(fromB64(kat.seedA_b64));
const identityB = () => makeIdentity(fromB64(kat.seedB_b64));

describe('e2ee wire format (frozen)', () => {
    it('derives the same identity from a fixed seed', () => {
        // If this fails, key derivation itself moved and every test below is
        // failing for a reason that has nothing to do with the HKDF domains.
        expect(identityA().publicKeyEncoded).toBe(kat.pubA);
        expect(identityB().publicKeyEncoded).toBe(kat.pubB);
    });

    it('decrypts a DM encrypted under the pinned format (HKDF_DM_INFO)', async () => {
        const plain = await decryptDM(identityB(), kat.pubA, kat.dm.envelope as never);
        expect(plain).toBe(kat.dm.plaintext);
    });

    it('decrypts a self-stored envelope under the pinned format (HKDF_SELF_INFO)', async () => {
        const plain = await decryptSelf(identityA(), kat.self.envelope as never);
        expect(plain).toBe(kat.self.plaintext);
    });

    it('unwraps a channel key wrapped under the pinned format (HKDF_WRAP_INFO)', async () => {
        const ck = await unwrapChannelKey(identityB(), kat.wrappedChannelKey as never);
        expect(ck).not.toBeNull();
        expect(toB64(ck as Uint8Array)).toBe(kat.channelKey_b64);
    });

    /**
     * Positive control. Every assertion above is of the form "this decrypts",
     * and a decrypt path that returned the expected value unconditionally — or
     * a fixture that silently failed to load — would satisfy all of them. This
     * proves the rig can actually observe a failure: the SAME ciphertext opened
     * with the wrong peer key must come back null.
     */
    it('fails to decrypt when the derivation inputs are wrong', async () => {
        const wrongPeer = makeIdentity(new Uint8Array(32).fill(9)).publicKeyEncoded;
        const plain = await decryptDM(identityB(), wrongPeer, kat.dm.envelope as never);
        expect(plain).toBeNull();
    });

    /**
     * The round trip must still work, so a failure above is unambiguous: the
     * format changed, rather than the whole DM path being broken.
     */
    it('still round-trips a fresh DM', async () => {
        const a = identityA();
        const b = identityB();
        const env = await encryptDM(a, b.publicKeyEncoded, 'round trip');
        expect(env).not.toBeNull();
        expect(await decryptDM(b, a.publicKeyEncoded, env as never)).toBe('round trip');
    });
});

describe('the live E2EE verifier reimplements the SHIPPED constants', () => {
    /**
     * `frontend/e2e/e2ee-live-verify.mjs` hand-reimplements the crypto so it can
     * check a live server independently of the app. An independent
     * reimplementation is only worth anything while it agrees with the thing it
     * is checking — and this one had already drifted to `-v1` while the app moved
     * to `-v2`, then had its domains rewritten again by the rename. A verifier
     * that derives different keys than the app cannot verify the app; it can only
     * report failures that are its own.
     */
    it('uses the same HKDF domain strings as api/e2ee.ts', async () => {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const read = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

        const src = read('src/api/e2ee.ts');
        const harness = read('e2e/e2ee-live-verify.mjs');

        const domainOf = (text: string, name: string) => {
            const m = text.match(new RegExp(`${name}\\s*=\\s*(?:utf8|enc\\.encode)\\('([^']+)'\\)`));
            return m ? m[1] : null;
        };

        for (const name of ['HKDF_DM_INFO', 'HKDF_WRAP_INFO', 'HKDF_SELF_INFO']) {
            const shipped = domainOf(src, name);
            const reimplemented = domainOf(harness, name);
            expect(shipped, `${name} not found in api/e2ee.ts`).not.toBeNull();
            expect(reimplemented, `${name} not found in e2e/e2ee-live-verify.mjs`).not.toBeNull();
            expect(reimplemented, `${name} disagrees with the shipped implementation`).toBe(shipped);
        }
    });
});
