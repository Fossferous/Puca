/**
 * Live stats for ONE stream, for the tile overlay (right-click a stream →
 * Show Stream Stats): resolution, frame rate, bitrate, codec, hardware or
 * software, loss, round trip, and — for your own share — what is limiting it.
 *
 * The video numbers come from statsSummary's reducer, the one the log
 * sampler and the in-call diagnostics use, so the overlay and puca.log can
 * never disagree about what "fps" or "dropped" means. This adds only what an
 * overlay needs and the reducer does not carry: bitrate as a rate, audio
 * bitrate, the codec, the hardware flag, and loss as a percentage.
 *
 * Rates are over the window between two consecutive reads (the sampler keeps
 * the previous report), never lifetime averages: a stream that was bad an
 * hour ago and fine now must read fine now.
 */
import { summariseRtcStats, summariseRtcStatsDelta } from './statsSummary';
import { negotiatedH264Profile } from './h264Profiles';

/** One RTP sender or receiver carrying part of a stream. `key` is the
 *  underlying RTCRtpSender/RTCRtpReceiver, stable across reads. */
export interface RtpEndpoint {
    key: object;
    direction: 'inbound' | 'outbound';
    kind: string;
    getStats: () => Promise<RTCStatsReport>;
}

export interface StreamStatsView {
    /** 'inbound' — a stream you are watching; 'outbound' — your own share. */
    direction: 'inbound' | 'outbound';
    size: string | null;
    fps: number | null;
    /** Video bitrate over the last window, kbps. Outbound: per viewer on a
     *  mesh call (each gets its own encode); all rungs together on the SFU. */
    videoKbps: number | null;
    audioKbps: number | null;
    /** 'H264 High', 'VP8', 'AV1' … */
    codec: string | null;
    /** The decoder (watching) or encoder (sharing) the browser chose. */
    implementation: string | null;
    /** The browser's own hardware verdict (powerEfficientDecoder/Encoder);
     *  null where it does not say. */
    hardware: boolean | null;
    /** Watching: video packets lost in the window, as a share of those that
     *  should have arrived. */
    lossPct: number | null;
    jitterBufferMs: number | null;
    rttMs: number | null;
    /** Watching: frames dropped / freezes in the window. */
    framesDropped: number | null;
    freezes: number | null;
    /** Sharing: what the encoder says is holding it back — 'none', 'cpu',
     *  'bandwidth' or 'other'. */
    limit: string | null;
    targetKbps: number | null;
    /** 'UDP', 'TCP', or a TURN relay. */
    transport: string | null;
    /** Sharing on a mesh call: how many viewers it is encoded for. */
    viewers: number | null;
    /** False on the first read: rates need a second one. */
    measured: boolean;
}

/** One endpoint's two reads (`prev` null on the first). */
export interface EndpointSample {
    direction: 'inbound' | 'outbound';
    kind: string;
    prev: RTCStatsReport | null;
    now: RTCStatsReport;
    /** Milliseconds between `prev` and `now`. */
    ms: number;
}

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function rows(report: RTCStatsReport): Row[] {
    const out: Row[] = [];
    report.forEach((s) => out.push(s as unknown as Row));
    return out;
}

function rowById(report: RTCStatsReport | null, id: unknown): Row | undefined {
    if (!report || typeof id !== 'string') return undefined;
    return report.get(id) as Row | undefined;
}

/** H.264 profile-level-id → the profile's name (first byte is profile_idc). */
function h264ProfileName(profileLevelId: string | null): string | null {
    if (!profileLevelId || profileLevelId.length < 4) return null;
    const idc = profileLevelId.slice(0, 2).toLowerCase();
    const constraints = parseInt(profileLevelId.slice(2, 4), 16);
    if (idc === '42') return (constraints & 0x40) ? 'Constrained Baseline' : 'Baseline';
    if (idc === '4d') return 'Main';
    if (idc === '64') return (constraints & 0x0c) === 0x0c ? 'Constrained High' : 'High';
    return null;
}

