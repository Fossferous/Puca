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
 *
 * One thing is not a window: a picture frozen RIGHT NOW. WebRTC counts a
 * freeze only once it is over (FreezeWatch, below), so the sampler keeps
 * enough of each watched stream's past to say "frozen for 12 s" while it is
 * still frozen.
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
    /** Watching: true while the picture is not supposed to move, because the
     *  receiving track is muted or ended or (on the SFU) the sender muted
     *  it. A still picture then is not a freeze. Absent: never. */
    muted?: () => boolean;
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
    /** Watching: frames dropped / freezes in the window. A freeze counts
     *  only once it has ENDED (WebRTC's rule), so `freezes` is 0 all through
     *  one; `frozenMs` is the one in progress. */
    framesDropped: number | null;
    freezes: number | null;
    /** Watching: how long the picture has been frozen, while it still is
     *  (FreezeWatch); null when it is moving, or still for a reason that is
     *  not a freeze. At least this long: counted from the read that last saw
     *  a new frame. */
    frozenMs: number | null;
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
    /** Watching: this endpoint's freeze in progress, from the sampler's
     *  FreezeWatch (it needs more than two reads). */
    frozenMs?: number | null;
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
    let frozenMs: number | null = null;
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
                frozenMs = s.prev ? (s.frozenMs ?? null) : null;
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
        frozenMs,
        limit,
        targetKbps,
        transport,
        viewers: direction === 'outbound' ? video.length : null,
        measured,
    };
}

// ---- a freeze in progress ---------------------------------------------------

/** WebRTC's freeze rule (below): a gap of at least max(3 x avg, avg + 150 ms),
 *  avg over the last 30 frames, once there are 5 to average. */
const FREEZE_FACTOR = 3;
const FREEZE_MIN_INCREASE_MS = 150;
const FREEZE_AVG_FRAMES = 30;
const FREEZE_MIN_FRAMES = 5;
/** libwebrtc's kInactiveDuration: no packet for this long and the gap is a
 *  PAUSE (pauseCount), not a freeze. */
const PAUSE_NO_PACKETS_MS = 5000;
/** How many reads in a row an endpoint may miss and keep its freeze watch. */
const FREEZE_KEEP_MISSED_READS = 5;

/** Some frames, and the time between them (ms). */
interface FrameRun { frames: number; ms: number }

/** One read: `bytes` is the media bytes (retransmissions taken out). */
interface FreezeRead { id: string; at: number; frames: number; bytes: number | null; row: Row }

/**
 * Is ONE watched video frozen right now, and since when?
 *
 * WebRTC cannot say. The spec (webrtc-stats, `freezeCount`) calls the gap
 * between two consecutively rendered frames a freeze when it is at least
 * max(3 x avg, avg + 150 ms), avg the linear average of the last 30 frame
 * durations, and `totalFreezesDuration` "is updated when a frame is rendered":
 * the freeze is counted by the frame that ENDS it. libwebrtc
 * (VideoQualityObserver::OnRenderedFrame, which Chromium's counters come from)
 * does exactly that, once it has 5 frames to average. So a picture frozen for
 * 65 s with 2 Mbps still arriving (the owner's report, 2026-11-19) read
 * "0 freezes" all 65 s. Measured in Edge (e2e/stream-stats-real-browser.mjs):
 * every frame dropped at the receiver for 9 s, packets still arriving —
 * freezeCount 0 throughout, then 1 with totalFreezesDuration 9.08 s.
 *
 * Not every still picture is a freeze, and this follows Chromium in telling
 * them apart. The spec calls any gap over 5 s a PAUSE; libwebrtc calls it one
 * only when no packet has arrived for 5 s either (VideoReceiveStream2::
 * OnDecodableFrameTimeout, kInactiveDuration) — measured: a sender that stops
 * sending frames for 9 s is pauseCount 1, freezeCount 0, while the 65 s with
 * packets arriving was a freeze. So a freeze here is the stream's packets
 * still arriving and no frame coming of them:
 *   - no new frame decoded for at least the threshold above, the average
 *     being this stream's own pace (a 1 fps share of a still screen has a
 *     3 s threshold, so a second without a frame is not frozen);
 *   - media bytes received after the last frame and still no frame by the
 *     read after them (one read of slack: a frame caught between its packets
 *     arriving and its decode is not a freeze). Media bytes are
 *     bytesReceived less retransmittedBytesReceived: the bandwidth estimator
 *     probes by resending old packets, which carry no new picture (measured:
 *     a 1 fps canvas share's first seconds were mostly these);
 *   - never 5 s without media bytes since the last frame: then the sender
 *     stopped (or the connection did), a pause as WebRTC counts it. If the
 *     packets come back and still no frame comes of them, that is a frozen
 *     picture again, counted from their return. WebRTC books that whole gap
 *     as the pause (its is_paused_ holds until the next frame), so the
 *     freezes count will not show it afterwards; but a still picture with the
 *     stream arriving is exactly what this is here to say (a reconnect whose
 *     keyframe never decodes, a key that does not open the frames);
 *   - and the track not muted or ended (RtpEndpoint.muted).
 * A sender that turns its camera off (track.enabled = false) sends black
 * frames at the full rate (measured), so its picture moves: not a freeze.
 *
 * The gap is a LOWER bound, counted from the read that first saw the newest
 * frame (the overlay reads once a second), so it never says longer than it
 * has been. Opened on a stream that is already frozen, it counts from the
 * first read, with the lifetime counters as the stream's pace; opened on one
 * whose packets had stopped (perhaps for longer than 5 s: it cannot know),
 * from their return.
 */
