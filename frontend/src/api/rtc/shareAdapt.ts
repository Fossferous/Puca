/**
 * How a single-layer SFU screen share adapts to the SHARER's upload.
 *
 * WHY PÚCA CHOOSES THE RESOLUTION INSTEAD OF LIBWEBRTC. The share used to be
 * published with `degradationPreference: 'maintain-framerate'` and left to
 * libwebrtc, which lowers resolution by one notch every few seconds while the
 * bandwidth target is short and raises it again only when its quality scaler
 * sees low quantisers — slowly, and often not at all. On 2026-10-05 a
 * streamer's estimate collapsed 20 s into a share and viewers got 310x180 for
 * the rest of it. Measured on a shaped loopback LiveKit (500 ms router buffer,
 * the app's publish settings, a game-like moving test picture):
 *
 *   link       maintain-framerate   balanced        this module
 *   450 kbps   180p @ 30, or 0-1    270p @ 15 fps   360p @ 13 fps
 *   600 kbps   180p @ 30 fps        -               360p @ 22 fps
 *   1 Mbps     270-360p @ 30 fps    360p @ 15 fps   540p @ 30 fps
 *   1.5 Mbps   540p @ 30 fps        540-720p @ 30   720p @ 30 fps
 *   good       1080p @ 30           -               1080p @ 30 (from ~6 s)
 *
 * (frontend/e2e/share-adapt-shaped.mjs; "0-1" is a run where the startup
 * keyframe flooded the link and the estimate never recovered.)
 *
 * So the share is published 'maintain-resolution' (libwebrtc never shrinks the
 * picture on its own; when it must, it sends fewer frames) and this module
 * picks the resolution from the encoder's own bandwidth target
 * (`targetBitrate`), one rung of a fixed ladder at a time, with hysteresis.
 *
 * WHY THE FLOOR IS 360 LINES. Below it Chromium will not use a hardware H.264
 * encoder on any machine (sfuManager.ts, SHARE_LOW), and the measured
 * difference between 360p and the old 180p floor on a 450 kbps link is 13 fps
 * of a recognisable picture against 30 fps of a smear.
 *
 * WHY IT STARTS AT 540p. A share's first frame is a keyframe, and a 1080p
 * keyframe on a slow link fills the router's buffer before the estimator has
 * learned anything: every collapse measured started there. On a good link the
 * picture is 1080p about 4 s later.
 *
 * THE PROBE. At the bottom rung a high-motion picture needs more bits a frame
 * than the target allows, so the encoder sends a frame or two a second — far
 * under its own target — and the estimator (which may only rise to about 1.5x
 * what it sees acknowledged) never learns the link came back. Measured: the
 * target sat at ~120 kbps for 40-100 s on a recovered 5 Mbps link, and 1080p
 * returned 64-101 s after the link did. libwebrtc probes for bandwidth on its
 * own only for SCREEN CONTENT, which a track hinted 'motion' is not. So while
 * the encoder is starved like that, the track's hint is switched to 'detail'
 * (screen content, which turns the probing on) and back to 'motion' once the
 * estimate carries the next rung: 1080p returned in 24-34 s instead (six
 * runs; 60-75 s as shipped on the same rig). It is not
 * left on: screen-content mode costs frame rate (measured 30 -> 18 fps at 540p
 * on 1 Mbps), and while the encoder is starved there are no frames to lose.
 * The same goes for a lowest rung that has become a SLIDESHOW (4 fps or
 * fewer for 6 s): a second share on the same call starts from the estimate
 * the first one left behind, and there the encoder fills most of a ~100 kbps
 * target at 2-3 fps and still nothing grows (measured 40 s flat on a 5 Mbps
 * link). Both triggers apply only on the lowest rung. A weak link where the
 * picture still moves (~13 fps at 450 kbps) is left alone: an earlier version
 * that probed whenever the round trip looked quiet fired there and cost it
 * 13 -> 4 fps for the rest of the share.
 *
 * Pure: no timers, no transport. sfuManager feeds it a sample every
 * SHARE_ADAPT_INTERVAL_MS and applies what it returns.
 */

