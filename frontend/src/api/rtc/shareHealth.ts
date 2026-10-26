/**
 * Is this machine actually able to encode the screen share it was asked for?
 *
 * WHY THIS EXISTS. The browser already answers that question every second, in
 * `qualityLimitationReason` on the share's outbound-rtp stats: `'cpu'` means
 * the ENCODER is starved and Chromium is throwing away resolution to keep up.
 * The app has read that field for weeks — `voiceDiagnostics`, `meshDiagnostics`
 * and the background `[stream-diag]` log all record it — and has never once
 * told the person it is happening to. They find out the way the reports came
 * in: their game gets choppy while they are sharing, and they have no idea the
 * two are connected.
 *
 * It matters more here than in most apps because the share was encoded in
 * SOFTWARE on every machine this project had logs from (`encoder=OpenH264`) —
 * a profile-negotiation accident fixed 2026-09-16 (h264Profiles.ts), but a
 * machine with no hardware encoder still lands here. The encode is competing
 * with the game for the same cores. The resolution and frame rate are the only
 * controls the person has over how much it takes, and before this nothing told
 * them the controls were the answer.
 *
 * NOTHING IS IMPORTED HERE, deliberately. The share DIALOG needs the ladder
 * and the validation, and a dialog that transitively pulls in LiveKit, the
 * mesh manager and the API config to check two stored strings is a dialog that
 * cannot be tested in isolation — which is exactly how this module first broke
 * an unrelated test. The half that talks to a transport lives next door in
 * shareHealthLive.ts.
 *
 * SO THIS OFFERS, IT DOES NOT IMPOSE. Quietly halving somebody's stream while
 * they are mid-sentence is its own kind of broken; a one-click step down that
 * is then REMEMBERED (shareResolution / shareFps) is the same fix without
 * taking the decision away.
 */

/** The rung of a share that carries the largest picture still switched on —
 *  what most viewers are sent (statsSummary.ts shareSendReading). */
export interface SentRung {
    /** outbound-rtp framesPerSecond: frames encoded a second. Chromium leaves
     *  it out when it is 0. */
    fps?: number;
    /** This rung's own frame-rate cap (encodings[].maxFramerate). A ladder's
     *  bottom rung is capped at 30 on purpose: its lower rate is not a drop. */
    maxFps?: number;
    /** framesEncoded and bytesSent, cumulative: between two readings they say
     *  how big the frames are, which is how a still picture is told apart. */
    frames?: number;
    bytes?: number;
    width?: number;
    height?: number;
    /** The sender's stream id. A new publication starts its counters again. */
    ssrc?: number;
    /** The encoder's bandwidth target for this rung (outbound targetBitrate). */
    targetKbps?: number;
}

/** The fields of one outbound-rtp sample this module cares about. Deliberately
 *  a plain shape rather than `RTCOutboundRtpStreamStats` so both transports —
 *  and a test — can produce one. */
export interface EncodeSample {
    /** `qualityLimitationReason`: 'none' | 'cpu' | 'bandwidth' | 'other'. */
    limit?: string;
    /** `encoderImplementation`, e.g. 'OpenH264' (software) or a MediaFoundation
     *  name (hardware). Recorded for the report, not used in the verdict. */
    encoder?: string;
    /** When it was read (performance.now()), for rates between two readings. */
    atMs?: number;
    /** The frame rate the capture is SET to: the cap the person chose (the
     *  track's getSettings().frameRate). */
    setFps?: number;
    /** Frames a second the capture actually delivered to the encoder (the
     *  media-source framesPerSecond). */
    captureFps?: number;
    /** What was sent, on the rung most viewers get. */
    sent?: SentRung;
}

/** How many recent samples are considered, and how many of them must say 'cpu'.
 *
 *  NOT ONE SAMPLE. A keyframe, a scene change, or the moment a game loads a
 *  level will each starve the encoder for a tick, and a warning that fires on
 *  those is a warning people learn to dismiss without reading. Three out of
 *  five is a machine that cannot keep up, not a machine having a moment. */
export const CPU_WINDOW = 5;
export const CPU_NEEDED = 3;

/**
 * Is the encoder persistently starved of CPU?
 *
 * Returns false until there is a full window to judge on: a share that has
 * only just started has not yet earned an opinion, and the first samples after
 * `getDisplayMedia` are the least representative ones there are.
 */
export function cpuStarved(samples: readonly EncodeSample[]): boolean {
    const window = samples.slice(-CPU_WINDOW);
    if (window.length < CPU_WINDOW) return false;
    return window.filter(s => s.limit === 'cpu').length >= CPU_NEEDED;
}

