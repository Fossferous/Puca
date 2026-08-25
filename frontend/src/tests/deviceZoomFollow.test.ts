/**
 * Zoom-follows-monitor math. The worked example throughout: two 1920x1080
 * screens side by side, composite video 3840x1080 (step 1 — small enough to
 * hand-check every number), in a 960x270 surface (same 32:9 aspect, so the
 * composite letterboxes to the full box and video px = 4x screen px).
 */
import { describe, it, expect } from 'vitest';
import {
    ZOOM_FOLLOW_CONTAINMENT, ZOOM_FOLLOW_IN, ZOOM_FOLLOW_LANDING_MIN,
    ZOOM_FOLLOW_OUT_AT, ZOOM_FOLLOW_RETURN_MAX, ZOOM_FOLLOW_REARM_RATIO,
    captureSurfaceSize, clampPanTo, clampPanToStrip, initialMonitorRequest, manualCompositeHoldActive,
    monitorRegions, pickFollowTarget, remapIntoComposite,
    remapIntoMonitor, viewportInVideo, type Region, type View,
} from '../components/deviceZoomFollow';
import { ALL_DISPLAYS } from '../api/devices/session';

const MONITORS = [
    { id: 0, left: 0, top: 0, width: 1920, height: 1080 },
    { id: 1, left: 1920, top: 0, width: 1920, height: 1080 },
];
const BOX = { w: 960, h: 270 };
const COMPOSITE: View = {
    pict: { offX: 0, offY: 0, dispW: 960, dispH: 270 },
    videoW: 3840, videoH: 1080,
};
/** One 16:9 screen in the 32:9 box: pillarboxed to 480x270, centred. */
const SINGLE: View = {
    pict: { offX: 240, offY: 0, dispW: 480, dispH: 270 },
    videoW: 1920, videoH: 1080,
};
/** Zoomed 4x onto the RIGHT screen's centre (video px 2880, 540). */
const ZOOMED_RIGHT = { scale: 4, x: -2400, y: -405 };

describe('monitorRegions', () => {
    it('maps desktop rects into composite-video pixels', () => {
        expect(monitorRegions(MONITORS, 3840, 1080)).toEqual([
            { id: 0, x: 0, y: 0, w: 1920, h: 1080 },
            { id: 1, x: 1920, y: 0, w: 1920, h: 1080 },
        ]);
    });
    it('handles a stepped-down composite and a negative desktop origin', () => {
        const shifted = [
            { id: 0, left: -1920, top: 0, width: 1920, height: 1080 },
            { id: 2, left: 0, top: 0, width: 1920, height: 1080 },
        ];
        // Composite stepped to half size.
        expect(monitorRegions(shifted, 1920, 540)).toEqual([
            { id: 0, x: 0, y: 0, w: 960, h: 540 },
            { id: 2, x: 960, y: 0, w: 960, h: 540 },
        ]);
    });
    it('is null without full geometry, without two screens, or without video dims', () => {
        expect(monitorRegions([{ id: 0, left: 0, top: 0, width: 1920, height: 1080 }, { id: 1 }], 3840, 1080)).toBeNull();
        expect(monitorRegions([MONITORS[0]], 3840, 1080)).toBeNull();
        expect(monitorRegions(MONITORS, 0, 0)).toBeNull();
    });
});

describe('viewport and targeting', () => {
    it('at scale 1 the viewport is the whole frame', () => {
        expect(viewportInVideo(BOX, COMPOSITE, { scale: 1, x: 0, y: 0 }))
            .toEqual({ id: -1, x: 0, y: 0, w: 3840, h: 1080 });
    });
    it('zoomed onto one screen, that screen is the target', () => {
        const vp = viewportInVideo(BOX, COMPOSITE, ZOOMED_RIGHT);
        expect(vp).toEqual({ id: -1, x: 2400, y: 405, w: 960, h: 270 });
        const regions = monitorRegions(MONITORS, 3840, 1080) as Region[];
        expect(pickFollowTarget(vp, regions)).toBe(1);
    });
    it('straddling two screens targets NEITHER', () => {
        // Centered on the seam: half the viewport on each screen.
        const seam = { scale: 4, x: 960 / 2 - 4 * (1920 / 4), y: -405 };
        const vp = viewportInVideo(BOX, COMPOSITE, seam);
        const regions = monitorRegions(MONITORS, 3840, 1080) as Region[];
        expect(pickFollowTarget(vp, regions)).toBeNull();
    });
    it('the containment bar is a real fraction, not a majority vote', () => {
        expect(ZOOM_FOLLOW_CONTAINMENT).toBeGreaterThan(0.5);
    });
});

