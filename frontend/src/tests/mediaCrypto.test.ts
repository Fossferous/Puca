import { describe, it, expect, beforeAll } from 'vitest';
import {
    encryptFrame,
    decryptFrame,
    importMediaKey,
    advertiseE2ee,
    extractE2ee,
    type MediaCryptoState,
    type EncodedFrameLike,
} from '../api/rtc/mediaCrypto';
import {
    deriveMediaKey,
    mediaReadyTag,
    deriveMediaSessionKey,
    generateControlEphemeral,
} from '../api/e2ee';
import { testIdentity, warmIdentities, WARM_TIMEOUT_MS } from './fixtures/identities';

const SALT_A = 'a1'.repeat(16);
const SALT_B = 'b2'.repeat(16);

// Identities are fixtures here, not the thing under test, and each costs a
// 210k-iteration PBKDF2 (~380ms). Deriving them per test put the three-identity
// tests at ~1.5s idle, which flaked past the 5s default under load. Warm them
// once; every test below then runs on the strict default timeout, so a real
// regression in frame crypto still goes red.
// Spread these tuples at the call sites so the warm list cannot drift out of
// sync with what the tests actually ask for.
const ALICE = ['alice', SALT_A] as const;
const BOB = ['bob', SALT_B] as const;
const MALLORY = ['mallory', 'c3'.repeat(16)] as const;
const VICTIM = ['victim', 'd4'.repeat(16)] as const;
const CAROL = ['carol', 'e5'.repeat(16)] as const;

beforeAll(() => warmIdentities([ALICE, BOB, MALLORY, VICTIM, CAROL]), WARM_TIMEOUT_MS);

async function pairState(): Promise<{ send: MediaCryptoState; recv: MediaCryptoState }> {
    const a = await testIdentity(...ALICE);
    const b = await testIdentity(...BOB);
    const rawA = deriveMediaKey(a, b.publicKeyEncoded)!;
    const rawB = deriveMediaKey(b, a.publicKeyEncoded)!;
    expect(Buffer.from(rawA)).toEqual(Buffer.from(rawB)); // pairwise key agrees
    return {
        send: { key: await importMediaKey(rawA), enabled: true, requireE2ee: false },
        recv: { key: await importMediaKey(rawB), enabled: true, requireE2ee: false },
    };
}

function frame(bytes: number[], type?: 'key' | 'delta'): EncodedFrameLike {
    return { data: new Uint8Array(bytes).buffer, type };
}
const body = (f: EncodedFrameLike) => [...new Uint8Array(f.data)];

describe('media frame crypto', () => {
    it('round-trips a video delta frame (3-byte clear header)', async () => {
        const { send, recv } = await pairState();
        const original = Array.from({ length: 60 }, (_, i) => i % 256);
        const f = frame(original, 'delta');
        await encryptFrame(f, send);
        expect(body(f)).not.toEqual(original);       // ciphertext differs
        expect(body(f).slice(0, 3)).toEqual(original.slice(0, 3)); // header preserved
        const keep = await decryptFrame(f, recv);
        expect(keep).toBe(true);
        expect(body(f)).toEqual(original);           // recovered exactly
    });

    it('round-trips a video KEY frame (10-byte clear header) and an audio frame (1-byte)', async () => {
        const { send, recv } = await pairState();
        for (const type of ['key', undefined] as const) {
            const original = Array.from({ length: 40 }, (_, i) => (i * 7) % 256);
            const f = frame(original, type);
            await encryptFrame(f, send);
            expect(await decryptFrame(f, recv)).toBe(true);
            expect(body(f)).toEqual(original);
        }
    });

    it('does not encrypt when disabled (passthrough)', async () => {
        const { send } = await pairState();
        send.enabled = false;
        const original = [1, 2, 3, 4, 5, 6, 7, 8];
        const f = frame(original, 'delta');
        await encryptFrame(f, send);
        expect(body(f)).toEqual(original);
    });

    it('passes through an unmarked (plaintext) frame even when enabled', async () => {
        const { recv } = await pairState();
        const original = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
        const f = frame(original, 'delta');
        expect(await decryptFrame(f, recv)).toBe(true);
        expect(body(f)).toEqual(original); // unchanged
    });

    it('DROPS a tampered encrypted frame (auth failure)', async () => {
        const { send, recv } = await pairState();
        const f = frame(Array.from({ length: 50 }, (_, i) => i), 'delta');
        await encryptFrame(f, send);
        const bytes = new Uint8Array(f.data);
        bytes[20] ^= 0x01; // flip a ciphertext byte
        f.data = bytes.buffer;
        expect(await decryptFrame(f, recv)).toBe(false);
    });

    it('DROPS an encrypted frame under the wrong key', async () => {
        const { send } = await pairState();
        const attacker = await testIdentity(...MALLORY);
        const other = await testIdentity(...VICTIM);
        const wrong: MediaCryptoState = { key: await importMediaKey(deriveMediaKey(attacker, other.publicKeyEncoded)!), enabled: true, requireE2ee: false };
        const f = frame(Array.from({ length: 50 }, (_, i) => i), 'delta');
        await encryptFrame(f, send);
        expect(await decryptFrame(f, wrong)).toBe(false);
    });

    it('DROPS a frame whose clear codec header was tampered (header is AAD)', async () => {
        const { send, recv } = await pairState();
        const f = frame(Array.from({ length: 50 }, (_, i) => i), 'key'); // 10-byte header
        await encryptFrame(f, send);
        const bytes = new Uint8Array(f.data);
        bytes[2] ^= 0x01; // flip a byte inside the clear header
        f.data = bytes.buffer;
        expect(await decryptFrame(f, recv)).toBe(false);
    });

    describe('require-E2EE (fail-closed) enforcement', () => {
        it('outgoing: DROPS a frame to an unencrypted peer instead of sending plaintext', async () => {
            const { send } = await pairState();
            send.enabled = false;          // E2EE not active with this peer
            send.requireE2ee = true;       // but the user requires it
            const f = frame([1, 2, 3, 4, 5, 6, 7, 8], 'delta');
            const keep = await encryptFrame(f, send);
            expect(keep).toBe(false);      // frame is dropped, no plaintext leaves
        });

        it('outgoing: still SENDS (passthrough) to an unencrypted peer when NOT enforced', async () => {
            const { send } = await pairState();
            send.enabled = false;
            send.requireE2ee = false;
            const f = frame([1, 2, 3, 4], 'delta');
            expect(await encryptFrame(f, send)).toBe(true); // transport-only fallback
        });

        it('incoming: DROPS a plaintext frame under enforcement instead of rendering it', async () => {
            const { recv } = await pairState();
            recv.enabled = false;
            recv.requireE2ee = true;
            const f = frame([9, 8, 7, 6, 5], 'delta'); // unmarked / plaintext
            expect(await decryptFrame(f, recv)).toBe(false); // never rendered
        });

        it('enforcement still lets a properly encrypted frame through', async () => {
            const { send, recv } = await pairState();
            send.requireE2ee = true;
            recv.requireE2ee = true;
            const original = Array.from({ length: 40 }, (_, i) => i);
            const f = frame(original, 'delta');
            expect(await encryptFrame(f, send)).toBe(true);
            expect(await decryptFrame(f, recv)).toBe(true);
            expect(body(f)).toEqual(original);
        });
    });
});