/** How often the share's encode health is read while sharing. Slow on purpose:
 *  this runs for the whole life of a share on a machine that is, by the time it
 *  matters, already short of CPU. Five samples at this cadence means a verdict
 *  about fifteen seconds in, which is late enough to be sure and early enough
 *  to be worth saying. */
export const SAMPLE_MS = 3000;

/*
 * SHORT OF FRAMES, WITH NOTHING LIMITED.
 *
 * `cpuStarved` above only ever spoke when the browser said 'cpu', and on
 * 2026-10-25 a share stuttered for two viewers for an evening while it never
 * did. The sharer's own log, 214 one-minute samples: the top rung read
 * `set60fps cap30fps` (or cap44-49fps) and sent a median of 26 frames a second
 * (p25 20, p75 41), on three hardware encoders at about 4 ms a frame, with
 * `limit=none` throughout. So the capture delivered far fewer frames than were
 * set, and fewer still went out, and nothing told the person.
 *
 * Two shortfalls, both against what the share should manage:
 *   - CAPTURE: fewer frames reach the encoder than the frame rate set
 *     (`captureFps` under FRAME_SHORT_RATIO of `setFps`);
 *   - SEND: frames reach the encoder and do not go out (`sent.fps` under
 *     FRAME_SHORT_RATIO of the capture, or of the rung's own cap where that is
 *     lower).
 *
 * A STILL PICTURE IS NOT SHORT OF FRAMES. Chromium's screen capture is
 * damage-driven: a screen where nothing changes delivers about one frame a
 * second, and one with a blinking cursor, a clock or somebody typing a few
 * more (the clip spike counted ~15 on a still desktop, e2e/spike-clips).
 * Nothing is lost there, so nothing must be offered. The frame RATE cannot
 * tell that from a game the machine cannot keep up with; what the encoder
 * makes of the frames can. Measured 2026-10-26 on a real capture and encoder
 * (e2e/share-quality-live-real-browser.mjs, its own tab at 640x360 and
 * 1280x720): full-frame motion sent 0.24-0.89 bits a pixel a frame and 83% or
 * more of the encoder's bandwidth target; a 40 px square repainted 12 times a
 * second, or text typed at 10 characters a second, 0.003-0.022 bits a pixel
 * and 1-4% of the target. (0.01 bits a pixel, the first line drawn, read the
 * square as motion.) So a reading is MOVING when its frames are MOVING_BPP or
 * more, or fill MOVING_TARGET_SHARE of the target (the second is what keeps a
 * moving picture on a slow uplink, few bits a pixel because few bits at all,
 * counted as moving). Anything else is still.
 *
 * And at STILL_FPS or less it is still whatever the frames say: a picture
 * that has stopped is refreshed about once a second with frames the encoder
 * spends its spare bits on (measured up to 1.3 bits a pixel, and up to 44%
 * of the target), which would otherwise read as motion.
 *
 * FEWER FRAMES ARE NOT LOST FRAMES. A film plays at 24, 25 or 30 frames a
 * second, and a game capped at 30 renders 30: under a 60 setting each reads
 * "short at the capture" on every reading (measured: 24 fps motion under 60,
 * ten readings of ten). Scrolling a document, a video, a game that renders in
 * bursts: each makes the capture JUMP between readings, and still every frame
 * captured is sent (measured on a real capture: scrolling text in bursts,
 * random scrolling and noise-like bursts were each offered a step by a
 * jumping-capture rule, at readings 6-8, with sent equal to captured and
 * nothing lost). Offering any of those a step down is wrong advice. What
 * none of them does is drop frames between the capture and the wire. So the
 * window speaks only when SEND_NEEDED readings are short at the SEND. The
 * sharer of 2026-10-25 was: captures of 30 and 44-49 with 20-41 sent, and
 * every variant of that pattern drops frames there. How often the capture
 * jumped (UNEVEN_SWING, counted per window) goes to the log line only.
 */

/** A share is short of frames below this share of what it should manage. */
export const FRAME_SHORT_RATIO = 0.7;
/** At or below this many frames a second captured, the picture is still. */
export const STILL_FPS = 5;
/** Frames this many bits a pixel or bigger are a moving picture... */
export const MOVING_BPP = 0.05;
/** ...and so is a rung sending this share of its bandwidth target or more. */
export const MOVING_TARGET_SHARE = 0.5;
/** The last this-many readings are judged (24 s at SAMPLE_MS)... */
export const FRAMES_WINDOW = 8;
/** ...and this many of them must be short. A level loading, a scene change
 *  or a moment of contention is a reading or two, not six. */
export const FRAMES_NEEDED = 6;
/** And frames must be LOST: this many readings of the window short at the
 *  SEND (captured, and not sent). */
export const SEND_NEEDED = 2;
/** For the log line only: a jump of the capture, from one judged reading to
 *  the next, is this share of its median or more. Scrolling, a video and a
 *  starved capture all jump, so it decides nothing. */
