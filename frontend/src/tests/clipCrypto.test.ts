import { describe, it, expect } from 'vitest';
import {
    newRingKey, ringNonce, sealGop, openGop,
    newClipSecrets, sealPart, openPart, uuidToBytes, bytesToUuid,
    PART_HEADER_BYTES, PART_TAG_BYTES, PART_MAX_PLAINTEXT,
} from '../api/clips/clipCrypto';

const CLIP_ID = '9f2c1e0a-1234-4abc-8def-0123456789ab';

describe('clipCrypto — ring layer', () => {
    it('round-trips a GOP under a non-extractable key', async () => {
        const key = await newRingKey();
        expect(key.extractable).toBe(false);
        const plain = new Uint8Array(70_000); for (let i = 0; i < plain.length; i += 65_536) crypto.getRandomValues(plain.subarray(i, Math.min(plain.length, i + 65_536)));
        const ct = await sealGop(key, 7, plain);
        expect(ct.byteLength).toBe(plain.byteLength + 16);
        expect(await openGop(key, 7, ct)).toEqual(plain);
    });
    it('rejects the wrong counter (nonce) — the unit is bound to its position', async () => {
        const key = await newRingKey();
        const ct = await sealGop(key, 3, new Uint8Array([1, 2, 3]));
        await expect(openGop(key, 4, ct)).rejects.toBeTruthy();
    });
    it('nonce is 4 zero bytes || u64BE(counter) and refuses garbage', () => {
        expect(Array.from(ringNonce(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        expect(Array.from(ringNonce(0x1_0000_0000))).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
        expect(() => ringNonce(-1)).toThrow();
        expect(() => ringNonce(Number.MAX_SAFE_INTEGER + 2)).toThrow();
    });
});

describe('clipCrypto — part layer', () => {
    it('round-trips a part and lays out the header as documented', async () => {
        const s = newClipSecrets(CLIP_ID);
        const plain = crypto.getRandomValues(new Uint8Array(5000)); // < 64 KiB getRandomValues cap
        const wire = await sealPart(s, 2, plain);
        expect(wire.byteLength).toBe(PART_HEADER_BYTES + plain.byteLength + PART_TAG_BYTES);
        expect(String.fromCharCode(...wire.subarray(0, 4))).toBe('SVCP');
        expect(wire[4]).toBe(1);
        expect(new DataView(wire.buffer).getUint16(5)).toBe(2);
        // nonce = prefix || u32BE(index)
        expect(Array.from(wire.subarray(7, 15))).toEqual(Array.from(s.noncePrefix));
        expect(Array.from(wire.subarray(15, 19))).toEqual([0, 0, 0, 2]);
        expect(await openPart(s, 2, wire)).toEqual(plain);
    });
    it('REJECTS a flipped ciphertext byte', async () => {
        const s = newClipSecrets(CLIP_ID);
        const wire = await sealPart(s, 0, new Uint8Array(100));
        wire[PART_HEADER_BYTES + 10] ^= 0x01;
        await expect(openPart(s, 0, wire)).rejects.toBeTruthy();
    });
    it('REJECTS a part presented at a different index (reorder/splice)', async () => {
        const s = newClipSecrets(CLIP_ID);
        const p2 = await sealPart(s, 2, new Uint8Array([9, 9, 9]));
        // Header says 2, caller expects 3 → header check
        await expect(openPart(s, 3, p2)).rejects.toThrow(/index mismatch/);
        // Forge the header to say 3 (nonce prefix stays, index bytes changed):
        // now the header parses but the nonce/AAD no longer authenticate.
        const forged = p2.slice();
        new DataView(forged.buffer).setUint16(5, 3);
        new DataView(forged.buffer).setUint32(15, 3);
        await expect(openPart(s, 3, forged)).rejects.toBeTruthy();
    });
    it('REJECTS a part from a different clip (AAD binds the clip id)', async () => {
        const a = newClipSecrets(CLIP_ID);
        const b = { ...a, clipId: uuidToBytes('00000000-0000-4000-8000-000000000000') }; // same key+prefix, other clip
        const wire = await sealPart(a, 0, new Uint8Array([1, 2, 3, 4]));
        await expect(openPart(b, 0, wire)).rejects.toBeTruthy();
        // positive control: same secrets open fine
        expect(await openPart(a, 0, wire)).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
    it('rejects malformed wire (short, wrong magic, wrong version)', async () => {
        const s = newClipSecrets(CLIP_ID);
        await expect(openPart(s, 0, new Uint8Array(10))).rejects.toThrow(/too short/);
        const wire = await sealPart(s, 0, new Uint8Array(4));
        const badMagic = wire.slice(); badMagic[0] = 0x00;
        await expect(openPart(s, 0, badMagic)).rejects.toThrow(/not a clip part/);
        const badVer = wire.slice(); badVer[4] = 2;
        await expect(openPart(s, 0, badVer)).rejects.toThrow(/version/);
    });
    it('generates distinct nonces for all 64 indices and fresh prefixes per clip', async () => {
        const s1 = newClipSecrets(CLIP_ID), s2 = newClipSecrets(CLIP_ID);
        expect(Array.from(s1.noncePrefix)).not.toEqual(Array.from(s2.noncePrefix));
        expect(Array.from(s1.key)).not.toEqual(Array.from(s2.key));
        const nonces = new Set<string>();
        for (let i = 0; i < 64; i++) {
            const w = await sealPart(s1, i, new Uint8Array(1));
            nonces.add(Array.from(w.subarray(7, 19)).join(','));
        }
        expect(nonces.size).toBe(64);
    });
    it('refuses over-budget plaintext and out-of-range indices', async () => {
        const s = newClipSecrets(CLIP_ID);
        await expect(sealPart(s, 70000, new Uint8Array(1))).rejects.toThrow(/index/);
        // Do not allocate 24 MiB in a unit test: assert the constant instead.
        expect(PART_MAX_PLAINTEXT).toBe(24 * 1024 * 1024);
        expect(PART_MAX_PLAINTEXT + PART_HEADER_BYTES + PART_TAG_BYTES).toBeLessThan(25 * 1024 * 1024);
    });
    it('uuid helpers round-trip and reject junk', () => {
        expect(bytesToUuid(uuidToBytes(CLIP_ID))).toBe(CLIP_ID);
        expect(() => uuidToBytes('not-a-uuid')).toThrow();
    });
});
