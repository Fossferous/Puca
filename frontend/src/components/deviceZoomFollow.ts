/**
 * Zoom-follows-monitor: the math that decides when a zoomed-in All-Displays
 * view should switch the capture to the single screen under it, and how to
 * remap the view across the switch so nothing visually jumps.
 *
 * WHY. The All-Displays composite is capped at 3840x2160 and integer-stepped
 * down to fit (crates/puca-agent/src/composite.rs) — three 1080p screens
 * arrive with each monitor at 960x540, so zooming in magnifies quarter-res
 * pixels. The agent can already swap the capture under the live encoder with
 * no renegotiation, so the seamless fix is to FOLLOW the zoom: cross the
 * threshold over one screen and the capture becomes that screen at native
 * resolution; zoom back out and the composite returns, no reselection.
 *
 * PURE on purpose: the trigger matrix (thresholds, containment, hysteresis)
 * and both remaps are testable without a video element or a session. The
 * component feeds it measured geometry and applies the returned transforms.
 *
 * HYSTERESIS is level-based and cannot flap: switching IN needs the scale AT
 * OR ABOVE `ZOOM_FOLLOW_IN` with the viewport mostly inside one screen;
 * switching OUT happens only at full zoom-out (scale ~1) of an auto-followed
 * screen, and the returning composite view is capped at
 * `ZOOM_FOLLOW_RETURN_MAX` — just BELOW the in-threshold, so arriving back
 * on the composite can never immediately re-trigger the switch.
 */

export const ZOOM_FOLLOW_IN = 2;
/** The composite view a zoom-out returns to. Below ZOOM_FOLLOW_IN by design. */
export const ZOOM_FOLLOW_RETURN_MAX = 1.9;
/** How much of the viewport must lie within one screen's region to follow
 *  it. Below this the user is deliberately straddling screens — switching
 *  would cut off what they are looking at. */
export const ZOOM_FOLLOW_CONTAINMENT = 0.85;
/** Treat "zoomed fully out" with a little slack: pinch gestures rarely land
 *  on exactly 1.0. */
export const ZOOM_FOLLOW_OUT_AT = 1.02;
/** The LOWEST scale an in-switch may land on. Strictly ABOVE the out
 *  threshold, and load-bearing: physical continuity often computes a landing
 *  scale of exactly 1 (a viewport that just fits one screen), and a landing
 *  inside the out-window would bounce the user straight back to the
 *  composite — the guaranteed flap the first review caught across the whole
 *  natural trigger band. The cost is a slight extra zoom-in at the switch;
 *  the alternative was the feature undoing itself. */
export const ZOOM_FOLLOW_LANDING_MIN = 1.15;
/** How much FURTHER a user must zoom in, after deliberately choosing the
 *  composite while already zoomed, before that choice stops holding the follow
 *  off. Above pinch jitter, below a deliberate zoom step. */
export const ZOOM_FOLLOW_REARM_RATIO = 1.15;

/**
 * Does a manual "All displays" choice still suppress zoom-follow?
 *
 * Picking the composite on purpose while zoomed in has to STICK, or the level
 * check re-follows a screen ~300ms later and the choice appears to be ignored.
 * That is what `heldAtScale` records.
 *
 * But a hold that only ends on zoom-OUT is a one-way latch, and it produced the
 * exact bug this guards: the composite is sampled down past 3840x2160, so
 * holding it at high zoom looks blurry — and the natural response to a blurry
 * picture is to zoom IN, which under a zoom-out-only release could never clear
 * the hold. The picture then stayed soft for the rest of the session, with the
 * one escape (zoom all the way out, then back in) being the thing nobody tries.
 *
 * So a hold ends on EITHER kind of fresh intent:
 *  - zooming back below the in-threshold — crossing it again is a new gesture;
 *  - zooming meaningfully FURTHER in than the choice was made at, which is an
 *    unambiguous request for more detail, and detail is precisely what
 *    following to the monitor's native resolution provides.
 */