export const UNEVEN_SWING = 0.25;

/** What one reading says about the share's frames. 'still' and 'unknown' are
 *  never short: no evidence is not evidence of starvation. */
export type FrameVerdict = 'capture' | 'send' | 'ok' | 'still' | 'unknown';

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Bits a pixel in each frame sent between two readings of the same sender,
 *  or null when they cannot be compared (no previous reading, a new sender, a
 *  counter that went back, no frame sent, no size). */
export function bitsPerPixel(s: EncodeSample, prev: EncodeSample | null): number | null {
    const a = prev?.sent;
    const b = s.sent;
    if (!a || !b || a.ssrc !== b.ssrc) return null;
    if (!finite(a.frames) || !finite(b.frames) || !finite(a.bytes) || !finite(b.bytes)) return null;
    const frames = b.frames - a.frames;
    const bytes = b.bytes - a.bytes;
    const px = (b.width ?? 0) * (b.height ?? 0);
    if (frames <= 0 || bytes < 0 || !(px > 0)) return null;
    return (bytes * 8) / frames / px;
}

/** kbps sent on the rung between two readings of the same sender, or null. */
export function sentKbps(s: EncodeSample, prev: EncodeSample | null): number | null {
    const a = prev?.sent;
    const b = s.sent;
    if (!a || !b || a.ssrc !== b.ssrc || !finite(a.bytes) || !finite(b.bytes) || b.bytes < a.bytes) return null;
    if (!finite(s.atMs) || !finite(prev?.atMs) || s.atMs <= prev!.atMs!) return null;
    return ((b.bytes - a.bytes) * 8) / (s.atMs - prev!.atMs!);
}

/** Is the picture between two readings MOVING (see the note above
 *  FRAME_SHORT_RATIO)? Null when the frames cannot be measured. */
function moving(s: EncodeSample, prev: EncodeSample | null): boolean | null {
    const bpp = bitsPerPixel(s, prev);
    if (bpp === null) return null;
    if (bpp >= MOVING_BPP) return true;
    const kbps = sentKbps(s, prev);
    const target = s.sent?.targetKbps;
    return kbps !== null && finite(target) && target > 0 && kbps >= MOVING_TARGET_SHARE * target;
}

/** Frames a second sent on the rung: the browser's figure, or, where it leaves
 *  it out (it does at 0), the frame counter over the time between readings. */
function sentFps(s: EncodeSample, prev: EncodeSample | null): number | null {
    const b = s.sent;
    if (!b) return null;
    if (finite(b.fps)) return b.fps;
    const a = prev?.sent;
    if (!a || a.ssrc !== b.ssrc || !finite(a.frames) || !finite(b.frames) || b.frames < a.frames) return null;
    if (!finite(s.atMs) || !finite(prev?.atMs) || s.atMs <= prev!.atMs!) return null;
    return ((b.frames - a.frames) * 1000) / (s.atMs - prev!.atMs!);
}

/** A judged reading, with the numbers the offer and its log line quote. */
interface FrameReading {
    verdict: FrameVerdict;
    /** Moving, and captured under FRAME_SHORT_RATIO of the setting. */
    captureShort: boolean;
    /** Moving, and sending under FRAME_SHORT_RATIO of what it captures (or of
     *  the rung's own cap): judged whatever the capture did. */
    sendShort: boolean;
    set: number | null;
    capture: number | null;
    sent: number | null;
    bpp: number | null;
    /** kbps sent over the encoder's target. */
    targetShare: number | null;
}

/** One reading, judged in full (see the notes above FRAME_SHORT_RATIO). */
function judge(s: EncodeSample, prev: EncodeSample | null): FrameReading {
    const set = s.setFps;
    const cap = s.captureFps;
    const sent = sentFps(s, prev);
    const bpp = bitsPerPixel(s, prev);
    const kbps = sentKbps(s, prev);
    const target = s.sent?.targetKbps;
    const r: FrameReading = {
        verdict: 'unknown', captureShort: false, sendShort: false,
        set: finite(set) ? set : null, capture: finite(cap) ? cap : null, sent, bpp,
        targetShare: kbps !== null && finite(target) && target > 0 ? kbps / target : null,
    };
    if (!finite(set) || set <= 0 || !finite(cap) || cap < 0) return r;
    if (cap <= STILL_FPS) return { ...r, verdict: 'still' };
    const motion = moving(s, prev);
    if (motion === null) return r;
    if (!motion) return { ...r, verdict: 'still' };
    r.captureShort = cap < FRAME_SHORT_RATIO * set;
    if (sent !== null) {
        const rungCap = s.sent?.maxFps;
        const expected = Math.min(cap, finite(rungCap) && rungCap > 0 ? rungCap : Infinity);
        r.sendShort = sent < FRAME_SHORT_RATIO * expected;
    }
    r.verdict = r.captureShort ? 'capture' : r.sendShort ? 'send' : 'ok';
    return r;
}

