/**
 * rtc/statsSummary — the reducer every latency diagnostic reads through.
 *
 * Fed hand-built getStats rows with KNOWN values, so each derived
 * millisecond can be checked against arithmetic rather than against another
 * copy of the same code. The positive controls matter: a reducer that
 * returned null for everything would make every diagnostic look healthy.
 */
import { describe, it, expect } from 'vitest';
import {
    formatLatencyLine, receiverHints, summariseRtcStats, summariseRtcStatsDelta,
} from '../api/rtc/statsSummary';

type Row = Record<string, unknown> & { id: string; type: string };

/** A getStats report stand-in: only `forEach` is used by the reducer. */
function report(rows: Row[]): RTCStatsReport {
    return { forEach: (fn: (v: unknown) => void) => rows.forEach(fn) } as unknown as RTCStatsReport;
}

const inboundRow = (over: Partial<Row> = {}): Row => ({
    id: 'in1', type: 'inbound-rtp', kind: 'video', ssrc: 111,
    framesReceived: 600, framesDecoded: 600, framesDropped: 3, framesPerSecond: 30,
    frameWidth: 1920, frameHeight: 1080, decoderImplementation: 'libvpx',
    jitterBufferDelay: 12.0, jitterBufferTargetDelay: 9.0, jitterBufferMinimumDelay: 6.0, jitterBufferEmittedCount: 600,
    totalProcessingDelay: 15.0, totalAssemblyTime: 0.6, framesAssembledFromMultiplePackets: 300,
    totalDecodeTime: 1.5, totalInterFrameDelay: 20.0, freezeCount: 2, totalFreezesDuration: 0.75, pauseCount: 0,
    packetsLost: 7, nackCount: 5, pliCount: 1, keyFramesDecoded: 4, bytesReceived: 5_000_000,
    ...over,
});
const outboundRow = (over: Partial<Row> = {}): Row => ({
    id: 'out1', type: 'outbound-rtp', kind: 'video', ssrc: 222, rid: undefined,
    framesSent: 590, framesEncoded: 600, framesPerSecond: 30, frameWidth: 1280, frameHeight: 720,
    encoderImplementation: 'OpenH264', totalEncodeTime: 3.0, totalPacketSendDelay: 2.5, packetsSent: 5000,
    qualityLimitationReason: 'bandwidth', qualityLimitationDurations: { bandwidth: 4, cpu: 0, none: 10, other: 0 },
    qualityLimitationResolutionChanges: 2, targetBitrate: 4_500_000, bytesSent: 9_000_000,
    keyFramesEncoded: 3, hugeFramesSent: 1, nackCount: 0, pliCount: 2,
    ...over,
});
const transportRows: Row[] = [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'P' },
    { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.183, availableOutgoingBitrate: 2_400_000, state: 'succeeded' },
    { id: 'L', type: 'local-candidate', candidateType: 'relay', protocol: 'udp', relayProtocol: 'tcp' },
    { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' },
    { id: 'RI', type: 'remote-inbound-rtp', kind: 'video', ssrc: 222, roundTripTime: 0.2, fractionLost: 0.03, jitter: 0.004 },
];

describe('summariseRtcStats', () => {
    it('turns cumulative counters into per-frame / per-packet milliseconds', () => {
        const s = summariseRtcStats(report([inboundRow(), outboundRow(), ...transportRows]));
        expect(s.inbound).toHaveLength(1);
        const i = s.inbound[0];
        expect(i.jitterBufferMs, '12 s over 600 frames').toBe(20);
        expect(i.jitterBufferTargetMs).toBe(15);
        expect(i.jitterBufferMinMs).toBe(10);
        expect(i.processingMs).toBe(25);
        expect(i.assemblyMs, '0.6 s over 300 multi-packet frames').toBe(2);
        expect(i.decodeMs).toBe(2.5);
        expect(i.interFrameMs).toBe(33);
        expect(i.freezeMs).toBe(750);
        expect(i.size).toBe('1920x1080');
        expect(i.decoder).toBe('libvpx');
        expect(i.framesDropped).toBe(3);
        expect(i.packetsLost).toBe(7);

        const o = s.outbound[0];
        expect(o.encodeMs).toBe(5);
        expect(o.sendDelayMs, '2.5 s over 5000 packets').toBe(0.5);
        expect(o.encodeSentGap, 'frames parked between encoder and sender').toBe(10);
        expect(o.targetKbps).toBe(4500);
        expect(o.limit).toBe('bandwidth');
        expect(o.encoder).toBe('OpenH264');
        expect(o.size).toBe('1280x720');
    });

    it('names the selected pair and the protocol the media actually rides', () => {
        const s = summariseRtcStats(report([outboundRow(), ...transportRows]));
        expect(s.pair).toEqual({
            rttMs: 183, outKbps: 2400, inKbps: null,
            local: 'relay/udp/tcp', remote: 'host/udp',
            // A TURN relay reports its own transport: this pair is TCP to
            // the relay however the candidate itself is labelled.
            protocol: 'tcp',
        });
        expect(s.remoteInbound).toEqual([{ ssrc: 222, rttMs: 200, fractionLost: 0.03, jitterMs: 4 }]);
    });

    it('falls back to a nominated succeeded pair when the report has no transport row', () => {
        const rows = transportRows.filter(r => r.type !== 'transport').map(r => (r.id === 'P' ? { ...r, nominated: true } : r));
        const s = summariseRtcStats(report(rows));
        expect(s.pair?.rttMs).toBe(183);
    });

    it('answers null, not 0, for a field the browser did not provide, and skips audio', () => {
        const s = summariseRtcStats(report([
            inboundRow({ jitterBufferTargetDelay: undefined, totalProcessingDelay: undefined, framesAssembledFromMultiplePackets: 0 }),
            { id: 'a', type: 'inbound-rtp', kind: 'audio', ssrc: 5, jitterBufferDelay: 1, jitterBufferEmittedCount: 1 },
        ]));
        expect(s.inbound).toHaveLength(1);
        expect(s.inbound[0].jitterBufferTargetMs).toBeNull();
        expect(s.inbound[0].processingMs).toBeNull();
        expect(s.inbound[0].assemblyMs, 'no multi-packet frames yet').toBeNull();
        expect(s.pair).toBeNull();
    });

    it('a stream with no decoded frame yet reports null delays rather than dividing by zero', () => {
        const s = summariseRtcStats(report([inboundRow({ framesDecoded: 0, jitterBufferEmittedCount: 0 })]));
        expect(s.inbound[0].jitterBufferMs).toBeNull();
        expect(s.inbound[0].decodeMs).toBeNull();
    });
});

