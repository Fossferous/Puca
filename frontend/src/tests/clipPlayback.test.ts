import { describe, it, expect } from 'vitest';
import { clipPlaybackMode, downloadClipBytes, pickMseType, BLOB_FALLBACK_CAP_BYTES } from '../api/clips/clipPlayback';
import { newClipSecrets, sealPart } from '../api/clips/clipCrypto';
import type { ClipManifest } from '../api/clips/clipRef';

/** jsdom's Blob has no `.arrayBuffer()`; FileReader is the one thing both
 *  jsdom and real browsers implement for reading a Blob back out. */
function blobBytes(b: Blob): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
        r.onerror = () => reject(r.error);
        r.readAsArrayBuffer(b);
    });
}

const uuid = (i: number) => `${i.toString(16).padStart(8, '0')}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const m = (over: Partial<ClipManifest> = {}): ClipManifest => ({
    key: new Uint8Array(32), noncePrefix: new Uint8Array(8), clipId: uuid(99), videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2',
    durationMs: 60_000, width: 1920, height: 1080, totalCipherBytes: 10 * 1024 * 1024,
    parts: [uuid(1), uuid(2), uuid(3), uuid(4)], partDurMs: [0, 20_000, 20_000, 20_000], ...over,
});

describe('clipPlayback — mode selection', () => {
    it('prefers MSE when MediaSource exists and a codec string is supported', () => {
        const env = { hasMediaSource: true, isTypeSupported: (t: string) => t.includes('avc1.640029') };
        expect(clipPlaybackMode(m(), env)).toBe('mse');
        // the manifest's actual codec string wins over the generic ladder
        expect(pickMseType(m(), env.isTypeSupported)).toBe('video/mp4; codecs="avc1.640029, mp4a.40.2"');
        expect(pickMseType(m(), (t) => t.includes('avc1.640028'))).toBe('video/mp4; codecs="avc1.640028, mp4a.40.2"');
    });
    it('falls back to blob only under the cap when MSE is missing (iOS), else unsupported', () => {
        const noMse = { hasMediaSource: false, isTypeSupported: () => false };
        expect(clipPlaybackMode(m({ totalCipherBytes: BLOB_FALLBACK_CAP_BYTES }), noMse)).toBe('blob');
        expect(clipPlaybackMode(m({ totalCipherBytes: BLOB_FALLBACK_CAP_BYTES + 1 }), noMse)).toBe('unsupported');
        // MSE present but no supported codec string → same fallback logic
        const mseNoCodec = { hasMediaSource: true, isTypeSupported: () => false };
        expect(clipPlaybackMode(m({ totalCipherBytes: 1024 }), mseNoCodec)).toBe('blob');
    });
    it('opus manifests ask MSE for an opus codec string', () => {
        const seen: string[] = [];
        pickMseType(m({ audioCodec: 'opus' }), (t) => { seen.push(t); return false; });
        expect(seen[0]).toContain(', opus"');
    });
});

describe('downloadClipBytes — reconstructs the original bytes (review request: "how does the clipper download the original")', () => {
    it('fetches + decrypts every part IN ORDER and concatenates them byte-for-byte', async () => {
        const clipId = m().clipId;
        const secrets = newClipSecrets(clipId);
        // "original" plaintext parts — init segment (small) + two media segments.
        const originals = [new Uint8Array([1, 2, 3, 4]), new Uint8Array(50).fill(9), new Uint8Array(50).fill(7)];
        const sealed = await Promise.all(originals.map((p, i) => sealPart(secrets, i, p)));
        const manifest = m({ key: secrets.key, noncePrefix: secrets.noncePrefix, clipId, parts: sealed.map((_, i) => `part-${i}`) });

        const fetched: string[] = [];
        const fetchPart = async (id: string) => { fetched.push(id); return sealed[Number(id.split('-')[1])]; };
        const progress: number[] = [];
        const blob = await downloadClipBytes(manifest, p => progress.push(p.done), fetchPart);

        expect(fetched).toEqual(['part-0', 'part-1', 'part-2']); // in order, not concurrent/shuffled
        expect(progress).toEqual([1, 2, 3]);
        const bytes = await blobBytes(blob);
        const expected = new Uint8Array(originals.reduce((n, p) => n + p.length, 0));
        let off = 0;
        for (const p of originals) { expected.set(p, off); off += p.length; }
        expect(bytes).toEqual(expected); // exactly the muxer's original output, concatenated
        expect(blob.type).toBe('video/mp4');
    });

    it('a tampered part is rejected (auth failure), not silently included', async () => {
        const clipId = m().clipId;
        const secrets = newClipSecrets(clipId);
        const sealed = await sealPart(secrets, 0, new Uint8Array([1, 2, 3]));
        sealed[sealed.length - 1] ^= 0xff; // flip a tag byte
        const manifest = m({ key: secrets.key, noncePrefix: secrets.noncePrefix, clipId, parts: ['p0'] });
        await expect(downloadClipBytes(manifest, undefined, async () => sealed)).rejects.toThrow();
    });

    it('a missing part (404) propagates the status so the caller can show "no longer on the server"', async () => {
        const blob = downloadClipBytes(m(), undefined, async () => { throw Object.assign(new Error('gone'), { status: 404 }); });
        await expect(blob).rejects.toMatchObject({ status: 404 });
    });
});
