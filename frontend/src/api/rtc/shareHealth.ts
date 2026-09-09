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
 * It matters more here than in most apps because the share is encoded in
 * SOFTWARE on every machine this project has logs from (`encoder=OpenH264`).
 * The encode is competing with the game for the same cores. The resolution and
 * frame rate are the only controls the person has over how much it takes, and
 * before this nothing told them the controls were the answer.
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
 * `add` returns true EXACTLY ONCE per share — the moment the window first says
 * the encoder is starved. Repeating the offer every three seconds for the rest
 * of a two-hour call would be the same information delivered as harassment,
 * and somebody who has already declined it has answered.
 */
export function createShareLoadWatch() {
    const samples: EncodeSample[] = [];
    let offered = false;
    return {
        /** Feed one reading (null = nothing to read this tick). True = offer now. */
        add(s: EncodeSample | null): boolean {
            if (s) samples.push(s);
            if (offered || !cpuStarved(samples)) return false;
            offered = true;
            return true;
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
 *  walks. This is now the single source: ScreenShareModal derives its option
 *  list from it, and the capture size comes from `shareDimensions` below. */
export const RES_STEPS = ['source', '1440', '1080', '720'] as const;
/** The frame rates the dialog offers, fastest first. */
export const FPS_STEPS = [60, 30, 15] as const;

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
    currentFps: number,
): ShareQuality | null {
    for (const resolution of RES_STEPS) {          // largest first
        const d = shareDimensions(resolution);
        if (d.width < capture.width || d.height < capture.height) return { resolution, fps: currentFps };
    }
    // Already at or below the smallest picture offered; spend the frame rate.
    const slower = FPS_STEPS.find(f => f < currentFps);
    return slower === undefined ? null : { resolution: RES_STEPS[RES_STEPS.length - 1], fps: slower };
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
        ? stepDownFromCapture(capture, current.fps)
        : nextStepDown(current);
    if (!to) {
        // Nothing left to give up. Saying "your CPU cannot keep up" and
        // offering no action would be a notification whose only content is
        // bad news, so this stays quiet and the diagnostics carry the detail.
        return null;
    }
    return { text: `Your screen share is being limited by CPU. Drop to ${qualityLabel(to)}?`, to };
}
