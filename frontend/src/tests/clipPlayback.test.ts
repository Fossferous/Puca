import { describe, it, expect } from 'vitest';
import { clipPlaybackMode, downloadClipBytes, forEachClipPart, pickMseType, BLOB_FALLBACK_CAP_BYTES, type ClipDownloadProgress } from '../api/clips/clipPlayback';
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

        expect(fetched).toEqual(['part-0', 'part-1', 'part-2']); // requested in order, never shuffled
        // Progress also fires while bytes arrive; the parts-done count only climbs.
        expect([...new Set(progress)]).toEqual([0, 1, 2, 3]);
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

// ---- the phone's Download: fetch the next part WHILE this one is written ----
// Owner report 2026-10-04: downloads "took very long". forEachClipPart awaited
// the write of part i before it even requested part i+1, so the total was
// network time PLUS bridge-write time (51.5 s for 129 MB on the emulator, the
// link idle 4-5 s after every part). Now they overlap — but never by more than
// one part, which is what keeps a ~1 GB clip from filling the phone's memory
// (the 0.9.831 crash).
describe('forEachClipPart — pipelined, at most two parts in hand', () => {
    async function sealedParts(n: number, size = 4096) {
        const clipId = m().clipId;
        const secrets = newClipSecrets(clipId);
        const originals = Array.from({ length: n }, (_, i) => new Uint8Array(i === 0 ? 64 : size).map((_, j) => (i * 31 + j) & 0xff));
        const sealed = await Promise.all(originals.map((p, i) => sealPart(secrets, i, p)));
        const ids = sealed.map((_, i) => uuid(100 + i));
        const manifest = m({
            key: secrets.key, noncePrefix: secrets.noncePrefix, clipId, parts: ids, partDurMs: ids.map((_, i) => (i ? 2000 : 0)),
            totalCipherBytes: sealed.reduce((a, w) => a + w.byteLength, 0),
        });
        const wire = new Map(ids.map((id, i) => [id, sealed[i]]));
        return { manifest, originals, wire, ids };
    }
    const tick = () => new Promise<void>(r => setTimeout(r, 0));
    const until = async (cond: () => boolean, max = 200) => { for (let i = 0; i < max && !cond(); i++) await tick(); };

    it('requests part i+1 while part i is being handed over, and part i+2 only after that hand-over returned', async () => {
        const { manifest, originals, wire, ids } = await sealedParts(5);
        const events: string[] = [];
        const fetchPart = async (id: string) => { events.push(`fetch ${ids.indexOf(id)}`); return wire.get(id)!; };
        const release: Array<() => void> = [];
        const out: Uint8Array[] = [];
        const run = forEachClipPart(manifest, async (plain, i) => {
            events.push(`write ${i} start`);
            await new Promise<void>(r => release.push(r));
            out.push(plain);
            events.push(`write ${i} end`);
        }, undefined, fetchPart);
        for (let i = 0; i < 5; i++) {
            await until(() => release.length > 0);
            await until(() => events.includes(`fetch ${i + 1}`) || i === 4, 50);
            // Part i is being written. Part i+1 is already on its way...
            if (i < 4) expect(events, `part ${i + 1} while part ${i} is written`).toContain(`fetch ${i + 1}`);
            // ...and part i+2 is not, so at most two parts are ever held.
            expect(events).not.toContain(`fetch ${i + 2}`);
            release.shift()!();
        }
        await run;
        expect(events.filter(e => e.startsWith('write') && e.endsWith('start'))).toEqual([0, 1, 2, 3, 4].map(i => `write ${i} start`));
        const got = Buffer.concat(out.map(p => Buffer.from(p)));
        expect(got.equals(Buffer.concat(originals.map(p => Buffer.from(p))))).toBe(true);
    });

    it('progress counts bytes as they arrive, ends at the full size, and parts done only climb', async () => {
        const { manifest, wire } = await sealedParts(3);
        const seen: ClipDownloadProgress[] = [];
        const fetchPart = async (id: string, _s?: AbortSignal, onBytes?: (n: number, t: number | null) => void) => {
            const w = wire.get(id)!;
            onBytes?.(Math.floor(w.byteLength / 2), null); // half of it, mid-part
            onBytes?.(w.byteLength, null);
            return w;
        };
        await forEachClipPart(manifest, async () => {}, (p) => seen.push({ ...p }), fetchPart);
        const half = Math.floor(wire.get(manifest.parts[0])!.byteLength / 2);
        expect(seen[0]).toMatchObject({ done: 0, bytesDone: half, totalBytes: manifest.totalCipherBytes });
        expect(seen.at(-1)).toEqual({ done: 3, total: 3, bytesDone: manifest.totalCipherBytes, totalBytes: manifest.totalCipherBytes });
        for (let i = 1; i < seen.length; i++) {
            expect(seen[i].bytesDone).toBeGreaterThanOrEqual(seen[i - 1].bytesDone);
            expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
        }
    });

    it('a write that fails stops the run and cancels the part already on its way', async () => {
        const { manifest, wire, ids } = await sealedParts(4);
        const signals: AbortSignal[] = [];
        const fetchPart = async (id: string, signal?: AbortSignal) => {
            signals.push(signal!);
            if (ids.indexOf(id) === 2) await new Promise<void>((_, rej) => signal!.addEventListener('abort', () => rej(new Error('aborted'))));
            return wire.get(id)!;
        };
        const written: number[] = [];
        await expect(forEachClipPart(manifest, async (_p, i) => {
            if (i === 1) { await until(() => signals.length === 3); throw new Error('disk full'); }
            written.push(i);
        }, undefined, fetchPart)).rejects.toThrow('disk full');
        expect(written).toEqual([0]);
        expect(signals.length).toBe(3); // part 3 was never requested
        expect(signals[2].aborted).toBe(true); // and part 2, in flight, was cancelled
    });

    it('a part gone from the server mid-run keeps its 404 for the caller', async () => {
        const { manifest, wire, ids } = await sealedParts(3);
        const fetchPart = async (id: string) => {
            if (ids.indexOf(id) === 2) throw Object.assign(new Error('gone'), { status: 404 });
            return wire.get(id)!;
        };
        await expect(forEachClipPart(manifest, async () => {}, undefined, fetchPart)).rejects.toMatchObject({ status: 404 });
    });
});