export const SHARE_ADAPT_INTERVAL_MS = 2000;

/** Below this many lines Chromium encodes H.264 in software on every machine. */
const FLOOR_LINES = 360;
const STANDARD_HEIGHTS = [2160, 1440, 1080, 720, 540, 360];
/** kbps a 1080p30 game-like picture needs to look like 1080p (measured: the
 *  share settles there from ~2.5 Mbps). Other rungs scale with their pixels. */
const NEED_1080P30_KBPS = 2600;
/** A rung is kept while the smoothed target is at least this share of its need. */
const KEEP_RATIO = 0.8;
/** ...and left at once if a single reading falls under this share. */
const PANIC_RATIO = 0.5;
const UP_READS = 2;
/** The encoder is "starved" when it sends under this share of its target. */
const STARVED_RATIO = 0.6;
const STARVED_READS = 2;
/** Minimum time in each hint mode, so a link that stays weak cannot flap it. */
const MODE_DWELL_MS = 10_000;
/** ...or when it is a slideshow: at most this many frames a second... */
const SLIDESHOW_FPS = 4;
/** ...for this many readings in a row. */
const SLIDESHOW_READS = 3;
const CPU_READS = 2;
const CPU_HOLD_MS = 60_000;

/** The resolution ladder for a source this tall, tallest first. */
export function rungsFor(sourceHeight: number): number[] {
    const h = Math.round(sourceHeight);
    if (h <= FLOOR_LINES) return [h];
    return [h, ...STANDARD_HEIGHTS.filter(x => x < h && x >= FLOOR_LINES)];
}

/** Bandwidth target (kbps) a rung needs before it is chosen. The lowest rung
 *  needs nothing: it is where the share goes when nothing else fits. */
export function rungNeedKbps(height: number, fps: number, floorHeight: number, capKbps = Infinity): number {
    if (height <= floorHeight) return 0;
    const need = NEED_1080P30_KBPS * (height / 1080) ** 2 * (fps > 30 ? 1.5 : 1);
    return Math.round(Math.min(need, capKbps));
}

export interface ShareAdaptSample {
    atMs: number;
    /** outbound-rtp targetBitrate, in kbps. */
    targetKbps: number;
    /** outbound-rtp bytesSent (cumulative). */
    bytesSent: number;
    /** outbound-rtp qualityLimitationReason. */
    limit: string;
    /** outbound-rtp framesEncoded (cumulative). */
    framesEncoded: number;
}

export interface ShareAdaptAction {
    /** New height to encode at (the caller turns it into scaleResolutionDownBy). */
    height?: number;
    /** New contentHint for the captured track. */
    contentHint?: 'detail' | 'motion';
}

export class ShareAdapter {
    private rungs: number[];
    private fps: number;
    private readonly capKbps: number;
    private cur: number;
    private hist: number[] = [];
    private upReads = 0;
    private lastBytes: number | null = null;
    private lastAt = 0;
    private starvedReads = 0;
    private isProbing = false;
    private modeSince: number | null = null;
    private cpuReads = 0;
    private lastFrames: number | null = null;
    private slideshowReads = 0;
    private cpuCap: { height: number; until: number } | null = null;

    constructor(opts: { sourceHeight: number; fps: number; maxKbps?: number; startHeight?: number }) {
        this.rungs = rungsFor(opts.sourceHeight);
        this.fps = opts.fps;
        // The top rung can never need more than the encoder may send.
        this.capKbps = 0.9 * (opts.maxKbps ?? 4500);
        const start = opts.startHeight ?? 540;
        this.cur = this.rungs.find(r => r <= start) ?? this.floor;
    }

    get currentHeight(): number { return this.cur; }
    get probing(): boolean { return this.isProbing; }
    get sourceHeight(): number { return this.rungs[0]; }
    private get floor(): number { return this.rungs[this.rungs.length - 1]; }
    private need(h: number): number { return rungNeedKbps(h, this.fps, this.floor, this.capKbps); }
    /** The tallest rung a target of `kbps` carries. */
    private fit(kbps: number): number { return this.rungs.find(r => this.need(r) <= kbps) ?? this.floor; }

