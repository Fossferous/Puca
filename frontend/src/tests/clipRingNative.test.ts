/**
 * The replay ring on the NATIVE (auto-arm) path, driven with real H.264 access
 * units from the fixture and sealed through the real muxer and crypto, then
 * decrypted and demuxed again so every assertion is on what a viewer gets.
 *
 * What these pin, each shown red on the code before the fix:
 *  - a Clip press leaves no hole in the ring. The native path cannot force a
 *    keyframe, so closing the open GOP at the press lost everything up to the
 *    agent's next timed keyframe (up to 2 s) from every LATER clip spanning it,
 *    and a seal that failed part-way did the same;
 *  - a seal contains exactly the footage that existed when it was asked for,
 *    even when GOPs close and the full ring evicts while it is still muxing;
 *  - native audio lands on the video timeline where it happened: its clock and
 *    the agent's are anchored by measurement, not by the worker's time origin;
 *  - the status bitrate counts native video bytes once, and the picker path's
 *    video bytes still count.
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

// The worker module posts to `self`; in jsdom that is window, whose
// postMessage wants two arguments. Record instead.
const posts: { t: string;[k: string]: unknown }[] = [];
vi.stubGlobal('self', { postMessage: (m: { t: string }) => posts.push(m), onmessage: null, close() { } });

/** Stand-ins for WebCodecs (jsdom has none). */
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

/** An AudioEncoder that emits one chunk per input, stamped with the input's
 *  timestamp and carrying the input's index (so a demuxed packet says which
 *  sample it was). */
let aacConfig: AudioDecoderConfig;
class FakeAudioEncoder {
    static async isConfigSupported() { return { supported: true }; }
    state = 'configured';
    private first = true;
    constructor(private init: { output: (c: FakeChunk, m?: unknown) => void; error: (e: Error) => void }) { }
    configure() { }
    encode(d: { timestamp: number; index: number }) {
        const data = new Uint8Array(8);
        new DataView(data.buffer).setUint32(0, d.index);
        this.init.output(new FakeChunk({ type: 'key', timestamp: d.timestamp, duration: 21_333, data }), this.first ? { decoderConfig: aacConfig } : undefined);
        this.first = false;
    }
    async flush() { }
    close() { this.state = 'closed'; }
}
vi.stubGlobal('AudioEncoder', FakeAudioEncoder);

type RingT = InstanceType<typeof import('../api/clips/replayWorker').Ring>;
let Ring: typeof import('../api/clips/replayWorker').Ring;
let openPart: typeof import('../api/clips/clipCrypto').openPart;

// ---- the fixture as a native Annex-B stream ---------------------------------
let keyAU: Uint8Array;          // IDR with SPS/PPS in front, as the agent sends it
let deltaAUs: Uint8Array[];     // the fixture's non-key frames
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
    ({ openPart } = await import('../api/clips/clipCrypto'));
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
    const at = (await input.getPrimaryAudioTrack())!;
    aacConfig = (await at.getDecoderConfig())!;
    expect(keyAU).toBeTruthy();
    expect(deltaAUs.length).toBeGreaterThan(5);
    expect(aacConfig.description).toBeTruthy();
}, 30_000);

afterEach(() => { posts.length = 0; vi.restoreAllMocks(); });

// ---- helpers ------------------------------------------------------------------
const FRAME_US = 33_333;
const GOP = 60; // the agent forces a keyframe every 2 s at 30 fps
const tsOf = (k: number) => 1_000 + k * FRAME_US; // native ts: never 0 at the first chunk
const frameOf = (tsUs: number) => Math.round((tsUs - 1_000) / FRAME_US);

