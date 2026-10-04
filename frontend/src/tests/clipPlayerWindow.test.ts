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
import { createClipPlayer, estimatePartBytes, PLAY_AHEAD_S, KEEP_BEHIND_S, type ClipLoadProgress } from '../api/clips/clipPlayback';
import { encodeClipRef, decodeClipRef, type ClipManifest } from '../api/clips/clipRef';
import { newClipSecrets, sealPart } from '../api/clips/clipCrypto';

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
            const startMs = (partIdx - 1) * PART_MS;
            this.buffered.add(startMs / 1000, (startMs + PART_MS) / 1000);
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
