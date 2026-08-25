/**
 * Detect a stage whose video element looks healthy but has stopped producing
 * frames, and ask for recovery.
 *
 * The one state the resume nudge (deviceStageResume.ts) cannot see: the
 * element is playing, the track is live and unmuted, RTP is arriving — and
 * nothing decodes, because the decoder lost its reference state while Android
 * had the process frozen and every arriving frame is a delta against a
 * picture it no longer has. With the agent's infinite GOP that is permanent
 * unless someone asks for an IDR.
 *
 * FALSE-POSITIVE BOUND, load-bearing: a still remote desktop legitimately
 * produces ZERO frames (the agent's pump returns NoChange), so "no frames"
 * alone is NOT a stall. The watchdog is therefore dormant except inside a
 * short window opened by a foreground return — the only moment decoder state
 * loss can have just happened — and capped per window. A redundant IDR costs
 * one I-frame; an IDR loop at an idle desktop would cost bandwidth forever.
 *
 * The frame clock is requestVideoFrameCallback where it exists, falling back
 * to polling getVideoPlaybackQuality; with neither (jsdom, odd WebViews) the
 * watchdog simply never fires — the resume-triggered request in DeviceStage
 * is the primary mechanism and must not depend on this file.
 *
 * NEVER rebinds srcObject — see deviceStageResume.ts for why that paints an
 * idle desktop black forever.
 */

type FrameClockVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
    getVideoPlaybackQuality?: () => { totalVideoFrames: number };
};

/** No frames for this long, inside an open window, while visibly playing = stall. */
export const STALL_MS = 2_500;
/** How long after a foreground return the watchdog stays armed. */
export const RESUME_WINDOW_MS = 8_000;
/** Recovery attempts per window; requestKeyframe's own budget spaces them. */
const MAX_FIRINGS_PER_WINDOW = 3;

export interface StallWatchdog {
    /** Arm the watchdog: a foreground return (or reattach) just happened. */
    openWindow(): void;
    uninstall(): void;
}

export function installStallWatchdog(
    getVideo: () => HTMLVideoElement | null,
    onStall: () => boolean | void,
    clock?: { now?: () => number; intervalMs?: number },
): StallWatchdog {
    const now = clock?.now ?? (() => performance.now());
    let lastFrameAt = now();
    let windowUntil = 0;
    let firings = 0;
    let disposed = false;
    let bound: FrameClockVideo | null = null;
    let rvfcHandle = 0;
    let fallbackFrames = -1;

    const onFrame = () => {
        lastFrameAt = now();
        scheduleRvfc();
    };
    const scheduleRvfc = () => {
        if (disposed || !bound?.requestVideoFrameCallback) return;
        rvfcHandle = bound.requestVideoFrameCallback(onFrame);
    };
    /** Track the CURRENT element/stream; a rebind resets the frame clock so a
     *  fresh stream is never instantly "stalled". */
    const bind = (v: HTMLVideoElement | null) => {
        if (bound === v) return;
        bound?.cancelVideoFrameCallback?.(rvfcHandle);
        bound = v as FrameClockVideo | null;
        lastFrameAt = now();
        fallbackFrames = -1;
        scheduleRvfc();
    };

    const tick = setInterval(() => {
        const v = getVideo() as FrameClockVideo | null;
        bind(v);
        if (!v || !v.srcObject) return;
        // Fallback frame clock where rVFC is missing.
        if (!v.requestVideoFrameCallback) {
            const q = v.getVideoPlaybackQuality?.();
            if (!q) return; // no frame clock at all: never fire
            if (q.totalVideoFrames !== fallbackFrames) {
                fallbackFrames = q.totalVideoFrames;
                lastFrameAt = now();
            }
        }
        const t = now();
        if (t > windowUntil || firings >= MAX_FIRINGS_PER_WINDOW) return; // dormant
        if (document.visibilityState !== 'visible') return;
        if (v.paused || v.readyState < 2) return;
        const track = (v.srcObject as MediaStream).getVideoTracks?.()[0];
        // A muted track means no RTP is arriving — that is a transport
        // condition (or a legitimately still desktop, where the agent sends
        // nothing), not decoder state loss, and an IDR fixes neither.
        if (!track || track.readyState !== 'live' || track.muted) return;
        if (t - lastFrameAt > STALL_MS) {
            // Only a recovery attempt that actually WENT OUT spends the cap.
            // onStall returns false when requestKeyframe's shared budget (or
            // a downed transport) suppressed the send — counting those burned
            // all three firings on two silent ticks and left no retry for
            // the rest of the window. `void` returns still count, so a
            // callback that reports nothing keeps the old bound.
            if (onStall() !== false) firings += 1;
        }
    }, clock?.intervalMs ?? 1_000);

    return {
        openWindow() {
            windowUntil = now() + RESUME_WINDOW_MS;
            firings = 0;
            // A window open is a fresh start for the clock: the time spent
            // backgrounded must not count as "already stalled".
            lastFrameAt = now();
        },
        uninstall() {
            disposed = true;
            clearInterval(tick);
            bind(null);
        },
    };
}
