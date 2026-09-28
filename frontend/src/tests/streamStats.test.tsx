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

import { summariseStreamStats, StreamStatsSampler, formatKbps, type EndpointSample, type StreamStatsView } from '../api/rtc/streamStats';
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
        framesDropped: 2, freezes: 1, limit: null, targetKbps: null, transport: 'UDP', viewers: null, measured: true,
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
