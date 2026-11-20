/**
 * Stream stats (right-click a stream → Show Stream Stats).
 *
 * The reducer is also run against REAL Chromium reports by
 * e2e/stream-stats-real-browser.mjs; these cover what a two-peer loopback
 * cannot produce: several mesh viewers, an SFU ladder of rungs, real loss,
 * stream audio, every H.264 profile name, and endpoints coming and going.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const live = vi.hoisted(() => ({
    views: [] as unknown[],
    samplers: 0,
}));
vi.mock('../api/rtc/streamStatsLive', () => ({
    streamStatsSampler: () => {
        live.samplers++;
        return { sample: async () => live.views.shift() ?? null };
    },
}));

import { summariseStreamStats, StreamStatsSampler, formatKbps, formatFrozenFor, type EndpointSample, type StreamStatsView } from '../api/rtc/streamStats';
import { StreamStatsOverlay, STREAM_STATS_INTERVAL_MS } from '../components/StreamStatsOverlay';

type Row = Record<string, unknown>;
/** An RTCStatsReport stand-in: forEach + get, which is all either reducer uses. */
const report = (...rows: Row[]) => new Map(rows.map(r => [r.id as string, r])) as unknown as RTCStatsReport;

const codec = (id: string, mimeType: string, sdpFmtpLine?: string): Row => ({ id, type: 'codec', mimeType, sdpFmtpLine });
const pair: Row = { id: 'P', type: 'candidate-pair', selected: true, state: 'succeeded', currentRoundTripTime: 0.024, localCandidateId: 'L', remoteCandidateId: 'R' };
const transport: Row = { id: 'T', type: 'transport', selectedCandidatePairId: 'P' };
const local = (relay = false): Row => ({ id: 'L', type: 'local-candidate', candidateType: relay ? 'relay' : 'host', protocol: 'udp' });
const remote: Row = { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' };

function inbound(over: Row = {}): Row {
    return {
        id: 'IN', type: 'inbound-rtp', kind: 'video', codecId: 'C1', frameWidth: 1920, frameHeight: 1080,
        framesDecoded: 0, framesDropped: 0, freezeCount: 0, packetsLost: 0, packetsReceived: 0, bytesReceived: 0,
        jitterBufferDelay: 0, jitterBufferEmittedCount: 0, decoderImplementation: 'D3D11VideoDecoder', powerEfficientDecoder: true,
        ...over,
    };
}
function outbound(id: string, over: Row = {}): Row {
    return {
        id, type: 'outbound-rtp', kind: 'video', codecId: 'C1', frameWidth: 1920, frameHeight: 1080, framesEncoded: 0,
        bytesSent: 0, encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', powerEfficientEncoder: true,
        qualityLimitationReason: 'none', targetBitrate: 6_000_000, ...over,
    };
}

describe('watching a stream', () => {
    it('reads picture, rate, bitrate, codec, hardware, loss, delay and route over one window', () => {
        const h264 = codec('C1', 'video/H264', 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032');
        const prev = report(inbound(), h264, pair, transport, local(), remote);
        const now = report(inbound({
            framesDecoded: 60, framesDropped: 2, freezeCount: 1,
            packetsLost: 50, packetsReceived: 950, bytesReceived: 750_000,
            jitterBufferDelay: 2.4, jitterBufferEmittedCount: 60,
        }), h264, pair, transport, local(), remote);
        const v = summariseStreamStats([{ direction: 'inbound', kind: 'video', prev, now, ms: 1000 }])!;
        expect(v).toMatchObject({
            direction: 'inbound', size: '1920x1080', fps: 60, videoKbps: 6000,
            codec: 'H264 High', implementation: 'D3D11VideoDecoder', hardware: true,
            lossPct: 5, jitterBufferMs: 40, rttMs: 24, framesDropped: 2, freezes: 1,
            transport: 'UDP', measured: true, viewers: null,
        });
    });

    it('adds the stream audio bitrate, and names a TURN relay', () => {
        const a0: Row = { id: 'A', type: 'inbound-rtp', kind: 'audio', bytesReceived: 0 };
        const a1: Row = { ...a0, bytesReceived: 16_000 };
        const vp8 = codec('C1', 'video/VP8');
        const v = summariseStreamStats([
            { direction: 'inbound', kind: 'video', prev: report(inbound(), vp8, pair, transport, local(true), remote),
                now: report(inbound({ framesDecoded: 30 }), vp8, pair, transport, local(true), remote), ms: 1000 },
            { direction: 'inbound', kind: 'audio', prev: report(a0), now: report(a1), ms: 1000 },
        ])!;
        expect(v.audioKbps).toBe(128);
        expect(v.codec).toBe('VP8');
        expect(v.transport).toBe('TURN relay (UDP)');
    });

    it('a first read has no rates — and says so', () => {
        const v = summariseStreamStats([{ direction: 'inbound', kind: 'video', prev: null, now: report(inbound({ framesPerSecond: 58 })), ms: 0 }])!;
        expect(v.measured).toBe(false);
        expect(v.videoKbps).toBeNull();
        expect(v.lossPct).toBeNull();
        expect(v.framesDropped).toBeNull();
        expect(v.fps).toBe(58); // the browser's own estimate, until a window exists
    });

    it('no video endpoint yet is no view', () => {
        expect(summariseStreamStats([])).toBeNull();
        expect(summariseStreamStats([{ direction: 'inbound', kind: 'audio', prev: null, now: report(), ms: 0 }])).toBeNull();
    });
});

describe('your own stream', () => {
    it('SFU: every rung counts toward the bitrate; the top rung is the picture', () => {
        const vp8 = codec('C1', 'video/VP8');
        const rungs = (bytes: number): Row[] => [
            outbound('q', { rid: 'q', frameWidth: 640, frameHeight: 360, bytesSent: bytes / 6, targetBitrate: 500_000 }),
            outbound('f', { rid: 'f', frameWidth: 1920, frameHeight: 1080, bytesSent: bytes, framesEncoded: bytes ? 60 : 0, targetBitrate: 6_000_000 }),
        ];
        const v = summariseStreamStats([{ direction: 'outbound', kind: 'video', prev: report(...rungs(0), vp8), now: report(...rungs(750_000), vp8), ms: 1000 }])!;
        expect(v.size).toBe('1920x1080');
        expect(v.fps).toBe(60);
        expect(v.videoKbps).toBe(7000); // 6000 + 1000
        expect(v.targetKbps).toBe(6500);
        expect(v.hardware).toBe(true);
        expect(v.viewers).toBe(1);
    });

    it('mesh: a viewer each — the per-viewer bitrate, the worst limit, the viewer count', () => {
        const vp8 = codec('C1', 'video/VP8');
        const peer = (bytes: number, limit: string): EndpointSample => ({
            direction: 'outbound', kind: 'video',
            prev: report(outbound('o', { qualityLimitationReason: limit }), vp8),
            now: report(outbound('o', { bytesSent: bytes, framesEncoded: 30, qualityLimitationReason: limit }), vp8),
            ms: 1000,
        });
        const v = summariseStreamStats([peer(500_000, 'none'), peer(250_000, 'cpu'), peer(750_000, 'none')])!;
        expect(v.videoKbps).toBe(4000); // (4000 + 2000 + 6000) / 3
        expect(v.limit).toBe('cpu');
        expect(v.viewers).toBe(3);
    });

    it('round trip from the receiver\'s report when the report has no candidate pair', () => {
        const vp8 = codec('C1', 'video/VP8');
        const rir: Row = { id: 'RI', type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.031 };
        const v = summariseStreamStats([{ direction: 'outbound', kind: 'video', prev: report(outbound('o'), vp8, rir), now: report(outbound('o', { bytesSent: 1000 }), vp8, rir), ms: 1000 }])!;
        expect(v.rttMs).toBe(31);
        expect(v.transport).toBeNull();
    });

    it('mesh audio: one copy is the rate, not one per viewer', () => {
        const vp8 = codec('C1', 'video/VP8');
        const video: EndpointSample = { direction: 'outbound', kind: 'video', prev: report(outbound('o'), vp8), now: report(outbound('o', { bytesSent: 1000 }), vp8), ms: 1000 };
        const audio = (): EndpointSample => ({
            direction: 'outbound', kind: 'audio',
            prev: report({ id: 'A', type: 'outbound-rtp', kind: 'audio', bytesSent: 0 }),
            now: report({ id: 'A', type: 'outbound-rtp', kind: 'audio', bytesSent: 16_000 }), ms: 1000,
        });
        expect(summariseStreamStats([video, audio(), audio(), audio()])!.audioKbps).toBe(128);
    });
});

describe('H.264 profiles by name (the profile decides hardware encoding)', () => {
    it.each([
        ['42e01f', 'H264 Constrained Baseline'],
        ['42001f', 'H264 Baseline'],
        ['4d001f', 'H264 Main'],
        ['640032', 'H264 High'],
        ['640c1f', 'H264 Constrained High'],
        ['f40032', 'H264'],
    ])('%s → %s', (pli, name) => {
        const c = codec('C1', 'video/H264', `packetization-mode=1;profile-level-id=${pli}`);
        const v = summariseStreamStats([{ direction: 'inbound', kind: 'video', prev: null, now: report(inbound(), c), ms: 0 }])!;
        expect(v.codec).toBe(name);
    });
});

describe('the sampler', () => {
    it('keeps each endpoint\'s last read, and forgets one that went away', async () => {
        const keyA = {};
        const keyB = {};
        let reads = 0;
        const rep = () => report(inbound({ bytesReceived: 125_000 * ++reads, framesDecoded: 30 * reads }), codec('C1', 'video/VP8'));
        let endpoints = [{ key: keyA, direction: 'inbound' as const, kind: 'video', getStats: async () => rep() }];
        let clock = 0;
        const sampler = new StreamStatsSampler(() => endpoints);
        expect((await sampler.sample(() => (clock += 1000)))!.measured).toBe(false);
        const second = (await sampler.sample(() => (clock += 1000)))!;
        expect(second.measured).toBe(true);
        expect(second.videoKbps).toBe(1000);
        // A different endpoint replaces it: its first read must not diff
        // against the old one's report.
        endpoints = [{ key: keyB, direction: 'inbound' as const, kind: 'video', getStats: async () => rep() }];
        expect((await sampler.sample(() => (clock += 1000)))!.measured).toBe(false);
    });

    it('an endpoint that left and came back starts fresh, not against a stale read', async () => {
        const key = {};
        let reads = 0;
        const rep = () => report(inbound({ bytesReceived: 125_000 * ++reads, framesDecoded: 30 * reads }), codec('C1', 'video/VP8'));
        const ep = { key, direction: 'inbound' as const, kind: 'video', getStats: async () => rep() };
        let present = true;
        let clock = 0;
        const sampler = new StreamStatsSampler(() => (present ? [ep] : []));
        await sampler.sample(() => (clock += 1000));
        present = false;
        await sampler.sample(() => (clock += 1000));
        present = true;
        expect((await sampler.sample(() => (clock += 1000)))!.measured).toBe(false);
    });

    it('an endpoint that fails to read is skipped, not fatal', async () => {
        const sampler = new StreamStatsSampler(() => [
            { key: {}, direction: 'inbound' as const, kind: 'video', getStats: async () => { throw new Error('detached'); } },
        ]);
        await expect(sampler.sample()).resolves.toBeNull();
    });

    it('formats bitrates for people', () => {
        expect(formatKbps(null)).toBe('—');
        expect(formatKbps(850)).toBe('850 kbps');
        expect(formatKbps(6200)).toBe('6.2 Mbps');
    });
});

/**
 * A watched stream second by second, its counters as Chromium keeps them:
 * second k's frames evenly spaced over (k, k+1], so the read at (k+1) s sees
 * them all; totalInterFrameDelay is last frame minus first frame (libwebrtc's
 * TotalFramesDurationMs), and a gap is added to freeze or pause totals only by
 * the frame that ends it, the way VideoQualityObserver does.
 */
interface Second {
    frames: number;
    /** Packets arrive this second. Default: when frames do. */
    bytes?: boolean;
    /** Only retransmissions arrive (the bandwidth estimator's probes). */
    rtx?: boolean;
    /** Its first frame ends a gap WebRTC counts as a freeze / a pause. */
    endsFreeze?: boolean;
    endsPause?: boolean;
}
function watched(seconds: Second[], { interFrameDelay = true } = {}): Row[] {
    let decoded = 0;
    let bytes = 0;
    let first: number | null = null;
    let lastFrame: number | null = null;
    let freezeCount = 0, freezeS = 0, pauseCount = 0, pauseS = 0;
    let rtx = 0;
    return seconds.map((s, k) => {
        if (s.bytes ?? s.frames > 0) bytes += 100_000;
        if (s.rtx) { bytes += 20_000; rtx += 20_000; }
        for (let j = 1; j <= s.frames; j++) {
            const t = k + j / s.frames;
            if (j === 1 && lastFrame !== null) {
                if (s.endsFreeze) { freezeCount++; freezeS += t - lastFrame; }
                if (s.endsPause) { pauseCount++; pauseS += t - lastFrame; }
            }
            first ??= t;
            lastFrame = t;
            decoded++;
        }
        const row: Row = {
            framesDecoded: decoded, bytesReceived: bytes, retransmittedBytesReceived: rtx, packetsReceived: bytes / 1000,
            freezeCount, totalFreezesDuration: freezeS, pauseCount, totalPausesDuration: pauseS,
        };
        if (interFrameDelay) row.totalInterFrameDelay = lastFrame === null ? 0 : lastFrame - first!;
        return row;
    });
}
const secs = (n: number, s: Second): Second[] => Array.from({ length: n }, () => ({ ...s }));

/** The sampler, read once a second over `rows` (one per read, read i at
 *  (i + 1) s), as the overlay drives it; each read's view. `muted(i)` /
 *  `id(i)`: read i's track state and inbound-rtp id; `absent(i)`: the
 *  endpoint is not listed for read i; `throws(i)`: its getStats throws. */
async function sampleEach(rows: Row[], opts: {
    muted?: (i: number) => boolean; id?: (i: number) => string;
    absent?: (i: number) => boolean; throws?: (i: number) => boolean;
} = {}) {
    const vp8 = codec('C1', 'video/VP8');
    let i = 0;
    const sampler = new StreamStatsSampler(() => (opts.absent?.(i) ? [] : [{
        key: KEY, direction: 'inbound' as const, kind: 'video',
        getStats: async () => {
            if (opts.throws?.(i)) throw new Error('detached');
            return report(inbound({ ...rows[i], id: opts.id?.(i) ?? 'IN' }), vp8);
        },
        muted: () => opts.muted?.(i) ?? false,
    }]));
    const views: (StreamStatsView | null)[] = [];
    for (; i < rows.length; i++) views.push(await sampler.sample(() => (i + 1) * 1000));
    return views;
}
const KEY = {};
const frozen = (views: (StreamStatsView | null)[]) => views.map((v) => v?.frozenMs ?? null);

describe('a freeze in progress (WebRTC counts one only when it ends)', () => {
    it('the field case: no frame for 12 s with packets still arriving reads frozen, ticking; frames back, the count takes over', async () => {
        // 30 fps, then 12 s of packets and no decoded frame: freezeCount stays 0
        // all through it, as Chromium's does (e2e/stream-stats-real-browser.mjs).
        const rows = watched([...secs(5, { frames: 30 }), ...secs(12, { frames: 0, bytes: true }), { frames: 30, endsFreeze: true }, { frames: 30 }]);
        expect(rows[16].freezeCount).toBe(0);
        const views = await sampleEach(rows);
        expect(frozen(views)).toEqual([
            null, null, null, null, null,
            // The first second without a frame is not yet called one: its
            // packets may be a frame still being decoded.
            null, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000,
            null, null,
        ]);
        expect(views[16]).toMatchObject({ fps: 0, freezes: 0, videoKbps: 800 });
        // The frame that ends it is what WebRTC counts: the window's count shows.
        expect(views[17]).toMatchObject({ frozenMs: null, freezes: 1 });
        expect(views[18]).toMatchObject({ frozenMs: null, freezes: 0 });
    });

    it('CONTROL: a sender that stops sending (no packets) is a pause, not a freeze', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(12, { frames: 0, bytes: false }), { frames: 30, endsPause: true }]);
        const views = await sampleEach(rows);
        expect(frozen(views).every((f) => f === null)).toBe(true);
        expect(views[17]).toMatchObject({ freezes: 0 });
    });

    it('CONTROL: a stopped sender\'s bandwidth probes (old packets resent) are not new packets', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(8, { frames: 0, bytes: false, rtx: true })]);
        expect(frozen(await sampleEach(rows)).every((f) => f === null)).toBe(true);
    });

    it('a freeze whose packets then stop for 5 s becomes a pause, as WebRTC will count it', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(3, { frames: 0, bytes: true }), ...secs(8, { frames: 0, bytes: false })]);
        const f = frozen(await sampleEach(rows));
        expect(f.slice(5)).toEqual([null, 2000, 3000, 4000, 5000, 6000, 7000, null, null, null, null]);
    });

    it('packets back after a pause with still no picture (a reconnect whose keyframe never decodes): frozen, counted from their return', async () => {
        // 30 fps, 6 s with nothing (WebRTC: a pause), then 2 Mbps and no frame.
        const rows = watched([...secs(5, { frames: 30 }), ...secs(6, { frames: 0, bytes: false }), ...secs(10, { frames: 0, bytes: true }),
            { frames: 30, endsPause: true }, ...secs(3, { frames: 0, bytes: true })]);
        const f = frozen(await sampleEach(rows));
        expect(f.slice(5, 11).every((x) => x === null)).toBe(true); // the pause itself
        // Their return is read 11; one read of slack, then the count from it.
        expect(f.slice(11, 21)).toEqual([null, null, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000]);
        // A frame ends it; the next gap is judged afresh.
        expect(f.slice(21)).toEqual([null, null, 2000, 3000]);
    });

    it('CONTROL: a muted track\'s still picture is not a freeze, the same reports otherwise are', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(8, { frames: 0, bytes: true })]);
        expect(frozen(await sampleEach(rows, { muted: (i) => i >= 5 })).every((f) => f === null)).toBe(true);
        expect(frozen(await sampleEach(rows)).at(-1)).toBe(8000);
    });

    it('CONTROL: a 1 fps share of a still screen is not frozen when a second goes by without a frame', async () => {
        // Frames 800 and 1200 ms apart (Chromium repeats a still screen's
        // frame about once a second): every other second has none. A guard
        // against a "no frame this second" rule; packets come only with the
        // frames here, so the pace threshold is pinned by the next test.
        const rows = watched([{ frames: 1 }, ...Array.from({ length: 20 }, (_, k) => ({ frames: k % 2 ? 2 : 0 }))]);
        const views = await sampleEach(rows);
        expect(views.filter((v) => v?.fps === 0).length).toBeGreaterThan(5); // a "no frame this second" rule would have fired
        expect(frozen(views).every((f) => f === null)).toBe(true);
    });

    it('CONTROL: the threshold is the stream\'s own pace — 2 s with packets and no frame is a freeze at 30 fps, not at 1 fps', async () => {
        const gap = secs(2, { frames: 0, bytes: true });
        const fast = frozen(await sampleEach(watched([...secs(10, { frames: 30 }), ...gap])));
        const slow = frozen(await sampleEach(watched([...secs(10, { frames: 1 }), ...gap])));
        expect(fast.at(-1)).toBe(2000);
        expect(slow.at(-1)).toBeNull();
        // ...and a 1 fps stream that stays stuck past 3 x its pace is frozen.
        const stuck = frozen(await sampleEach(watched([...secs(10, { frames: 1 }), ...secs(4, { frames: 0, bytes: true })])));
        expect(stuck.slice(10)).toEqual([null, null, 3000, 4000]);
    });

    it('CONTROL: no measurement yet — a first read, and fewer than 5 frames to set a pace, are never frozen', async () => {
        const views = await sampleEach(watched([{ frames: 3 }, ...secs(6, { frames: 0, bytes: true })]));
        expect(views[0]).toMatchObject({ measured: false, frozenMs: null });
        expect(frozen(views).every((f) => f === null)).toBe(true);
    });

    it('opened on a picture that is already frozen: frozen from the overlay\'s third read, counted from its first', async () => {
        // Minutes of 30 fps before the overlay opened; its pace is the lifetime counters'.
        const rows = watched([...secs(120, { frames: 30 }), ...secs(30, { frames: 0, bytes: true })]).slice(125);
        const f = frozen(await sampleEach(rows));
        expect(f.slice(0, 4)).toEqual([null, null, 2000, 3000]);
    });

    it('opened while the packets had stopped (a pause it cannot measure): counted from their return, not from the opening', async () => {
        // The sender stopped 20 s before the overlay opened; its packets come
        // back on the overlay's third read, no frame for 4 s.
        const rows = watched([...secs(120, { frames: 30 }), ...secs(20, { frames: 0, bytes: false }), ...secs(6, { frames: 0, bytes: true })]).slice(138);
        expect(frozen(await sampleEach(rows))).toEqual([null, null, null, null, 2000, 3000, 4000, 5000]);
    });

    it('a read missed mid-freeze (getStats threw, the endpoint unlisted for a moment) does not start the count over', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(10, { frames: 0, bytes: true })]);
        const thrown = frozen(await sampleEach(rows, { throws: (i) => i === 9 }));
        const unlisted = frozen(await sampleEach(rows, { absent: (i) => i === 9 || i === 10 }));
        // The read after a miss has no window ("measuring"); then it goes on.
        expect(thrown.slice(5)).toEqual([null, 2000, 3000, 4000, null, null, 7000, 8000, 9000, 10000]);
        expect(unlisted.slice(5)).toEqual([null, 2000, 3000, 4000, null, null, null, 8000, 9000, 10000]);
    });

    it('a browser without totalInterFrameDelay still finds it, from the frames per read', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(4, { frames: 0, bytes: true })], { interFrameDelay: false });
        expect(frozen(await sampleEach(rows)).slice(5)).toEqual([null, 2000, 3000, 4000]);
    });

    it('a new stream on the receiver (another SSRC) starts over instead of diffing across', async () => {
        const rows = watched([...secs(5, { frames: 30 }), ...secs(4, { frames: 0, bytes: true })]);
        const f = frozen(await sampleEach(rows, { id: (i) => (i < 7 ? 'IN' : 'IN2') }));
        expect(f.slice(5)).toEqual([null, 2000, null, null]);
    });

    it('says how long in words that fit a phone', () => {
        expect(formatFrozenFor(400)).toBe('1 s');
        expect(formatFrozenFor(12_900)).toBe('12 s');
        expect(formatFrozenFor(60_000)).toBe('1 min');
        expect(formatFrozenFor(65_400)).toBe('1 min 5 s');
    });
});