describe('remapIntoMonitor — the switch must not visually jump', () => {
    it('keeps physical magnification and the centre point', () => {
        const regions = monitorRegions(MONITORS, 3840, 1080) as Region[];
        const next = remapIntoMonitor({
            box: BOX, from: COMPOSITE, fromTransform: ZOOMED_RIGHT,
            region: regions[1], to: SINGLE, maxZoom: 40,
        });
        // Hand-derived: same screen-px-per-native-px means scale 4; the
        // screen's centre (native 960,540 -> content 480,135) stays under
        // the surface centre.
        expect(next.scale).toBeCloseTo(4, 5);
        expect(next.x).toBeCloseTo(-1440, 5);
        expect(next.y).toBeCloseTo(-405, 5);
    });
    it('the landing floor sits ABOVE the out-threshold — the anti-flap invariant', () => {
        // Physical continuity often computes a landing of exactly 1 (a
        // viewport that just fits one screen). A floor inside the out-window
        // meant the in-switch bounced straight back to the composite — the
        // guaranteed flap the review proved across the natural trigger band.
        expect(ZOOM_FOLLOW_LANDING_MIN).toBeGreaterThan(ZOOM_FOLLOW_OUT_AT);
        expect(ZOOM_FOLLOW_RETURN_MAX).toBeLessThan(ZOOM_FOLLOW_IN);
    });

    it('the review\'s bounce case: three screens, stepped composite, 3x pinch', () => {
        // Three 1920x1080 side by side: union 5760x1080 -> step 2 ->
        // composite video 2880x540, in a 1600x900 stage (dispW 1600,
        // dispH 300, offY 300). 3x centred on the MIDDLE screen makes the
        // viewport exactly that screen's region: continuity computes a
        // landing of exactly 1.0, which used to land inside the out-window.
        const three = [
            { id: 0, left: 0, top: 0, width: 1920, height: 1080 },
            { id: 1, left: 1920, top: 0, width: 1920, height: 1080 },
            { id: 2, left: 3840, top: 0, width: 1920, height: 1080 },
        ];
        const compositeStepped: View = {
            pict: { offX: 0, offY: 300, dispW: 1600, dispH: 300 },
            videoW: 2880, videoH: 540,
        };
        const singleInStage: View = {
            pict: { offX: 0, offY: 0, dispW: 1600, dispH: 900 },
            videoW: 1920, videoH: 1080,
        };
        const box = { w: 1600, h: 900 };
        const t = { scale: 3, x: -1600, y: -900 }; // centred on video (1440, 270)
        const regions = monitorRegions(three, 2880, 540) as Region[];
        expect(pickFollowTarget(viewportInVideo(box, compositeStepped, t), regions)).toBe(1);
        const next = remapIntoMonitor({
            box, from: compositeStepped, fromTransform: t,
            region: regions[1], to: singleInStage, maxZoom: 40,
        });
        expect(
            next.scale,
            'the landing must clear the out-threshold or the switch undoes itself',
        ).toBeGreaterThan(ZOOM_FOLLOW_OUT_AT);
        expect(next.scale).toBe(ZOOM_FOLLOW_LANDING_MIN);
    });

    it('clamps into [landing floor, maxZoom]', () => {
        const regions = monitorRegions(MONITORS, 3840, 1080) as Region[];
        const next = remapIntoMonitor({
            box: BOX, from: COMPOSITE,
            fromTransform: { scale: 2, x: -1200, y: -202.5 },
            region: regions[1], to: SINGLE, maxZoom: 40,
        });
        expect(next.scale).toBeGreaterThanOrEqual(ZOOM_FOLLOW_LANDING_MIN);
        expect(next.scale).toBeLessThanOrEqual(40);
    });
});

