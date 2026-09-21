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

describe('native ring: audio lands where it happened', () => {
    /** Worker-clock ms at which the agent's video ts 0 and the first audio
     *  sample happened. The worker never sees either directly. */
    const V0 = 612.345, A0 = 1_500;
    /** AudioData timestamps live on their own clock (measured: ~30 h at the
     *  first sample). */
    const RAW0 = 108_000_000_000;
    const AUDIO_US = 21_333;

    /** Feed 10 s of both streams in worker-time order, each sample arriving
     *  some ms after it happened (video's first 12 as a backlog, as the
     *  WASAPI-init queue delivers them), then seal. Returns, per audio packet,
     *  how far its clip time is from where it truly belongs, in ms. */
    /** `lead(j)`: the loopback scheduling lead, ms, sample j was rendered with
     *  (it renders that much after it happened); `reported(j)`: what the
     *  main thread tells the worker the lead was (defaults to the truth). */
    async function audioErrorsMs(audioOffsetUs: number, opts: { staleTail?: boolean; lead?: (j: number) => number; reported?: (j: number) => number; skip?: (j: number) => boolean; reportFrom?: number } = {}): Promise<number[]> {
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

        type Ev = { at: number; video?: number; audio?: number; sched?: number };
        const evs: Ev[] = [];
        // The first 450 ms of video wait in a queue (WASAPI init) and flush
        // in order at its end; after that each frame takes 3-17 ms to arrive.
        let prev = 0;
        for (let k = 0; k < 300; k++) {
            prev = Math.max(prev, V0 + 450, V0 + tsOf(k) / 1000 + 3 + ((k * 7) % 15));
            evs.push({ at: prev, video: k });
        }
        const lead = opts.lead ?? (() => 0);
        const reported = opts.reported ?? lead;
        // Sample j happens at A0 + j*21.333 ms and RENDERS lead(j) later; the
        // pump reads it 2-12 ms after that, and its AudioData timestamp is
        // the render time on the audio clock.
        for (let j = 0; j < 400; j++) evs.push({ at: A0 + (j * AUDIO_US) / 1000 + lead(j) + 2 + ((j * 5) % 10), audio: j });
        // nativeCapture reports a lead when it SCHEDULES a packet (capture order,
        // ~12 ms after the packet was captured), not when it renders: on a
        // drift reset the report with the small lead therefore comes AFTER
        // reports of old packets that will still render later than it.
        const from = opts.reportFrom ?? 0; // reports only exist from this sample on (system audio retried later)
        if (opts.lead) for (let j = from; j < 400; j++) if (j === from || reported(j) !== reported(j - 1) || j % 46 === 0) evs.push({ at: A0 + (j * AUDIO_US) / 1000 + 12, sched: j });
        evs.sort((a, b) => a.at - b.at);
        for (const e of evs) {
            clock = e.at;
            if (e.video !== undefined) ingestOne(ring, e.video);
            else if (e.sched !== undefined) {
                // The main thread's report for this packet: the EPOCH time it will
                // render at (the mocked performance.now is the worker's clock; the
                // two contexts share only timeOrigin's base) and the lead.
                const j = e.sched;
                ring.noteAudioLead({ renderAtMs: performance.timeOrigin + A0 + (j * AUDIO_US) / 1000 + lead(j), leadMs: reported(j) });
            } else {
                const j = e.audio!;
                ctrl.enqueue({ timestamp: RAW0 + j * AUDIO_US + Math.round(lead(j) * 1000), index: j, close() { } } as unknown as AudioData);
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
        // Sample j happened at A0 + j*21.333 ms; on the video timeline that is
        // (that - V0) ms after video ts 0, and the clip starts at frame 0.
        return packets.filter(p => !opts.skip?.(p.index)).map(p => (p.t * 1e6 - ((A0 + (p.index * AUDIO_US) / 1000 - V0) * 1000 - tsOf(0))) / 1000);
    }

    it('native audio is within a couple of ms of its video', async () => {
        const errs = await audioErrorsMs(0);
        // The residual is the difference between the two streams' fastest
        // transport (2 ms audio, 3 ms video here): -1 ms. Before the anchor it
        // was V0 plus the first audio read's latency, 614 ms late here (and
        // the picker's 40 ms on top in production).
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('the loopback scheduling lead is taken back out, per sample, through a lead jump', async () => {
        // The lead the desktop-audio player runs at (nativeCapture.ts): 80 ms,
        // then an underrun re-prime leaves it at 130 ms from sample 200 on.
        // Without the correction every sample would land that late.
        const errs = await audioErrorsMs(0, { lead: j => (j < 200 ? 80 : 130) });
        expect(errs.length).toBeGreaterThan(300);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('a drift RESET (the lead dropping 450 -> 50) is corrected on both sides of it', async () => {
        // nativeCapture re-primes the playhead once the lead passes MAX_BACKLOG_S:
        // the lead falls by ~450 ms in one packet and the reported render time
        // goes BACKWARDS with it. For the next ~400 ms the OLD packets (still
        // scheduled) and the NEW ones render together, so no single lead is
        // right there; the worker keeps its list sorted (drops what the reset
        // overwrote) so that everything AFTER the overlap gets the new lead
        // and everything before it kept the old one. Samples 182-199 are the
        // old tail inside the overlap and are excluded.
        const errs = await audioErrorsMs(0, { lead: j => (j < 200 ? 450 : 50), skip: j => j >= 182 && j < 200 });
        expect(errs.length).toBeGreaterThan(300);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('positive control: the correction uses the REPORTED lead', async () => {
        // Samples really render 120 ms late but the main thread reports 60:
        // the clip must show 60 ms of lateness, which proves the subtraction
        // takes the reported figure and nothing else.
        const errs = await audioErrorsMs(0, { lead: () => 120, reported: () => 60 });
        // 60 ms late, give or take the model's 1 ms transport difference.
        for (const e of errs) expect(Math.abs(e - 60)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('system audio that starts after a mic-only stretch: the earlier samples get no correction', async () => {
        // No loopback before sample 200 (mic only, no lead), then a retry
        // schedules with an 80 ms lead. The first report must not be applied
        // backwards: before it the lead was 0, from it 80 is taken out.
        // (The first version returned leads[0] before the first report and
        // pulled the whole mic-only stretch 80 ms early.)
        const errs = await audioErrorsMs(0, { lead: j => (j < 200 ? 0 : 80), reportFrom: 200 });
        expect(errs.length).toBeGreaterThan(300);
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('a stale chunk from the previous capture does not move the anchor', async () => {
        // Taken as a clock sample it would put audio 600 s late; the stale
        // keyframe would also have opened a unit ten minutes in the future.
        const errs = await audioErrorsMs(0, { staleTail: true });
        for (const e of errs) expect(Math.abs(e)).toBeLessThanOrEqual(2);
    }, 60_000);

    it('positive control: a configured offset shows up in the clip', async () => {
        // Proves the demuxed times are not normalised into agreement.
        const errs = await audioErrorsMs(300_000);
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
        await onmessage({ data: { t: 'audioLead', renderAtMs: 1234.5, leadMs: 88 } });
        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ renderAtMs: 1234.5, leadMs: 88 }));
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
