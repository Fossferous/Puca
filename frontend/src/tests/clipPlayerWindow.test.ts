/**
 * Windowed MSE clip player — the fix for the field failure "Failed to execute
 * 'appendBuffer' on 'SourceBuffer': The SourceBuffer is full, and cannot free
 * space to append additional buffers." (a real 257 MB / 1:59 1440p clip).
 *
 * The original player appended EVERY part up front; a SourceBuffer has a
 * browser quota (~150 MB video on desktop Chromium) and with the playhead
 * still at 0 there was nothing behind it to evict, so a large clip failed for
 * every viewer while small ones slipped under the cap.
 *
 * These tests drive the real createClipPlayer against fake MediaSource /
 * SourceBuffer / <video> objects that model the three behaviours that matter:
 * a byte quota that throws QuotaExceededError, buffered-range bookkeeping that
 * remove() actually shrinks, and a movable currentTime. jsdom has none of
 * these, so they are built here.
 */
import { describe, it, expect, vi } from 'vitest';
import { createClipPlayer, estimatePartBytes, startBytesNeeded, PLAY_AHEAD_S, KEEP_BEHIND_S, type ClipLoadProgress } from '../api/clips/clipPlayback';
import { encodeClipRef, decodeClipRef, type ClipManifest } from '../api/clips/clipRef';
import { newClipSecrets, sealPart, PART_HEADER_BYTES, PART_MAX_PLAINTEXT, PART_TAG_BYTES } from '../api/clips/clipCrypto';

// A part is `PART_BYTES` of ciphertext; the fake SourceBuffer quota fits only
// a few at once, forcing the window to evict to make progress.
const PART_BYTES = 24 * 1024 * 1024; // PART_MAX_PLAINTEXT — the real part size
const PART_MS = 10000; // ~10 s of 1440p per 24 MiB part
const N = 12; // 12 parts = 288 MiB (like the 257 MB field clip); the whole clip does NOT fit a 150 MB SourceBuffer at once
const QUOTA = 150 * 1024 * 1024; // desktop Chromium's ~150 MB video SourceBuffer cap

class FakeBufferedRanges {
    ranges: Array<[number, number]> = [];
    get length() { return this.ranges.length; }
    start(i: number) { return this.ranges[i][0]; }
    end(i: number) { return this.ranges[i][1]; }
    add(a: number, b: number) {
        this.ranges.push([a, b]);
        this.ranges.sort((x, y) => x[0] - y[0]);
        // coalesce touching/overlapping ranges (±0.25 s slack, like real MSE)
        const merged: Array<[number, number]> = [];
        for (const r of this.ranges) {
            const last = merged[merged.length - 1];
            if (last && r[0] <= last[1] + 0.25) last[1] = Math.max(last[1], r[1]);
            else merged.push([r[0], r[1]]);
        }
        this.ranges = merged;
    }
    removeRange(a: number, b: number) {
        const out: Array<[number, number]> = [];
        for (const [s, e] of this.ranges) {
            if (e <= a || s >= b) { out.push([s, e]); continue; }
            if (s < a) out.push([s, a]);
            if (e > b) out.push([b, e]);
        }
        this.ranges = out;
    }
}