describe('summariseRtcStatsDelta', () => {
    it('measures the WINDOW, not the life of the track', () => {
        // Life-of-track averages are healthy (20 ms buffer); the last 2 s
        // were not — 100 frames that each sat 300 ms.
        const before = report([inboundRow({ framesDecoded: 600, jitterBufferEmittedCount: 600, jitterBufferDelay: 12.0, totalDecodeTime: 1.5, freezeCount: 2, bytesReceived: 5_000_000 })]);
        const after = report([inboundRow({ framesDecoded: 700, jitterBufferEmittedCount: 700, jitterBufferDelay: 42.0, totalDecodeTime: 2.5, freezeCount: 5, bytesReceived: 5_800_000 })]);
        const cumulative = summariseRtcStats(after);
        expect(cumulative.inbound[0].jitterBufferMs, 'the one-shot read hides it').toBe(60);
        const w = summariseRtcStatsDelta(before, after, 2000);
        expect(w.inbound[0].jitterBufferMs, 'thirty seconds over the 100 frames of the window').toBe(300);
        expect(w.inbound[0].decodeMs).toBe(10);
        expect(w.inbound[0].freezeCount).toBe(3);
        expect(w.inbound[0].fps, '100 frames in 2 s').toBe(50);
        expect(w.inbound[0].bytes).toBe(800_000);
    });

    it('a stream that appeared mid-window has no delta and is left out', () => {
        const w = summariseRtcStatsDelta(report([]), report([inboundRow()]), 1000);
        expect(w.inbound).toHaveLength(0);
    });

    it('the limit-reason durations are windowed per reason, not reported for the life of the track', () => {
        const before = report([outboundRow({ qualityLimitationDurations: { bandwidth: 240, cpu: 0, none: 360, other: 0 } })]);
        const after = report([outboundRow({ qualityLimitationDurations: { bandwidth: 244.5, cpu: 0.5, none: 360, other: 0 } })]);
        const w = summariseRtcStatsDelta(before, after, 5000);
        expect(w.outbound[0].limitDurations).toEqual({ bandwidth: 4.5, cpu: 0.5, none: 0, other: 0 });
        // Absent on one side: unknown, never a lifetime figure.
        const w2 = summariseRtcStatsDelta(report([outboundRow({ qualityLimitationDurations: undefined })]), after, 5000);
        expect(w2.outbound[0].limitDurations).toBeNull();
    });

    it('the outbound gap and pacer delay are windowed too', () => {
        const before = report([outboundRow({ framesEncoded: 600, framesSent: 600, totalPacketSendDelay: 2.5, packetsSent: 5000 })]);
        const after = report([outboundRow({ framesEncoded: 660, framesSent: 640, totalPacketSendDelay: 12.5, packetsSent: 5100 })]);
        const w = summariseRtcStatsDelta(before, after, 2000);
        expect(w.outbound[0].encodeSentGap, '20 frames parked during the window').toBe(20);
        expect(w.outbound[0].sendDelayMs, '10 s over 100 packets').toBe(100);
    });
});

describe('receiverHints and the log line', () => {
    it('reads back what a receiver was asked to hold', () => {
        const video = { track: { kind: 'video' }, playoutDelayHint: 0, jitterBufferTarget: 0 } as unknown as RTCRtpReceiver;
        const audio = { track: { kind: 'audio' }, playoutDelayHint: 0.2 } as unknown as RTCRtpReceiver;
        const unset = { track: { kind: 'video' } } as unknown as RTCRtpReceiver;
        expect(receiverHints([video, audio, unset])).toEqual([
            { playoutDelayHint: 0, jitterBufferTarget: 0 },
            { playoutDelayHint: null, jitterBufferTarget: null },
        ]);
    });

    it('formats one fragment per stream plus the pair', () => {
        const s = summariseRtcStats(report([inboundRow(), outboundRow(), ...transportRows]));
        const line = formatLatencyLine(s);
        expect(line).toContain('out fps=30 size=1280x720 enc=5ms send=0.5ms gap=10 limit=bandwidth encoder=OpenH264');
        expect(line).toContain('in fps=30 size=1920x1080 jb=20ms(target 15) proc=25ms dec=2.5ms drop=3 freeze=2 lost=7 decoder=libvpx');
        expect(line).toContain('pair=tcp relay/udp/tcp->host/udp rtt=183ms out=2400kbps');
    });
});
