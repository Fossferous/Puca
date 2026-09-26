/**
 * The minute health line. It exists because a call degraded after hours on one
 * machine (2026-09-25) and nothing had been written down: so the line must
 * (a) carry each number that could have drifted, (b) be measured over the
 * minute rather than since the call began, and (c) start and stop with the
 * call and never run twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { voiceDiagnostics, meshDiagnostics, sfuAudio, meshAudio, invoke, replay } = vi.hoisted(() => ({
    voiceDiagnostics: vi.fn(),
    meshDiagnostics: vi.fn(),
    sfuAudio: vi.fn(),
    meshAudio: vi.fn(),
    invoke: vi.fn(),
    replay: { phase: 'idle', fps: 0, kbps: 0, ringBytes: 0, droppedFrames: 0 },
}));

vi.mock('../api/platform', () => ({ isTauri: () => true }));
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { voiceDiagnostics, inboundAudioHealth: sfuAudio } }));
vi.mock('../api/webrtc', () => ({ webrtcManager: { inboundAudioHealth: meshAudio, meshDiagnostics } }));
vi.mock('../api/clips/replayBuffer', () => ({ getReplayState: () => replay }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

import {
    formatHealthLine, formatSendLine, sampleHealth, noteRender, startHealthLog, stopHealthLog,
    healthLogSettled, healthLogRunning, HEALTH_INTERVAL_MS, type HealthInput,
} from '../api/healthLog';
import { outboundTrackId, summariseInboundAudio, videoSendExtras } from '../api/rtc/statsSummary';

const report = (rows: Array<Record<string, unknown>>) => {
    const m = new Map(rows.map(r => [String(r.id), r]));
    return m as unknown as RTCStatsReport;
};

const base: HealthInput = {
    minutesInCall: 12, video: [], sending: [], audio: [], lagAvgMs: 1, lagMaxMs: 4, longTasks: 0, longTaskMs: 0,
    heapMB: 18, domNodes: 480, audioEls: 5, videoEls: 1, renders: [], noise: null,
    clip: { phase: 'idle', fps: 0, kbps: 0, ringMB: 0, dropped: 0 },
};

beforeEach(() => {
    voiceDiagnostics.mockReset().mockResolvedValue({ remoteRtp: [], noise: { mode: 'deepfilter', contextState: 'running', deepFilter: { worker: { avgMs: 3.68, maxMs: 4.6, overBudgetHops: 0 }, worklet: { dryDelta: 0, flipsDelta: 0, overloaded: false } } } });
    meshDiagnostics.mockReset().mockResolvedValue([]);
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

/**
 * WHAT YOU SEND. On 2026-09-25 a viewer received a steady 22 fps with nothing
 * lost: the cause was on the streamer's machine, and nothing said whether the
 * screen only changed 22 times a second or the encoder dropped frames. The
 * streamer's own line now says which.
 */