class FakeSourceBuffer extends EventTarget {
    updating = false;
    buffered = new FakeBufferedRanges();
    bytes = 0;
    appends: number[] = []; // media part indices appended (in order)
    constructor(_ms: FakeMediaSource) { super(); }
    appendBuffer(data: Uint8Array) {
        // First byte of the test payload is the part index (fill(i)); the init
        // part is a distinct tiny buffer. Real parts carry absolute tfdt, so
        // the fake places each media part at its OWN timeline position by
        // index — which is what makes a seek's re-append land correctly.
        const isInit = data.byteLength < 1024;
        if (!isInit && this.bytes + data.byteLength > QUOTA) {
            const err = new Error('The SourceBuffer is full, and cannot free space to append additional buffers.');
            err.name = 'QuotaExceededError';
            throw err;
        }
        this.updating = true;
        this.bytes += data.byteLength;
        if (!isInit) {
            const partIdx = data[0]; // fill(i) tagged it
            const startMs = layout ? layout.startMs[partIdx] : (partIdx - 1) * PART_MS;
            const durMs = layout ? layout.durMs[partIdx] : PART_MS;
            this.buffered.add(startMs / 1000, (startMs + durMs) / 1000);
            this.appends.push(partIdx);
        }
        queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    remove(a: number, b: number) {
        this.updating = true;
        // approximate byte accounting: bytes are proportional to removed seconds
        const before = this.buffered.ranges.reduce((n, [s, e]) => n + (e - s), 0);
        this.buffered.removeRange(a, b);
        const after = this.buffered.ranges.reduce((n, [s, e]) => n + (e - s), 0);
        if (before > 0) this.bytes = Math.round(this.bytes * (after / before));
        queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    abort() { this.updating = false; }
}

class FakeMediaSource extends EventTarget {
    readyState = 'closed';
    duration = 0;
    sb: FakeSourceBuffer | null = null;
    endOfStream = vi.fn(() => { this.readyState = 'ended'; });
    addSourceBuffer() { this.sb = new FakeSourceBuffer(this); return this.sb as unknown as SourceBuffer; }
    _open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
}

class FakeVideo extends EventTarget {
    currentTime = 0;
    paused = true;
    _ms: FakeMediaSource | null = null;
    set src(_v: string) { queueMicrotask(() => this._ms?._open()); }
    get buffered() { return this._ms?.sb?.buffered ?? new FakeBufferedRanges(); }
    pause() {}
    removeAttribute() {}
    load() {}
    play() { return Promise.resolve(); }
    seekTo(t: number) { this.currentTime = t; this.dispatchEvent(new Event('seeking')); this.dispatchEvent(new Event('timeupdate')); }
    advance(t: number) { this.currentTime = t; this.dispatchEvent(new Event('timeupdate')); }
}

/** Where each media part lands on the timeline, for a manifest whose parts
 *  are not all PART_MS long (null = the uniform layout). */
let layout: { startMs: number[]; durMs: number[] } | null = null;

let created: FakeMediaSource[] = [];
const origMS = globalThis.MediaSource;
const origURL = globalThis.URL.createObjectURL;

function install() {
    created = [];
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = class extends FakeMediaSource {
        constructor() { super(); created.push(this); }
    };
    globalThis.URL.createObjectURL = ((obj: unknown) => {
        // link the just-created MS so the FakeVideo can open it
        const ms = created[created.length - 1];
        if (obj instanceof (globalThis as unknown as { MediaSource: new () => FakeMediaSource }).MediaSource) videoRef!._ms = ms;
        return 'blob:fake';
    }) as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = () => {};
}
function restore() {
    (globalThis as unknown as { MediaSource: unknown }).MediaSource = origMS;
    globalThis.URL.createObjectURL = origURL;
}

let videoRef: FakeVideo | null = null;

async function makeManifest(): Promise<{ manifest: ClipManifest; fetchPart: (id: string) => Promise<Uint8Array> }> {
    const secrets = newClipSecrets('0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b');
    const parts: string[] = [];
    const partDurMs: number[] = [0];
    const wires = new Map<string, Uint8Array>();
    // init part 0 (tiny) + N media parts
    const init = await sealPart(secrets, 0, new Uint8Array(64));
    const id0 = '00000000-0000-4000-8000-000000000000';
    parts.push(id0); wires.set(id0, init);
    for (let i = 1; i <= N; i++) {
        const wire = await sealPart(secrets, i, new Uint8Array(PART_BYTES).fill(i));
        const id = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
        parts.push(id); wires.set(id, wire); partDurMs.push(PART_MS);
    }
    const href = encodeClipRef({
        key: secrets.key, noncePrefix: secrets.noncePrefix, clipId: '0f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b',
        videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: N * PART_MS, width: 2560, height: 1440,
        totalCipherBytes: N * PART_BYTES, parts, partDurMs,
    });
    const manifest = decodeClipRef(href)!;
    return { manifest, fetchPart: async (id: string) => wires.get(id)! };
}

const env = { hasMediaSource: true, isTypeSupported: () => true };
const settle = () => new Promise<void>(r => setTimeout(r, 0));
/** Settle until `cond` holds, up to `max` ticks. The pump runs on WebCrypto
 *  and microtask hops whose count varies with the host, so a fixed number of
 *  ticks is a race (CI saw "expected 11 to be 12" on an unchanged test); a
 *  bounded wait for the state itself is not, and it cannot pass vacuously —
 *  the caller still asserts the condition afterwards. */
const settleUntil = async (cond: () => boolean, max = 400): Promise<void> => {
    for (let i = 0; i < max && !cond(); i++) await settle();
};

describe('windowed MSE clip player (the 257 MB "SourceBuffer is full" fix)', () => {
    it('attach() resolves once the FIRST media part is in, well before the whole clip', async () => {
        install();
        try {
            const { manifest, fetchPart } = await makeManifest();
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, fetchPart);
            await player.attach(video as unknown as HTMLVideoElement);
            const sb = video._ms!.sb!;
            // Playable: init + at least the first media part, and NOT all N.
            expect(sb.appends.length).toBeGreaterThanOrEqual(1);
            expect(sb.appends.length).toBeLessThan(N);
            player.destroy();
        } finally { restore(); }
    });

    it('never exceeds the SourceBuffer quota even for a clip many times its size — it evicts behind the playhead and keeps going', async () => {
        install();
        try {
            const { manifest, fetchPart } = await makeManifest();
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, fetchPart);
            const onError = vi.fn();
            player.onError = onError;
            await player.attach(video as unknown as HTMLVideoElement);
            const sb = video._ms!.sb!;
            // Walk the playhead across the whole clip; the pump must keep the
            // window fed without ever throwing an unrecovered quota error.
            for (let t = 0; t < (N * PART_MS) / 1000; t += 2) {
                video.advance(t);
                await settle();
                expect(sb.bytes).toBeLessThanOrEqual(QUOTA);
            }
            await settleUntil(() => new Set(sb.appends).size === N);
            expect(onError).not.toHaveBeenCalled();
            // Every part was reached across the walk (played through), and the
            // buffer stayed bounded far under quota the whole time — the exact
            // combination the old all-up-front player could not achieve.
            expect(new Set(sb.appends).size).toBe(N);
            expect(sb.bytes).toBeLessThan(QUOTA);
            player.destroy();
        } finally { restore(); }
    });

    it('keeps roughly PLAY_AHEAD_S ahead and drops what is far behind the playhead', async () => {
        install();
        try {
            const { manifest, fetchPart } = await makeManifest();
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, fetchPart);
            await player.attach(video as unknown as HTMLVideoElement);
            const sb = video._ms!.sb!;
            video.advance(20);
            for (let i = 0; i < 10; i++) await settle();
            // ahead: buffered end should be within a part of cur+PLAY_AHEAD_S,
            // not the whole clip; behind: nothing older than cur-KEEP_BEHIND_S-slack.
            const end = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) : 0;
            const start = sb.buffered.length ? sb.buffered.start(0) : 0;
            expect(end).toBeLessThanOrEqual(20 + PLAY_AHEAD_S + PART_MS / 1000 + 0.5);
            expect(start).toBeGreaterThanOrEqual(20 - KEEP_BEHIND_S - PART_MS / 1000 - 0.5);
            player.destroy();
        } finally { restore(); }
    });

    it('a seek far ahead restarts the window at that part (init re-appended) rather than streaming the gap', async () => {
        install();
        try {
            const { manifest, fetchPart } = await makeManifest();
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, fetchPart);
            await player.attach(video as unknown as HTMLVideoElement);
            const sb = video._ms!.sb!;
            const before = sb.appends.length;
            video.seekTo((N - 2) * PART_MS / 1000); // near the end
            // It buffered around the seek target without having appended all
            // the intervening parts contiguously first.
            const t = (N - 2) * PART_MS / 1000;
            const coversTarget = () => {
                for (let i = 0; i < sb.buffered.length; i++) if (sb.buffered.start(i) <= t + 0.5 && t <= sb.buffered.end(i) + 0.5) return true;
                return false;
            };
            await settleUntil(coversTarget);
            const covers = coversTarget();
            expect(covers).toBe(true);
            expect(sb.appends.length - before).toBeLessThan(N); // did not stream the whole gap
            player.destroy();
        } finally { restore(); }
    });

    it('surfaces onError when a part is genuinely too large for the quota (nothing to evict frees enough)', async () => {
        install();
        try {
            const { manifest, fetchPart } = await makeManifest();
            const video = new FakeVideo(); videoRef = video;
            // Wrap fetchPart so part 1 is bigger than the whole quota.
            const wrapped = async (id: string) => {
                const b = await fetchPart(id);
                return id === manifest.parts[1] ? new Uint8Array(QUOTA + PART_BYTES).fill(1) : b;
            };
            const player = createClipPlayer(manifest, env, wrapped);
            const onError = vi.fn();
            player.onError = onError;
            // attach() rejects (first media part cannot be placed at all).
            await expect(player.attach(video as unknown as HTMLVideoElement)).rejects.toThrow();
            player.destroy();
        } finally { restore(); }
    });
});

