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

/** The fields of one outbound-rtp sample this module cares about. Deliberately
 *  a plain shape rather than `RTCOutboundRtpStreamStats` so both transports —
 *  and a test — can produce one. */
export interface EncodeSample {
    /** `qualityLimitationReason`: 'none' | 'cpu' | 'bandwidth' | 'other'. */
    limit?: string;
    /** `encoderImplementation`, e.g. 'OpenH264' (software) or a MediaFoundation
     *  name (hardware). Recorded for the report, not used in the verdict. */
    encoder?: string;
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
 */
export function createShareLoadWatch() {
    let samples: EncodeSample[] = [];
    let offered = false;
    return {
        /** Feed one reading (null = nothing to read this tick). True = offer now. */
        add(s: EncodeSample | null): boolean {
            if (s) samples.push(s);
            // Bounded: only the last window is ever consulted, and a three-hour
            // share would otherwise accumulate thousands of readings on a
            // machine that is by definition already short of memory and CPU.
            if (samples.length > CPU_WINDOW * 2) samples = samples.slice(-CPU_WINDOW);
            if (offered || !cpuStarved(samples)) return false;
            offered = true;
            return true;
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
 * first one pulled, for the same reason the publish sets
 * `degradationPreference: 'maintain-framerate'`: a choppy game stream is worse
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