export function manualCompositeHoldActive(heldAtScale: number, scale: number): boolean {
    if (scale < ZOOM_FOLLOW_IN) return false;
    if (scale > heldAtScale * ZOOM_FOLLOW_REARM_RATIO) return false;
    return true;
}

export interface MonitorGeom {
    id: number;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
}

export interface Region { id: number; x: number; y: number; w: number; h: number }
export interface Box { w: number; h: number }
export interface Transform { scale: number; x: number; y: number }
/** object-fit: contain letterbox of a video inside its element. */
export interface Picture { offX: number; offY: number; dispW: number; dispH: number }
/** Everything the maps need to know about one side of a switch. */
export interface View { pict: Picture; videoW: number; videoH: number }

/**
 * Which screen a fresh session should ask the host for once the picture is
 * flowing — or null to leave the host's choice alone.
 *
 * ALL_DISPLAYS (255) when the host has more than one screen, is not already
 * showing the composite, and is a host that can capture it. A host from 0.8.104
 * on starts a multi-monitor machine on the composite itself and announces
 * `active: 255`, so against it this is always null; an older host starts on
 * output 0 and this is the one request that brings it into line — what tapping
 * "All" sends, a moment after the first frame instead of never.
 *
 * "Can capture it" is read from the announcement: the agent measures a
 * desktop-space rect for EVERY screen (its own composite needs them), the
 * webview host reports none — and the webview host's `setMonitor` rejects,
 * which would put "could not switch screens" on the viewer's screen at connect
 * for nothing. Geometry on every entry, or no request. The caller waits for
 * the first frame because the agent only has a stream to switch once it has
 * answered the offer; a request that arrives before that is refused the same
 * way.
 */
export function initialMonitorRequest(monitors: MonitorGeom[], active: number | null): number | null {
    // session.ts's ALL_DISPLAYS, NOT imported: this module is pure and must
    // stay importable without dragging the session (and its crypto) into
    // every test. The two are pinned equal by deviceZoomFollow.test.ts.
    const ALL_DISPLAYS = 255;
    if (monitors.length < 2) return null;
    if (active === ALL_DISPLAYS) return null;
    const measured = monitors.every(m =>
        typeof m.left === 'number' && typeof m.top === 'number'
        && typeof m.width === 'number' && typeof m.height === 'number'
        && m.width > 0 && m.height > 0);
    return measured ? ALL_DISPLAYS : null;
}

/**
 * The captured surface's size in DESKTOP pixels — what the agent's caret
 * fractions are OF. The whole desktop's bounding box on the All-Displays
 * composite (the agent's surface is that box, whatever integer step it was
 * sampled down by), the one screen's size otherwise; null when the host has
 * not said (no geometry, no active screen, or a screen it never announced).
 * The auto-keyboard turns its "same line / same field" tolerances into pixels
 * with this, so a third of a text box stays a third of a text box on a
 * three-screen composite rather than becoming a whole monitor.
 */
export function captureSurfaceSize(monitors: MonitorGeom[], active: number | null): { w: number; h: number } | null {
    const ALL_DISPLAYS = 255;  // session.ts's sentinel; see initialMonitorRequest
    if (active === null || monitors.length === 0) return null;
    const measured = monitors.filter(m =>
        typeof m.left === 'number' && typeof m.top === 'number'
        && typeof m.width === 'number' && typeof m.height === 'number'
        && m.width > 0 && m.height > 0) as Required<MonitorGeom>[];
    if (active === ALL_DISPLAYS) {
        if (measured.length !== monitors.length) return null;
        const minL = Math.min(...measured.map(m => m.left));
        const minT = Math.min(...measured.map(m => m.top));
        const w = Math.max(...measured.map(m => m.left + m.width)) - minL;
        const h = Math.max(...measured.map(m => m.top + m.height)) - minT;
        return w > 0 && h > 0 ? { w, h } : null;
    }
    const m = measured.find(x => x.id === active);
    return m ? { w: m.width, h: m.height } : null;
}