export class FreezeWatch {
    private last: FreezeRead | null = null;
    /** The read that first showed the newest frame, and the bytes then. */
    private frameAt = 0;
    private bytesAtFrame: number | null = null;
    /** False until a read has shown a new frame (frameAt is then real). */
    private frameSeen = false;
    /** The last read whose media bytes had grown. */
    private bytesAt: number | null = null;
    /** This gap has gone PAUSE_NO_PACKETS_MS without media bytes: a pause,
     *  until a frame or the packets' return. */
    private paused = false;
    /** Since start(), and before any frame, a read brought no media bytes. */
    private quiet = false;
    /** The newest frames' pace, newest last: enough for FREEZE_AVG_FRAMES. */
    private runs: FrameRun[] = [];

    /** One read of the receiver's report at `at` (ms, any monotonic clock);
     *  `live` false while the track is muted. The freeze's length so far,
     *  or null. */
    observe(report: RTCStatsReport, at: number, live = true): number | null {
        let row: Row | undefined;
        report.forEach((s) => {
            const r = s as unknown as Row;
            if (!row && r.type === 'inbound-rtp' && r.kind === 'video') row = r;
        });
        const frames = row ? num(row.framesDecoded) : null;
        if (!row || frames === null || typeof row.id !== 'string') { this.last = null; return null; }
        const received = num(row.bytesReceived);
        const bytes = received === null ? null : received - (num(row.retransmittedBytesReceived) ?? 0);
        const prev = this.last;
        // A new stream on this receiver (new SSRC), counters that went back,
        // or a clock that did: start over rather than diff across it.
        if (!prev || prev.id !== row.id || frames < prev.frames || at <= prev.at) {
            this.start(row, at, frames, bytes);
            return null;
        }
        this.last = { id: row.id, at, frames, bytes, row };
        const grew = bytes !== null && prev.bytes !== null && bytes > prev.bytes;
        if (grew) this.bytesAt = at;
        if (frames > prev.frames) {
            this.addRun(prev, row, frames - prev.frames, at);
            this.frameAt = at;
            this.bytesAtFrame = bytes;
            this.frameSeen = true;
            this.paused = false;
            this.quiet = false;
            return null;
        }
        if (!grew) {
            if (!this.frameSeen) this.quiet = true;
        } else if (this.paused || this.quiet) {
            // The packets are back after a pause (or after a quiet stretch
            // the overlay opened into, which may have been one), with no
            // frame of them yet: the clock starts again from their return.
            this.frameAt = at;
            this.bytesAtFrame = bytes;
            this.paused = false;
            this.quiet = false;
        }
        if (at - Math.max(this.bytesAt ?? -Infinity, this.frameAt) >= PAUSE_NO_PACKETS_MS) this.paused = true;
        const avg = this.averageFrameMs();
        if (!live || avg === null || this.paused) return null;
        const gap = at - this.frameAt;
        const threshold = Math.max(FREEZE_FACTOR * avg, avg + FREEZE_MIN_INCREASE_MS);
        const waiting = prev.bytes !== null && this.bytesAtFrame !== null && prev.bytes > this.bytesAtFrame;
        return gap >= threshold && waiting ? gap : null;
    }

    private start(row: Row, at: number, frames: number, bytes: number | null): void {
        this.last = { id: row.id as string, at, frames, bytes, row };
        this.frameAt = at;
        this.bytesAtFrame = bytes;
        this.frameSeen = false;
        this.bytesAt = null;
        this.paused = false;
        this.quiet = false;
        this.runs = [];
        // The pace so far is all there is to go on for a stream that is
        // frozen when the overlay opens: its lifetime counters, with the
        // freezes and pauses taken out (totalInterFrameDelay counts them).
        const total = num(row.totalInterFrameDelay);
        if (total === null) return;
        const ms = 1000 * (total - (num(row.totalFreezesDuration) ?? 0) - (num(row.totalPausesDuration) ?? 0));
        const n = frames - 1 - (num(row.freezeCount) ?? 0) - (num(row.pauseCount) ?? 0);
        if (n > 0 && ms > 0) this.push({ frames: n, ms });
    }