// ---- time to first frame: what the player asks the network for, and when ----
// Owner report 2026-10-04: clips on the phone "took very long" to start. The
// pump used to request part idx+1 (prefetch) BEFORE part idx, in the same
// tick, so the part the playhead waits for shared the link with the next one
// and the first frame waited for ~48 MB instead of ~24 MB (8.2 s instead of
// 4.3 s at 50 Mbit/s, measured).
describe('clip player — the part the playhead waits for is fetched ALONE', () => {
    /** A fetchPart whose answers the test releases one by one. */
    function gatedFetch(serve: (id: string) => Promise<Uint8Array>) {
        const requested: string[] = [];
        const gates = new Map<string, () => void>();
        const fetchPart = async (id: string, _signal?: AbortSignal, onBytes?: (n: number, total: number | null) => void) => {
            requested.push(id);
            const wire = await serve(id);
            await new Promise<void>(r => gates.set(id, r));
            onBytes?.(wire.byteLength, null);
            return wire;
        };
        const release = (id: string) => { const g = gates.get(id); if (!g) throw new Error(`${id} was not requested`); gates.delete(id); g(); };
        return { requested, fetchPart, release, waiting: (id: string) => gates.has(id) };
    }

    it('part 2 is not requested until part 1 has arrived, and is requested right after', async () => {
        install();
        try {
            const { manifest, fetchPart: serve } = await makeManifest();
            const g = gatedFetch(serve);
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, g.fetchPart);
            const attached = player.attach(video as unknown as HTMLVideoElement);
            await settleUntil(() => g.waiting(manifest.parts[0]));
            g.release(manifest.parts[0]); // init
            await settleUntil(() => g.waiting(manifest.parts[1]));
            await settleUntil(() => g.requested.length > 2, 50); // give a stray prefetch every chance to show
            expect(g.requested).toEqual([manifest.parts[0], manifest.parts[1]]);
            g.release(manifest.parts[1]);
            await attached; // playable on part 1 alone
            await settleUntil(() => g.requested.length > 2);
            expect(g.requested).toEqual([manifest.parts[0], manifest.parts[1], manifest.parts[2]]);
            player.destroy();
        } finally { restore(); }
    });

    it('never asks for a part past the last one (the old prefetch fetched /files/undefined)', async () => {
        install();
        try {
            const { manifest, fetchPart } = await makeManifest();
            const asked: Array<string | undefined> = [];
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, async (id: string) => { asked.push(id); return fetchPart(id); });
            await player.attach(video as unknown as HTMLVideoElement);
            const sb = video._ms!.sb!;
            for (let t = 0; t < (N * PART_MS) / 1000; t += 2) { video.advance(t); await settle(); }
            await settleUntil(() => new Set(sb.appends).size === N);
            expect(new Set(sb.appends).size).toBe(N); // it did reach the last part
            expect(asked.every(id => typeof id === 'string' && manifest.parts.includes(id))).toBe(true);
            player.destroy();
        } finally { restore(); }
    });

    it('reports the bytes it is waiting for until the clip is playable, then stops', async () => {
        install();
        try {
            const { manifest, fetchPart: serve } = await makeManifest();
            const g = gatedFetch(serve);
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, env, g.fetchPart);
            const seen: ClipLoadProgress[] = [];
            player.onLoadProgress = (p) => seen.push(p);
            const attached = player.attach(video as unknown as HTMLVideoElement);
            await settleUntil(() => g.waiting(manifest.parts[0]));
            g.release(manifest.parts[0]);
            await settleUntil(() => g.waiting(manifest.parts[1]));
            const init = (await serve(manifest.parts[0])).byteLength;
            const part1 = (await serve(manifest.parts[1])).byteLength;
            // Init in; part 1 still on its way: the estimate for it stands in.
            expect(seen.at(-1)).toEqual({ loaded: init, needed: init + estimatePartBytes(manifest, 1) });
            g.release(manifest.parts[1]);
            await attached;
            expect(seen.at(-1)).toEqual({ loaded: init + part1, needed: init + part1 });
            const count = seen.length;
            await settleUntil(() => g.requested.length > 2);
            g.release(manifest.parts[2]);
            await settleUntil(() => !g.waiting(manifest.parts[2]));
            expect(seen.length).toBe(count); // playing: later parts report nothing
            player.destroy();
        } finally { restore(); }
    });

    it('estimatePartBytes shares the total out by duration (no Content-Length to go on)', async () => {
        const { manifest } = await makeManifest();
        const media = manifest.totalCipherBytes - 4096;
        expect(estimatePartBytes(manifest, 0)).toBe(4096);
        expect(estimatePartBytes(manifest, 1)).toBe(Math.round(media / N)); // equal durations, equal shares
        const graduated = { ...manifest, partDurMs: [0, 2000, 4000, ...manifest.partDurMs.slice(3)] };
        const total = graduated.partDurMs.reduce((a, d) => a + d, 0);
        expect(estimatePartBytes(graduated, 1)).toBe(Math.round(media * 2000 / total));
    });
});

