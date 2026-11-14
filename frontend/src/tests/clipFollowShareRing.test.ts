/**
 * The ring CARRIES ON from another video stream through the same encoder
 * (replayWorker.ts Ring.rebindVideo): the worker half of "one capture of a
 * surface, not two" (replayBuffer.ts followShareCapture, docs/CLIPS.md
 * "Sharing while armed"). The picker arm used to capture a surface a second
 * time beside a screen share of it; now it moves onto a clone of the share's
 * track, and this is what makes that move cost the clip nothing:
 *
 *  - the SAME VideoEncoder keeps going: no reconfigure, so the footage
 *    buffered before the move is still in every clip made after it;
 *  - the new stream's frames are put on the ring's timeline (their capture
 *    clock has its own origin), so a clip spanning the move is one
 *    continuous, increasing timeline, decrypted and demuxed through the
 *    real muxer to prove it;
 *  - the old stream is let go of (cancelled), so its frames stop entering
 *    the ring and its capture can stop;
 *  - a stream whose frames are NOT the encoder's size is refused and the
 *    old one kept, because taking it would reconfigure and cost the buffer;
 *  - a native ring takes no stream.
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

const posts: { t: string;[k: string]: unknown }[] = [];
vi.stubGlobal('self', { postMessage: (m: { t: string }) => posts.push(m), onmessage: null, close() { } });

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

/** A captured frame: which stream it came from and its number there. */
class FakeFrame {
    codedWidth: number; codedHeight: number; timestamp: number; src: string; n: number; closed = false;
    constructor(init: { w: number; h: number; ts: number; src: string; n: number }) {
        this.codedWidth = init.w; this.codedHeight = init.h; this.timestamp = init.ts; this.src = init.src; this.n = init.n;
    }
    close() { this.closed = true; }
}
/** `new VideoFrame(frame, { timestamp })`: the same picture, re-timed. */
class FakeVideoFrame extends FakeFrame {
    constructor(src: FakeFrame, init: { timestamp: number }) {
        super({ w: src.codedWidth, h: src.codedHeight, ts: init.timestamp, src: src.src, n: src.n });
    }
}
vi.stubGlobal('VideoFrame', FakeVideoFrame);

let keyAU: Uint8Array;
let deltaAUs: Uint8Array[];
let codec: string;
let W: number, H: number;

/** Every encoder made, and every frame each was given. Emits the fixture's
 *  access units (Annex-B, as the native path does), keyed as asked. */
const encoders: FakeEncoder[] = [];
class FakeEncoder {
    static async isConfigSupported() { return { supported: true }; }
    state = 'unconfigured'; encodeQueueSize = 0;
    got: { src: string; n: number; ts: number; key: boolean }[] = [];
    private first = true;
    constructor(private init: { output: (c: FakeChunk, m?: unknown) => void; error: (e: Error) => void }) { encoders.push(this); }
    configure() { this.state = 'configured'; }
    encode(f: FakeFrame, o: { keyFrame: boolean }) {
        this.got.push({ src: f.src, n: f.n, ts: f.timestamp, key: o.keyFrame });
        const data = (o.keyFrame ? keyAU : deltaAUs[this.got.length % deltaAUs.length]).slice();
        this.init.output(new FakeChunk({ type: o.keyFrame ? 'key' : 'delta', timestamp: f.timestamp, duration: 33_333, data }), this.first ? { decoderConfig: { codec, codedWidth: W, codedHeight: H } } : undefined);
        this.first = false;
    }
    async flush() { }
    close() { this.state = 'closed'; }
}
vi.stubGlobal('VideoEncoder', FakeEncoder);

type RingT = InstanceType<typeof import('../api/clips/replayWorker').Ring>;
type ArmConfig = Parameters<RingT['arm']>[0];
let Ring: typeof import('../api/clips/replayWorker').Ring;
let openPart: typeof import('../api/clips/clipCrypto').openPart;

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
    ({ openPart } = await import('../api/clips/clipCrypto'));
    const fixture = new Uint8Array(readFileSync(join(__dirname, 'fixtures', 'clip-avc-1s.mp4')));
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(fixture) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const dc = (await vt.getDecoderConfig())!;
    codec = dc.codec; W = dc.codedWidth!; H = dc.codedHeight!;
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
}, 30_000);

afterEach(() => { posts.length = 0; encoders.length = 0; });

const FRAME_US = 33_333;
const pickerCfg = (): ArmConfig => ({
    preset: { id: '1080p30', label: 'test', maxWidth: 1920, maxHeight: 1080, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    width: W, height: H, ringMs: 300_000, maxRingBytes: 512 * 1024 * 1024, audioOffsetUs: 0, audioCodec: 'mp4a.40.2',
});

/** A capture as a stream we feed by hand, and whether it was let go of. */
function source(name: string, originUs: number, w = W, h = H) {
    let ctl!: ReadableStreamDefaultController<FakeFrame>;
    const state = { cancelled: false, sent: 0 };
    const readable = new ReadableStream<FakeFrame>({
        start(c) { ctl = c; },
        cancel() { state.cancelled = true; },
    });
    const push = (count: number) => {
        for (let i = 0; i < count; i++) {
            const n = state.sent++;
            try { ctl.enqueue(new FakeFrame({ w, h, ts: originUs + n * FRAME_US, src: name, n })); } catch { /* cancelled */ }
        }
    };
    return { readable: readable as unknown as ReadableStream<VideoFrame>, push, state };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0)); };
