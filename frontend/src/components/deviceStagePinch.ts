/**
 * ONE FINGER'S MOVE IN A TWO-FINGER PINCH OR PAN on the remote-control stage.
 *
 * A touch screen reports both fingers together, one touch event per frame,
 * but the browser hands that event to the page as one `pointermove` PER
 * FINGER, one after the other. The stage turns each into a step of the
 * gesture as it arrives, so between the first finger's move and the second's
 * it sees a spread the hand never made: two fingers 60 px apart sliding 25 px
 * along the line between them read as a pinch to 35 px and straight back out.
 * Left like that, the zoom limits and the pan clamp acted on that half-step.
 * Zooming out about the fingers pulls the picture's edge inside the screen,
 * the clamp pushed it back, and zooming back in then carried it past the
 * screen's edge again, so the step ended short of it: a two-finger pan into
 * an edge stopped (R - 1) x (the fingers' distance from that edge) short, R
 * being the half-step's spread ratio. Which way round that happens depends on
 * which finger the browser hands over first. In Chromium that is a fixed
 * order, so a pan toward one pair of edges never got there at all (80 to
 * 210 px short of the right and bottom ones in the device-stage walk), and on
 * a busy machine the order sometimes flips, so the other pair missed too.
 * The hop arrows are offered only at an edge, so they did not come up.
 *
 * So every finger's move of ONE touch event composes with the earlier ones
 * of that event before any limit or clamp applies, and what the stage shows
 * after the last of them is the whole event's step, limited and clamped
 * once. The browser gives each of those pointermoves the touch event's
 * timeStamp, and a finger moves at most once in an event. Between events
 * everything is clamped as before, so a pan pushed past an edge and back
 * moves back at once.
 *
 * Pure, as a state updater must be: React may run one twice (StrictMode) or
 * again over a different base (a render it threw away). What an earlier move
 * of the same event composed is found from the view it returned, the `shown`
 * the next one is handed: a view any other writer produced (the zoom-follow
 * landing, a wheel, the caret camera) has none, so the step starts from that
 * view as it stands.
 *
 * The picture viewer (ImageLightbox) has the same two-finger gesture over the
 * same kind of view and steps it here too, with its own limits and clamp: it
 * stopped 140 to 236 px short of an edge at x2.5 on a phone in Edge, and a
 * sideways slide just above x1 hit the zoom floor half way and came back out
 * at x1.7. Nothing in this file is the stage's own.
 */

export interface StageView { scale: number; x: number; y: number }

export interface FingerMove {
    /** PointerEvent.timeStamp: shared by every finger one touch event moves. */
    at: number;
    /** PointerEvent.pointerId of the finger that moved. */
    finger: number;
    /** The pinch's two fingers before and after this move: their distance
     *  apart and their midpoint, in surface px (the view's own coordinates). */
    prevDist: number;
    dist: number;
    prevCenter: { x: number; y: number };
    center: { x: number; y: number };
}

export interface PinchLimits {
    minZoom: number;
    maxZoom: number;
    /** The stage's pan clamp at a scale; null when it cannot clamp (no
     *  surface measured yet). */
    clampPan: (scale: number, x: number, y: number) => { x: number; y: number } | null;
}

/** What each view a step returned was composed as, before the limits and the
 *  clamp: the touch event, the fingers it has moved so far and the view. */
const composedAs = new WeakMap<StageView, { at: number; fingers: readonly number[]; raw: StageView }>();

/** The view after `move`, given the view on the stage now. */
export function pinchStep(shown: StageView, move: FingerMove, limits: PinchLimits): StageView {
    const earlier = composedAs.get(shown);
    const sameEvent = !!earlier && earlier.at === move.at && !earlier.fingers.includes(move.finger);
    const base = sameEvent ? earlier!.raw : shown;
    const k = move.dist / (move.prevDist > 0 ? move.prevDist : 1);
    // The fingers' midpoint keeps the picture point it held.
    const raw: StageView = {
        scale: base.scale * k,
        x: move.center.x - (move.prevCenter.x - base.x) * k,
        y: move.center.y - (move.prevCenter.y - base.y) * k,
    };
    // Shown: the zoom limits, about the fingers' midpoint, then the pan clamp.
    const scale = Math.max(limits.minZoom, Math.min(limits.maxZoom, raw.scale));
    const r = scale / raw.scale;
    let x = move.center.x - (move.center.x - raw.x) * r;
    let y = move.center.y - (move.center.y - raw.y) * r;
    if (scale === 1) {
        x = 0;
        y = 0;
    } else {
        const c = limits.clampPan(scale, x, y);
        if (c) { x = c.x; y = c.y; }
    }
    const out: StageView = { scale, x, y };
    composedAs.set(out, { at: move.at, fingers: [...(sameEvent ? earlier!.fingers : []), move.finger], raw });
    return out;
}
