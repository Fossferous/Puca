/**
 * The unattended log sampler (api/streamDiag.ts) — the whole point is that a
 * human CANNOT read __pucaMeshDiag()/__pucaVoiceDiag() live while a
 * fullscreen game holds focus, so this must write samples to the log file on
 * its own timer without anyone at DevTools. Contract under test: it starts on
 * the FIRST holder, stops on the LAST, and actually reports data when data
 * exists (positive control) as well as when neither transport has an
 * outbound video track (so a silent bug in the diag paths themselves does
 * not read as "nothing to report").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { invokeMock, meshDiagMock, voiceDiagMock } = vi.hoisted(() => ({
    invokeMock: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>().mockResolvedValue(undefined),
    meshDiagMock: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    voiceDiagMock: vi.fn<() => Promise<Record<string, unknown>>>().mockResolvedValue({ localRtp: [] }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('../api/webrtc', () => ({ webrtcManager: { meshDiagnostics: meshDiagMock } }));
vi.mock('../api/rtc/sfuManager', () => ({ sfuManager: { voiceDiagnostics: voiceDiagMock } }));

import {
    holdStreamDiag, releaseStreamDiag, streamDiagHolders, streamDiagSettled, sampleOnce,
    setStreamDiagProbe, streamDiagIntervalMs,
} from '../api/streamDiag';

function logLines(): string[] {
    return invokeMock.mock.calls
        .filter(([cmd]) => cmd === 'log_stream_diag')
        .map(([, args]) => (args as { line: string }).line);
}

beforeEach(async () => {
    for (const h of streamDiagHolders()) releaseStreamDiag(h);
    await streamDiagSettled();
    invokeMock.mockClear();
    meshDiagMock.mockReset().mockResolvedValue([]);
    voiceDiagMock.mockReset().mockResolvedValue({ localRtp: [] });
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('streamDiag sampler', () => {
    it('positive control: a real outbound video track IS reported', async () => {
        meshDiagMock.mockResolvedValue([
            { userId: 42, rtp: [{ dir: 'outbound-rtp', kind: 'video', fps: 8, limit: 'cpu', encoder: 'libvpx' }] },
        ]);
        await sampleOnce();
        await streamDiagSettled();
        const lines = logLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('mesh peer=42');
        expect(lines[0]).toContain('limit=cpu');
        expect(lines[0]).toContain('encoder=libvpx');
    });

    it('reports the SFU localRtp path too, tagged by source', async () => {
        voiceDiagMock.mockResolvedValue({
            localRtp: [{ source: 'screen_share', kind: 'video', fps: 15, limit: 'none', encoder: 'libvpx' }],
        });
        await sampleOnce();
        await streamDiagSettled();
        expect(logLines()[0]).toContain('sfu source=screen_share');
    });

    it('ignores non-video / non-outbound entries', async () => {
        meshDiagMock.mockResolvedValue([
            { userId: 1, rtp: [
                { dir: 'inbound-rtp', kind: 'video', fps: 30 },
                { dir: 'outbound-rtp', kind: 'audio', fps: undefined },
            ] },
        ]);
        await sampleOnce();
        await streamDiagSettled();
        expect(logLines()[0]).toBe('(no outbound video track)');
    });

    it('starts on the first holder and samples immediately', async () => {
        holdStreamDiag('voice-share');
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
        const lines = logLines();
        expect(lines[0]).toBe('=== stream-diag session start ===');
    });

    it('further holders do not restart the timer or re-log the start marker', async () => {
        holdStreamDiag('voice-share');
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
        invokeMock.mockClear();
        holdStreamDiag('device-host');
        await Promise.resolve();
        expect(logLines().filter(l => l.includes('session start'))).toHaveLength(0);
        expect(streamDiagHolders().sort()).toEqual(['device-host', 'voice-share']);
    });

    it('samples repeatedly on the interval while a holder is active', async () => {
        holdStreamDiag('voice-share');
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
        const before = meshDiagMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(5000);
        await vi.advanceTimersByTimeAsync(5000);
        expect(meshDiagMock.mock.calls.length).toBeGreaterThanOrEqual(before + 2);
    });

    it('stops only when the LAST holder releases, and logs an end marker', async () => {
        holdStreamDiag('voice-share');
        holdStreamDiag('device-host');
        await vi.waitFor(() => expect(invokeMock).toHaveBeenCalled());
        await streamDiagSettled();
        releaseStreamDiag('voice-share');
        await streamDiagSettled();
        expect(logLines().some(l => l.includes('session end'))).toBe(false);
        invokeMock.mockClear();
        releaseStreamDiag('device-host');
        await streamDiagSettled();
        expect(logLines()[0]).toBe('=== stream-diag session end ===');
        // The interval must actually be cleared — advancing time produces no
        // further samples.
        const callsAtRelease = meshDiagMock.mock.calls.length;
        await vi.advanceTimersByTimeAsync(20000);
        expect(meshDiagMock.mock.calls.length).toBe(callsAtRelease);
    });

    it('does nothing outside the Tauri shell', async () => {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
        holdStreamDiag('voice-share');
        await Promise.resolve();
        expect(invokeMock).not.toHaveBeenCalled();
        expect(streamDiagHolders()).toEqual([]);
    });
});

describe('streamDiag: the viewer\'s side of a slow share', () => {
    const inbound = {
        ssrc: 1, framesReceived: 300, framesDecoded: 300, framesDropped: 0, fps: 30, size: '1920x1080',
        decoder: 'libvpx', jitterBufferMs: 240, jitterBufferTargetMs: 230, jitterBufferMinMs: 14,
        processingMs: 245, assemblyMs: 1, decodeMs: 2.1, interFrameMs: 33, freezeCount: 3, freezeMs: 900,
        pauseCount: 0, packetsLost: 12, nack: 4, pli: 1, keyFrames: 2, bytes: 1,
    };
    const pair = { rttMs: 180, outKbps: 900, inKbps: null, local: 'relay/udp/tcp', remote: 'host/udp', protocol: 'tcp' };

    it('a mesh peer\'s DELAY fields are logged — jitter buffer, processing, decode, the pair\'s protocol', async () => {
        meshDiagMock.mockResolvedValue([
            { userId: 7, rtp: [], latency: { inbound: [inbound], outbound: [], pair, remoteInbound: [] } },
        ]);
        await sampleOnce();
        await streamDiagSettled();
        const [line] = logLines();
        expect(line).toContain('mesh peer=7 in fps=30');
        expect(line).toContain('jb=240ms(target 230)');
        expect(line).toContain('proc=245ms');
        expect(line).toContain('dec=2.1ms');
        expect(line).toContain('freeze=3');
        expect(line).toContain('pair=tcp relay/udp/tcp->host/udp rtt=180ms');
    });

    it('an SFU viewer\'s subscribed share is logged by peer and source', async () => {
        voiceDiagMock.mockResolvedValue({
            localRtp: [],
            remoteRtp: [{ userId: 9, source: 'screen_share', latency: { inbound: [inbound], outbound: [], pair: null, remoteInbound: [] } }],
        });
        await sampleOnce();
        await streamDiagSettled();
        const [line] = logLines();
        expect(line).toContain('sfu peer=9 source=screen_share in fps=30');
        expect(line).toContain('jb=240ms');
    });

    it('the probe line leads every sample — the native sink caps a line at 2000 chars', async () => {
        meshDiagMock.mockResolvedValue([
            { userId: 7, rtp: [], latency: { inbound: [inbound], outbound: [], pair, remoteInbound: [] } },
        ]);
        setStreamDiagProbe(() => 'rc=viewer peer=7 lane=relay');
        try {
            await sampleOnce();
            await streamDiagSettled();
            expect(logLines()[0].startsWith('rc=viewer peer=7 lane=relay | '), 'first, never the fragment a big call cuts off').toBe(true);
        } finally {
            setStreamDiagProbe(null);
        }
    });

    it('a live remote-control holder samples every second; a bare capture every five', () => {
        holdStreamDiag('voice-share');
        expect(streamDiagIntervalMs()).toBe(5000);
        holdStreamDiag('rc-viewer');
        expect(streamDiagIntervalMs(), 'a pacer spike lasts a few hundred ms').toBe(1000);
        releaseStreamDiag('rc-viewer');
        expect(streamDiagIntervalMs(), 'back to the capture cadence').toBe(5000);
        releaseStreamDiag('voice-share');
        expect(streamDiagIntervalMs()).toBe(0);
    });
});