describe('the overlay', () => {
    let container: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        live.views = [];
        live.samplers = 0;
        vi.useFakeTimers();
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.useRealTimers();
    });

    const base: StreamStatsView = {
        direction: 'inbound', size: '1920x1080', fps: 60, videoKbps: 6200, audioKbps: 128, codec: 'H264 High',
        implementation: 'D3D11VideoDecoder', hardware: true, lossPct: 0.5, jitterBufferMs: 40, rttMs: 24,
        framesDropped: 2, freezes: 1, frozenMs: null, limit: null, targetKbps: null, transport: 'UDP', viewers: null, measured: true,
    };
    const text = () => container.textContent ?? '';
    async function mount(views: StreamStatsView[]) {
        live.views = [...views];
        const onClose = vi.fn();
        await act(async () => { root.render(<StreamStatsOverlay stream={{} as MediaStream} onClose={onClose} />); });
        await act(async () => { await Promise.resolve(); });
        return onClose;
    }

    it('shows what a viewer needs, and refreshes every second', async () => {
        await mount([base, { ...base, fps: 30, videoKbps: 900 }]);
        expect(text()).toContain('1920×1080 · 60 fps');
        expect(text()).toContain('6.2 Mbps');
        expect(text()).toContain('H264 High · hardware (D3D11VideoDecoder)');
        expect(text()).toContain('0.5%');
        expect(text()).toContain('24 ms');
        expect(text()).toContain('2 frames · 1 freezes');
        await act(async () => { vi.advanceTimersByTime(STREAM_STATS_INTERVAL_MS); await Promise.resolve(); });
        expect(text()).toContain('30 fps');
        expect(text()).toContain('900 kbps');
    });

    it("your own stream says what limits it and how many it is encoded for", async () => {
        await mount([{ ...base, direction: 'outbound', limit: 'cpu', targetKbps: 6500, viewers: 3, hardware: false, implementation: 'OpenH264' }]);
        expect(text()).toContain('Your stream');
        expect(text()).toContain('CPU (the encoder cannot keep up)');
        expect(text()).toContain('3 viewers');
        expect(text()).toContain('software (OpenH264)');
        expect(text()).toContain('target 6.5 Mbps');
    });

    it('a frozen picture says so, ticking, in place of "0 freezes"; frames back, the count is back', async () => {
        const still = { ...base, fps: 0, framesDropped: 0, freezes: 0, lossPct: 31, videoKbps: 2100 };
        await mount([{ ...still, frozenMs: 12_400 }, { ...still, frozenMs: 13_400 }, { ...base, freezes: 1 }]);
        expect(text()).toContain('1920×1080 · 0 fps');
        expect(text()).toContain('Frozenfor 12 s');
        expect(text()).not.toContain('freezes');
        await act(async () => { vi.advanceTimersByTime(STREAM_STATS_INTERVAL_MS); await Promise.resolve(); });
        expect(text()).toContain('Frozenfor 13 s');
        await act(async () => { vi.advanceTimersByTime(STREAM_STATS_INTERVAL_MS); await Promise.resolve(); });
        expect(text()).not.toContain('Frozen');
        expect(text()).toContain('2 frames · 1 freezes');
    });

    it('a first read says "measuring", never a fake zero', async () => {
        await mount([{ ...base, measured: false, videoKbps: null, lossPct: null }]);
        expect(text()).toContain('measuring…');
        expect(text()).not.toContain('0 kbps');
    });

    it('never stacks a second read behind a slow one', async () => {
        let release!: () => void;
        let calls = 0;
        live.views = [];
        // One sampler whose first read hangs until released.
        const slow = new Promise<null>((res) => { release = () => res(null); });
        const mod = await import('../api/rtc/streamStatsLive');
        vi.spyOn(mod, 'streamStatsSampler').mockReturnValue({ sample: () => { calls++; return slow; } } as never);
        await act(async () => { root.render(<StreamStatsOverlay stream={{} as MediaStream} onClose={() => {}} />); });
        await act(async () => { vi.advanceTimersByTime(STREAM_STATS_INTERVAL_MS * 3); await Promise.resolve(); });
        expect(calls).toBe(1);
        await act(async () => { release(); await Promise.resolve(); });
    });

    it('says when no video is flowing', async () => {
        await mount([]);
        expect(text()).toContain('No video is flowing');
    });

    it('closes from its own button', async () => {
        const onClose = await mount([base]);
        await act(async () => { (container.querySelector('button[aria-label="Hide stream stats"]') as HTMLButtonElement).click(); });
        expect(onClose).toHaveBeenCalled();
    });
});
