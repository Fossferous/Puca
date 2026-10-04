/**
 * The SEAL's graduated first parts, wired end to end: the real Ring.seal and
 * the worker's trim, driven with real H.264 access units from the fixture,
 * through the real muxer, splitter and crypto.
 *
 * fmp4Split's own tests cut a stream with and without PART_RAMP_FRAGMENTS;
 * nothing pinned that the seal and the trim actually PASS the ramp, or that
 * the seal falls back to a flat cut when the ramp would exceed the 64-part
 * reference limit. Each of those lines could be dropped with every other clip
 * test still green (review, 2026-10-04): every new clip back to a 24 MiB
 * first part (~10 s to the first frame at 20 Mbit/s instead of ~1 s), or a 4K
 * clip near 10:30 refusing to seal with "clip needs N parts".
 * Silent: bytes and timestamps only. Nothing is played, captured or shown.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as webStreams from 'node:stream/web';
import { Input, ALL_FORMATS, BufferSource, EncodedPacketSink } from 'mediabunny';

for (const k of ['ReadableStream', 'WritableStream', 'TransformStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'] as const) {
    if (!(k in globalThis)) (globalThis as unknown as Record<string, unknown>)[k] = (webStreams as unknown as Record<string, unknown>)[k];
}

/** The reference limit, lowered by one test to reach the flat fallback with
 *  a clip of seconds rather than a 4K clip of ten minutes. */
const limits = vi.hoisted(() => ({ maxClipParts: null as number | null }));
vi.mock('../api/clips/clipRef', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/clips/clipRef')>();
    return { ...real, get MAX_CLIP_PARTS() { return limits.maxClipParts ?? real.MAX_CLIP_PARTS; } };
});

// The worker module posts to `self`; in jsdom that is window, whose
// postMessage wants two arguments. Record instead.
const posts: { t: string;[k: string]: unknown }[] = [];
vi.stubGlobal('self', { postMessage: (m: { t: string }) => posts.push(m), onmessage: null, close() { } });

/** A stand-in for WebCodecs' EncodedVideoChunk (jsdom has none). */
class FakeChunk {
    type: 'key' | 'delta'; timestamp: number; duration: number | null; byteLength: number;
    private data: Uint8Array;
    constructor(init: { type: 'key' | 'delta'; timestamp: number; duration?: number; data: ArrayBuffer | Uint8Array }) {
        this.type = init.type; this.timestamp = init.timestamp; this.duration = init.duration ?? null;
        this.data = new Uint8Array(init.data instanceof Uint8Array ? init.data : new Uint8Array(init.data)).slice();
        this.byteLength = this.data.byteLength;
    }
    copyTo(dst: Uint8Array) { dst.set(this.data); }
}
vi.stubGlobal('EncodedVideoChunk', FakeChunk);

type RingT = InstanceType<typeof import('../api/clips/replayWorker').Ring>;
type ArmConfig = Parameters<RingT['arm']>[0];
let Ring: typeof import('../api/clips/replayWorker').Ring;

let keyAU: Uint8Array;          // IDR with SPS/PPS in front, as the agent sends it
let deltaAUs: Uint8Array[];
let codec: string;
let codedWidth: number, codedHeight: number;

function annexB(avcc: Uint8Array, lengthSize: number, prefix: Uint8Array[] = []): Uint8Array {
    const nals: Uint8Array[] = [...prefix];
    for (let o = 0; o < avcc.length;) {
        let n = 0;
        for (let i = 0; i < lengthSize; i++) n = (n << 8) | avcc[o + i];
        o += lengthSize;
        nals.push(avcc.subarray(o, o + n));
        o += n;
    }
    const out = new Uint8Array(nals.reduce((s, x) => s + 4 + x.length, 0));
    let w = 0;
    for (const x of nals) { out.set([0, 0, 0, 1], w); out.set(x, w + 4); w += 4 + x.length; }
    return out;
}

beforeAll(async () => {
    ({ Ring } = await import('../api/clips/replayWorker'));
    const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'clip-avc-1s.mp4')));
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(fixture) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const dc = (await vt.getDecoderConfig())!;
    codec = dc.codec; codedWidth = dc.codedWidth!; codedHeight = dc.codedHeight!;
    const avcC = new Uint8Array(dc.description as ArrayBuffer);
    const lengthSize = (avcC[4] & 3) + 1;
    const params: Uint8Array[] = [];
    let o = 5;
    const nSps = avcC[o++] & 0x1f;
    for (let i = 0; i < nSps; i++) { const n = (avcC[o] << 8) | avcC[o + 1]; params.push(avcC.subarray(o + 2, o + 2 + n)); o += 2 + n; }
    const nPps = avcC[o++];
    for (let i = 0; i < nPps; i++) { const n = (avcC[o] << 8) | avcC[o + 1]; params.push(avcC.subarray(o + 2, o + 2 + n)); o += 2 + n; }
    deltaAUs = [];
    for await (const p of new EncodedPacketSink(vt).packets()) {
        if (p.type === 'key' && !keyAU) keyAU = annexB(p.data, lengthSize, params);
        else if (p.type !== 'key') deltaAUs.push(annexB(p.data, lengthSize));
    }
    expect(keyAU).toBeTruthy();
    expect(deltaAUs.length).toBeGreaterThan(5);
}, 30_000);

afterEach(() => { posts.length = 0; limits.maxClipParts = null; });