describe('media capability tag (ephemeral-binding MAC) + forward secrecy', () => {
    it('a peer verifies the other tag by recomputing the MAC over the received ephemeral', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const staticA = deriveMediaKey(a, b.publicKeyEncoded)!;
        const staticB = deriveMediaKey(b, a.publicKeyEncoded)!;
        const ephA = generateControlEphemeral();
        const ephB = generateControlEphemeral();
        const tagA = mediaReadyTag(staticA, ephA.pubEncoded); // A advertises this
        // B verifies A's tag using B's own copy of the static key + A's ephemeral.
        expect(mediaReadyTag(staticB, ephA.pubEncoded)).toBe(tagA);
        // Different ephemerals ⇒ the two sides' advertised tags differ.
        expect(mediaReadyTag(staticB, ephB.pubEncoded)).not.toBe(tagA);
    });

    it('both peers derive the SAME forward-secret session key', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const ephA = generateControlEphemeral();
        const ephB = generateControlEphemeral();
        const keyA = deriveMediaSessionKey(a.privateKey, b.publicKeyEncoded, ephA.priv, ephB.pubEncoded)!;
        const keyB = deriveMediaSessionKey(b.privateKey, a.publicKeyEncoded, ephB.priv, ephA.pubEncoded)!;
        expect(Buffer.from(keyA)).toEqual(Buffer.from(keyB));
        // A fresh pair of ephemerals ⇒ a different session key (forward secrecy).
        const ephA2 = generateControlEphemeral();
        const ephB2 = generateControlEphemeral();
        const keyA2 = deriveMediaSessionKey(a.privateKey, b.publicKeyEncoded, ephA2.priv, ephB2.pubEncoded)!;
        expect(Buffer.from(keyA2)).not.toEqual(Buffer.from(keyA));
    });

    it('a tampered ephemeral fails tag verification (server tamper ⇒ no E2EE, not broken media)', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const staticB = deriveMediaKey(b, a.publicKeyEncoded)!;
        const ephA = generateControlEphemeral();
        const tagA = mediaReadyTag(deriveMediaKey(a, b.publicKeyEncoded)!, ephA.pubEncoded);
        const forged = generateControlEphemeral(); // server swaps in its own ephemeral
        // B recomputes over the ephemeral it actually received (the forged one) →
        // mismatch → B stays transport-only.
        expect(mediaReadyTag(staticB, forged.pubEncoded)).not.toBe(tagA);
    });

    it('SDP advertise/extract round-trips the tag AND the ephemeral', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const eph = generateControlEphemeral();
        const tag = mediaReadyTag(deriveMediaKey(a, b.publicKeyEncoded)!, eph.pubEncoded);
        const sdp = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
        const adv = advertiseE2ee(sdp, tag, eph.pubEncoded);
        expect(adv.indexOf('sovereign-e2ee')).toBeLessThan(adv.indexOf('m='));
        const cap = extractE2ee(adv);
        expect(cap).not.toBeNull();
        expect(cap!.tag).toBe(tag);
        expect(cap!.ephemeralPubEncoded).toBe(eph.pubEncoded); // "x25519:" prefix restored
        expect(extractE2ee(sdp)).toBeNull();
        expect(advertiseE2ee(sdp, tag, null)).toBe(sdp); // no ephemeral ⇒ no advertisement
        expect(advertiseE2ee(sdp, null, eph.pubEncoded)).toBe(sdp); // no tag ⇒ no advertisement
    });

    it('a different pair yields a different tag (no cross-injection)', async () => {
        const a = await testIdentity(...ALICE);
        const b = await testIdentity(...BOB);
        const c = await testIdentity(...CAROL);
        const eph = generateControlEphemeral();
        const tagAB = mediaReadyTag(deriveMediaKey(a, b.publicKeyEncoded)!, eph.pubEncoded);
        const tagAC = mediaReadyTag(deriveMediaKey(a, c.publicKeyEncoded)!, eph.pubEncoded);
        expect(tagAB).not.toBe(tagAC);
    });
});