describe('remapIntoComposite — the way back', () => {
    it('returns to the grid centred on the screen it left, capped under the in-threshold', () => {
        const regions = monitorRegions(MONITORS, 3840, 1080) as Region[];
        const next = remapIntoComposite({
            box: BOX, from: SINGLE, fromTransform: { scale: 4, x: -1440, y: -405 },
            region: regions[1], to: COMPOSITE,
        });
        // In THIS aspect the half-width region already fills the box height
        // at scale 1, so the fit lands on the whole grid.
        expect(next.scale).toBeLessThanOrEqual(ZOOM_FOLLOW_RETURN_MAX);
        expect(next).toEqual({ scale: 1, x: 0, y: 0 });
    });
    it('a tall box fits the region wider than 1 but never over the cap', () => {
        const tallBox = { w: 480, h: 540 };
        const compositeTall: View = {
            // 3840x1080 in a 480x540 box: dispW 480, dispH 135, offY 202.5.
            pict: { offX: 0, offY: 202.5, dispW: 480, dispH: 135 },
            videoW: 3840, videoH: 1080,
        };
        const singleTall: View = {
            // 1920x1080 in 480x540: dispW 480, dispH 270, offY 135.
            pict: { offX: 0, offY: 135, dispW: 480, dispH: 270 },
            videoW: 1920, videoH: 1080,
        };
        const regions = monitorRegions(MONITORS, 3840, 1080) as Region[];
        const next = remapIntoComposite({
            box: tallBox, from: singleTall, fromTransform: { scale: 1, x: 0, y: 0 },
            region: regions[1], to: compositeTall,
        });
        // Fit would be 2 (the region is half the displayed width); the cap
        // keeps the return below the in-threshold so it cannot re-trigger.
        expect(next.scale).toBe(ZOOM_FOLLOW_RETURN_MAX);
    });
});

describe('clampPanTo — pan bounds come from the picture, not the canvas', () => {
    // The 2026-08-11 field repro: a portrait phone (390x844 surface)
    // controlling a landscape 1920x1080 desktop. The picture contains-fits to
    // a 390x219.375 band, letterboxed 312.3125px top and bottom.
    const box = { w: 390, h: 844 };
    const dispH = 390 * 1080 / 1920;          // 219.375
    const offY = (844 - dispH) / 2;           // 312.3125
    const pict = { offX: 0, offY, dispW: 390, dispH };

    it('at scale 1 everything centres to the origin', () => {
        const c = clampPanTo(box, pict, 1, -500, 300);
        expect(c.x).toBeCloseTo(0, 5);
        expect(c.y).toBeCloseTo(0, 5);
    });

    it('an overfilled axis pins the picture edges to the viewport edges', () => {
        const s = 8; // dispH*8 = 1755 > 844 — the picture overfills vertically
        const lo = box.h - s * (offY + dispH);
        const hi = -s * offY;
        expect(clampPanTo(box, pict, s, 0, hi + 1000).y).toBeCloseTo(hi, 5);
        expect(clampPanTo(box, pict, s, 0, lo - 1000).y).toBeCloseTo(lo, 5);
    });

    it('an underfilled axis is centred — there is nowhere legal to pan it', () => {
        const s = 2; // dispH*2 ≈ 439 < 844 — still shorter than the viewport
        const centred = (box.h - s * dispH) / 2 - s * offY;
        expect(clampPanTo(box, pict, s, 0, -10000).y).toBeCloseTo(centred, 5);
        expect(clampPanTo(box, pict, s, 0, 10000).y).toBeCloseTo(centred, 5);
    });

    it('the letterbox bar can never fill the viewport (the 0811 black-bars report)', () => {
        // The OLD canvas-box clamp allowed y = box.h*(1-s) here, which parked
        // the whole picture band ABOVE the viewport — the user saw only bar.
        // At any pan the clamp now allows, the picture must span the viewport
        // on every axis it overfills.
        const s = 4; // dispH*4 = 877.5 > 844, dispW*4 = 1560 > 390
        const worst = clampPanTo(box, pict, s, box.w * (1 - s), box.h * (1 - s));
        expect(worst.y + s * offY).toBeLessThanOrEqual(1e-6);                    // top edge at/above 0
        expect(worst.y + s * (offY + dispH)).toBeGreaterThanOrEqual(box.h - 1e-6); // bottom at/below box.h
        expect(worst.x).toBeLessThanOrEqual(1e-6);
        expect(worst.x + s * pict.dispW).toBeGreaterThanOrEqual(box.w - 1e-6);
    });

    it('falls back to canvas bounds before the first frame', () => {
        expect(clampPanTo(box, null, 2, -10000, 5)).toEqual({ scale: 2, x: -390, y: 0 });
    });
});

