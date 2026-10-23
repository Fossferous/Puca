/**
 * The desktop stage's live numbers: what the picture is doing NOW.
 *
 * "Copy diagnostics" answers after the fact, for a bug report. This answers
 * while you drive, once a second: frames a second, the path the media takes,
 * the round trip, and how long a frame waits on this end (the jitter buffer)
 * and takes to decode. Rates come from two readings of the cumulative
 * counters, so a window of the last second — not the session's average, which
 * the first minute's bandwidth ramp would drag for the rest of it.
 *
 * `hereMs` is the part of glass-to-glass this end can SEE: half the round
 * trip, plus the buffer, plus the decode. The host's capture and encode come
 * on top (a few ms each on the agent's hardware encoder, its log says), so it
 * is a floor, labelled as one; the measured figure is the input probe's.
 */
import type { DeviceStatsSample } from './session';

export interface LiveStats {
    fps: number | null;
    kbps: number | null;
    /** Average wait in the jitter buffer over the window, ms. */
    bufferMs: number | null;
    /** Average decode time a frame over the window, ms. */
    decodeMs: number | null;
    rttMs: number | null;
    /** Packets lost over the window, as a percentage of those expected. */
    lossPct: number | null;
    freezes: number;
    frame: string | null;
    path: DeviceStatsSample['path'];
    protocol: string | null;
    decoder: string | null;
    hardwareDecode: boolean | null;
    inputLane: string | null;
    /** Half the round trip + buffer + decode: this end's share. */
    hereMs: number | null;
}

/** Rates over the window between two readings of one session. */
export function liveStatsFrom(a: DeviceStatsSample, b: DeviceStatsSample): LiveStats {
    const secs = (b.at - a.at) / 1000;
    const frames = b.framesDecoded - a.framesDecoded;
    const emitted = b.jitterBufferEmittedCount - a.jitterBufferEmittedCount;
    const lost = Math.max(0, b.packetsLost - a.packetsLost);
    const got = Math.max(0, b.packetsReceived - a.packetsReceived);
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const fps = secs > 0 && frames >= 0 ? round1(frames / secs) : null;
    const bufferMs = emitted > 0 ? Math.round(((b.jitterBufferDelay - a.jitterBufferDelay) / emitted) * 1000) : null;
    const decodeMs = frames > 0 ? round1(((b.totalDecodeTime - a.totalDecodeTime) / frames) * 1000) : null;
    const hereMs = b.rttMs !== null && bufferMs !== null
        ? Math.round(b.rttMs / 2 + bufferMs + (decodeMs ?? 0))
        : null;
    return {
        fps,
        kbps: secs > 0 ? Math.round(((b.bytesReceived - a.bytesReceived) * 8) / 1000 / secs) : null,
        bufferMs,
        decodeMs,
        rttMs: b.rttMs,
        lossPct: lost + got > 0 ? round1((lost / (lost + got)) * 100) : null,
        freezes: Math.max(0, b.freezeCount - a.freezeCount),
        frame: b.frameWidth && b.frameHeight ? `${b.frameWidth}x${b.frameHeight}` : null,
        path: b.path,
        protocol: b.protocol,
        decoder: b.decoder,
        hardwareDecode: b.hardwareDecode,
        inputLane: b.inputLane,
        hereMs,
    };
}