const FRAME_US = 33_333;
const GOP = 60; // a keyframe every 2 s at 30 fps, as the agent forces it
/** 17 GOPs: the ramp's 1 + 2 + 4 + 8 fragments, and two more. The fixture's
 *  frames make ~2.9 MB a GOP, so the 24 MiB budget alone holds 8 GOPs. */
const FRAMES = 17 * GOP;
const cfg: ArmConfig = {
    preset: { id: '1440p30', label: 'test', maxWidth: 2560, maxHeight: 1440, fps: 30, videoBitrate: 8_000_000, audioBitrate: 128_000 },
    width: 0, height: 0, ringMs: 300_000, maxRingBytes: 512 * 1024 * 1024,
    audioOffsetUs: 0, audioCodec: 'mp4a.40.2', nativeVideo: { fps: 30 },
};
const chunk = (k: number) => {
    const key = k % GOP === 0;
    return { keyframe: key, tsUs: 1_000 + k * FRAME_US, durUs: FRAME_US, bytes: (key ? keyAU : deltaAUs[k % deltaAUs.length]).slice().buffer, ...(k === 0 ? { codec, codedWidth, codedHeight } : {}) };
};

/** Every queued GOP close finished (crypto is async; the ring refuses to
 *  fall more than a few GOPs behind). */
async function drain(ring: RingT): Promise<void> {
    const r = ring as unknown as { closing: Promise<void>; pendingCloses: number };
    while (r.pendingCloses > 0) await r.closing;
}

async function sealedRing(): Promise<Awaited<ReturnType<RingT['seal']>>> {
    const ring = new Ring();
    await ring.arm({ ...cfg, width: codedWidth, height: codedHeight }, null, null);
    for (let k = 0; k < FRAMES; k++) {
        ring.ingestNativeVideoChunk(chunk(k));
        if (k % GOP === GOP - 1) await drain(ring);
    }
    const s = await ring.seal(crypto.randomUUID(), 600_000);
    await ring.wipe();
    return s;
}

/** Media part durations in whole GOPs (2 s each), init part dropped. */
const gops = (durMs: number[]) => durMs.slice(1).map(d => Math.round(d / 2000));

describe('Ring.seal cuts the graduated first parts (PART_RAMP_FRAGMENTS)', () => {
    it('media parts 1-4 hold 1, 2, 4 and 8 keyframe intervals, then the rest', async () => {
        const s = await sealedRing();
        expect(s.parts[0].isInit).toBe(true);
        // A seal without the ramp cuts by the budget alone: 8, 8 and 1 GOPs.
        expect(gops(s.parts.map(p => p.durMs))).toEqual([1, 2, 4, 8, 2]);
        expect(s.info.partDurMs).toEqual(s.parts.map(p => p.durMs));
    }, 60_000);

    it('a clip the ramp would push past the reference limit is re-cut flat, not refused', async () => {
        limits.maxClipParts = 4; // ramped, this clip needs 6 parts; flat, 4
        const s = await sealedRing();
        expect(s.parts.length).toBe(4);
        expect(gops(s.parts.map(p => p.durMs))).toEqual([8, 8, 1]);
    }, 60_000);

    it('positive control: a clip that needs more parts than the limit even flat is still refused', async () => {
        limits.maxClipParts = 3;
        await expect(sealedRing()).rejects.toThrow(/clip needs 4 parts/);
    }, 60_000);
});

describe("the worker's trim keeps the graduated first parts", () => {
    it('a trimmed clip starts with 1, 2, 4 and 8 keyframe intervals too', async () => {
        const onmessage = (self as unknown as { onmessage: (ev: { data: unknown }) => Promise<void> }).onmessage;
        await onmessage({ data: { t: 'arm', cfg: { ...cfg, width: codedWidth, height: codedHeight }, video: null, audio: null } });
        // The worker's ring is private to the module: catch it as it ingests.
        const ingest = vi.spyOn(Ring.prototype, 'ingestNativeVideoChunk');
        for (let k = 0; k < FRAMES; k++) {
            await onmessage({ data: { t: 'nativeVideoChunk', ...chunk(k) } });
            if (k % GOP === GOP - 1) await drain(ingest.mock.contexts[0] as RingT);
        }
        ingest.mockRestore();
        await onmessage({ data: { t: 'seal', clipId: crypto.randomUUID(), requestedMs: 600_000 } });
        const sealed = posts.filter(p => p.t === 'sealed').pop() as unknown as { info: { partDurMs: number[] } } | undefined;
        expect(sealed, JSON.stringify(posts.filter(p => p.t !== 'status')).slice(0, 400)).toBeTruthy();
        expect(gops(sealed!.info.partDurMs)).toEqual([1, 2, 4, 8, 2]);
        posts.length = 0;
        // Cut the first GOP: 32 s are left, 16 GOPs.
        await onmessage({ data: { t: 'trim', startMs: 2_100, endMs: 40_000 } });
        const trimmed = posts.filter(p => p.t === 'sealed').pop() as unknown as { info: { partDurMs: number[]; durationMs: number } } | undefined;
        expect(trimmed, JSON.stringify(posts.filter(p => p.t !== 'status')).slice(0, 400)).toBeTruthy();
        // Without the ramp the trim cuts by the budget alone: 8 and 8 GOPs.
        expect(gops(trimmed!.info.partDurMs)).toEqual([1, 2, 4, 8, 1]);
        await onmessage({ data: { t: 'wipe' } });
    }, 60_000);
});