/** One reading, judged (see the note above FRAME_SHORT_RATIO). A reading
 *  short at both ends reads 'capture'. */
export function frameVerdict(s: EncodeSample, prev: EncodeSample | null): FrameVerdict {
    return judge(s, prev).verdict;
}

/** The share is losing frames: where, and the typical numbers (medians of
 *  the short readings), for the offer and the log. */
export interface FrameShortfall {
    /** Frames are being lost at the send either way; 'capture': and most
     *  short readings captured well under the setting too; 'send': the
     *  capture kept up, and the frames did not go out. */
    kind: 'capture' | 'send';
    setFps: number;
    captureFps: number;
    /** null when the sent rate could not be read. */
    sentFps: number | null;
    /** What the encoder made of the frames, for the log: bits a pixel, and
     *  the share of its bandwidth target it sent (null: not read). */
    bpp: number | null;
    targetShare: number | null;
    /** For the log: how many times the capture jumped (UNEVEN_SWING) between
     *  the window's judged readings. */
    jumps: number;
}

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** How many times the capture jumped by UNEVEN_SWING of its median or more,
 *  from one judged reading to the next (for the log line). */
function captureJumps(caps: readonly number[]): number {
    if (caps.length < 2) return 0;
    const typical = median([...caps]);
    if (!(typical > 0)) return 0;
    let jumps = 0;
    for (let i = 1; i < caps.length; i++) if (Math.abs(caps[i] - caps[i - 1]) >= UNEVEN_SWING * typical) jumps++;
    return jumps;
}

/** FRAMES_NEEDED of the last FRAMES_WINDOW readings short, with frames being
 *  LOST at the send (see the note above FRAME_SHORT_RATIO), or null. Like
 *  cpuStarved, nothing is said before there is a full window to judge on. */
function framesStarved(readings: readonly FrameReading[]): FrameShortfall | null {
    const window = readings.slice(-FRAMES_WINDOW);
    if (window.length < FRAMES_WINDOW) return null;
    const short = window.filter(r => r.captureShort || r.sendShort);
    if (short.length < FRAMES_NEEDED) return null;
    const sends = window.filter(r => r.sendShort);
    // Everything captured was sent: the content's own rate, however it
    // moves (a film, a capped game, scrolling, a video).
    if (sends.length < SEND_NEEDED) return null;
    const judged = window.filter(r => r.verdict === 'capture' || r.verdict === 'send' || r.verdict === 'ok');
    const atCapture = short.filter(r => r.captureShort);
    const kind: FrameShortfall['kind'] = atCapture.length * 2 >= short.length ? 'capture' : 'send';
    const of = kind === 'capture' ? atCapture : sends;
    const nums = (pick: (r: FrameReading) => number | null) => of.map(pick).filter(finite);
    const med = (xs: number[]) => (xs.length ? median(xs) : null);
    const sent = med(nums(r => r.sent));
    const bpp = med(nums(r => r.bpp));
    const share = med(nums(r => r.targetShare));
    return {
        kind,
        setFps: Math.round(med(nums(r => r.set)) ?? 0),
        captureFps: Math.round(med(nums(r => r.capture)) ?? 0),
        sentFps: sent === null ? null : Math.round(sent),
        bpp: bpp === null ? null : Math.round(bpp * 1000) / 1000,
        targetShare: share === null ? null : Math.round(share * 100) / 100,
        jumps: captureJumps(judged.map(r => r.capture).filter(finite)),
    };
}

/** Why the watch spoke: the encoder short of CPU, or the share short of frames. */
export type ShareLoadReason = { kind: 'cpu' } | FrameShortfall;

/**
 * The accumulating half of the watch, with no timer and no browser in it.
 *
 * `add` returns true ONCE PER ARM — at most once for the first offer, and once
 * more after each step the person actually took (see `rearm` below). Repeating
 * it every three seconds for the rest of a two-hour call would be the same
 * information delivered as harassment, and somebody who has DECLINED has
 * answered; somebody who accepted asked for help that may not have been enough.
 * The ladder is finite, so the repeats are too: `starvedOffer` returns null
 * once there is nothing left to give up.
 *
 * ONE OFFER FOR EITHER REASON. A CPU-limited encoder is checked first (its
 * offer steps the resolution); a share short of frames with nothing limited
 * comes next (its offer steps the frame rate). `reason()` says which spoke.
 */
