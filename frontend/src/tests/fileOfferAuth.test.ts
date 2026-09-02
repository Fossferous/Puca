/**
 * H-2: a "peer-to-peer" file offer is relayed by the SERVER, so a malicious
 * operator can substitute the offered hash and MITM the DTLS while the
 * receiver's own hash check still passes — against the hash the MITM chose. The
 * offer is now authenticated with a MAC keyed by the DM shared secret, which
 * only the two peers know. These are the crypto invariants that makes that work.
 */
import { describe, it, expect } from 'vitest';
import {
    makeIdentity,
    deriveFileOfferAuthKey,
    authenticateFileOffer,
    verifyFileOffer,
    canonicalJson,
} from '../api/e2ee';

// Two fixed seeds → two peers. (Seeds are arbitrary but non-zero.)
const alice = makeIdentity(new Uint8Array(32).fill(7));
const bob = makeIdentity(new Uint8Array(32).fill(9));

const record = (fields: Record<string, unknown>) => canonicalJson(fields);
const OFFER = {
    id: 't-1', from: 1, to: 2,
    name: 'secret.pdf', size: 12345, mime: 'application/pdf',
    sha256: 'abc123',
};

describe('file-offer authentication (H-2)', () => {
    it('both peers derive the SAME auth key from their opposite views', () => {
        // Sender (alice) uses the receiver's pub; receiver (bob) uses the
        // sender's pub. X25519 makes these the same shared secret.
        const kSender = deriveFileOfferAuthKey(alice, bob.publicKeyEncoded)!;
        const kReceiver = deriveFileOfferAuthKey(bob, alice.publicKeyEncoded)!;
        expect(kSender).toBeInstanceOf(Uint8Array);
        expect([...kSender]).toEqual([...kReceiver]);
    });

    it('a valid MAC verifies on the other side', () => {
        const kSender = deriveFileOfferAuthKey(alice, bob.publicKeyEncoded)!;
        const kReceiver = deriveFileOfferAuthKey(bob, alice.publicKeyEncoded)!;
        const tag = authenticateFileOffer(kSender, record(OFFER));
        expect(verifyFileOffer(kReceiver, record(OFFER), tag)).toBe(true);
    });

    it('a substituted hash (the MITM) fails verification', () => {
        const kSender = deriveFileOfferAuthKey(alice, bob.publicKeyEncoded)!;
        const kReceiver = deriveFileOfferAuthKey(bob, alice.publicKeyEncoded)!;
        const tag = authenticateFileOffer(kSender, record(OFFER));
        // The server swaps the hash for one matching a file it controls.
        const tampered = record({ ...OFFER, sha256: 'deadbeef' });
        expect(verifyFileOffer(kReceiver, tampered, tag)).toBe(false);
        // Same for a swapped size or name.
        expect(verifyFileOffer(kReceiver, record({ ...OFFER, size: 999 }), tag)).toBe(false);
        expect(verifyFileOffer(kReceiver, record({ ...OFFER, name: 'evil.exe' }), tag)).toBe(false);
    });

    it('a MAC from an UNRELATED key (e.g. the server guessing) fails', () => {
        const eve = makeIdentity(new Uint8Array(32).fill(3));
        const kEve = deriveFileOfferAuthKey(eve, bob.publicKeyEncoded)!;
        const kReceiver = deriveFileOfferAuthKey(bob, alice.publicKeyEncoded)!;
        const forged = authenticateFileOffer(kEve, record(OFFER));
        expect(verifyFileOffer(kReceiver, record(OFFER), forged)).toBe(false);
    });

    it('malformed inputs fail closed rather than throw', () => {
        const k = deriveFileOfferAuthKey(alice, bob.publicKeyEncoded)!;
        expect(verifyFileOffer(k, record(OFFER), 'not-base64!!')).toBe(false);
        expect(verifyFileOffer(k, record(OFFER), '')).toBe(false);
        expect(deriveFileOfferAuthKey(alice, 'not-a-key')).toBeNull();
    });
});

describe('v2 records (0.9.0): fingerprints and the accept direction are inside the MAC', async () => {
    const { fileOfferRecord, fileAcceptRecord, FILE_OFFER_AUTH_VERSION } = await import('../api/fileTransferManager');
    const fp = 'sha-256 ' + 'AB:'.repeat(31) + 'AB';
    it('the offer record carries v, t, the fingerprint and the timestamp, canonically ordered', () => {
        const r = fileOfferRecord({ id: 'x', from: 1, to: 2, name: 'n', size: 3, mime: 'm', sha256: 's', fp, ts: 10 });
        expect(FILE_OFFER_AUTH_VERSION).toBe(2);
        expect(JSON.parse(r)).toEqual({ v: 2, t: 'offer', id: 'x', from: 1, to: 2, name: 'n', size: 3, mime: 'm', sha256: 's', fp, ts: 10 });
        expect(r).toBe(JSON.stringify(JSON.parse(r), Object.keys(JSON.parse(r)).sort()));
    });
    it('an accept record is a different record from an offer with the same fields, and the direction is flipped', () => {
        const a = fileAcceptRecord({ id: 'x', from: 2, to: 1, fp, resume: 0 });
        expect(JSON.parse(a).t).toBe('accept');
        expect(a).not.toBe(fileAcceptRecord({ id: 'x', from: 1, to: 2, fp, resume: 0 }));
        expect(a).not.toBe(fileAcceptRecord({ id: 'x', from: 2, to: 1, fp, resume: 1024 }));
    });
});
