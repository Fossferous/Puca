/**
 * Latency-relevant `getStats` fields, reduced to the per-frame / per-packet
 * milliseconds a person can read at the moment a stream feels slow.
 *
 * One reducer for every consumer — the mesh diagnostics (`__pucaMeshDiag`),
 * the SFU diagnostics (`__pucaVoiceDiag`), the unattended log sampler
 * (streamDiag.ts) and the latency rig (e2e/rc-latency-2peer.mjs) — so the
 * numbers mean the same thing everywhere. Until this existed the in-call
 * diagnostics kept bytes/frames/fps/limit/encoder and threw every DELAY
 * field away, so a "the share is a second behind" report could not say
 * which stage owned the second: the sender's encoder, the sender's pacer,
 * the network, the receiver's jitter buffer, or its decoder. Each of those
 * has its own field below.
 *
 * Every value is derived from CUMULATIVE counters, so a one-shot read is the
 * average since the track started. `summariseRtcStatsDelta` gives the same
 * shape over a WINDOW (two reads), which is what to use while it feels slow:
 * a one-shot read taken after the user stopped dragging to reach a button
 * reports the pause, not the problem (devices/session.ts learned this the
 * hard way — see deviceDiagnosticsWindow).
 */

/** The receiver side of one video stream. */
export interface InboundVideoSummary {
    ssrc: number | null;
    framesReceived: number | null;
    framesDecoded: number | null;
    framesDropped: number | null;
    fps: number | null;
    size: string | null;
    decoder: string | null;
    /** Average time a frame sat in the jitter buffer — THE receive-side
     *  latency number. The browser's default is tuned for watching, not
     *  pointing; receiverLatency.ts asks for 0 while controlling. */
    jitterBufferMs: number | null;
    /** What the jitter-buffer estimator WANTS to hold; the hint is a floor
     *  the estimator can outrank on a jittery link. */
    jitterBufferTargetMs: number | null;
    jitterBufferMinMs: number | null;
    /** Packet arrival → frame decoded: jitter buffer + assembly + decode. */
    processingMs: number | null;
    assemblyMs: number | null;
    decodeMs: number | null;
    interFrameMs: number | null;
    freezeCount: number | null;
    freezeMs: number | null;
    pauseCount: number | null;
    packetsLost: number | null;
    nack: number | null;
    pli: number | null;
    keyFrames: number | null;
    bytes: number | null;
}

/** The sender side of one video stream. */
export interface OutboundVideoSummary {
    ssrc: number | null;
    rid: string | null;
    framesSent: number | null;
    framesEncoded: number | null;
    /** framesEncoded − framesSent. The media-E2EE frame transform sits
     *  exactly between those two counters (mesh), so a GROWING gap is frames
     *  parked in the main-thread queue; gap ÷ fps is the added delay. */
    encodeSentGap: number | null;
    fps: number | null;
    size: string | null;
    encoder: string | null;
    encodeMs: number | null;
    /** Average time a packet waited in the pacer before leaving — the
     *  sender's own queue when the encoder overshoots the bandwidth target. */
    sendDelayMs: number | null;
    limit: string | null;
    limitDurations: Record<string, number> | null;
    limitResolutionChanges: number | null;
    targetKbps: number | null;
    bytes: number | null;
    keyFrames: number | null;
    huge: number | null;
    nack: number | null;
    pli: number | null;
}

/** The selected ICE candidate pair — the one place a TCP relay shows. */
export interface PairSummary {
    rttMs: number | null;
    outKbps: number | null;
    inKbps: number | null;
    /** `<candidateType>/<protocol>[/<relayProtocol>]` of each end. */
    local: string | null;
    remote: string | null;
    /** Transport the media actually rides: 'udp' or 'tcp' (a TURN relay
     *  reports the relay's own protocol here). Anything but 'udp' turns
     *  congestion into a standing queue instead of loss. */
    protocol: string | null;
}

export interface RemoteInboundSummary {
    ssrc: number | null;
    rttMs: number | null;
    fractionLost: number | null;
    jitterMs: number | null;
}