async function armNative(opts: { ringMs?: number; audioOffsetUs?: number; audio?: ReadableStream<AudioData> | null } = {}): Promise<RingT> {
    const ring = new Ring();
    await ring.arm({
        preset: { id: '1440p30', label: 'test', maxWidth: 2560, maxHeight: 1440, fps: 30, videoBitrate: 8_000_000, audioBitrate: 128_000 },
        width: codedWidth, height: codedHeight, ringMs: opts.ringMs ?? 300_000, maxRingBytes: 512 * 1024 * 1024,
        audioOffsetUs: opts.audioOffsetUs ?? 0, audioCodec: 'mp4a.40.2', nativeVideo: { fps: 30 },
    }, null, opts.audio ?? null);
    return ring;
}

function ingestOne(ring: RingT, k: number): void {
    const key = k % GOP === 0;
    const bytes = (key ? keyAU : deltaAUs[k % deltaAUs.length]).slice().buffer;
    ring.ingestNativeVideoChunk({ keyframe: key, tsUs: tsOf(k), durUs: FRAME_US, bytes, ...(k === 0 ? { codec, codedWidth, codedHeight } : {}) });
}
function ingest(ring: RingT, from: number, to: number): void {
    for (let k = from; k <= to; k++) ingestOne(ring, k);
}

/** Every queued GOP close finished (crypto is async). */
async function drain(ring: RingT): Promise<void> {
    const r = ring as unknown as { closing: Promise<void>; pendingCloses: number };
    while (r.pendingCloses > 0) await r.closing;
}

/** Every copy of the open unit a seal takes (they are registered in
 *  sealTails), so a test can check they end up zero-filled. */
function captureTails(ring: RingT): Uint8Array[] {
    const set = (ring as unknown as { sealTails: Set<Uint8Array> }).sealTails;
    const tails: Uint8Array[] = [];
    const add = set.add.bind(set);
    set.add = (p: Uint8Array) => { tails.push(p); return add(p); };
    return tails;
}

const gopsOf = (ring: RingT) => (ring as unknown as { gops: { startUs: number; endUs: number }[] }).gops;

/** Decrypt a sealed clip and demux it: video frame indices (recovered from
 *  the clip's own timestamps, relative to its first frame), and each audio
 *  packet's clip time with the sample index its payload carries. */
async function demux(s: Awaited<ReturnType<RingT['seal']>>, firstFrame: number) {
    const plain: Uint8Array[] = [];
    for (const p of s.parts) plain.push(await openPart(s.secrets, p.index, p.wire));
    const all = new Uint8Array(plain.reduce((n, x) => n + x.length, 0));
    let w = 0;
    for (const x of plain) { all.set(x, w); w += x.length; }
    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(all) });
    const vt = (await input.getPrimaryVideoTrack())!;
    const video: number[] = [];
    let v0: number | null = null;
    for await (const p of new EncodedPacketSink(vt).packets()) {
        v0 ??= p.timestamp;
        video.push(firstFrame + Math.round(((p.timestamp - v0) * 1e6) / FRAME_US));
    }
    const audio: { t: number; index: number }[] = [];
    const at = await input.getPrimaryAudioTrack();
    if (at) for await (const p of new EncodedPacketSink(at).packets()) {
        audio.push({ t: p.timestamp - v0!, index: new DataView(p.data.buffer, p.data.byteOffset).getUint32(0) });
    }
    return { video, audio };
}

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const seal = (ring: RingT, ms = 600_000) => ring.seal(crypto.randomUUID(), ms);