    /** The capture changed size (a window resized, a live quality change):
     *  rebuild the ladder and keep to the nearest rung not above the old one. */
    resize(sourceHeight: number, fps: number): ShareAdaptAction {
        if (Math.round(sourceHeight) === this.rungs[0] && fps === this.fps) return {};
        this.rungs = rungsFor(sourceHeight);
        this.fps = fps;
        this.cur = this.rungs.find(r => r <= this.cur) ?? this.floor;
        this.upReads = 0;
        return { height: this.cur };
    }

    step(s: ShareAdaptSample): ShareAdaptAction {
        const act: ShareAdaptAction = {};
        if (this.modeSince === null) this.modeSince = s.atMs;
        const t = s.targetKbps;
        this.hist.push(t);
        if (this.hist.length > 3) this.hist.shift();
        const mean = this.hist.reduce((a, b) => a + b, 0) / this.hist.length;
        const low = Math.min(t, mean);

        // --- the rung ---
        let next = this.cur;
        this.cpuReads = s.limit === 'cpu' ? this.cpuReads + 1 : 0;
        const capped = this.cpuCap && s.atMs < this.cpuCap.until ? this.cpuCap.height : Infinity;
        if (this.cpuReads >= CPU_READS && this.cur > this.floor) {
            // The ENCODER is short, not the link: give back pixels, and do not
            // climb straight back into the same overload.
            next = this.rungs[this.rungs.indexOf(this.cur) + 1];
            this.cpuCap = { height: next, until: s.atMs + CPU_HOLD_MS };
            this.cpuReads = 0;
            this.upReads = 0;
        } else if (t < PANIC_RATIO * this.need(this.cur) || mean < KEEP_RATIO * this.need(this.cur)) {
            next = Math.min(this.fit(low), this.cur);
            this.upReads = 0;
        } else {
            const up = Math.min(this.fit(low), capped);
            if (up > this.cur) {
                if (++this.upReads >= UP_READS) { next = up; this.upReads = 0; }
            } else {
                this.upReads = 0;
            }
        }
        if (next !== this.cur) { this.cur = next; act.height = next; }

        // --- the probe ---
        const prevBytes = this.lastBytes;
        const dt = s.atMs - this.lastAt;
        this.lastBytes = s.bytesSent;
        this.lastAt = s.atMs;
        const prevFrames = this.lastFrames;
        this.lastFrames = s.framesEncoded;
        // A new sender restarts its counters: no rate to read this time.
        const reset = prevBytes === null || prevFrames === null || s.bytesSent < prevBytes || s.framesEncoded < prevFrames || dt <= 0;
        const sentKbps = reset ? null : ((s.bytesSent - prevBytes) * 8) / dt;
        const fps = reset ? null : ((s.framesEncoded - prevFrames) * 1000) / dt;
        const dwelt = s.atMs - this.modeSince >= MODE_DWELL_MS;
        if (!this.isProbing) {
            // Only ever on the lowest rung, and only below what the top needs:
            // anywhere else the picture is working and the hint would cost it.
            const eligible = this.cur === this.floor && t < this.need(this.rungs[0]);
            const starved = eligible && sentKbps !== null && sentKbps < STARVED_RATIO * t;
            const slideshow = eligible && fps !== null && fps <= SLIDESHOW_FPS;
            this.starvedReads = starved ? this.starvedReads + 1 : 0;
            this.slideshowReads = slideshow ? this.slideshowReads + 1 : 0;
            if ((this.starvedReads >= STARVED_READS || this.slideshowReads >= SLIDESHOW_READS) && dwelt) {
                this.isProbing = true;
                this.modeSince = s.atMs;
                this.starvedReads = 0;
                this.slideshowReads = 0;
                act.contentHint = 'detail';
            }
        } else if (dwelt) {
            const i = this.rungs.indexOf(this.cur);
            const nextNeed = i > 0 ? this.need(this.rungs[i - 1]) : 0;
            if (Math.min(...this.hist) >= nextNeed) {
                this.isProbing = false;
                this.modeSince = s.atMs;
                act.contentHint = 'motion';
            }
        }
        return act;
    }
}