export function createShareLoadWatch() {
    let samples: EncodeSample[] = [];
    let readings: FrameReading[] = [];
    let prev: EncodeSample | null = null;
    let offered = false;
    let why: ShareLoadReason | null = null;
    return {
        /** Feed one reading (null = nothing to read this tick). True = offer now. */
        add(s: EncodeSample | null): boolean {
            if (s) {
                samples.push(s);
                readings.push(judge(s, prev));
                prev = s;
            }
            // Bounded: only the last window is ever consulted, and a three-hour
            // share would otherwise accumulate thousands of readings on a
            // machine that is by definition already short of memory and CPU.
            if (samples.length > CPU_WINDOW * 2) samples = samples.slice(-CPU_WINDOW);
            if (readings.length > FRAMES_WINDOW * 2) readings = readings.slice(-FRAMES_WINDOW);
            if (offered) return false;
            if (cpuStarved(samples)) {
                offered = true;
                why = { kind: 'cpu' };
                return true;
            }
            const short = framesStarved(readings);
            if (!short) return false;
            offered = true;
            why = short;
            return true;
        },

        /** Why the last offer was made, or null before any. */
        reason(): ShareLoadReason | null {
            return why;
        },

        /**
         * Allow ONE more offer, after a step that was actually applied.
         *
         * WHY THIS EXISTS. Without it, accepting a step and declining one were
         * the same to this watch: both spent the single offer. But they mean
         * opposite things. Somebody who declined has answered. Somebody who
         * ACCEPTED asked for help — and a step is not guaranteed to be enough,
         * least of all on the machines this is for: on a 1366x768 panel the
         * only rung below the capture is 720p, worth about 12%, and on a
         * 1920x1200 panel the first step is worth 19% against the 32-41% the
         * table above quotes for 16:9. Leaving them with a still-stuttering
         * game and no further offer is the one-way-latch trap this project has
         * been bitten by twice.
         *
         * The old evidence is dropped with it, so the next offer needs a fresh
         * window of starvation — the step is given a real chance to work before
         * anything is said again.
         */
        rearm(): void {
            offered = false;
            samples = [];
            readings = [];
            prev = null;
            why = null;
        },
        /** The encoder actually in use, for the log line that accompanies the
         *  offer — 'OpenH264' there is the difference between "this machine is
         *  busy" and "this machine is encoding in software". */
        encoder(): string | undefined {
            return samples.length ? samples[samples.length - 1].encoder : undefined;
        },
    };
}

/** The share sizes the dialog offers, largest first — the order a step DOWN
 *  walks. This is now the single source: ScreenShareModal and the live
 *  quality panel derive their option lists from it, and the capture size
 *  comes from `shareDimensions` below. */
export const RES_STEPS = ['source', '1440', '1080', '720'] as const;
/** The frame rates the dialog offers, fastest first. */
export const FPS_STEPS = [60, 30, 15] as const;

/** The resolution choices as the dialogs show them, smallest first (the way
 *  they are read). Derived from RES_STEPS so the dialogs and the step-down
 *  offer cannot come to disagree about which sizes exist. */
export const RESOLUTION_OPTIONS = [...RES_STEPS].reverse().map(value => ({
    value,
    label: value === 'source' ? 'Source' : `${value}p`,
}));

/** The frame-rate choices as the dialogs show them, slowest first. */
export const FPS_OPTIONS = [...FPS_STEPS].reverse();

export interface ShareQuality { resolution: string; fps: number }

/** Pixel size for each option the dialog offers.
 *
 *  'source' is 4K rather than "whatever the monitor is": the constraint is a
 *  CAP, and a cap above every real desktop is the same as no cap, which is
 *  what "Source" means. (Before the cap was a cap it was an `ideal`, and a
 *  1440p monitor asked for 1080p encoded 1440p — see shareCaptureCap.test.ts.)
 */
export function shareDimensions(resolution: string): { width: number; height: number } {
    switch (resolution) {
        case '720': return { width: 1280, height: 720 };
        case '1440': return { width: 2560, height: 1440 };
        case 'source': return { width: 3840, height: 2160 };
        default: return { width: 1920, height: 1080 };
    }
}