describe('native ring: a Clip press leaves no hole', () => {
    it('a later clip spanning an earlier press has every frame', async () => {
        const ring = await armNative();
        const tails = captureTails(ring);
        ingest(ring, 0, 159);             // the press lands mid-GOP (last key at 120)
        await drain(ring);
        expect((await demux(await seal(ring), 0)).video).toEqual(range(0, 159)); // the clip just made was always whole
        // The seal's copy of the open unit is zero-filled once the clip is made.
        expect(tails.length).toBe(1);
        expect(tails[0].length).toBeGreaterThan(0);
        expect(tails[0].every(b => b === 0)).toBe(true);
        // The open unit's per-chunk plaintext is zero-filled when it closes.
        const openParts = [...(ring as unknown as { open: { videoParts: Uint8Array[] } }).open.videoParts];
        expect(openParts.some(p => p.some(b => b !== 0))).toBe(true); // positive control

        ingest(ring, 160, 359);           // keys only at 180, 240, 300: none forced
        await drain(ring);
        expect(openParts.every(p => p.every(b => b === 0))).toBe(true);
        // Frames 160-179 went missing before the fix: the press closed the open
        // GOP and every delta until the next keyframe had nowhere to go.
        expect((await demux(await seal(ring), 0)).video).toEqual(range(0, 359));
        await ring.wipe();
    }, 60_000);

    it('a seal that fails part-way leaves the ring whole', async () => {
        const ring = await armNative();
        ingest(ring, 0, 159);
        await drain(ring);
        const tails = captureTails(ring);
        const subtle = globalThis.crypto.subtle;
        const spy = vi.spyOn(subtle, 'decrypt').mockRejectedValueOnce(new Error('injected'));
        await expect(seal(ring)).rejects.toThrow('injected');
        spy.mockRestore();
        expect(tails.length).toBe(1);
        expect(tails[0].every(b => b === 0)).toBe(true); // a failed seal zero-fills its copy too
        // "Try again" in the composer seals a window that spans the failure.
        ingest(ring, 160, 239);
        await drain(ring);
        expect((await demux(await seal(ring), 0)).video).toEqual(range(0, 239));
        const t = ring as unknown as { sealTails: Set<Uint8Array>; sealsInFlight: number };
        expect(t.sealTails.size).toBe(0);
        expect(t.sealsInFlight).toBe(0);
        await ring.wipe();
    }, 60_000);
});

describe('native ring: a seal after the ring failed', () => {
    it('rejects instead of waiting forever on a close that was never queued', async () => {
        const ring = await armNative();
        // Five GOPs closed in one synchronous burst: over the pending-close
        // cap, so the fifth is refused and the ring fails.
        ingest(ring, 0, 300);
        expect(posts.some(p => p.t === 'error' && p.stage === 'crypto')).toBe(true); // the cap really tripped
        await expect(seal(ring)).rejects.toThrow('the buffer stopped');
        await ring.wipe();
        // The refused close was counted back out (the seal's wait also stops
        // on `fatal`, so the rejection above does not pin this on its own).
        expect((ring as unknown as { pendingCloses: number }).pendingCloses).toBe(0);
    }, 30_000);
});

describe('native ring: a seal contains exactly what existed when it was asked for', () => {
    it('GOPs that close, and the evictions they cause, while the seal is muxing change nothing', async () => {
        const ring = await armNative({ ringMs: 6_000 }); // three 2 s GOPs: the ring is full and rotating
        ingest(ring, 0, 299);
        await drain(ring);
        const firstKept = frameOf(gopsOf(ring)[0].startUs);
        expect(firstKept).toBe(60); // positive control: the ring really has evicted

        // Before each unit the seal decrypts, a whole GOP arrives and closes
        // (evicting the oldest, on the old code), as frames do while a long
        // clip muxes. Deterministic, rather than a race against a timer.
        const subtle = globalThis.crypto.subtle;
        const decrypt = subtle.decrypt.bind(subtle);
        let next = 300;
        const spy = vi.spyOn(subtle, 'decrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['decrypt']>) => {
            ingest(ring, next, next + GOP - 1);
            next += GOP;
            await drain(ring);
            return decrypt(...args);
        });
        const sealed = await seal(ring);
        spy.mockRestore();

        expect(next).toBeGreaterThanOrEqual(300 + 3 * GOP); // at least two post-press GOPs closed mid-seal
        // Exactly frames 60..299: none after the press, none skipped.
        expect((await demux(sealed, firstKept)).video).toEqual(range(firstKept, 299));
        // ...and eviction caught up once the seal was done.
        const g = gopsOf(ring);
        expect(g[g.length - 1].endUs - g[0].startUs).toBeLessThanOrEqual(6_000_000);
        await ring.wipe();
    }, 60_000);
});

