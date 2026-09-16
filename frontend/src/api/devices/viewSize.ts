/**
 * The controller's stage, as the host needs to hear it.
 *
 * WHY THIS EXISTS. The agent encoded the monitor at its native size and the
 * viewer decoded every pixel to show a fraction of them: the owner's phone,
 * held sideways, decoded a 1440x2560 portrait monitor — 15.8 ms a frame,
 * half the 33 ms budget at 30 fps — to display it at 607x1080. Nothing in the
 * device protocol carried a size: the controller could ask for frames per
 * second and bits per second, never for fewer pixels. Now it reports the
 * stage it is showing the picture on, in its own device pixels, and the host
 * steps the picture down to what that can show (`composite::fit_step` in the
 * agent — integer steps, the same box average the all-displays view uses).
 *
 * Pure so the arithmetic is testable without a stage: what is sent is the
 * CSS box times the device pixel ratio times the pinch zoom, because a zoomed
 * viewer is looking at fewer source pixels per screen pixel and should get
 * them back sharp.
 */

export type FitResolution = 'fit' | 'full';

export const FIT_RESOLUTION_KEY = 'device-stage-fit-resolution';

/** FIT by default: the whole point is that the default settings were the slow
 *  ones. "Full" exists for the reader who zooms constantly and would rather
 *  pay the decode than see the step change under a pinch. */
export function readFitResolutionPreference(): FitResolution {
    try {
        const saved = localStorage.getItem(FIT_RESOLUTION_KEY);
        if (saved === 'full') return 'full';
        if (saved === 'fit') return 'fit';
    } catch {
        // Private mode, or storage disabled. Fall through to the default.
    }
    return 'fit';
}

/** Below this the stage is mid-layout — a collapsed element, a sheet in
 *  transition — not a size anyone is looking at, and a stage of a few pixels
 *  must not be reported as the picture's target. */
export const MIN_STAGE_CSS_PX = 64;

/** Mirrors `MAX_VIEW_EDGE` in crates/puca-agent/src/protocol.rs: the agent
 *  refuses anything larger, so nothing larger is ever sent. */
export const MAX_VIEW_EDGE = 16384;

export interface ViewSize {
    w: number;
    h: number;
}

/**
 * What to send for this stage, or null when nothing should be sent yet.
 *
 * `'full'` sends 0x0, which is the wire's "native" — the same thing an older
 * app sends by sending nothing.
 */
export function viewSizeFor(
    box: { w: number; h: number } | null,
    dpr: number,
    zoom: number,
    mode: FitResolution,
): ViewSize | null {
    if (mode === 'full') return { w: 0, h: 0 };
    if (!box) return null;
    if (!(box.w >= MIN_STAGE_CSS_PX) || !(box.h >= MIN_STAGE_CSS_PX)) return null;
    // A ratio is 1..3 on real hardware; a runaway value must not become a
    // runaway request. A zoom under 1 does not exist on the stage (it clamps
    // at fitted) and is read as fitted here too.
    const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 4) : 1;
    const scale = Number.isFinite(zoom) && zoom > 1 ? Math.min(zoom, 8) : 1;
    return {
        w: Math.min(MAX_VIEW_EDGE, Math.round(box.w * ratio * scale)),
        h: Math.min(MAX_VIEW_EDGE, Math.round(box.h * ratio * scale)),
    };
}

/** A dimension the HOST will accept off the wire: a non-negative integer no
 *  larger than the agent's bound. Validated on the host because the value
 *  arrives from the peer. */
export function isViewDim(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_VIEW_EDGE;
}