// The 0813 field report: "monitor resolution no longer matches zoom in on all
// monitors when controlling device — it is currently blurry when zoomed in, and
// this was fixed a while ago."
//
// Root cause was a one-way latch. Choosing "All displays" by hand while zoomed
// in set a hold that suppressed zoom-follow, and the ONLY release was zooming
// back below the in-threshold. Since the composite is sampled down past
// 3840x2160, that held view is blurry — and the natural answer to a blurry
// picture is to zoom IN, which could never clear the hold. The picture stayed
// soft for the rest of the session.
describe('manualCompositeHoldActive — a manual "All displays" pick must not latch forever', () => {
    // POSITIVE CONTROL. Every release assertion below is worthless unless the
    // hold can be shown to HOLD: a function returning false unconditionally
    // would satisfy all of them.
    it('holds right after the pick, so the follow cannot undo the choice 300ms later', () => {
        expect(manualCompositeHoldActive(3, 3)).toBe(true);
    });

    it('still holds through pinch jitter around the chosen scale', () => {
        expect(manualCompositeHoldActive(3, 3.05)).toBe(true);
        expect(manualCompositeHoldActive(3, 2.8)).toBe(true);
    });

    it('RELEASES when the user zooms meaningfully FURTHER in — the regression', () => {
        // This is the case that was broken: more zoom is an unambiguous request
        // for more detail, and detail is what following to the native-resolution
        // monitor delivers.
        expect(manualCompositeHoldActive(3, 3 * ZOOM_FOLLOW_REARM_RATIO + 0.01)).toBe(false);
        expect(manualCompositeHoldActive(2, 4)).toBe(false);
    });

    it('releases when the user zooms back out below the in-threshold', () => {
        expect(manualCompositeHoldActive(3, ZOOM_FOLLOW_IN - 0.01)).toBe(false);
    });

    it('a pick made at the in-threshold still leaves room to zoom in and release', () => {
        // Guards against a re-arm ratio so wide that the reachable zoom range
        // above a low pick can never cross it.
        expect(manualCompositeHoldActive(ZOOM_FOLLOW_IN, ZOOM_FOLLOW_IN)).toBe(true);
        expect(manualCompositeHoldActive(ZOOM_FOLLOW_IN, ZOOM_FOLLOW_IN * 1.5)).toBe(false);
    });
});

// THE CONTROL FOR THE clampPanAxis REFACTOR.
//
// The caret follow needs a clamp against a BAND of the surface with a relaxed
// far bound, so clampPanAxis was rewritten to delegate to a windowed helper.
// clampPanTo is shared by the pinch, the wheel, centreOn, remapIntoMonitor and
// remapIntoComposite, and the whole suite above pins its behaviour — but only
// through clampPanTo. This block pins the EQUIVALENCE directly: over the whole
// box with zero slack, the windowed clamp must be the old one, in every regime
// the suite above names. It goes red the instant the helper stops reproducing
// the old bounds.
describe('clampPanToStrip degenerates to clampPanTo over the whole box', () => {
    const box = { w: 390, h: 844 };
    const dispH = 390 * 1080 / 1920;
    const offY = (844 - dispH) / 2;
    const pict = { offX: 0, offY, dispW: 390, dispH };
    const whole = { top: 0, bottom: box.h, slack: 0 };

    const cases: Array<[string, number, number, number]> = [
        ['scale 1 (both axes underfill or exactly fit)', 1, -500, 300],
        ['overfilled, pinned at the near end', 8, 0, 10_000],
        ['overfilled, pinned at the far end', 8, 0, -10_000],
        ['underfilled vertically', 2, 0, -10_000],
        ['the black-bars worst case', 4, box.w * (1 - 4), box.h * (1 - 4)],
    ];
    for (const [name, scale, x, y] of cases) {
        it(name, () => {
            expect(clampPanToStrip(box, pict, scale, x, y, whole))
                .toEqual(clampPanTo(box, pict, scale, x, y));
        });
    }

    it('and falls through to the canvas bounds with no picture, exactly as before', () => {
        expect(clampPanToStrip(box, null, 2, -10_000, 5, whole))
            .toEqual(clampPanTo(box, null, 2, -10_000, 5));
    });

    it('POSITIVE CONTROL: a real band and real slack do NOT agree with it', () => {
        // Without this, an implementation that ignored `band` entirely would pass
        // every assertion above.
        const band = { top: 200, bottom: 500, slack: 150 };
        expect(clampPanToStrip(box, pict, 4, 0, -10_000, band))
            .not.toEqual(clampPanTo(box, pict, 4, 0, -10_000));
    });
});