describe('native ring: audio lands where it happened, on one continuous timeline', () => {
    /** Worker-clock ms at which the agent's video ts 0 and the first audio
     *  frame RENDERED. The worker never sees either directly. */
    const V0 = 612.345, A0 = 1_500;
    /** AudioData timestamps live on their own clock (measured: ~30 h at the
     *  first sample). */
    const RAW0 = 108_000_000_000;
    const AUDIO_US = 21_333;
    const FRAMES = 400;

    /** A stretch of the loopback's render timeline (nativeCapture.ts): from
     *  render frame `at`, `silence` frames of rendered silence (an underrun's
     *  gap, or a reset's re-prime), then content captured `lead` ms before it
     *  renders. `reported`: the lead its start report carries (a prime
     *  reports JITTER_S and learns the rest); `grow`: growth reports, `after`
     *  frames into the segment. `unreported`: no report at all (mic only). */
    type Seg = { at: number; lead: number; silence?: number; reported?: number; grow?: { after: number; lead: number }[]; unreported?: boolean };

    /** Feed 10 s of video and FRAMES audio frames in worker-time order —
     *  the audio as the mix renders it: one CONTINUOUS timeline, each frame
     *  read by the pump 2-12 ms after it renders — with the lead reports
     *  the main thread makes, then seal and demux. Per content frame: how
     *  far its clip time is from where it truly belongs, in ms; plus the
     *  clip's audio continuity (every step between packets that is not one
     *  frame long) and how many silence frames made it into the clip. */
    async function renderedAudio(audioOffsetUs: number, segs: Seg[], opts: { staleTail?: boolean } = {}) {
        let clock = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => clock);
        let ctrl!: ReadableStreamDefaultController<AudioData>;
        const audio = new ReadableStream<AudioData>({ start(c) { ctrl = c; } }, { highWaterMark: 0 });
        const ring = await armNative({ audioOffsetUs, audio });
        if (opts.staleTail) {
            // "Restart buffer": the previous capture's last chunks (its clock
            // 10 minutes in) reach the new ring before the new capture's
            // first, a codec-bearing keyframe among them.
            clock = V0 + 440;
            // Its own codec string and size, so a restart that kept the old
            // capture's configuration would show in the sealed clip.
            const staleCodec = codec === 'avc1.640033' ? 'avc1.64002A' : 'avc1.640033';
            const stale = (k: number, key: boolean) => ring.ingestNativeVideoChunk({
                keyframe: key, tsUs: 600_000_000 + k * FRAME_US, durUs: FRAME_US,
                bytes: (key ? keyAU : deltaAUs[0]).slice().buffer,
                ...(key ? { codec: staleCodec, codedWidth: codedWidth + 16, codedHeight } : {}),
            });
            stale(-1, false);
            stale(0, true);
            stale(1, false);
        }

        const R = (f: number) => A0 + (f * AUDIO_US) / 1000;
        const segOf = (f: number) => segs.filter(g => g.at <= f).at(-1)!;
        /** Frame f's content: when it was captured (worker ms), or null for silence. */
        const captured = (f: number): number | null => {
            const g = segOf(f);
            return f < g.at + (g.silence ?? 0) ? null : R(f) - g.lead;
        };
        type Ev = { at: number; video?: number; audio?: number; report?: { renderAtMs: number; leadMs: number; newSegment: boolean } };
        const evs: Ev[] = [];
        // The first 450 ms of video wait in a queue (WASAPI init) and flush
        // in order at its end; after that each frame takes 3-17 ms to arrive.
        let prev = 0;
        for (let k = 0; k < 300; k++) {
            prev = Math.max(prev, V0 + 450, V0 + tsOf(k) / 1000 + 3 + ((k * 7) % 15));
            evs.push({ at: prev, video: k });
        }
        for (let f = 0; f < FRAMES; f++) evs.push({ at: R(f) + 2 + ((f * 5) % 10), audio: f });
        // The main thread's reports, when it makes them: a segment's start when
        // its priming packet is scheduled (50 ms before it renders), growth when
        // the packet that showed it is — never before the report ahead of it,
        // because packets arrive in capture order (the packets that show an
        // underrun's lead arrive in the burst right BEHIND its priming one).
        // Render times go out as EPOCH ms (the mocked performance.now is the
        // worker's clock; the two contexts share only timeOrigin's base).
        let lastReport = -Infinity;
        const report = (at: number, r: NonNullable<Ev['report']>) => { lastReport = Math.max(at, lastReport + 0.01); evs.push({ at: lastReport, report: r }); };
        for (const g of segs) {
            if (g.unreported) continue;
            const primed = g.at + (g.silence ?? 0);
            report(R(primed) - 50, { renderAtMs: performance.timeOrigin + R(g.at), leadMs: g.reported ?? g.lead, newSegment: true });
            for (const x of g.grow ?? []) report(R(g.at + x.after) - x.lead, { renderAtMs: performance.timeOrigin + R(g.at + x.after), leadMs: x.lead, newSegment: false });
        }
        evs.sort((a, b) => a.at - b.at);
        for (const e of evs) {
            clock = e.at;
            if (e.video !== undefined) ingestOne(ring, e.video);
            else if (e.report) ring.noteAudioLead(e.report);
            else {
                const f = e.audio!;
                ctrl.enqueue({ timestamp: RAW0 + f * AUDIO_US, index: f, close() { } } as unknown as AudioData);
                await new Promise(r => setTimeout(r, 0)); // the pump reads it at THIS clock
            }
        }
        await drain(ring);
        if (opts.staleTail) {
            // The stale unit (ten minutes in the future) never entered the
            // ring, so eviction, window selection and the buffered readout
            // all see one timeline.
            expect(gopsOf(ring).every(g => g.startUs < 600_000_000)).toBe(true);
        }
        const sealed = await seal(ring);
        if (opts.staleTail) {
            expect(sealed.info.lostMs).toBe(0);
            expect(sealed.videoCodec).toBe(codec); // the new capture's configuration
        }
        const { video, audio: packets } = await demux(sealed, 0);
        expect(video).toEqual(range(0, 299));
        expect(packets.length).toBeGreaterThan(300);
        await ring.wipe();
        // Content captured at C ms (worker clock) belongs (C - V0) ms after
        // video ts 0 on the video timeline, and the clip starts at frame 0.
        const errs = packets.filter(p => captured(p.index) !== null)
            .map(p => (p.t * 1e6 - ((captured(p.index)! - V0) * 1000 - tsOf(0))) / 1000);
        // Continuity: a packet lasts until the next one starts, and each holds one frame.
        const steps = packets.slice(1).map((p, i) => Math.round((p.t - packets[i].t) * 1e6) - AUDIO_US).filter(d => Math.abs(d) > 100);
        return { errs, steps, silenceInClip: packets.filter(p => captured(p.index) === null).length, packets: packets.length };
    }
    const HALF_FRAME_MS = AUDIO_US / 2000;

    it('native audio is within a couple of ms of its video', async () => {
        const { errs, steps } = await renderedAudio(0, [{ at: 0, lead: 0, unreported: true }]);
        // The residual is the difference between the two streams' fastest
        // transport (2 ms audio, 3 ms video here): -1 ms. Before the anchor it
        // was V0 plus the first audio read's latency, 614 ms late here (and
        // the picker's 40 ms on top in production).
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
        expect(steps).toEqual([]);
    }, 60_000);

    it("the loopback's lead is taken back out, and a lead learnt after its segment began governs all of it", async () => {
        // A prime reports JITTER_S (50 ms); the packets bunched up behind it
        // show the segment's real lead (80 ms) over its next frames. Every
        // frame of the segment was rendered 80 ms after capture, the early
        // ones included.
        const { errs, steps } = await renderedAudio(0, [{ at: 0, lead: 80, reported: 50, grow: [{ after: 3, lead: 62 }, { after: 6, lead: 80 }] }]);
        expect(errs.length).toBeGreaterThan(300);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
        expect(steps, 'no frame is cut short or stretched').toEqual([]);
    }, 60_000);

    it("an underrun: the rendered silence is dropped and the audio either side joins up", async () => {
        // The loopback ran dry at frame 200: three frames of silence rendered
        // before the next packet, which re-primed with the lead 3 frames
        // bigger. Nothing was lost — the audio after the gap is the audio
        // that was late — so the clip plays it straight on.
        const { errs, steps, silenceInClip } = await renderedAudio(0, [
            { at: 0, lead: 80 },
            { at: 200, silence: 3, lead: 80 + (3 * AUDIO_US) / 1000, reported: 50, grow: [{ after: 5, lead: 80 + (3 * AUDIO_US) / 1000 }] },
        ]);
        expect(errs.length).toBeGreaterThan(300);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
        expect(silenceInClip, 'the underrun silence is not in the clip').toBe(0);
        expect(steps, 'one continuous timeline across the seam').toEqual([]);
    }, 60_000);

    it('a drift RESET (the lead dropping 450 -> 43) keeps each side where it happened and the lost backlog as one hole', async () => {
        // nativeCapture re-primes once the lead passes MAX_BACKLOG_S: the
        // backlog still scheduled is STOPPED (lost), two frames of silence
        // render while the next packet primes, and the new lead is about
        // JITTER_S. The clip keeps both sides where they happened, with the
        // lost stretch as the one hole in it.
        const newLead = (2 * AUDIO_US) / 1000;
        const { errs, steps } = await renderedAudio(0, [{ at: 0, lead: 450 }, { at: 200, silence: 2, lead: newLead }]);
        expect(errs.length).toBeGreaterThan(300);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
        expect(steps.length, `steps ${steps.join(', ')}`).toBe(1);
        expect(steps[0] / 1000).toBeCloseTo(450 - newLead, 0);
    }, 60_000);

    it('a lead that creeps up (the clocks drifting) keeps the timeline whole, within half a frame', async () => {
        // Reported 5 ms at a time, as nativeCapture does. Each step is
        // absorbed until the shift it owes reaches half a frame; then one
        // frame is dropped and the rest follow on.
        const grow = Array.from({ length: 12 }, (_, i) => ({ after: 30 * (i + 1), lead: 60 + 5 * (i + 1) }));
        const { errs, steps } = await renderedAudio(0, [{ at: 0, lead: 60, grow }]);
        expect(errs.length).toBeGreaterThan(300);
        expect(steps).toEqual([]);
        // The truth moves with the reported lead, and a placement is never
        // more than half a frame (plus the model's transport) away from it.
        const truthLead = (f: number) => 60 + 5 * Math.min(12, Math.floor(f / 30));
        expect(truthLead(399)).toBe(120);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(60 + HALF_FRAME_MS + 2);
    }, 60_000);

    it('positive control: the correction uses the REPORTED lead', async () => {
        // Frames really render 120 ms after capture but the main thread
        // reports 60: the clip must show 60 ms of lateness, which proves the
        // subtraction takes the reported figure and nothing else.
        const { errs } = await renderedAudio(0, [{ at: 0, lead: 120, reported: 60 }]);
        for (const e of errs) expect(Math.abs(e - 60)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('system audio that starts after a mic-only stretch: the earlier frames get no correction', async () => {
        // No loopback before frame 200 (mic only, no lead), then a retry
        // schedules with an 80 ms lead and the mic delay ramps up to it: the
        // ramp's four frames are the mic stretched, dropped at the seam. The
        // first report must not be applied backwards: before it the lead was
        // 0. (The first version returned leads[0] before the first report and
        // pulled the whole mic-only stretch 80 ms early.)
        const { errs, steps } = await renderedAudio(0, [{ at: 0, lead: 0, unreported: true }, { at: 200, silence: 4, lead: 80 }]);
        expect(errs.length).toBeGreaterThan(300);
        const before = errs.slice(0, 190), after = errs.slice(-150);
        for (const e of before) expect(Math.abs(e)).toBeLessThanOrEqual(2);
        for (const e of after) expect(Math.abs(e)).toBeLessThanOrEqual(HALF_FRAME_MS + 2);
        expect(steps).toEqual([]);
    }, 60_000);

    it('a stale chunk from the previous capture does not move the anchor', async () => {
        // Taken as a clock sample it would put audio 600 s late; the stale
        // keyframe would also have opened a unit ten minutes in the future.
        const { errs } = await renderedAudio(0, [{ at: 0, lead: 0, unreported: true }], { staleTail: true });
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('positive control: a configured offset shows up in the clip', async () => {
        // Proves the demuxed times are not normalised into agreement.
        const { errs } = await renderedAudio(300_000, [{ at: 0, lead: 0, unreported: true }]);
        for (const e of errs) expect(e).toBeCloseTo(299, 0);
    }, 60_000);
});

describe("the worker wires the main thread's lead reports to the ring", () => {
    it('an audioLead message reaches the armed ring', async () => {
        // The ring tests above call noteAudioLead directly; this pins the one
        // line that connects it to replayBuffer's leadReporter messages.
        const spy = vi.spyOn(Ring.prototype, 'noteAudioLead');
        const onmessage = (self as unknown as { onmessage: (ev: { data: unknown }) => Promise<void> }).onmessage;
        await onmessage({ data: { t: 'arm', cfg: { preset: { id: '1440p30', label: 'test', maxWidth: 2560, maxHeight: 1440, fps: 30, videoBitrate: 8_000_000, audioBitrate: 128_000 }, width: codedWidth, height: codedHeight, ringMs: 60_000, maxRingBytes: 64 << 20, audioOffsetUs: 0, audioCodec: 'aac', nativeVideo: { fps: 30 } }, video: null, audio: null } });
        await onmessage({ data: { t: 'audioLead', renderAtMs: 1234.5, leadMs: 88, newSegment: true } });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ renderAtMs: 1234.5, leadMs: 88, newSegment: true }));
        await onmessage({ data: { t: 'wipe' } });
        spy.mockRestore();
    });
});

describe('native ring: the status bitrate', () => {
    it('counts native video bytes once', async () => {
        const ring = await armNative();
        ingest(ring, 0, 29);
        const sent = range(0, 29).map(k => (k % GOP === 0 ? keyAU : deltaAUs[k % deltaAUs.length]).byteLength).reduce((a, b) => a + b, 0);
        (ring as unknown as { emitStatus(): void }).emitStatus();
        const status = posts.filter(p => p.t === 'status').pop() as unknown as { s: { kbps: number; fps: number } };
        expect(status.s.fps).toBe(30);
        expect(status.s.kbps).toBeCloseTo((sent * 8) / 1000, 6);
        await ring.wipe();
    }, 30_000);

    it('positive control: a picker-path chunk still counts its bytes', async () => {
        // The picker path's video bytes are counted in onVideoChunk and nowhere
        // else; a fix that deleted THAT count would pass the test above.
        const ring = new Ring() as unknown as { cfg: unknown; bytesThisSec: number; onVideoChunk(c: FakeChunk): void };
        ring.cfg = { preset: { fps: 30 }, maxRingBytes: 1 << 30, ringMs: 300_000 };
        ring.onVideoChunk(new FakeChunk({ type: 'key', timestamp: 0, duration: FRAME_US, data: keyAU }));
        expect(ring.bytesThisSec).toBe(keyAU.byteLength);
    });
});