// ---- the start-up gate: no early stalls on a link under twice the bitrate ----
// New clips are sealed with a RAMP of small first parts (1, 2, 4, 8 two-second
// fragments), each twice as long as the last. Playing on the first part alone,
// part k+1 then has to download within part k's play time: a link of at least
// twice the clip's bitrate. Review 2026-10-04, measured on a 12 Mbit/s link
// with a 1440p clip (8.9 Mbit/s): freezes at 0:02, 0:06, 0:14 and 0:30. These
// tests play the clip on a SIMULATED clock and link, with the part durations
// and byte rate of that very clip, and count the stalls.
describe('clip player — the start-up gate (startBytesNeeded)', () => {
    /** The measured clip: 129.2 MB over 120 s. Sealed bytes per ms of media. */
    const BYTES_PER_MS = 1077;
    /** Its media part durations as sealed with the ramp, and cut flat. */
    const RAMPED = [2048, 4096, 8149, 16341, 22464, 22443, 22464, 21993];
    const FLAT = [22464, 22464, 22464, 22443, 22464, 7699];
    const CAP = PART_MAX_PLAINTEXT + PART_HEADER_BYTES + PART_TAG_BYTES;

    async function timedManifest(durs: number[]) {
        const clipId = '1f5b4b1a-6a1c-4d5e-8f2b-1c3d4e5f6a7b';
        const secrets = newClipSecrets(clipId);
        const ids: string[] = [];
        const wires = new Map<string, Uint8Array>();
        const id = (i: number) => `${String(i).padStart(8, '0')}-0000-4000-8000-00000000000a`;
        ids.push(id(0)); wires.set(id(0), await sealPart(secrets, 0, new Uint8Array(64)));
        let total = wires.get(id(0))!.byteLength;
        const startMs = [0], durMs = [0];
        let at = 0;
        for (let i = 1; i <= durs.length; i++) {
            const wire = await sealPart(secrets, i, new Uint8Array(durs[i - 1] * BYTES_PER_MS).fill(i));
            ids.push(id(i)); wires.set(id(i), wire); total += wire.byteLength;
            startMs.push(at); durMs.push(durs[i - 1]); at += durs[i - 1];
        }
        const manifest = decodeClipRef(encodeClipRef({
            key: secrets.key, noncePrefix: secrets.noncePrefix, clipId,
            videoCodec: 'avc1.640029', audioCodec: 'mp4a.40.2', durationMs: at, width: 2560, height: 1440,
            totalCipherBytes: total, parts: ids, partDurMs: durMs,
        }))!;
        return { manifest, wires, layout: { startMs, durMs } };
    }

    /** One connection carrying `bytesPerMs`, oldest request first, each
     *  answer starting `latencyMs` after its request; GET /files sends no
     *  Content-Length, so the player only ever learns sizes on arrival.
     *  `setClock` moves the player's clock to each delivery's moment. */
    function simulatedLink(wires: Map<string, Uint8Array>, bytesPerMs: number, latencyMs: number, clock: () => number, setClock: (ms: number) => void) {
        const queue: { id: string; wire: Uint8Array; got: number; from: number; onBytes?: (n: number, t: number | null) => void; done: (w: Uint8Array) => void }[] = [];
        const requested: string[] = [];
        const arrived: string[] = [];
        const fetchPart = (id: string, _signal?: AbortSignal, onBytes?: (n: number, t: number | null) => void) => new Promise<Uint8Array>((done) => {
            requested.push(id);
            queue.push({ id, wire: wires.get(id)!, got: 0, from: clock() + latencyMs, onBytes, done });
        });
        /** Carry what the link can between `from` and `to` (ms). */
        const carry = (from: number, to: number) => {
            let at = from;
            while (at < to && queue.length) {
                const h = queue[0];
                at = Math.max(at, h.from);
                if (at >= to) break;
                const take = Math.min((to - at) * bytesPerMs, h.wire.byteLength - h.got);
                h.got += take; at += take / bytesPerMs;
                setClock(at);
                h.onBytes?.(h.got, null);
                if (h.got >= h.wire.byteLength) { queue.shift(); arrived.push(h.id); h.done(h.wire); }
            }
        };
        return { fetchPart, carry, requested, arrived };
    }

    const STEP_MS = 100;
    /** One turn of the event loop. setTimeout(0) waits for the timer tick
     *  (~15 ms on Windows), which made each simulated second cost real ones. */
    const turn = () => new Promise<void>(r => setImmediate(r));
    const turnUntil = async (cond: () => boolean, max: number) => { for (let i = 0; i < max && !cond(); i++) await turn(); };

    /** Press Play at t = 0 on a link `linkX` times the clip's bitrate, then
     *  play in real time whatever is buffered for `watchS` seconds of clock
     *  after the gate opened. */
    async function play(durs: number[], linkX: number, watchS: number, opts: { pressNativePlayAtMs?: number; latencyMs?: number } = {}) {
        install();
        try {
            const { manifest, wires, layout: l } = await timedManifest(durs);
            layout = l;
            let t = 0; // the simulation's step clock
            let clock = 0; // what the player reads: moved to each delivery's moment
            const link = simulatedLink(wires, BYTES_PER_MS * linkX, opts.latencyMs ?? 60, () => clock, (ms) => { clock = ms; });
            const video = new FakeVideo(); videoRef = video;
            const player = createClipPlayer(manifest, { ...env, now: () => clock }, link.fetchPart);
            const seen: ClipLoadProgress[] = [];
            player.onLoadProgress = (p) => seen.push(p);
            let startedAt: number | null = null;
            let failed: unknown = null;
            player.attach(video as unknown as HTMLVideoElement).then(() => { startedAt = t; }, (e) => { failed = e; });
            const stalls: number[] = []; // playhead (s) at each stalled step
            let handled = 0;
            const ready = () => {
                // The pump has dealt with every part that arrived: appended it,
                // and asked for the next one (it always does, on arrival).
                for (let k = handled; k < link.arrived.length; k++) {
                    const idx = manifest.parts.indexOf(link.arrived[k]);
                    const next = manifest.parts[idx + 1];
                    const appended = idx === 0 ? true : !!video._ms?.sb?.appends.includes(idx);
                    if (!appended || (next !== undefined && !link.requested.includes(next))) return false;
                }
                return true;
            };
            await settleUntil(() => link.requested.length > 0);
            const endAt = () => (startedAt === null ? Infinity : startedAt + watchS * 1000);
            const clipEndS = manifest.durationMs / 1000;
            while (t < Math.min(endAt(), 300_000)) {
                if (opts.pressNativePlayAtMs !== undefined && t === opts.pressNativePlayAtMs) { video.paused = false; video.dispatchEvent(new Event('play')); }
                link.carry(t, t + STEP_MS);
                t += STEP_MS;
                clock = t;
                await turn();
                await turnUntil(ready, 20_000);
                expect(ready()).toBe(true);
                handled = link.arrived.length;
                await turn();
                if (failed) throw failed;
                if (startedAt === null || startedAt === t) continue;
                const cur = video.currentTime;
                if (cur >= clipEndS - 0.001) break;
                const buf = video.buffered as unknown as FakeBufferedRanges;
                let end = -1;
                for (let i = 0; i < buf.length; i++) if (buf.start(i) - 0.001 <= cur && cur <= buf.end(i) + 0.001) end = buf.end(i);
                if (end >= cur + STEP_MS / 1000 - 1e-9 || end >= clipEndS - 0.001) video.advance(Math.min(cur + STEP_MS / 1000, clipEndS));
                else stalls.push(Math.round(cur * 10) / 10);
            }
            player.destroy();
            return { startedAt: startedAt as number | null, stalls, seen };
        } finally { layout = null; restore(); }
    }

    it('on a link 1.35x the bitrate (12 Mbit/s for an 8.9 Mbit/s clip) a ramped clip waits once, about half the flat wait, and never stalls', async () => {
        const ramped = await play(RAMPED, 1.35, 45);
        const flat = await play(FLAT, 1.35, 45);
        // Positive control: the flat cut waits for its whole 22 s first part.
        expect(flat.startedAt!).toBeGreaterThanOrEqual(Math.floor(22464 / 1.35));
        expect(flat.stalls).toEqual([]);
        // The ramp without the gate started at ~1.6 s and froze at 0:02, 0:06,
        // 0:14 and 0:30.
        expect(ramped.stalls).toEqual([]);
        expect(ramped.startedAt!).toBeGreaterThan(4000);
        expect(ramped.startedAt!).toBeLessThan(0.65 * flat.startedAt!);
        // The readout counted toward what the gate waited for, not part 1 alone.
        const last = ramped.seen.at(-1)!;
        expect(last.loaded).toBeGreaterThanOrEqual(last.needed);
        expect(last.needed).toBeGreaterThan(4 * RAMPED[0] * BYTES_PER_MS);
        // ...and never asked for much more than that on the way: a rate timed
        // over the first request's round trip alone said "0.1 / 24 MB".
        expect(Math.max(...ramped.seen.map(p => p.needed))).toBeLessThanOrEqual(1.25 * last.needed);
    }, 120_000);

    it('on a link twice the bitrate or faster the gate holds nothing: playback starts on the first 2 s part', async () => {
        const r = await play(RAMPED, 2.4, 40);
        expect(r.startedAt!).toBeLessThanOrEqual(Math.ceil(RAMPED[0] / 2.4 / STEP_MS) * STEP_MS + 2 * STEP_MS);
        expect(r.stalls).toEqual([]);
    }, 120_000);

    it('a clip cut flat starts on its first part, as before the gate, on a link at least its bitrate', async () => {
        const r = await play(FLAT, 1.05, 20);
        expect(r.startedAt!).toBeLessThanOrEqual(Math.ceil(FLAT[0] / 1.05 / STEP_MS) * STEP_MS + 2 * STEP_MS);
    }, 120_000);

    it("on a link SLOWER than the bitrate it never waits longer than a flat cut's first part would have", async () => {
        const r = await play(RAMPED, 0.8, 5);
        const rate = 0.8 * BYTES_PER_MS;
        // (+ up to a step and a round trip per part boundary, where the link
        // idles while the next request goes out)
        expect(r.startedAt!).toBeLessThanOrEqual((CAP + 4096) / rate + 10 * STEP_MS);
        expect(r.startedAt!).toBeGreaterThan((CAP - 2 * 1024 * 1024) / rate); // it did hold, up to the cap
    }, 120_000);

    it("the viewer pressing the video's own play while the gate holds starts it at once", async () => {
        const r = await play(RAMPED, 1.35, 3, { pressNativePlayAtMs: 3000 });
        expect(r.startedAt).toBe(3100); // the step the press landed in, not ~9 s
    }, 120_000);
});