export interface RtcLatencySummary {
    inbound: InboundVideoSummary[];
    outbound: OutboundVideoSummary[];
    pair: PairSummary | null;
    remoteInbound: RemoteInboundSummary[];
}

/** What a receiver was ASKED to hold. Read back beside jitterBufferMs so "the
 *  assignment silently did nothing" is distinguishable from "it worked". */
export interface ReceiverHints {
    playoutDelayHint: number | null;
    jitterBufferTarget: number | null;
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** ms of `seconds` per `count`, rounded to `dp` decimals; null when either is missing or count is 0. */
function per(seconds: unknown, count: unknown, dp = 0): number | null {
    const s = num(seconds);
    const c = num(count);
    if (s === null || c === null || c <= 0) return null;
    const f = 10 ** dp;
    return Math.round((1000 * s / c) * f) / f;
}
const size = (r: Row): string | null => (num(r.frameWidth) ? `${r.frameWidth}x${r.frameHeight}` : null);

function inboundOf(r: Row): InboundVideoSummary {
    const decoded = r.framesDecoded;
    const emitted = r.jitterBufferEmittedCount;
    return {
        ssrc: num(r.ssrc),
        framesReceived: num(r.framesReceived),
        framesDecoded: num(decoded),
        framesDropped: num(r.framesDropped),
        fps: num(r.framesPerSecond),
        size: size(r),
        decoder: str(r.decoderImplementation),
        jitterBufferMs: per(r.jitterBufferDelay, emitted),
        jitterBufferTargetMs: per(r.jitterBufferTargetDelay, emitted),
        jitterBufferMinMs: per(r.jitterBufferMinimumDelay, emitted),
        processingMs: per(r.totalProcessingDelay, decoded),
        assemblyMs: per(r.totalAssemblyTime, r.framesAssembledFromMultiplePackets),
        decodeMs: per(r.totalDecodeTime, decoded, 1),
        interFrameMs: per(r.totalInterFrameDelay, decoded),
        freezeCount: num(r.freezeCount),
        freezeMs: num(r.totalFreezesDuration) === null ? null : Math.round(1000 * (r.totalFreezesDuration as number)),
        pauseCount: num(r.pauseCount),
        packetsLost: num(r.packetsLost),
        nack: num(r.nackCount),
        pli: num(r.pliCount),
        keyFrames: num(r.keyFramesDecoded),
        bytes: num(r.bytesReceived),
    };
}

function outboundOf(r: Row): OutboundVideoSummary {
    const encoded = num(r.framesEncoded);
    const sent = num(r.framesSent);
    return {
        ssrc: num(r.ssrc),
        rid: str(r.rid),
        framesSent: sent,
        framesEncoded: encoded,
        encodeSentGap: encoded !== null && sent !== null ? encoded - sent : null,
        fps: num(r.framesPerSecond),
        size: size(r),
        encoder: str(r.encoderImplementation),
        encodeMs: per(r.totalEncodeTime, r.framesEncoded, 1),
        sendDelayMs: per(r.totalPacketSendDelay, r.packetsSent, 1),
        limit: str(r.qualityLimitationReason),
        limitDurations: (r.qualityLimitationDurations && typeof r.qualityLimitationDurations === 'object')
            ? r.qualityLimitationDurations as Record<string, number> : null,
        limitResolutionChanges: num(r.qualityLimitationResolutionChanges),
        targetKbps: num(r.targetBitrate) === null ? null : Math.round((r.targetBitrate as number) / 1000),
        bytes: num(r.bytesSent),
        keyFrames: num(r.keyFramesEncoded),
        huge: num(r.hugeFramesSent),
        nack: num(r.nackCount),
        pli: num(r.pliCount),
    };
}

function candidateLabel(c: Row | undefined): string | null {
    if (!c) return null;
    const parts = [str(c.candidateType), str(c.protocol)].filter(Boolean);
    if (str(c.relayProtocol)) parts.push(c.relayProtocol as string);
    return parts.length ? parts.join('/') : null;
}

/** Reduce one report. Only VIDEO rtp streams are summarised — audio has no
 *  frame-delay counters worth a row and would only add noise keys. */
export function summariseRtcStats(report: RTCStatsReport): RtcLatencySummary {
    const byId = new Map<string, Row>();
    report.forEach((s) => byId.set((s as { id: string }).id, s as unknown as Row));
    const out: RtcLatencySummary = { inbound: [], outbound: [], pair: null, remoteInbound: [] };
    // Prefer the transport's selected pair; fall back to any pair marked
    // selected (receiver/sender-scoped reports may omit the transport row).
    let pairRow: Row | undefined;
    for (const r of byId.values()) {
        if (r.type === 'transport' && typeof r.selectedCandidatePairId === 'string') {
            pairRow = byId.get(r.selectedCandidatePairId);
            if (pairRow) break;
        }
    }
    if (!pairRow) {
        for (const r of byId.values()) {
            if (r.type === 'candidate-pair' && (r.selected === true || r.nominated === true) && r.state === 'succeeded') { pairRow = r; break; }
        }
    }
    for (const r of byId.values()) {
        if (r.kind !== 'video') continue;
        if (r.type === 'inbound-rtp') out.inbound.push(inboundOf(r));
        else if (r.type === 'outbound-rtp') out.outbound.push(outboundOf(r));
        else if (r.type === 'remote-inbound-rtp') {
            out.remoteInbound.push({
                ssrc: num(r.ssrc),
                rttMs: num(r.roundTripTime) === null ? null : Math.round(1000 * (r.roundTripTime as number)),
                fractionLost: num(r.fractionLost),
                jitterMs: num(r.jitter) === null ? null : Math.round(1000 * (r.jitter as number)),
            });
        }
    }
    if (pairRow) {
        const local = typeof pairRow.localCandidateId === 'string' ? byId.get(pairRow.localCandidateId) : undefined;
        const remote = typeof pairRow.remoteCandidateId === 'string' ? byId.get(pairRow.remoteCandidateId) : undefined;
        const proto = local ? (str(local.relayProtocol) ?? str(local.protocol)) : null;
        out.pair = {
            rttMs: num(pairRow.currentRoundTripTime) === null ? null : Math.round(1000 * (pairRow.currentRoundTripTime as number)),
            outKbps: num(pairRow.availableOutgoingBitrate) === null ? null : Math.round((pairRow.availableOutgoingBitrate as number) / 1000),
            inKbps: num(pairRow.availableIncomingBitrate) === null ? null : Math.round((pairRow.availableIncomingBitrate as number) / 1000),
            local: candidateLabel(local),
            remote: candidateLabel(remote),
            protocol: proto ? proto.toLowerCase() : null,
        };
    }
    return out;
}

/**
 * The same shape over the WINDOW between two reads of the same connection,
 * `ms` apart: rates are per-window, per-frame delays are averaged over the
 * frames of the window only. Streams present in only one read are skipped.
 */
export function summariseRtcStatsDelta(before: RTCStatsReport, after: RTCStatsReport, ms: number): RtcLatencySummary {
    const prev = new Map<string, Row>();
    before.forEach((s) => prev.set((s as { id: string }).id, s as unknown as Row));
    const secs = Math.max(ms, 1) / 1000;
    const diffed = new Map<string, Row>();
    after.forEach((s) => {
        const b = s as unknown as Row;
        const id = (s as { id: string }).id;
        const a = prev.get(id);
        if ((b.type === 'inbound-rtp' || b.type === 'outbound-rtp') && b.kind === 'video') {
            if (!a) return; // appeared mid-window: no delta to report
            const d: Row = { ...b };
            const delta = (k: string) => (num(b[k]) !== null && num(a[k]) !== null ? (b[k] as number) - (a[k] as number) : null);
            for (const k of ['framesReceived', 'framesDecoded', 'framesDropped', 'framesEncoded', 'framesSent',
                'jitterBufferDelay', 'jitterBufferTargetDelay', 'jitterBufferMinimumDelay', 'jitterBufferEmittedCount',
                'totalProcessingDelay', 'totalAssemblyTime', 'framesAssembledFromMultiplePackets', 'totalDecodeTime',
                'totalInterFrameDelay', 'freezeCount', 'totalFreezesDuration', 'pauseCount', 'packetsLost', 'nackCount',
                'pliCount', 'keyFramesDecoded', 'keyFramesEncoded', 'bytesReceived', 'bytesSent', 'totalEncodeTime',
                'totalPacketSendDelay', 'packetsSent', 'hugeFramesSent', 'qualityLimitationResolutionChanges']) {
                const v = delta(k);
                if (v !== null) d[k] = v;
            }
            // The reason→seconds record is cumulative as well; window it per
            // reason (a reason absent before counts from 0), or report it
            // unknown rather than a lifetime figure dressed as a window.
            const durB = b.qualityLimitationDurations as Record<string, unknown> | undefined;
            const durA = a.qualityLimitationDurations as Record<string, unknown> | undefined;
            if (durB && typeof durB === 'object' && durA && typeof durA === 'object') {
                const w: Record<string, number> = {};
                for (const [k, v] of Object.entries(durB)) {
                    if (typeof v === 'number') w[k] = Math.round((v - (typeof durA[k] === 'number' ? durA[k] as number : 0)) * 1000) / 1000;
                }
                d.qualityLimitationDurations = w;
            } else {
                delete d.qualityLimitationDurations;
            }
            // fps over the window, from the frame counters rather than the
            // browser's own one-second estimate.
            const frames = num(d.framesDecoded) ?? num(d.framesEncoded);
            if (frames !== null) d.framesPerSecond = Math.round(frames / secs);
            diffed.set(id, d);
        } else {
            diffed.set(id, b);
        }
    });
    const report = {
        forEach: (fn: (v: unknown) => void) => { diffed.forEach((v) => fn(v)); },
    } as unknown as RTCStatsReport;
    return summariseRtcStats(report);
}

/** Read back the hints on every VIDEO receiver. */
export function receiverHints(receivers: RTCRtpReceiver[]): ReceiverHints[] {
    return receivers
        .filter((r) => r.track && r.track.kind === 'video')
        .map((r) => {
            const t = r as RTCRtpReceiver & { playoutDelayHint?: number; jitterBufferTarget?: number | null };
            return {
                playoutDelayHint: typeof t.playoutDelayHint === 'number' ? t.playoutDelayHint : null,
                jitterBufferTarget: typeof t.jitterBufferTarget === 'number' ? t.jitterBufferTarget : null,
            };
        });
}

/** One log-line fragment per stream, for the unattended sampler. */
export function formatLatencyLine(s: RtcLatencySummary): string {
    const parts: string[] = [];
    for (const o of s.outbound) {
        parts.push(`out fps=${o.fps ?? '?'} size=${o.size ?? '?'} enc=${o.encodeMs ?? '?'}ms send=${o.sendDelayMs ?? '?'}ms gap=${o.encodeSentGap ?? '?'} limit=${o.limit ?? '?'} encoder=${o.encoder ?? '?'}${o.rid ? ` rid=${o.rid}` : ''}`);
    }
    for (const i of s.inbound) {
        parts.push(`in fps=${i.fps ?? '?'} size=${i.size ?? '?'} jb=${i.jitterBufferMs ?? '?'}ms(target ${i.jitterBufferTargetMs ?? '?'}) proc=${i.processingMs ?? '?'}ms dec=${i.decodeMs ?? '?'}ms drop=${i.framesDropped ?? '?'} freeze=${i.freezeCount ?? '?'} lost=${i.packetsLost ?? '?'} decoder=${i.decoder ?? '?'}`);
    }
    if (s.pair) {
        parts.push(`pair=${s.pair.protocol ?? '?'} ${s.pair.local ?? '?'}->${s.pair.remote ?? '?'} rtt=${s.pair.rttMs ?? '?'}ms out=${s.pair.outKbps ?? '?'}kbps`);
    }
    return parts.join(' | ');
}