/**
 * The next cheaper setting to offer, or null when there is nothing left.
 *
 * RESOLUTION FIRST, THEN FRAME RATE, one notch at a time.
 *
 * MEASURED, so the trade is explicit rather than assumed
 * (frontend/e2e/encode-cost.mjs, H.264, a Ryzen 7 7800X3D + RTX 4080 SUPER,
 * each run proving which encoder it actually used — read the RATIOS, not the
 * milliseconds, because that machine is several times faster than the laptops
 * this feature exists for). Encode milliseconds per second of video:
 *
 *                software (OpenH264)   hardware (NVENC)
 *     720p30            158                  56
 *     720p60            284                 106
 *     1080p30           238                 103
 *     1080p60           484                 195
 *     1440p60           712                 331
 *
 * Two things fall out. First, in software a 1440p60 share costs 71% of one
 * core CONTINUOUSLY on a fast CPU — on a laptop several times slower it is not
 * affordable at all, which is the whole reason this module exists. Second,
 * hardware encode is worth 54–65%, i.e. MORE than any single step on this
 * ladder; if the app can be got onto it (see the note in diagnosticsReport.ts)
 * that beats every option here.
 *
 * Within the ladder: a step of RESOLUTION saves 32–41%, a step of FRAME RATE
 * saves 44–51%. Frame rate is the bigger lever and is deliberately not the
 * first one pulled, for the same reason the share's resolution picker
 * (shareAdapt.ts) gives up pixels before frames: a choppy game stream is worse
 * than a blurry one, and this is the same judgement applied to the same trade.
 * Somebody who wants the larger saving can take a second step, or set it
 * directly in the dialog.
 *
 * Predictability is the other half. A "make it cheaper" button that raises the
 * frame rate because the arithmetic said so — 720p60 costs 284 against
 * 1080p30's 238, so a pixels-per-second ladder would do exactly that — is a
 * button nobody trusts twice.
 *
 * An unrecognised stored resolution steps to '1080' rather than returning null:
 * the point is to offer a way down, and refusing because the current value is
 * unfamiliar strands exactly the profile that most needs it.
 */
export function nextStepDown(q: ShareQuality): ShareQuality | null {
    const at = RES_STEPS.indexOf(q.resolution as typeof RES_STEPS[number]);
    if (at === -1) return { resolution: '1080', fps: q.fps };
    if (at < RES_STEPS.length - 1) return { resolution: RES_STEPS[at + 1], fps: q.fps };
    // Already at the smallest picture; spend the frame rate instead.
    const f = FPS_STEPS.indexOf(q.fps as typeof FPS_STEPS[number]);
    if (f === -1) return { resolution: q.resolution, fps: 30 };
    if (f < FPS_STEPS.length - 1) return { resolution: q.resolution, fps: FPS_STEPS[f + 1] };
    return null;
}

/**
 * The quality the share dialog should open on: what was remembered, or the
 * default when that is not something this build offers.
 *
 * A stored value is only as trustworthy as the build that wrote it. A
 * resolution this build no longer lists would leave the dialog with no option
 * highlighted and no way to tell what is about to be captured — and the person
 * most likely to be carrying an odd stored value is the one who has been
 * changing it, i.e. the one whose machine is struggling.
 *
 * Lives here rather than in ScreenShareModal so the dialog's options and this
 * validation cannot drift apart, and so the component file exports components
 * only (`react-refresh/only-export-components`).
 */
export function rememberedQuality(s: { shareResolution?: string; shareFps?: number }): ShareQuality {
    return {
        resolution: RES_STEPS.includes(s.shareResolution as typeof RES_STEPS[number]) ? s.shareResolution as string : '1080',
        fps: FPS_STEPS.includes(s.shareFps as typeof FPS_STEPS[number]) ? s.shareFps as number : 30,
    };
}

/** Human label for a quality pair, for the offer text. */
export function qualityLabel(q: ShareQuality): string {
    return `${q.resolution === 'source' ? 'Source' : q.resolution + 'p'} at ${q.fps} fps`;
}

/**
 * The next cheaper setting, chosen from WHAT IS ACTUALLY BEING CAPTURED rather
 * than from the label the person picked.
 *
 * THE BUG THIS FIXES. Every one of these settings is a CAP, not a size. Pick
 * "Source" on a 1080p monitor and you capture 1920x1080; the label-based
 * step-down then offered "1440p", which caps at 2560x1440 — above what is
 * already being captured, so applying it changed precisely nothing while the
 * button reported success and the one-per-share offer was spent. The person
 * was told their share had been lowered, their game kept stuttering, and
 * nothing would offer again until they restarted the share.
 *
 * Resolution comes from reality; the FRAME RATE still comes from the setting,
 * because that cap IS honoured and a measured rate is noisy (a 60 fps share
 * commonly reads 57).
 */
export function stepDownFromCapture(
    capture: { width: number; height: number },
    current: ShareQuality,
): ShareQuality | null {
    for (const resolution of RES_STEPS) {          // largest first
        const d = shareDimensions(resolution);
        if (d.width < capture.width || d.height < capture.height) return { resolution, fps: current.fps };
    }
    // Already at or below the smallest picture offered; spend the frame rate
    // and KEEP THE CHOSEN RESOLUTION. Returning '720' here instead would have
    // rewritten the person's stored setting: share one small window on a big
    // monitor, take a frame-rate step, and every later full-screen share would
    // silently start at 720p because the step "down" had quietly moved a
    // control the person never touched. The resolution is not what changed.
    const slower = FPS_STEPS.find(f => f < current.fps);
    return slower === undefined ? null : { resolution: current.resolution, fps: slower };
}