/**
 * Each monitor's rectangle in COMPOSITE-VIDEO pixels, or null when the
 * layout is unusable (any rect missing, fewer than two screens, or no video
 * dimensions yet). Scaling from desktop space to video space tolerates the
 * composite's rounding: hit-testing a viewport does not care about a pixel.
 */
export function monitorRegions(monitors: MonitorGeom[], videoW: number, videoH: number): Region[] | null {
    if (videoW <= 0 || videoH <= 0 || monitors.length < 2) return null;
    if (monitors.some(m =>
        typeof m.left !== 'number' || typeof m.top !== 'number'
        || typeof m.width !== 'number' || typeof m.height !== 'number'
        || m.width <= 0 || m.height <= 0)) {
        return null;
    }
    const rects = monitors as Required<MonitorGeom>[];
    const minL = Math.min(...rects.map(m => m.left));
    const minT = Math.min(...rects.map(m => m.top));
    const unionW = Math.max(...rects.map(m => m.left + m.width)) - minL;
    const unionH = Math.max(...rects.map(m => m.top + m.height)) - minT;
    if (unionW <= 0 || unionH <= 0) return null;
    const sx = videoW / unionW;
    const sy = videoH / unionH;
    return rects.map(m => ({
        id: m.id,
        x: (m.left - minL) * sx,
        y: (m.top - minT) * sy,
        w: m.width * sx,
        h: m.height * sy,
    }));
}

// --- ZOOM TO THE TEXT CARET WHILE TYPING (mobile) ------------------------
//
// A phone shows a whole 1920x1080 desktop in a 390px-wide strip, and the soft
// keyboard covers the bottom 40-55% of it: the remote caret is 3-4 CSS px tall
// and routinely behind the keyboard, so "type and watch nothing happen" is the
// normal case. The agent reports where the caret is as FRACTIONS of the surface
// it is capturing (the one representation a monitor or resolution switch cannot
// make stale) and the solver below turns that into a transform that puts the
// caret's LINE at a readable size inside the band of picture that is actually
// visible — between the extra-keys bar at the top and the keyboard at the
// bottom.
//
// Pure, for the same reason as everything above it: every decision here is
// hand-checkable arithmetic, and DeviceStage is never mounted in a test.

/** How tall the caret's LINE should read on screen, in CSS px. 22px makes the
 *  text beside it comfortably legible at arm's length and is half a 44px touch
 *  target — the size the rest of this UI is built around. */
export const CARET_TARGET_LINE_PX = 22;
/** Below this fraction of the target, re-zoom. Above it, PAN only: re-zooming
 *  on every keystroke is nausea, and a line at 60% of target is still readable. */
export const CARET_MIN_READABLE_RATIO = 0.6;
/** Where a re-solve PARKS the caret in the band: 35% across, because text runs
 *  left to right and the two thirds ahead of the caret are what the user is
 *  about to fill; 55% down, so the line above stays visible and there is room
 *  below for the wrap. */
export const CARET_PLACE_X = 0.35;
export const CARET_PLACE_Y = 0.55;
/** The STILL ZONE. While the caret stays inside this inset of the band the view
 *  does not move at all — a camera that re-centres on every character is
 *  unusable. Must strictly contain (CARET_PLACE_X, CARET_PLACE_Y) or every
 *  solve immediately re-solves: a pan loop at report rate. */
export const CARET_DEADZONE_X = 0.18;
export const CARET_DEADZONE_Y = 0.18;
/** How much of the band may be BLANK below the picture, as a fraction of the
 *  band. This is the "space below the text at the bottom edge" ask: with the
 *  normal clamp a caret on the remote screen's bottom row can only reach the
 *  band's bottom edge, i.e. flush against the keyboard. Must exceed
 *  1 - CARET_PLACE_Y or the bottom row could never reach its target. BOUNDED
 *  rather than absent: an unbounded pan is precisely the 2026-08-11 black-bars
 *  report the picture clamp above exists to prevent. */