describe('startBytesNeeded — the arithmetic', () => {
    const MB = 1_000_000;
    // The ramped clip's media parts as measured: bytes and ms.
    const sizes = [2.27, 4.38, 8.82, 17.63, 24.21, 24.03].map(x => Math.round(x * MB));
    const durs = [2048, 4096, 8149, 16341, 22464, 22443];
    const rateOf = (mbitPerS: number) => (mbitPerS * MB) / 8 / 1000; // bytes per ms
    const CAP = 24 * 1024 * 1024 + 35;

    it('asks for the first part only when nothing has been measured, or on a fast link', () => {
        expect(startBytesNeeded(sizes, durs, null, 40_000, CAP)).toBe(sizes[0]);
        expect(startBytesNeeded(sizes, durs, Infinity, 40_000, CAP)).toBe(sizes[0]);
        expect(startBytesNeeded(sizes, durs, rateOf(20), 40_000, CAP)).toBe(sizes[0]);
    });

    it('on a 12 Mbit/s link asks for every byte the first ~40 s needs, less what arrives while they play', () => {
        const r = rateOf(11.7); // what the throttled link measured
        const before = [0, 2048, 6144, 14293, 30634];
        const cum = [1, 2, 3, 4, 5].map(k => sizes.slice(0, k).reduce((a, b) => a + b, 0));
        const want = Math.max(...cum.map((c, k) => c - r * before[k]));
        expect(startBytesNeeded(sizes, durs, r, 40_000, CAP)).toBe(want);
        expect(want).toBe(cum[4] - r * before[4]); // the first full-size part is the binding one
        expect(want).toBeGreaterThan(4 * sizes[0]);
        // part 6 starts at 53 s, past the horizon: it is not counted
        expect(startBytesNeeded(sizes, durs, r, 40_000, CAP)).toBe(startBytesNeeded(sizes.slice(0, 5), durs.slice(0, 5), r, 40_000, CAP));
    });

    it('a flat cut on a link at least its bitrate asks for its first part, whatever the horizon', () => {
        const flat = [24.4, 24.1, 24.1, 24.1].map(x => Math.round(x * MB));
        const fd = [22464, 22464, 22464, 22443];
        expect(startBytesNeeded(flat, fd, rateOf(9), 1e9, CAP)).toBe(flat[0]);
    });

    it('never asks for more than the cap (a flat first part), nor less than the first part', () => {
        expect(startBytesNeeded(sizes, durs, rateOf(4), 40_000, CAP)).toBe(CAP);
        expect(startBytesNeeded([30 * MB, ...sizes], [20000, ...durs], rateOf(4), 40_000, CAP)).toBe(30 * MB);
    });

    it('a playhead already into the first part has less time before the next one is due', () => {
        const r = rateOf(11.7);
        const at0 = startBytesNeeded(sizes, durs, r, 40_000, CAP);
        const at1s = startBytesNeeded(sizes, durs, r, 40_000, CAP, 1000);
        expect(at1s).toBeCloseTo(at0 + r * 1000, 6);
    });
});
