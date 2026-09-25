/**
 * The minute health line. It exists because a call degraded after hours on one
 * machine (2026-09-25) and nothing had been written down: so the line must
 * (a) carry each number that could have drifted, (b) be measured over the
 * minute rather than since the call began, and (c) start and stop with the
 * call and never run twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { voiceDiagnostics, sfuAudio, meshAudio, invoke, replay } = vi.hoisted(() => ({
    voiceDiagnostics: vi.fn(),
    sfuAudio: vi.fn(),
    meshAudio: vi.fn(),
    invoke: vi.fn(),
    replay: { phase: 'idle', fps: 0, kbps: 0, ringBytes: 0, droppedFrames: 0 },
}));

vi.mock('../api/platform', () => ({ isTauri: () => true }));
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { voiceDiagnostics, inboundAudioHealth: sfuAudio } }));
vi.mock('../api/webrtc', () => ({ webrtcManager: { inboundAudioHealth: meshAudio } }));
vi.mock('../api/clips/replayBuffer', () => ({ getReplayState: () => replay }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
    formatHealthLine, sampleHealth, noteRender, startHealthLog, stopHealthLog,
    healthLogSettled, healthLogRunning, HEALTH_INTERVAL_MS, type HealthInput,
} from '../api/healthLog';
import { summariseInboundAudio } from '../api/rtc/statsSummary';

const report = (rows: Array<Record<string, unknown>>) => {
    const m = new Map(rows.map(r => [String(r.id), r]));
    return m as unknown as RTCStatsReport;
};

const base: HealthInput = {
    minutesInCall: 12, video: [], audio: [], lagAvgMs: 1, lagMaxMs: 4, longTasks: 0, longTaskMs: 0,
    heapMB: 18, domNodes: 480, audioEls: 5, videoEls: 1, renders: [], noise: null,
    clip: { phase: 'idle', fps: 0, kbps: 0, ringMB: 0, dropped: 0 },
};

beforeEach(() => {
    voiceDiagnostics.mockReset().mockResolvedValue({ remoteRtp: [], noise: { mode: 'deepfilter', contextState: 'running', deepFilter: { worker: { avgMs: 3.68, maxMs: 4.6, overBudgetHops: 0 }, worklet: { dryDelta: 0, flipsDelta: 0, overloaded: false } } } });
    sfuAudio.mockReset().mockResolvedValue([]);
    meshAudio.mockReset().mockResolvedValue([]);
    invoke.mockReset().mockResolvedValue(undefined);
    Object.assign(replay, { phase: 'idle', fps: 0, kbps: 0, ringBytes: 0, droppedFrames: 0 });
});
afterEach(() => { stopHealthLog(); vi.useRealTimers(); });

describe('an incoming voice, measured over a window', () => {
    it('reports the jitter buffer and concealment of THIS window, not since the call began', () => {
        const before = report([{ id: 'A', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 10, jitterBufferEmittedCount: 1000, totalSamplesReceived: 100_000, concealedSamples: 0, removedSamplesForAcceleration: 0, insertedSamplesForDeceleration: 0, packetsLost: 0 }]);
        const after = report([{ id: 'A', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 40, jitterBufferEmittedCount: 1100, totalSamplesReceived: 200_000, concealedSamples: 5_000, removedSamplesForAcceleration: 1_000, insertedSamplesForDeceleration: 0, packetsLost: 7 }]);
        const [h] = summariseInboundAudio(before, after);
        // 30 s of buffering spread over 100 new samples = 300 ms each — the
        // since-start average would have said (40/1100) ≈ 36 ms and hidden it.
        expect(h.jbMs).toBe(300);
        expect(h.concealedPct).toBe(5);
        expect(h.accelPct).toBe(1);
        expect(h.decelPct).toBe(0);
        expect(h.lost).toBe(7);
    });

    it('says "unknown", not zero, when a window has nothing to divide by', () => {
        const same = [{ id: 'A', type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 1, jitterBufferEmittedCount: 10, totalSamplesReceived: 480, concealedSamples: 0 }];
        const [h] = summariseInboundAudio(report(same), report(same));
        expect(h.jbMs).toBeNull();
        expect(h.concealedPct).toBeNull();
    });

    it('ignores video and outbound rows', () => {
        const r = report([
            { id: 'V', type: 'inbound-rtp', kind: 'video', framesDecoded: 5 },
            { id: 'O', type: 'outbound-rtp', kind: 'audio', packetsSent: 5 },
        ]);
        expect(summariseInboundAudio(null, r)).toEqual([]);
    });
});

describe('the line', () => {
    it('carries every number that could drift, in one place', () => {
        const line = formatHealthLine({
            ...base,
            video: [{ source: 'screen_share', fps: 22, size: '1280x720', dropped: 0, freezes: 1, freezeMs: 250, jbMs: 45, decodeMs: 0.4, lost: 0 }],
            audio: [{ id: 'x', userId: '8', jbMs: 60, concealedPct: 0.2, accelPct: 0, decelPct: 0.1, lost: 0 }],
            renders: [['chat', 42], ['voicePanel', 30]],
            noise: { mode: 'deepfilter', context: 'running', dfAvgMs: 3.7, dfMaxMs: 4.6, overBudget: 0, dry: 0, flips: 0, overloaded: false },
            clip: { phase: 'armed', fps: 30, kbps: 7600, ringMB: 290, dropped: 0 },
        });
        for (const part of ['t=12min', 'screen_share:22fps/1280x720', 'frz1/250ms', '8:jb60ms/conc0.2%', 'lag1/4ms', 'heap18MB', 'audioEl5', 'chat42', 'voicePanel30', 'df3.7ms/4.6ms', 'clip=armed/30fps/7600kbps/290MB']) {
            expect(line).toContain(part);
        }
        expect(line).not.toContain('OVERLOADED');
    });

    it('says "none" and "?" rather than inventing numbers', () => {
        const line = formatHealthLine({ ...base, heapMB: null });
        expect(line).toContain('v=[none]');
        expect(line).toContain('a=[none]');
        expect(line).toContain('heap?');
        expect(line).toContain('nz=?');
    });

    it('shouts when the noise filter is overloaded', () => {
        const line = formatHealthLine({ ...base, noise: { mode: 'deepfilter', context: 'running', dfAvgMs: 12, dfMaxMs: 30, overBudget: 40, dry: 3, flips: 2, overloaded: true } });
        expect(line).toContain('OVERLOADED');
    });
});

describe('sampling', () => {
    it('counts renders per minute and starts the next minute from zero', async () => {
        noteRender('chat'); noteRender('chat'); noteRender('voicePanel');
        const first = await sampleHealth();
        expect(first).toContain('chat2');
        expect(first).toContain('voicePanel1');
        const second = await sampleHealth();
        expect(second).toContain('renders/min none');
    });

    it('falls back to the peer-to-peer voices when there is no SFU call', async () => {
        meshAudio.mockResolvedValue([{ id: 'm', userId: '4', jbMs: 80, concealedPct: 0, accelPct: 0, decelPct: 0, lost: 0 }]);
        expect(await sampleHealth()).toContain('4:jb80ms');
        // POSITIVE CONTROL: with SFU voices present, those are what it reports.
        sfuAudio.mockResolvedValue([{ id: 's', userId: '9', jbMs: 50, concealedPct: 0, accelPct: 0, decelPct: 0, lost: 0 }]);
        const line = await sampleHealth();
        expect(line).toContain('9:jb50ms');
        expect(line).not.toContain('4:jb80ms');
    });
});

describe('lifecycle', () => {
    const lines = () => invoke.mock.calls.filter(c => c[0] === 'log_stream_diag').map(c => String((c[1] as { line: string }).line));

    it('writes a line each minute while in a call, and nothing after it ends', async () => {
        vi.useFakeTimers();
        startHealthLog();
        expect(healthLogRunning()).toBe(true);
        await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 2 + 5000);
        await healthLogSettled();
        const during = lines().filter(l => l.startsWith('health t='));
        expect(during.length).toBe(2);
        stopHealthLog();
        expect(healthLogRunning()).toBe(false);
        await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS * 3);
        await healthLogSettled();
        expect(lines().filter(l => l.startsWith('health t=')).length).toBe(2);
        expect(lines()).toContain('health stopped');
    });

    it('never runs twice when started twice', async () => {
        vi.useFakeTimers();
        startHealthLog();
        startHealthLog();
        await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS + 5000);
        await healthLogSettled();
        expect(lines().filter(l => l.startsWith('health t=')).length).toBe(1);
        expect(lines().filter(l => l === 'health started').length).toBe(1);
    });

    it('measures how late the page runs its timers', async () => {
        vi.useFakeTimers();
        startHealthLog();
        // A main thread that is 300 ms late once in the minute: the probe must
        // see it (this is what "the page fell behind" looks like).
        await vi.advanceTimersByTimeAsync(10_000);
        vi.setSystemTime(Date.now() + 300);
        await vi.advanceTimersByTimeAsync(HEALTH_INTERVAL_MS);
        await healthLogSettled();
        const line = lines().find(l => l.startsWith('health t='))!;
        expect(line).toMatch(/lag\d+\/(\d{3})ms/);
    });
});