export const CARET_BOTTOM_SLACK = 0.5;
/** Below this the keyboard has eaten the picture and zooming is theatre. ~4
 *  lines of CARET_TARGET_LINE_PX. */
export const CARET_MIN_STRIP_PX = 96;
/** A caret reported with zero height (UIA sometimes gives a degenerate rect),
 *  and the whole line height assumed for the pointer fallback, in REMOTE px. */
export const CARET_FALLBACK_LINE_PX = 20;
/** A "band" taller than this fraction of the surface is not a keyboard. A
 *  floating or split Gboard is an overlay window and reports a ZERO-height IME
 *  inset, so the ladder's assumed tier would invent a keyboard that is not
 *  there — and zooming for it is worse than doing nothing. */
export const CARET_NO_KEYBOARD_STRIP_RATIO = 0.85;

/**
 * The visible band of the surface, in SURFACE px, or null when there is nothing
 * worth aiming at.
 *
 * The keyboard overlay is `position: fixed; top: 0`, so the extra-keys bar eats
 * the surface from the TOP (by however much of it overlaps — on a phone the
 * surface starts at the screen origin, on a desktop-shaped layout it does not)
 * and the soft keyboard eats it from the bottom. Both edges are MEASURED: the
 * bar is ~190px unfolded rather than the ~33px its stylesheet's comments claim,
 * and it changes when the user folds it.
 */
export function caretBandFrom(
    rect: { top: number; bottom: number; height: number } | null,
    keyBarH: number,
    imeTopCss: number | null,
): { top: number; bottom: number } | null {
    if (!rect || !(rect.height > 0)) return null;
    if (!(keyBarH > 0)) return null;                  // the bar has not measured itself yet
    if (imeTopCss === null) return null;              // nothing has measured the keyboard
    const top = Math.min(rect.height, Math.max(0, keyBarH - rect.top));
    const bottom = rect.height - Math.max(0, rect.bottom - imeTopCss);
    if (!(bottom > top)) return null;
    if (bottom - top > rect.height * CARET_NO_KEYBOARD_STRIP_RATIO) return null;
    return { top, bottom };
}

/** A screen-space point (in the surface box) expressed in VIDEO pixels. */
function screenToVideo(px: number, py: number, view: View, t: Transform): { x: number; y: number } {
    const cx = (px - t.x) / t.scale;
    const cy = (py - t.y) / t.scale;
    return {
        x: (cx - view.pict.offX) * (view.videoW / view.pict.dispW),
        y: (cy - view.pict.offY) * (view.videoH / view.pict.dispH),
    };
}

/** The on-screen viewport expressed in VIDEO pixels: which part of the frame
 *  the user is actually looking at, given the current pan/zoom. */