    /** The pace of the frames that arrived since `prev`. */
    private addRun(prev: FreezeRead, row: Row, frames: number, at: number): void {
        const d = (k: string): number | null => {
            const a = num(row[k]);
            const b = num(prev.row[k]);
            return a !== null && b !== null ? a - b : null;
        };
        const delay = d('totalInterFrameDelay');
        if (delay !== null) {
            // Every gap is in totalInterFrameDelay, freezes and pauses too;
            // taken out, what is left is the stream's own pace.
            const ms = 1000 * (delay - (d('totalFreezesDuration') ?? 0) - (d('totalPausesDuration') ?? 0));
            const n = frames - (d('freezeCount') ?? 0) - (d('pauseCount') ?? 0);
            if (n > 0 && ms > 0) this.push({ frames: n, ms });
            return;
        }
        // A browser without totalInterFrameDelay: the time since the read
        // that last brought a frame, unless a freeze or pause ended in it.
        if (this.frameSeen && !((d('freezeCount') ?? 0) > 0) && !((d('pauseCount') ?? 0) > 0)) {
            this.push({ frames, ms: at - this.frameAt });
        }
    }

    private push(run: FrameRun): void {
        this.runs.push(run);
        let kept = 0;
        for (let i = this.runs.length - 1; i > 0; i--) {
            kept += this.runs[i].frames;
            if (kept >= FREEZE_AVG_FRAMES) { this.runs.splice(0, i); return; }
        }
    }

    /** The average frame duration over the newest FREEZE_AVG_FRAMES frames;
     *  null with fewer than FREEZE_MIN_FRAMES. */
    private averageFrameMs(): number | null {
        let frames = 0;
        let ms = 0;
        for (let i = this.runs.length - 1; i >= 0 && frames < FREEZE_AVG_FRAMES; i--) {
            const r = this.runs[i];
            const take = Math.min(r.frames, FREEZE_AVG_FRAMES - frames);
            frames += take;
            ms += r.ms * (take / r.frames);
        }
        return frames >= FREEZE_MIN_FRAMES ? ms / frames : null;
    }
}

/**
 * Samples one stream once per call, keeping each endpoint's previous report
 * so every read after the first is a real one-window rate. `resolve` is asked
 * afresh each time, because a stream's endpoints change under it: a viewer
 * joins a mesh call, the SFU resubscribes after a reconnect.
 */
export class StreamStatsSampler {
    private prev = new Map<object, { report: RTCStatsReport; at: number }>();
    /** Each watched video's freeze watch, by endpoint, and how many reads in
     *  a row it has missed. */
    private freeze = new Map<object, { watch: FreezeWatch; missed: number }>();
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
        const nextFreeze = new Map<object, { watch: FreezeWatch; missed: number }>();
        const samples: EndpointSample[] = [];
        for (const r of reads) {
            if (!r) continue;
            const before = this.prev.get(r.e.key);
            let frozenMs: number | null = null;
            if (r.e.direction === 'inbound' && r.e.kind === 'video') {
                const watch = this.freeze.get(r.e.key)?.watch ?? new FreezeWatch();
                let muted = false;
                try { muted = r.e.muted?.() === true; } catch { /* gone mid-read: not muted */ }
                frozenMs = watch.observe(r.report, r.at, !muted);
                nextFreeze.set(r.e.key, { watch, missed: 0 });
            }
            samples.push({
                direction: r.e.direction,
                kind: r.e.kind,
                prev: before?.report ?? null,
                now: r.report,
                ms: before ? r.at - before.at : 0,
                frozenMs,
            });
            next.set(r.e.key, { report: r.report, at: r.at });
        }
        // Endpoints that went away are forgotten, so a sender replaced by a
        // new one never diffs against a report that is not its own.
        this.prev = next;
        // Except a freeze watch, for a few reads: a getStats that threw, or a
        // publication whose receiver was unset for a moment, is most likely
        // around connection trouble, the very time a long freeze's count must
        // not start over at "2 s". It is keyed by the receiver itself, and a
        // new stream on it (another SSRC, counters back) restarts it anyway.
        for (const [key, e] of this.freeze) {
            if (!nextFreeze.has(key) && e.missed < FREEZE_KEEP_MISSED_READS) nextFreeze.set(key, { watch: e.watch, missed: e.missed + 1 });
        }
        this.freeze = nextFreeze;
        return summariseStreamStats(samples);
    }
}

/** How long a freeze has lasted, in whole seconds so far: '12 s',
 *  '1 min 5 s'. Never '0 s': a freeze is shown only once it is one. */
export function formatFrozenFor(ms: number): string {
    const s = Math.max(1, Math.floor(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** Human bitrate: '850 kbps', '6.2 Mbps'. */
export function formatKbps(k: number | null): string {
    if (k === null) return '—';
    return k >= 1000 ? `${(k / 1000).toFixed(1)} Mbps` : `${k} kbps`;
}