async function drain(ring: RingT): Promise<void> {
    const r = ring as unknown as { closing: Promise<void>; pendingCloses: number };
    while (r.pendingCloses > 0) await r.closing;
}

async function demuxTimes(s: Awaited<ReturnType<RingT['seal']>>): Promise<number[]> {
    const plain: Uint8Array[] = [];
    for (const p of s.parts) plain.push(await openPart(s.secrets, p.index, p.wire));
    const all = new Uint8Array(plain.reduce((n, x) => n + x.length, 0));
    let w = 0;
    for (const x of plain) { all.set(x, w); w += x.length; }
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(all) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const ts: number[] = [];
    for await (const p of new EncodedPacketSink(vt).packets()) ts.push(Math.round(p.timestamp * 1e6));
    return ts;
}

describe('Ring.rebindVideo: the ring carries on from another stream', () => {
    it('keeps the same encoder, lets the old stream go, and a clip across the move is whole and continuous', async () => {
        const ring = new Ring();
        const own = source('own', 5_000_000);
        await ring.arm(pickerCfg(), own.readable, null);
        // Three keyframe intervals of its own capture.
        for (let g = 0; g < 3; g++) { own.push(60); await settle(); await drain(ring); }
        expect(encoders).toHaveLength(1);
        const before = encoders[0].got.length;
        expect(before).toBe(180);

        // The share's clone: a capture clock with a wholly different origin.
        const share = source('share', 90_000_000_000);
        const done = ring.rebindVideo(7, share.readable);
        share.push(1);
        await done;
        expect(posts.find(p => p.t === 'videoRebound')).toMatchObject({ seq: 7, ok: true });
        await settle();
        expect(own.state.cancelled).toBe(true);
        // The old stream stops entering the ring the moment it is let go of.
        own.push(10);
        for (let g = 0; g < 3; g++) { share.push(60); await settle(); await drain(ring); }

        const got = encoders[0].got;
        expect(encoders).toHaveLength(1); // never reconfigured: the same encoder throughout
        expect(posts.some(p => p.t === 'reconfigured')).toBe(false);
        expect(got.slice(before).every(g => g.src === 'share')).toBe(true);
        expect(got.filter(g => g.src === 'share')).toHaveLength(181);
        // One increasing timeline, one frame apart across the move.
        for (let i = 1; i < got.length; i++) expect(got[i].ts).toBeGreaterThan(got[i - 1].ts);
        const gap = got[before].ts - got[before - 1].ts;
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThan(FRAME_US * 3);

        // A clip of the whole ring: its own capture AND the share's, as one.
        const s = await ring.seal(crypto.randomUUID(), 600_000);
        const ts = await demuxTimes(s);
        for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
        expect(ts.length).toBeGreaterThanOrEqual(360);
        expect(s.info.lostMs).toBe(0);
        expect(ts[ts.length - 1] - ts[0]).toBeGreaterThan(11_000_000);
        await ring.wipe();
    });

    it('refuses a stream of another size and keeps reading the one it had', async () => {
        const ring = new Ring();
        const own = source('own', 1_000_000);
        await ring.arm(pickerCfg(), own.readable, null);
        own.push(30); await settle();
        const small = source('small', 7_000_000, W / 2, H / 2);
        const done = ring.rebindVideo(3, small.readable);
        small.push(1);
        await done;
        expect(posts.find(p => p.t === 'videoRebound')).toMatchObject({ seq: 3, ok: false, reason: 'size', width: W / 2, height: H / 2 });
        await settle();
        expect(small.state.cancelled).toBe(true);
        expect(own.state.cancelled).toBe(false);
        own.push(30); await settle();
        expect(encoders).toHaveLength(1);
        expect(encoders[0].got.filter(g => g.src === 'own')).toHaveLength(60);
        expect(encoders[0].got.some(g => g.src === 'small')).toBe(false);
        expect(posts.some(p => p.t === 'reconfigured')).toBe(false);
        await ring.wipe();
    });

    it('a native ring takes no stream', async () => {
        const ring = new Ring();
        await ring.arm({ ...pickerCfg(), nativeVideo: { fps: 30 } }, null, null);
        const share = source('share', 1);
        await ring.rebindVideo(1, share.readable);
        expect(posts.find(p => p.t === 'videoRebound')).toMatchObject({ ok: false, reason: 'native' });
        expect(share.state.cancelled).toBe(true);
        await ring.wipe();
    });

    it('a stream that ends before a frame is refused, and the old one kept', async () => {
        const ring = new Ring();
        const own = source('own', 1_000_000);
        await ring.arm(pickerCfg(), own.readable, null);
        own.push(5); await settle();
        const empty = new ReadableStream<VideoFrame>({ start(c) { c.close(); } });
        await ring.rebindVideo(2, empty);
        expect(posts.find(p => p.t === 'videoRebound')).toMatchObject({ ok: false, reason: 'ended' });
        own.push(5); await settle();
        expect(encoders[0].got).toHaveLength(10);
        await ring.wipe();
    });
});