/**
 * What to say when the encoder is starved, or null when there is nothing
 * useful to say. Separated from the React that renders it so the wording — the
 * part that is actually read by a person mid-call — is pinned by a test.
 *
 * `capture` is the live track's own `getSettings()`. When it is unavailable
 * (no track yet) the offer falls back to the stored labels, which is the old
 * behaviour and still better than saying nothing.
 */
export function starvedOffer(
    current: ShareQuality,
    capture?: { width: number; height: number } | null,
): { text: string; to: ShareQuality } | null {
    const to = capture && capture.width > 0 && capture.height > 0
        ? stepDownFromCapture(capture, current)
        : nextStepDown(current);
    if (!to) {
        // Nothing left to give up. Saying "your CPU cannot keep up" and
        // offering no action would be a notification whose only content is
        // bad news, so this stays quiet and the diagnostics carry the detail.
        return null;
    }
    return { text: `Your screen share is being limited by CPU. Drop to ${qualityLabel(to)}?`, to };
}

/**
 * The step for a share short of FRAMES: 30 fps first, then a smaller picture.
 *
 * FRAME RATE FIRST, the other way round from the CPU step. The share already
 * gets fewer frames than its setting, so a setting it can reach gives up
 * little it has now: a capture delivering 31 of 60 sends about the same 30 a
 * second at 30, evenly, and the bitrate that follows the quality
 * (shareBitrate.ts) drops from the 60 fps budget to the 30 fps one, which
 * every viewer's connection carries more easily. At 30 or less it gives up
 * pixels instead, from the size actually captured (stepDownFromCapture), and
 * KEEPS the frame rate until the picture is as small as it goes.
 */
export function framesStepDown(
    current: ShareQuality,
    capture?: { width: number; height: number } | null,
): ShareQuality | null {
    if (current.fps > 30) return { resolution: current.resolution, fps: 30 };
    return capture && capture.width > 0 && capture.height > 0
        ? stepDownFromCapture(capture, current)
        : nextStepDown(current);
}

/** The quality to step down FROM: the remembered one, with the frame rate the
 *  running capture is really set to when it is one the dialog offers. A share
 *  started by an embedding host, say, need not be at the remembered rate, and
 *  a step "down" from the wrong one would change nothing. */
export function liveQuality(saved: ShareQuality, setFps: number | null | undefined): ShareQuality {
    const live = finite(setFps) ? FPS_STEPS.find(f => Math.abs(f - setFps) <= 1.5) : undefined;
    return live === undefined ? saved : { resolution: saved.resolution, fps: live };
}

/** An offer: what to say, what "Lower it" sets, and whether that is kept as
 *  the person's setting for the next share. */
export interface ShareLoadOffer { text: string; to: ShareQuality; remember: boolean }

/**
 * What to say when the share is short of frames, or null when there is
 * nothing left to give up. Plain words: what is happening, and, in the
 * question, exactly what "Lower it" will set.
 *
 * FOR THIS SHARE ONLY (remember: false). The frames this share loses are this
 * share's trouble: the game, the window, what else the machine is doing. Kept
 * as the setting, a step taken during one evening's share would start the
 * next game share at 30 fps, and a second step would walk it on down.
 */
export function framesOffer(
    short: FrameShortfall,
    current: ShareQuality,
    capture?: { width: number; height: number } | null,
): ShareLoadOffer | null {
    const to = framesStepDown(liveQuality(current, short.setFps), capture);
    if (!to) return null;
    const what = short.kind === 'send' && short.sentFps !== null
        ? `Your screen share is sending only about ${short.sentFps} of the ${short.captureFps} frames a second it captures, so it stutters for viewers.`
        : `Your screen share is getting only about ${short.captureFps} of the ${short.setFps} frames a second you chose, and sending fewer still, so it stutters for viewers.`;
    return { text: `${what} Lower this share to ${qualityLabel(to)}?`, to, remember: false };
}

/** The offer for whatever the watch found. The CPU step is remembered, as it
 *  always was: an encoder short of CPU is the machine, and stays so. */
export function shareLoadOffer(
    why: ShareLoadReason,
    current: ShareQuality,
    capture?: { width: number; height: number } | null,
): ShareLoadOffer | null {
    if (why.kind !== 'cpu') return framesOffer(why, current, capture);
    const offer = starvedOffer(current, capture);
    return offer ? { ...offer, remember: true } : null;
}

