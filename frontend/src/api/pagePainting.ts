/**
 * Is this page ACTUALLY on screen right now?
 *
 * WHY NOT `document.visibilityState`. Every watchdog in the device-session
 * layer defers when it reads `'hidden'`, and that deferral is correct: a
 * suspended timer fires on thaw with its whole interval "elapsed" in an
 * instant, and treating that as evidence against the remote machine tore down
 * sessions that were about to resume. But the flag is a claim, and on Android
 * it is a claim that can get stuck: after a long screen-lock a WebView has
 * been observed reporting `'hidden'` while the user is looking straight at it.
 * Every watchdog then defers forever — a remote session sat on "Waiting for
 * the device's screen…" indefinitely and never produced the honest error it
 * has, because the 30s clock re-armed on every expiry.
 *
 * `requestAnimationFrame` cannot get stuck the same way. It is driven by the
 * compositor: callbacks run per frame while the page is being painted and stop
 * when it is not. So "has a frame callback run in the last moment" is a
 * MEASUREMENT of visibility rather than a flag about it, and it answers the
 * question the watchdogs actually care about — were my timers running, or was
 * I frozen.
 *
 * Used to CORROBORATE, never to override on its own: a watchdog treats the app
 * as hidden only when the flag says hidden AND no frames are arriving. That
 * ordering is deliberate — it can only ever make a watchdog fire in the case
 * where the flag is demonstrably lying, and never suppresses a deferral that
 * would have happened before.
 */

/** When a frame callback last ran. 0 until the loop starts. */
let lastFrameAt = 0;
let running = false;

/**
 * How stale a frame may be before we stop believing the page is painting.
 *
 * A visible page paints at the display's cadence (16ms at 60Hz, less on a
 * 120Hz panel). Even a heavily janked frame lands far inside this. The margin
 * is wide because the cost of being wrong is asymmetric: too tight and we call
 * a busy-but-visible page hidden, which restores today's forever-deferral;
 * too loose only delays noticing a genuine background by a second.
 */
const FRESH_FRAME_MS = 2_000;

/**
 * A gap this long between frames means the page was not being painted — the
 * app was backgrounded, the screen was off, or the WebView was suspended.
 * Comfortably longer than any single janked frame or GC pause.
 */
const RESUME_GAP_MS = 5_000;

const resumeListeners = new Set<() => void>();

/**
 * How often to ask for a frame.
 *
 * SAMPLED rather than a continuous rAF chain, deliberately. A self-rescheduling
 * rAF loop asks for a frame every frame, which forces a composite on an idle
 * window that would otherwise not paint at all — a real, if small, power cost
 * on a laptop, paid forever, to answer a question that changes on a human
 * timescale. One frame a second is the same signal for a sixtieth of the work.
 */
const SAMPLE_MS = 1_000;

function sample(): void {
    if (!running) return;
    requestAnimationFrame(() => {
        const now = Date.now();
        // Frames have STARTED AGAIN after a gap: the app is back on screen.
        // This is the resume signal that does not depend on
        // `visibilitychange` firing — when that event is missed (or the flag
        // is stuck), this is the only thing that still notices, and it is what
        // gets a socket that died silently during a long lock reconnected
        // without the user force-quitting the app.
        if (lastFrameAt !== 0 && now - lastFrameAt > RESUME_GAP_MS) {
            for (const l of [...resumeListeners]) {
                try {
                    l();
                } catch {
                    // One bad subscriber must not stop the others healing.
                }
            }
        }
        lastFrameAt = now;
    });
}

/** Run `fn` when painting resumes after a gap. Returns an unsubscribe. */
export function onPaintResumed(fn: () => void): () => void {
    resumeListeners.add(fn);
    return () => { resumeListeners.delete(fn); };
}

/** Begin measuring. Idempotent; safe to call before the DOM exists. */
export function installPaintProbe(): void {
    if (running) return;
    if (typeof requestAnimationFrame !== 'function') return;
    running = true;
    // The rAF inside `sample` is what proves painting; the interval only paces
    // the asking. Both stop when the page does, which is the point: a
    // suspended app leaves `lastFrameAt` stale and reads as backgrounded.
    setInterval(sample, SAMPLE_MS);
    sample();
}

/**
 * True when frames are arriving, i.e. the page really is on screen.
 *
 * False on a platform with no rAF at all (jsdom, SSR), which keeps every
 * caller on its previous behaviour rather than inventing a visibility signal
 * where none exists.
 */
export function pageIsPainting(): boolean {
    if (!running || lastFrameAt === 0) return false;
    return Date.now() - lastFrameAt < FRESH_FRAME_MS;
}

/**
 * The question the watchdogs ask: may I treat this app as backgrounded?
 *
 * Hidden requires BOTH the flag and the absence of frames. When the flag says
 * hidden but frames are still arriving, the flag is wrong and the honest
 * answer is "no, the user is looking at this" — which is what lets a stalled
 * session report itself instead of deferring for ever.
 */
export function appIsBackgrounded(): boolean {
    if (typeof document === 'undefined') return false;
    if (document.visibilityState !== 'hidden') return false;
    return !pageIsPainting();
}

/** Test seam. */
export function __setPaintProbeForTests(state: { running: boolean; lastFrameAt: number }): void {
    running = state.running;
    lastFrameAt = state.lastFrameAt;
}