function codecName(report: RTCStatsReport, row: Row): string | null {
    const codec = rowById(report, row.codecId);
    const mime = typeof codec?.mimeType === 'string' ? codec.mimeType : null;
    if (!mime) return null;
    const name = mime.replace(/^video\//i, '').replace(/^audio\//i, '');
    if (name.toLowerCase() !== 'h264') return name.toUpperCase();
    const profile = h264ProfileName(negotiatedH264Profile(report, row.codecId));
    return profile ? `H264 ${profile}` : 'H264';
}

/** kbps from a byte counter over `ms`; null when either read is missing. */
function kbps(bytesNow: unknown, bytesPrev: unknown, ms: number): number | null {
    const a = num(bytesNow);
    const b = num(bytesPrev);
    if (a === null || b === null || ms <= 0 || a < b) return null;
    return Math.round(((a - b) * 8) / ms);
}

function transportLabel(protocol: string | null, local: string | null): string | null {
    if (!protocol) return null;
    if (local && /relay/i.test(local)) return `TURN relay (${protocol.toUpperCase()})`;
    return protocol.toUpperCase();
}

/**
 * Reduce one tick's reads of every endpoint carrying the stream into what
 * the overlay shows. Null when no endpoint carries its video (yet).
 */
export function summariseStreamStats(samples: EndpointSample[]): StreamStatsView | null {
    const video = samples.filter((s) => s.kind === 'video');
    if (video.length === 0) return null;
    const direction = video[0].direction;
    const measured = video.some((s) => s.prev !== null);

    let size: string | null = null;
    let fps: number | null = null;
    let codec: string | null = null;
    let implementation: string | null = null;
    let hardware: boolean | null = null;
    let jitterBufferMs: number | null = null;
    let framesDropped: number | null = null;
    let freezes: number | null = null;
    let limit: string | null = null;
    let targetKbps: number | null = null;
    let rttMs: number | null = null;
    let transport: string | null = null;
    let lost = 0;
    let expected = 0;
    let lossKnown = false;
    const perEndpointKbps: number[] = [];

    for (const s of video) {
        const summary = s.prev ? summariseRtcStatsDelta(s.prev, s.now, s.ms) : summariseRtcStats(s.now);
        const raw = rows(s.now).filter((r) => r.kind === 'video'
            && r.type === (direction === 'inbound' ? 'inbound-rtp' : 'outbound-rtp'));
        // Largest picture first: an SFU share carries several rungs, and the
        // one that matters to "what am I sending" is the top one.
        const area = (r: Row) => (num(r.frameWidth) ?? 0) * (num(r.frameHeight) ?? 0);
        raw.sort((a, b) => area(b) - area(a));
        const top = raw[0];

        if (direction === 'inbound') {
            const i = summary.inbound[0];
            if (i && size === null) {
                size = i.size;
                fps = i.fps;
                jitterBufferMs = i.jitterBufferMs;
                framesDropped = s.prev ? i.framesDropped : null;
                freezes = s.prev ? i.freezeCount : null;
            }
        } else {
            const sized = [...summary.outbound].sort((a, b) => {
                const px = (x: string | null) => (x ? x.split('x').reduce((m, v) => m * Number(v), 1) : 0);
                return px(b.size) - px(a.size);
            });
            const o = sized[0];
            if (o && size === null) {
                size = o.size;
                fps = o.fps;
                targetKbps = summary.outbound.reduce<number | null>((t, x) => (x.targetKbps === null ? t : (t ?? 0) + x.targetKbps), null);
            }
            // The worst limit across viewers/rungs is the one worth showing.
            for (const x of summary.outbound) {
                if (x.limit && x.limit !== 'none') limit = x.limit;
                else if (x.limit && limit === null) limit = x.limit;
            }
        }
        if (top && codec === null) {
            codec = codecName(s.now, top);
            const impl = direction === 'inbound' ? top.decoderImplementation : top.encoderImplementation;
            implementation = typeof impl === 'string' ? impl : null;
            const hw = direction === 'inbound' ? top.powerEfficientDecoder : top.powerEfficientEncoder;
            hardware = typeof hw === 'boolean' ? hw : null;
        }
        // Bitrate: every rung of this endpoint together.
        if (s.prev) {
            let sum: number | null = null;
            for (const r of raw) {
                const before = rowById(s.prev, r.id);
                const k = kbps(direction === 'inbound' ? r.bytesReceived : r.bytesSent,
                    before ? (direction === 'inbound' ? before.bytesReceived : before.bytesSent) : undefined, s.ms);
                if (k !== null) sum = (sum ?? 0) + k;
            }
            if (sum !== null) perEndpointKbps.push(sum);
            if (direction === 'inbound' && top) {
                const before = rowById(s.prev, top.id);
                const dLost = num(top.packetsLost) !== null && num(before?.packetsLost) !== null
                    ? (top.packetsLost as number) - (before!.packetsLost as number) : null;
                const dRecv = num(top.packetsReceived) !== null && num(before?.packetsReceived) !== null
                    ? (top.packetsReceived as number) - (before!.packetsReceived as number) : null;
                if (dLost !== null && dRecv !== null && dLost >= 0 && dRecv >= 0) {
                    lossKnown = true;
                    lost += dLost;
                    expected += dLost + dRecv;
                }
            }
        }
        if (rttMs === null) {
            rttMs = summary.pair?.rttMs ?? summary.remoteInbound.find((r) => r.rttMs !== null)?.rttMs ?? null;
        }
        if (transport === null && summary.pair) {
            transport = transportLabel(summary.pair.protocol, summary.pair.local);
        }
    }

    let audioKbps: number | null = null;
    for (const s of samples.filter((x) => x.kind === 'audio' && x.prev)) {
        const type = s.direction === 'inbound' ? 'inbound-rtp' : 'outbound-rtp';
        for (const r of rows(s.now)) {
            if (r.kind !== 'audio' || r.type !== type) continue;
            const before = rowById(s.prev, r.id);
            const k = kbps(s.direction === 'inbound' ? r.bytesReceived : r.bytesSent,
                before ? (s.direction === 'inbound' ? before.bytesReceived : before.bytesSent) : undefined, s.ms);
            if (k !== null) audioKbps = (audioKbps ?? 0) + k;
        }
        // Mesh: the same audio goes to every viewer; one copy is the rate.
        if (s.direction === 'outbound' && audioKbps !== null) break;
    }

    const videoKbps = perEndpointKbps.length === 0
        ? null
        : Math.round(perEndpointKbps.reduce((a, b) => a + b, 0) / perEndpointKbps.length);

    return {
        direction,
        size,
        fps,
        videoKbps,
        audioKbps,
        codec,
        implementation,
        hardware,
        lossPct: lossKnown ? (expected > 0 ? Math.round((1000 * lost) / expected) / 10 : 0) : null,
        jitterBufferMs,
        rttMs,
        framesDropped,
        freezes,
        limit,
        targetKbps,
        transport,
        viewers: direction === 'outbound' ? video.length : null,
        measured,
    };
}

/**
 * Samples one stream once per call, keeping each endpoint's previous report
 * so every read after the first is a real one-window rate. `resolve` is asked
 * afresh each time, because a stream's endpoints change under it: a viewer
 * joins a mesh call, the SFU resubscribes after a reconnect.
 */
export class StreamStatsSampler {
    private prev = new Map<object, { report: RTCStatsReport; at: number }>();
    private readonly resolve: () => RtpEndpoint[];

    constructor(resolve: () => RtpEndpoint[]) {
        this.resolve = resolve;
    }

    async sample(now: () => number = () => performance.now()): Promise<StreamStatsView | null> {
        const endpoints = this.resolve();
        const reads = await Promise.all(endpoints.map(async (e) => {
            try {
                return { e, report: await e.getStats(), at: now() };
            } catch {
                return null; // detached mid-read: skip it this tick
            }
        }));
        const next = new Map<object, { report: RTCStatsReport; at: number }>();
        const samples: EndpointSample[] = [];
        for (const r of reads) {
            if (!r) continue;
            const before = this.prev.get(r.e.key);
            samples.push({
                direction: r.e.direction,
                kind: r.e.kind,
                prev: before?.report ?? null,
                now: r.report,
                ms: before ? r.at - before.at : 0,
            });
            next.set(r.e.key, { report: r.report, at: r.at });
        }
        // Endpoints that went away are forgotten, so a sender replaced by a
        // new one never diffs against a report that is not its own.
        this.prev = next;
        return summariseStreamStats(samples);
    }
}

/** Human bitrate: '850 kbps', '6.2 Mbps'. */
export function formatKbps(k: number | null): string {
    if (k === null) return '—';
    return k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${k} kbps`;
}