export function viewportInVideo(box: Box, view: View, t: Transform): Region {
    const tl = screenToVideo(0, 0, view, t);
    const br = screenToVideo(box.w, box.h, view, t);
    return { id: -1, x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
}

/** The screen the viewport is committed to: highest overlap, and only when
 *  that overlap covers at least ZOOM_FOLLOW_CONTAINMENT of the viewport. */
export function pickFollowTarget(viewport: Region, regions: Region[]): number | null {
    const area = viewport.w * viewport.h;
    if (!(area > 0)) return null;
    let best: { id: number; frac: number } | null = null;
    for (const r of regions) {
        const ox = Math.max(0, Math.min(viewport.x + viewport.w, r.x + r.w) - Math.max(viewport.x, r.x));
        const oy = Math.max(0, Math.min(viewport.y + viewport.h, r.y + r.h) - Math.max(viewport.y, r.y));
        const frac = (ox * oy) / area;
        if (!best || frac > best.frac) best = { id: r.id, frac };
    }
    return best && best.frac >= ZOOM_FOLLOW_CONTAINMENT ? best.id : null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Place fraction (fx, fy) of the frame at the surface centre. */
function centreOn(box: Box, view: View, scale: number, fx: number, fy: number): Transform {
    const cx = view.pict.offX + fx * view.pict.dispW;
    const cy = view.pict.offY + fy * view.pict.dispH;
    return clampPanTo(box, view.pict, scale, box.w / 2 - scale * cx, box.h / 2 - scale * cy);
}

/**
 * One axis, clamped into a WINDOW of the surface rather than the whole surface,
 * with a relaxable far bound.
 *
 * `near`/`far` bound the visible band in surface px. `slackFar` is how far
 * inside the window the picture's far edge may come — blank space past the
 * content, which the whole-surface clamp forbids outright.
 *
 * With near=0, far=viewport, slackFar=0 this is byte-for-byte the old
 * clampPanAxis, which is why that function now delegates here and why the
 * equivalence has a test of its own (deviceZoomFollow.test.ts) — that test is
 * what protects remapIntoMonitor/remapIntoComposite from this refactor.
 *
 * UNDERFILL IS JUDGED WITHOUT THE SLACK. The slack exists to let a picture that
 * OVERFILLS the band sit low in it; letting it also invent pan room inside a
 * band the picture cannot fill would stop an underfilled picture being centred,
 * and the centring is the whole reason the two regimes meet continuously at
 * scale 1.
 */
function clampPanAxisWindow(
    near: number, far: number, off: number, disp: number,
    scale: number, v: number, slackFar: number,
): number {
    const hi = near - scale * off;                       // picture's near edge on the window's near edge
    const tight = far - scale * (off + disp);            // far edge on the window's far edge, no slack
    if (tight > hi) return near + (far - near - scale * disp) / 2 - scale * off; // underfills → centred IN THE WINDOW
    return Math.max(far - slackFar - scale * (off + disp), Math.min(hi, v));
}

/**
 * One axis of the pan clamp, against the PICTURE, not the canvas.
 *
 * `off`/`disp` are the picture's letterbox offset and drawn size in canvas
 * (pre-transform) pixels; `viewport` is the surface size; `v` the proposed
 * pan. When the scaled picture overfills the viewport its edges may not come
 * inside (no black past the content edge); when it underfills, it sits
 * centred — there is nowhere legal to pan it, and centring is what scale 1
 * already looks like, so the two regimes meet continuously.
 */
function clampPanAxis(viewport: number, off: number, disp: number, scale: number, v: number): number {
    return clampPanAxisWindow(0, viewport, off, disp, scale, v, 0);
}

/** The visible band of an axis, in surface px, and how much blank may show
 *  past the picture's far edge inside it. */
export interface Band {
    /** Top of the visible band. */
    top: number;
    /** Bottom of the visible band. */
    bottom: number;
    /** How much blank may show BELOW the picture inside the band, in px. */
    slack: number;
}

/**
 * THE pan clamp — DeviceStage imports this rather than keeping its own copy
 * (the old duplicate drifted from this one is exactly how the pan limits
 * would diverge between pinch and zoom-follow).
 *
 * The old bounds used the CANVAS box, which carries the letterbox bars with
 * it: on a portrait phone controlling a landscape desktop the picture is a
 * short strip in a tall canvas, and canvas bounds let the strip leave the
 * viewport entirely — a zoomed pan could show nothing but bar (the
 * 2026-08-11 "black bars" field report). `pict` null (no frame yet — video
 * dimensions unknown) falls back to those canvas bounds.
 */
export function clampPanTo(box: Box, pict: Picture | null, scale: number, x: number, y: number): Transform {
    if (!pict) {
        const minX = box.w * (1 - scale);
        const minY = box.h * (1 - scale);
        return { scale, x: Math.max(minX, Math.min(0, x)), y: Math.max(minY, Math.min(0, y)) };
    }
    return {
        scale,
        x: clampPanAxis(box.w, pict.offX, pict.dispW, scale, x),
        y: clampPanAxis(box.h, pict.offY, pict.dispH, scale, y),
    };
}

/**
 * The pan clamp for a view whose visible region is a BAND of the surface —
 * between a top-anchored key bar and a soft keyboard.
 *
 * A SIBLING rather than a flag on clampPanTo, deliberately. clampPanTo has four
 * callers (DeviceStage.clampPan, centreOn, and through it remapIntoMonitor and
 * remapIntoComposite) and one of its pinned invariants — "the letterbox bar can
 * never fill the viewport", the 2026-08-11 black-bars report — is what the
 * relaxed bottom bound here deliberately bends. An optional parameter that
 * flips a documented safety invariant is a footgun aimed at whoever adds the
 * fifth caller.
 *
 * x is clamped exactly as always (the band spans the full width). y is clamped
 * against the band: no blank ABOVE the picture (the near bound is unchanged in
 * kind, only moved down to band.top), and up to `slack` of blank BELOW it, so a
 * caret on the remote screen's last row is not pinned against the keyboard. An
 * axis the scaled picture underfills is centred in the BAND, not the box.
 */
export function clampPanToStrip(
    box: Box, pict: Picture | null, scale: number, x: number, y: number, band: Band,
): Transform {
    // No picture means no letterbox to reason about, and the canvas fallback
    // knows nothing of bands. Better the old bounds than invented ones.
    if (!pict) return clampPanTo(box, null, scale, x, y);
    return {
        scale,
        x: clampPanAxis(box.w, pict.offX, pict.dispW, scale, x),
        y: clampPanAxisWindow(band.top, band.bottom, pict.offY, pict.dispH, scale, y, band.slack),
    };
}

/** Where the remote caret is, as fractions of the CURRENTLY CAPTURED surface.
 *  `src` is which tier of the agent's sampler answered; 'field' means the
 *  focused element's whole box rather than a caret, which is placed
 *  differently. */
export interface CaretRect { x: number; y: number; w: number; h: number; src?: string | null }

export interface CaretFollowInput {
    /** The surface, CSS px. */
    box: Box;
    /** The visible band of the surface: below the key bar, above the keyboard. */
    strip: { top: number; bottom: number };
    /** Measured PRE-transform (offsetWidth/offsetHeight), like every other
     *  consumer of Picture in this module. */
    view: View;
    current: Transform;
    caret: CaretRect;
    /** Solve from scratch: the keyboard just opened, the band changed, or the
     *  captured surface changed. Overrides the dead zone AND the
     *  already-readable check. */
    force: boolean;
    /** The user has pinched or two-finger-panned since the keyboard opened.
     *  THEIR VIEW IS THEIRS from then on: the camera never changes the scale
     *  again this activation, and it only pans — and only when the caret has
     *  actually left the visible band. Without this the camera re-zoomed on
     *  the very next keystroke after a pinch-out, which on a phone read as
     *  "zooming out does not go back to All Displays" (zoom-follow's return
     *  needs 180ms of stillness that a 10Hz camera never allowed) and "I cannot
     *  slide to the other monitor" (the pan was undone by the next re-place). */
    userDrove?: boolean;
    minZoom: number;
    maxZoom: number;
}

/**
 * The transform that puts the remote caret in the readable band, or null for
 * "leave the view exactly as it is" — the same null-means-nothing-to-do idiom as
 * pickFollowTarget/monitorRegions, so the caller can skip the setState
 * entirely.
 *
 * NEVER ZOOMS OUT. Someone who pinched to 20x to read 8pt code keeps 20x; the
 * only automatic zoom is IN, to make the caret's line readable, and only when
 * it is not readable already (or the caller forced a fresh solve).
 */
export function caretFollowTransform(input: CaretFollowInput): Transform | null {
    const { box, strip, view, current, caret, force, minZoom, maxZoom } = input;
    const userDrove = input.userDrove === true;
    const stripH = strip.bottom - strip.top;
    // `!(a >= b)` rather than `a < b` so a NaN band (an unmeasured surface)
    // falls out here instead of propagating into the transform.
    if (!(stripH >= CARET_MIN_STRIP_PX)) return null;
    if (!(box.w > 0) || !(view.pict.dispW > 0) || !(view.pict.dispH > 0)) return null;
    if (!(view.videoH > 0)) return null;
    // Repeated even though session.ts already range-checked the wire frame: this
    // is also fed the LOCAL pointer fallback, which is built here, not parsed.
    for (const n of [caret.x, caret.y, caret.w, caret.h]) {
        if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    }
    if (caret.x < 0 || caret.x > 1 || caret.y < 0 || caret.y > 1) return null;
    if (caret.w < 0 || caret.h < 0) return null;

    // 'field' is the focused element's BOX — a 400px-tall textarea, not a line.
    // Zooming to make the box 22px tall would zoom OUT of readability, so the
    // line height is the fallback and the aim point is the box's top third:
    // wherever the real caret is inside it, it is much likelier to be near the
    // top than at the centre of a tall box.
    const isField = caret.src === 'field';
    const hFrac = !isField && caret.h > 0 ? caret.h : CARET_FALLBACK_LINE_PX / view.videoH;
    const lineAt1 = hFrac * view.pict.dispH;
    if (!(lineAt1 > 0)) return null;
    const cyFrac = isField ? caret.y + caret.h / 3 : caret.y + hFrac / 2;

    // The caret's centre in canvas (pre-transform) px.
    const cxc = view.pict.offX + (caret.x + caret.w / 2) * view.pict.dispW;
    const cyc = view.pict.offY + cyFrac * view.pict.dispH;

    if (userDrove) {
        // THE USER HAS THE WHEEL. Scale is theirs — even a 1x they chose to
        // see every screen at once, unreadable caret and all — and `force`
        // (a band or surface change) does not take it back either. The camera
        // is reduced to the one thing that cannot be argued with: if the caret
        // has left the visible band entirely (typed off the bottom under the
        // keyboard, or the user panned away and then typed), pan it back into
        // place at THEIR scale.
        const scale = Math.min(maxZoom, Math.max(minZoom, current.scale));
        const sx = current.x + scale * cxc;
        const sy = current.y + scale * cyc;
        const half = scale * lineAt1 / 2;
        const halfW = scale * (caret.w * view.pict.dispW) / 2;
        const visibleX = sx + halfW >= 0 && sx - halfW <= box.w;
        const visibleY = sy - half >= strip.top && sy + half <= strip.bottom;
        if (visibleX && visibleY) return null;
        const next = clampPanToStrip(
            box, view.pict, scale,
            box.w * CARET_PLACE_X - scale * cxc,
            strip.top + stripH * CARET_PLACE_Y - scale * cyc,
            { top: strip.top, bottom: strip.bottom, slack: stripH * CARET_BOTTOM_SLACK },
        );
        if (next.scale === current.scale && next.x === current.x && next.y === current.y) return null;
        return next;
    }

    const readableNow = lineAt1 * current.scale >= CARET_TARGET_LINE_PX * CARET_MIN_READABLE_RATIO;
    const need = CARET_TARGET_LINE_PX / lineAt1;
    const scale = force || !readableNow
        ? Math.min(maxZoom, Math.max(minZoom, current.scale, need))
        : Math.max(minZoom, current.scale);

    const next = clampPanToStrip(
        box, view.pict, scale,
        box.w * CARET_PLACE_X - scale * cxc,
        strip.top + stripH * CARET_PLACE_Y - scale * cyc,
        { top: strip.top, bottom: strip.bottom, slack: stripH * CARET_BOTTOM_SLACK },
    );

    if (!force && scale === current.scale) {
        const sx = current.x + current.scale * cxc;
        const sy = current.y + current.scale * cyc;
        // The caret's FULL extent, so a line entering the bottom margin
        // triggers before any of it is clipped by the keyboard.
        const half = current.scale * lineAt1 / 2;
        const inX = sx >= box.w * CARET_DEADZONE_X && sx <= box.w * (1 - CARET_DEADZONE_X);
        const inY = sy - half >= strip.top + stripH * CARET_DEADZONE_Y
            && sy + half <= strip.bottom - stripH * CARET_DEADZONE_Y;
        // CLAMP-AWARE. An axis the clamp has PINNED counts as satisfied even
        // when the caret sits outside its zone: a caret on the remote screen's
        // top rows can never reach the y target because there is no blank
        // above the picture, so its "out of zone" is permanent — and judging
        // it by position alone made every keystroke re-solve, dragging x back
        // to CARET_PLACE_X each time. That was a view that scrolled 9px on
        // every character typed into a browser's URL bar. If a re-solve would
        // not move an axis, that axis is as still as it can be.
        const stillX = inX || next.x === current.x;
        const stillY = inY || next.y === current.y;
        if (stillX && stillY) return null;
    }

    if (next.scale === current.scale && next.x === current.x && next.y === current.y) return null;
    return next;
}

/**
 * The transform for the SINGLE-monitor view that keeps what the user was
 * looking at in place: same centre point, same physical magnification (a
 * native pixel occupies the screen area its composite pixels did), clamped
 * to the zoom floor/ceiling and the pan bounds.
 */
export function remapIntoMonitor(opts: {
    box: Box;
    from: View;             // composite, measured BEFORE the switch
    fromTransform: Transform;
    region: Region;         // the followed screen, in composite-video px
    to: View;               // single monitor, measured AFTER the switch
    maxZoom: number;
}): Transform {
    const { box, from, fromTransform, region, to, maxZoom } = opts;
    // Physical continuity, derived on the x-axis (both axes share it — the
    // composite preserves aspect per monitor): screen px per native px
    // before = scale * (dispW/videoW) * (region.w/nativeW); after
    // = scale2 * (dispW2/nativeW). Equate and solve for scale2.
    const raw = fromTransform.scale * (from.pict.dispW / from.videoW) * region.w / to.pict.dispW;
    const scale = Math.max(ZOOM_FOLLOW_LANDING_MIN, Math.min(maxZoom, raw));

    const centre = screenToVideo(box.w / 2, box.h / 2, from, fromTransform);
    const fx = clamp01((centre.x - region.x) / region.w);
    const fy = clamp01((centre.y - region.y) / region.h);
    return centreOn(box, to, scale, fx, fy);
}

/**
 * The transform for the COMPOSITE view after zooming back out of a followed
 * screen: that screen roughly fills the viewport (so the outward pinch
 * continues visually from where it was), centred on the point the user was
 * looking at, capped under the in-threshold so the return cannot re-trigger.
 */
export function remapIntoComposite(opts: {
    box: Box;
    from: View;             // single monitor, measured BEFORE the switch
    fromTransform: Transform;
    region: Region;         // that screen's region, in composite-video px
    to: View;               // composite, measured AFTER the switch
}): Transform {
    const { box, from, fromTransform, region, to } = opts;
    const centre = screenToVideo(box.w / 2, box.h / 2, from, fromTransform);
    const fx = clamp01(centre.x / from.videoW);
    const fy = clamp01(centre.y / from.videoH);

    // Fit the region to the box: its displayed size at scale 1, then the
    // scale that makes it fill — capped under the in-threshold, floored at 1.
    const dispRegionW = region.w * (to.pict.dispW / to.videoW);
    const dispRegionH = region.h * (to.pict.dispH / to.videoH);
    const fit = Math.min(box.w / dispRegionW, box.h / dispRegionH);
    const scale = Math.max(1, Math.min(ZOOM_FOLLOW_RETURN_MAX, fit));

    const fxc = clamp01((region.x + fx * region.w) / to.videoW);
    const fyc = clamp01((region.y + fy * region.h) / to.videoH);
    return centreOn(box, to, scale, fxc, fyc);
}