describe('the sending side', () => {
    const share = {
        source: 'screen_share', rid: null, peer: null, active: true, ended: false, setFps: 30, maxFps: null, captureFps: 30, fps: 22,
        frames: 1000, size: '1920x1080', limit: 'cpu', limitPct: 40, hw: false, encoder: 'OpenH264',
    };
    /** An SFU localRtp row for the share, sender `ssrc`, with its cumulative
     *  qualityLimitationDurations. */
    const row = (none: number, cpu: number, ssrc = 1) => ({
        source: 'screen_share', kind: 'video', fps: 22, setFps: 30, captureFps: 30, size: '1920x1080', ssrc,
        limit: 'cpu', limitDurations: { none, cpu, bandwidth: 0, other: 0 }, hwEncoder: false, encoder: 'OpenH264',
    });
    const mic = { source: 'microphone', kind: 'audio', fps: undefined };
    const sfu = (...localRtp: unknown[]) => ({ connected: true, localRtp, remoteRtp: [] });
    /** A fresh call: startHealthLog clears the last-minute baselines. */
    const newCall = () => { startHealthLog(); stopHealthLog(); };

    it('puts chosen, captured and sent frame rates side by side, with the limit and the encoder', () => {
        expect(formatSendLine({ ...base, sending: [share] }))
            .toBe('health-send t=12min s=[screen_share:set30fps cap30fps sent22fps/1920x1080 lim:cpu40% sw:OpenH264]');
        expect(formatHealthLine({ ...base, sending: [share] }), 'the main line counts them').toContain(' s=1 ');
        expect(formatHealthLine(base)).toContain(' s=none ');
        expect(formatSendLine(base), 'no detail line when nothing is sent').toBeNull();
    });

    it('says ? rather than none when no transport could be read', () => {
        const line = formatHealthLine({ ...base, video: null, sending: null });
        expect(line).toContain('v=[?]');
        expect(line).toContain(' s=? ');
        expect(formatSendLine({ ...base, sending: null })).toBeNull();
    });

    it('keeps the fixed fields ahead of anything that grows with the call', () => {
        // The native sink keeps the first 2000 characters of a line. A big mesh
        // call used to push page lag, noise and clip state off the end.
        const many = Array.from({ length: 40 }, (_, i) => i);
        const line = formatHealthLine({
            ...base,
            video: many.map(i => ({ source: `camera<${i}`, fps: 30, size: '1280x720', dropped: 0, freezes: 0, freezeMs: 0, jbMs: 45, decodeMs: 3, lost: 0 })),
            audio: many.map(i => ({ id: String(i), userId: String(i), jbMs: 60, concealedPct: 0.3, accelPct: 1.2, decelPct: 0.5, lost: 0 })),
            sending: many.map(i => ({ ...share, peer: String(i) })),
        });
        expect(line.length, 'the rig of this test: the line really is over the cap').toBeGreaterThan(2000);
        const kept = line.slice(0, 2000);
        for (const part of ['lag1/4ms', 'heap18MB', 'renders/min', 'nz=', 'clip=idle', ' s=40 ']) expect(kept).toContain(part);
    });

    it('marks a paused rung as paused, a capped rung by its cap, and a real zero as zero', () => {
        const line = formatSendLine({ ...base, sending: [
            { ...share, source: 'camera', rid: 'f', active: false, fps: null, size: null },
            { ...share, source: 'camera', rid: 'q', maxFps: 15, fps: 15, size: '320x180', limit: 'none', limitPct: 0, encoder: 'libvpx' },
            { ...share, source: 'camera', rid: 'h', maxFps: 60, fps: 30, size: '640x360', limit: 'none', limitPct: 0 },
            { ...share, rid: 'x', fps: null, frames: 1200 },
            { ...share, rid: 'y', fps: null, frames: null },
            { ...share, source: 'camera', peer: '9', ended: true, fps: null },
        ] })!;
        expect(line).toContain('camera/f:paused;');
        expect(line, 'a binding cap is shown, so 15 of 30 is not read as drops').toContain('camera/q:set30fps max15fps cap30fps sent15fps/320x180 lim:none sw:libvpx');
        expect(line, 'a cap above the chosen rate binds nothing and is not shown').toContain('camera/h:set30fps cap30fps sent30fps/640x360');
        expect(line, 'Chromium omits fps when it is 0: with a frame counter that is 0').toContain('screen_share/x:set30fps cap30fps sent0fps/');
        expect(line, 'no fps and no counter is unknown').toContain('screen_share/y:set30fps cap30fps sent?/');
        expect(line, 'a mesh camera switched off is off, not a dead capture').toContain('camera>9:off');
    });

    it('carries paused, capped, zero, ended and hardware rows from the diagnostics into the line', async () => {
        newCall();
        voiceDiagnostics.mockResolvedValueOnce(sfu(
            { source: 'camera', kind: 'video', rid: 'f', active: false, setFps: 30, ssrc: 11 },
            { source: 'camera', kind: 'video', rid: 'q', active: true, setFps: 30, maxFps: 15, captureFps: 30, fps: 15, frames: 900, size: '320x180', ssrc: 12, limit: 'none', limitDurations: { none: 60, cpu: 0 }, encoder: 'libvpx', hwEncoder: false },
            { source: 'screen_share', kind: 'video', active: true, setFps: 30, captureFps: 30, frames: 5000, size: '1920x1080', ssrc: 13, limit: 'none', limitDurations: { none: 60, cpu: 0 }, encoder: 'MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)', hwEncoder: true },
            { source: 'camera', kind: 'video', ended: true, ssrc: 14 },
        ));
        const line = await sampleHealth();
        expect(line).toContain('camera/f:paused');
        expect(line).toContain('camera/q:set30fps max15fps cap30fps sent15fps/320x180 lim:none sw:libvpx');
        expect(line, 'no fps with a counter is 0, and the encoder name is the part in brackets')
            .toContain('screen_share:set30fps cap30fps sent0fps/1920x1080 lim:none hw:NVIDIA H.264 Encoder MFT');
        expect(line).toContain('camera:off');
        expect(line).toContain(' s=4 ');
    });

    it('works out the limit over THIS minute from the running totals', async () => {
        newCall();
        voiceDiagnostics.mockResolvedValueOnce(sfu(row(40, 60), mic));
        const first = await sampleHealth();
        expect(first, 'the first read covers the share so far: 60 of 100 s limited').toContain('lim:cpu60%');
        expect(first).not.toContain('microphone');
        voiceDiagnostics.mockResolvedValueOnce(sfu(row(76, 84), mic));
        const second = await sampleHealth();
        expect(second, '24 of the last 60 s were CPU-limited').toContain('lim:cpu40%');
        expect(second).toContain('set30fps cap30fps sent22fps/1920x1080');
        expect(second).toContain('sw:OpenH264');
        voiceDiagnostics.mockResolvedValueOnce(sfu(row(136, 84), mic));
        expect(await sampleHealth(), 'a clean minute after limited ones').toContain('lim:none');
    });

    it('never differences a NEW sender against the old one (a restarted share, a camera flip, a reconnect)', async () => {
        newCall();
        // A short first share: nothing in the new sender's counts goes DOWN from
        // it, so only keying by the sender (ssrc) can tell the two apart.
        voiceDiagnostics.mockResolvedValueOnce(sfu(row(30, 0, 1)));
        await sampleHealth();
        // The share was stopped and started: a new sender, counters from zero.
        voiceDiagnostics.mockResolvedValueOnce(sfu(row(40, 20, 2)));
        expect(await sampleHealth(), '20 of its 60 s, not 20 of the 30 left after subtracting the old share').toContain('lim:cpu33%');
    });

    it('forgets a sender that is gone, so one that comes back starts afresh', async () => {
        newCall();
        const noId = (none: number, cpu: number) => ({ ...row(none, cpu), ssrc: undefined });
        voiceDiagnostics.mockResolvedValueOnce(sfu(noId(30, 0)));
        await sampleHealth();
        voiceDiagnostics.mockResolvedValueOnce(sfu()); // the share stopped
        await sampleHealth();
        voiceDiagnostics.mockResolvedValueOnce(sfu(noId(40, 20))); // a new share, same name, no id
        expect(await sampleHealth()).toContain('lim:cpu33%');
    });

    it('treats any counter going down as a new sender, even without an id', async () => {
        newCall();
        const noId = (none: number, cpu: number) => ({ ...row(none, cpu), ssrc: undefined });
        voiceDiagnostics.mockResolvedValueOnce(sfu(noId(50, 550)));
        await sampleHealth();
        voiceDiagnostics.mockResolvedValueOnce(sfu(noId(55, 5)));
        expect(await sampleHealth(), 'a clamp per reason would have said none').toContain('lim:cpu8%');
    });

    it('reads a peer-to-peer call when there is no SFU room: one encoder per peer, by source and direction', async () => {
        newCall();
        voiceDiagnostics.mockResolvedValueOnce({ connected: false, localRtp: [], remoteRtp: [] });
        meshDiagnostics.mockResolvedValueOnce([{
            userId: 7,
            rtp: [
                { dir: 'outbound-rtp', kind: 'video', source: 'screen_share', fps: 30, setFps: 30, captureFps: 30, size: '1920x1080', ssrc: 5, limit: 'none', limitDurations: { none: 60, cpu: 0 }, encoder: 'libvpx', hwEncoder: false },
                { dir: 'outbound-rtp', kind: 'audio' },
                { dir: 'inbound-rtp', kind: 'video' },
            ],
            latency: { inbound: [
                { source: 'camera', fps: 29, size: '1280x720', framesDropped: 0, freezeCount: 0, freezeMs: 0, jitterBufferMs: 40, decodeMs: 2, packetsLost: 0 },
                { fps: 15, size: '640x360', framesDropped: 0, freezeCount: 0, freezeMs: 0, jitterBufferMs: 40, decodeMs: 2, packetsLost: 0 },
            ] },
        }]);
        const line = await sampleHealth();
        expect(line, '>7: sent TO peer 7').toContain('s=[screen_share>7:set30fps cap30fps sent30fps/1920x1080 lim:none sw:libvpx]');
        expect(line, '<7: received FROM peer 7, labelled by what it is').toContain('v=[camera<7:29fps/1280x720');
        expect(line, 'unknown source stays generic').toContain(';video<7:15fps/640x360');
    });

    it('prints a dead incoming copy (a peer\'s camera switched off) as off, not as a frozen camera', async () => {
        voiceDiagnostics.mockResolvedValueOnce({ connected: false, localRtp: [], remoteRtp: [] });
        meshDiagnostics.mockResolvedValueOnce([{
            userId: 7, rtp: [],
            latency: { inbound: [
                { source: 'camera', ended: true, fps: 0, size: '640x360' },
                { source: 'camera', fps: 30, size: '640x360', framesDropped: 0, freezeCount: 0, freezeMs: 0, jitterBufferMs: 40, decodeMs: 2, packetsLost: 0 },
            ] },
        }]);
        const line = await sampleHealth();
        expect(line).toContain('v=[camera<7:off;camera<7:30fps/640x360');
    });

    it('prefers the SFU room when there is one', async () => {
        voiceDiagnostics.mockResolvedValueOnce(sfu(row(10, 0)));
        await sampleHealth();
        expect(meshDiagnostics).not.toHaveBeenCalled();
    });

    it('says ? when neither transport answers', async () => {
        voiceDiagnostics.mockRejectedValueOnce(new Error('no room'));
        meshDiagnostics.mockRejectedValueOnce(new Error('no peers map'));
        const line = await sampleHealth();
        expect(line).toContain('v=[?]');
        expect(line).toContain(' s=? ');
        expect(line).not.toContain('health-send');
    });

    it('joins the capture by ITS id, and reads each rung\'s cap, state and sender id', () => {
        const stats = report([
            // A decoy first in iteration order: "the first media-source" is wrong.
            { id: 'decoy', type: 'media-source', kind: 'video', framesPerSecond: 60, trackIdentifier: 'other' },
            { id: 'out', type: 'outbound-rtp', kind: 'video', rid: 'q', mediaSourceId: 'src', frameWidth: 320, frameHeight: 180, framesPerSecond: 15, active: true, ssrc: 4242 },
            { id: 'src', type: 'media-source', kind: 'video', framesPerSecond: 30, trackIdentifier: 'cam-track' },
            { id: 'solo', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'src', framesPerSecond: 22 },
        ]);
        const get = (id: string) => (stats as unknown as Map<string, Record<string, unknown>>).get(id)!;
        const encodings = [{ rid: 'q', maxFramerate: 15, active: true }, { rid: 'h', maxFramerate: 20 }, { rid: 'f', active: false }];
        // Sent 15, captured 30 (not 15, not the decoy's 60): the rung's own cap is 15.
        expect(videoSendExtras(stats, get('out'), 30, encodings))
            .toEqual({ setFps: 30, maxFps: 15, captureFps: 30, size: '320x180', active: true, ssrc: 4242 });
        // No rid: the single encoding applies; more than one would be a guess.
        expect(videoSendExtras(stats, get('solo'), 30, [{ maxFramerate: 60 }])).toEqual({ setFps: 30, maxFps: 60, captureFps: 30 });
        expect(videoSendExtras(stats, get('solo'), 30, encodings), 'ambiguous: no cap claimed').toEqual({ setFps: 30, captureFps: 30 });
        expect(videoSendExtras(stats, { kind: 'audio' }, 30), 'nothing for audio').toEqual({});
        expect(videoSendExtras(stats, { kind: 'video' }, undefined), 'nothing invented').toEqual({});
        expect(videoSendExtras(stats, { kind: 'video' }, 0), 'a 0 setting is not a choice').toEqual({});
        expect(outboundTrackId(stats, get('out'))).toBe('cam-track');
        expect(outboundTrackId(stats, { kind: 'video' })).toBeNull();
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