/** The puca.log line that goes with an offer, or with the watch speaking when
 *  there was nothing left to offer (the share was already as low as it goes).
 *  A shortfall carries what the encoder made of the frames (bits a pixel, and
 *  the share of its target sent), so a log from a hardware encoder can show
 *  whether the still-picture check holds there too. */
export function shareLoadLogLine(why: ShareLoadReason, encoder: string | undefined, to: ShareQuality | null): string {
    const offer = to ? `offered ${qualityLabel(to)}` : 'nothing lower to offer';
    const enc = `encoder=${encoder ?? 'unknown'}`;
    if (why.kind === 'cpu') return `[share] encoder CPU-limited (${enc}); ${offer}`;
    return `[share] short of frames at the ${why.kind}: set ${why.setFps} fps, captured ${why.captureFps}, `
        + `sent ${why.sentFps ?? '?'}, bpp ${why.bpp ?? '?'}, of target ${why.targetShare ?? '?'}, capture jumps ${why.jumps} (${enc}); ${offer}`;
}

/**
 * What a screen share asks the browser for.
 *
 * `max`, NOT `ideal`, on all three. An ideal is a preference the browser may
 * ignore, and for display capture Chromium routinely does: it hands back the
 * surface at its native size. So somebody on a 1440p monitor who picked
 * "1080p" was capturing and ENCODING 1440p — 1.8x the pixels they chose — and
 * on a 4K monitor, four times. The frame rate was already capped here; the
 * resolution was not, and the clip path has always capped all three
 * (clips/replayBuffer.ts's displayConstraints).
 *
 * It matters more than it looks because the share was encoded in SOFTWARE on
 * every machine with a log line (`encoder=OpenH264`, until the profile fix in
 * h264Profiles.ts) and still is on any machine without a hardware encoder —
 * and software H.264 costs roughly linearly in pixels per second. Silently
 * doubling the pixel count silently doubles the CPU taken from whatever is
 * being shared, which is usually a game the person is also trying to play.
 *
 * Pure, and exported, so the cap is a testable contract rather than an object
 * literal three call frames inside a picker.
 */
/**
 * Would this cap actually reduce what is being captured?
 *
 * WHY IT HAS TO BE ASKED. These constraints are CEILINGS. Applying a ceiling
 * at or above the current capture succeeds and changes nothing — so a "lower
 * the quality" button would report success, spend its one-per-share offer, and
 * leave the machine exactly as overloaded as it was. It came up immediately:
 * "Source" on a 1080p monitor captures 1920x1080, and the step down from
 * Source was 1440p, whose ceiling is 2560x1440.
 *
 * Asked BEFORE applying rather than by diffing `getSettings()` afterwards,
 * because the engine need not have updated them by the time `applyConstraints`
 * resolves — a diff would report false failures.
 */
export function capWouldReduce(
    now: { width?: number; height?: number; frameRate?: number },
    width: number,
    height: number,
    fps: number,
): boolean {
    return (now.width ?? 0) > width
        || (now.height ?? 0) > height
        || Math.round(now.frameRate ?? 0) > fps;
}

export function shareVideoConstraints(width: number, height: number, fps: number) {
    return {
        width: { max: width },
        height: { max: height },
        frameRate: { max: fps },
    };
}

/** What a live capture produces after a re-size, read back from the track. */
export interface LiveCapture { width: number; height: number; fps: number }

/**
 * Re-size a LIVE display capture in place, up or down, and report what it
 * then produces.
 *
 * `applyConstraints` retunes the existing track: no new track, no SDP
 * renegotiation, so the share does not end and nobody watching is dropped.
 * Measured 2026-09-28 in Edge 154 (the WebView2 engine) on a real capture
 * with a loopback sender: 640x360@15 -> 1280x720@30 -> 854x480@10, the track
 * stayed live, and the encoder followed every step.
 *
 * The constraints are ceilings, but what a ceiling ABOVE the source does
 * depends on the surface. A window or screen stays at its own size (the
 * premise of the dialog's "Source" option). A browser TAB is re-rendered at
 * the asked size instead: measured, a 1920x1080 tab capped at 3840x2160
 * reports 3840x2160. So what comes back is read from the track, never echoed
 * from the request, and the caller shows the person the real size. Null when
 * the engine refused.
 */
export async function recapDisplayTrack(
    track: MediaStreamTrack,
    width: number,
    height: number,
    fps: number,
): Promise<LiveCapture | null> {
    try {
        await track.applyConstraints(shareVideoConstraints(width, height, fps) as MediaTrackConstraints);
    } catch (e) {
        console.warn('[WebRTC] Live share re-size refused:', e);
        return null;
    }
    const s = track.getSettings();
    return {
        width: s.width ?? 0,
        height: s.height ?? 0,
        fps: Math.round(s.frameRate ?? 0),
    };
}