// EVERY SCREEN BY DEFAULT — the viewer's half. Which hosts get asked, and
// which are left alone. The caller (DeviceStage) additionally waits for the
// first frame and for `session.unattended`; this pins the pure part.
describe('initialMonitorRequest', () => {
    const measured = [
        { id: 0, left: 0, top: 0, width: 1920, height: 1080 },
        { id: 1, left: 1920, top: 0, width: 1920, height: 1080 },
    ];

    it("pins 255 to the session module's ALL_DISPLAYS — this module keeps its own copy to stay pure", () => {
        // The pure module must not import the session (and its crypto), so
        // it spells the sentinel itself. If the two ever disagree this is the
        // test that says so.
        expect(initialMonitorRequest(measured, 0)).toBe(ALL_DISPLAYS);
        expect(ALL_DISPLAYS).toBe(255);
    });

    it('asks an agent host on a single screen for the composite', () => {
        expect(initialMonitorRequest(measured, 0)).toBe(255);
        expect(initialMonitorRequest(measured, 1)).toBe(255);
    });

    it('leaves a host already on the composite alone (a 0.8.104+ host starts there)', () => {
        expect(initialMonitorRequest(measured, 255)).toBeNull();
    });

    it('never asks a one-screen machine', () => {
        expect(initialMonitorRequest([measured[0]], 0)).toBeNull();
        expect(initialMonitorRequest([], null)).toBeNull();
    });

    it('never asks a webview host — no geometry, and its setMonitor rejects', () => {
        const bare = [{ id: 0 }, { id: 1 }];
        expect(initialMonitorRequest(bare, 0)).toBeNull();
        // Geometry on SOME screens is not enough: the composite needs all.
        expect(initialMonitorRequest([measured[0], { id: 1 }], 0)).toBeNull();
        // A degenerate rect is no geometry either.
        expect(initialMonitorRequest([measured[0], { ...measured[1], width: 0 }], 0)).toBeNull();
    });
});

// The captured surface in desktop pixels — what a caret fraction is OF — for
// the auto-keyboard's pixel tolerances.
describe('captureSurfaceSize', () => {
    const two = [
        { id: 0, left: 0, top: 0, width: 1920, height: 1080 },
        { id: 1, left: 1920, top: -200, width: 2560, height: 1440 },
    ];
    it('is the bounding box of every screen on the composite', () => {
        // left 0..4480, top -200..1240 → 4480 x 1440.
        expect(captureSurfaceSize(two, 255)).toEqual({ w: 4480, h: 1440 });
    });
    it("is the one screen's size on a single screen", () => {
        expect(captureSurfaceSize(two, 1)).toEqual({ w: 2560, h: 1440 });
        expect(captureSurfaceSize(two, 0)).toEqual({ w: 1920, h: 1080 });
    });
    it('is unknown without geometry, without an active screen, or for a screen never announced', () => {
        expect(captureSurfaceSize([{ id: 0 }, { id: 1 }], 255)).toBeNull();
        expect(captureSurfaceSize([{ id: 0 }, { id: 1 }], 0)).toBeNull();
        expect(captureSurfaceSize([two[0], { id: 1 }], 255), 'partial geometry is no geometry for the composite').toBeNull();
        expect(captureSurfaceSize(two, null)).toBeNull();
        expect(captureSurfaceSize(two, 7)).toBeNull();
        expect(captureSurfaceSize([], 0)).toBeNull();
    });
});
