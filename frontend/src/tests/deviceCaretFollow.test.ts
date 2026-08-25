/**
 * ZOOM TO THE REMOTE TEXT CARET WHILE TYPING — the numbers.
 *
 * The whole feature is one pure function, so every claim about it is arithmetic
 * that can be checked by hand. Every number below was derived from the fixture
 * with a calculator, never from the function's own output.
 *
 * The fixture is deliberately the 2026-08-11 black-bars geometry: a 390x844
 * phone in portrait showing a 1920x1080 desktop, which contain-fits to a
 * 390x219.375 band letterboxed 312.3125px top and bottom. The band of picture
 * that is actually visible while typing runs from the extra-keys bar (200) to
 * the top of the soft keyboard (500).
 *
 * REVERT-TO-RED, checked while writing these:
 *  - CARET_BOTTOM_SLACK -> 0 turns the bottom-edge test red (y becomes -1282.75
 *    and the caret lands at 833, i.e. 333px under the keyboard: the exact bug
 *    this feature exists to fix).
 *  - CARET_DEADZONE_X/Y -> 0 turns the "still while typing" test red at its
 *    LAST assertion (the 21st advance no longer re-solves, because with no
 *    inset the caret is still "in zone" at 82% of the width); the early
 *    advances stay null either way, so it is the re-place that proves the
 *    zone has an edge.
 *  - judging the still-zone by caret POSITION alone (dropping the "an axis the
 *    clamp has pinned counts as still" rule) turns the top-edge test red: a
 *    caret on the remote screen's first rows can never reach its y target, so
 *    without that rule every keystroke re-solved and dragged x back to
 *    CARET_PLACE_X.
 *  - dropping `current.scale` from the forced branch of the scale solve turns
 *    "not even on a forced solve" red.
 *  - judging underfill WITH the slack (so the relaxed bound invents pan room in
 *    a band the picture cannot fill) turns the band-centring test red.
 *
 * Every "returns null" assertion has a positive-control sibling: a function that
 * returned null unconditionally would otherwise pass most of this file.
 */
import { describe, it, expect } from 'vitest';
import {
    CARET_BOTTOM_SLACK, CARET_DEADZONE_X, CARET_DEADZONE_Y, CARET_MIN_READABLE_RATIO,
    CARET_MIN_STRIP_PX, CARET_NO_KEYBOARD_STRIP_RATIO, CARET_PLACE_X, CARET_PLACE_Y,
    CARET_TARGET_LINE_PX,
    caretBandFrom, caretFollowTransform, clampPanTo, type Transform, type View,
} from '../components/deviceZoomFollow';

const BOX = { w: 390, h: 844 };
/** 390 * 1080/1920 = 219.375, letterboxed (844 - 219.375)/2 = 312.3125. */
const DISP_H = 219.375;
const OFF_Y = 312.3125;
const VIEW: View = {
    pict: { offX: 0, offY: OFF_Y, dispW: 390, dispH: DISP_H },
    videoW: 1920, videoH: 1080,
};
/** Between the key bar and the keyboard: 300px tall, so 150px of slack. */
const STRIP = { top: 200, bottom: 500 };
/** A 2x27px caret in the middle of a 1920x1080 screen. */
const CARET = { x: 0.5, y: 0.5, w: 2 / 1920, h: 27 / 1080 };

/** hFrac 0.025 -> the caret's line is 5.484375 CSS px tall at scale 1. */
const LINE_AT_1 = 5.484375;
/** Caret centre in canvas (pre-transform) px: (0.5 + 1/1920)*390, and
 *  312.3125 + 0.5125*219.375. */
const CXC = 195.203125;
const CYC = 424.7421875;
/** The placement targets: 390*0.35 and 200 + 300*0.55. */
const PX = 136.5;
const PY = 365;
/** 22 / 5.484375 = 1408/351. */
const NEED = 4.011396011396012;

function solve(over: Partial<Parameters<typeof caretFollowTransform>[0]> = {}): Transform | null {
    return caretFollowTransform({
        box: BOX, strip: STRIP, view: VIEW,
        current: { scale: 1, x: 0, y: 0 },
        caret: CARET, force: true,
        minZoom: 1, maxZoom: 40,
        ...over,
    });
}

describe('first placement', () => {
    it('zooms until the caret line reads 22px and parks it 35% across, 55% down the band', () => {
        const t = solve();
        expect(t).not.toBeNull();
        expect(t!.scale).toBeCloseTo(NEED, 10);
        expect(t!.x).toBeCloseTo(-646.5370370370371, 6);
        expect(t!.y).toBeCloseTo(-1338.8091168091169, 6);
        // The two properties the numbers exist to produce.
        expect(t!.x + t!.scale * CXC, 'caret 35% across the surface').toBeCloseTo(PX, 6);
        expect(t!.y + t!.scale * CYC, 'caret 55% down the visible band').toBeCloseTo(PY, 6);
        // Exact, not close: 22/5.484375 * 5.484375 round-trips exactly in
        // doubles because 5.484375 is 351/64.
        expect(t!.scale * LINE_AT_1, 'the line is exactly the target height').toBe(CARET_TARGET_LINE_PX);
    });

    it('leaves no blank above the picture and none more than the slack below', () => {
        const t = solve()!;
        const top = t.y + t.scale * OFF_Y;
        const bottom = t.y + t.scale * (OFF_Y + DISP_H);
        expect(top, 'picture top is at or above the band top').toBeLessThanOrEqual(STRIP.top + 1e-9);
        expect(bottom, 'and it reaches at least into the slack').toBeGreaterThanOrEqual(
            STRIP.bottom - (STRIP.bottom - STRIP.top) * CARET_BOTTOM_SLACK - 1e-9,
        );
    });
});

describe('the still zone — a camera that re-centres on every character is unusable', () => {
    // POSITIVE CONTROL for the whole block: the same rig, one caret-y further
    // down, DOES solve. Without it, a function returning null unconditionally
    // would satisfy every "stays still" assertion here.
    it('POSITIVE CONTROL: a caret past the band margin re-places', () => {
        const t = solve({
            current: { scale: 4, x: -600, y: -1300 },
            caret: { ...CARET, y: 0.62 },
            force: false,
        });
        expect(t).not.toBeNull();
        // cyc = 312.3125 + 0.6325*219.375 = 451.0671875; on screen at
        // -1300 + 4*451.0671875 = 504.27, whose lower edge is past 446.
        expect(t!.y).toBeCloseTo(-1439.26875, 6);
        expect(t!.scale, 'already readable, so pan only').toBe(4);
    });

    it('holds the view while the caret sits inside the dead zone', () => {
        // sx = -600 + 4*195.203125 = 180.8125, inside [70.2, 319.8].
        // sy = -1300 + 4*424.7421875 = 398.96875, half-line 10.96875, so the
        // caret spans [388.0, 409.94] inside [254, 446].
        expect(solve({
            current: { scale: 4, x: -600, y: -1300 },
            force: false,
        })).toBeNull();
    });

    it('stays still for 20 character advances and re-places on the 21st', () => {
        // One character is ~11 remote px, which at the solved scale is
        // 4.011396 * (11/1920) * 390 = 8.96296 CSS px. From 136.5 the dead
        // zone's right edge is 390*0.82 = 319.8, i.e. 183.3px = 20.45 advances.
        const placed = solve()!;
        const step = 11 / 1920;
        for (let n = 1; n <= 20; n++) {
            expect(
                solve({ current: placed, caret: { ...CARET, x: 0.5 + n * step }, force: false }),
                `advance ${n} must not move the view`,
            ).toBeNull();
        }
        expect(
            solve({ current: placed, caret: { ...CARET, x: 0.5 + 21 * step }, force: false }),
            'the 21st advance leaves the dead zone and must re-place',
        ).not.toBeNull();
    });

    it('a forced solve overrides the dead zone — that is how a band change lands', () => {
        expect(solve({
            current: { scale: 4, x: -600, y: -1300 },
            force: true,
        })).not.toBeNull();
    });

    it('a caret pinned at the top edge does not re-solve on every keystroke', () => {
        // Caret on the remote screen's third row (y = 0.03): the y target is
        // unreachable because there is no blank ABOVE the picture, so the first
        // solve pins y at the top bound: 200 - 4.011396*312.3125 = -1052.809.
        // The caret then sits ABOVE the y still-zone for ever. Judged by
        // position alone that is "out of zone", and every keystroke re-solved —
        // dragging x back to CARET_PLACE_X each time, a view that scrolled ~9px
        // per character typed into a browser's URL bar. The rule under test:
        // an axis the clamp has pinned is as still as it can be.
        const top = { ...CARET, y: 0.03 };
        const placed = solve({ caret: top })!;
        expect(placed.y).toBeCloseTo(200 - (22 / 5.484375) * OFF_Y, 6);
        const step = 11 / 1920;
        for (let n = 1; n <= 20; n++) {
            expect(
                solve({ current: placed, caret: { ...top, x: 0.5 + n * step }, force: false }),
                `advance ${n} at the top edge must not move the view`,
            ).toBeNull();
        }
        // POSITIVE CONTROL: x still has an edge. Past it the view re-places in x
        // while y stays pinned exactly where it was.
        const moved = solve({ current: placed, caret: { ...top, x: 0.5 + 21 * step }, force: false });
        expect(moved, 'the 21st advance leaves the x zone and must re-place').not.toBeNull();
        expect(moved!.y).toBeCloseTo(placed.y, 9);
        expect(moved!.x).not.toBeCloseTo(placed.x, 3);
    });
});

describe('THE BOTTOM EDGE — the ask this feature exists for', () => {
    it('leaves blank space below the picture rather than pinning the caret to the keyboard', () => {
        // Caret on the remote screen's last row: cyc = 312.3125 + 0.9875*219.375
        // = 528.9453125.
        const t = solve({
            current: { scale: 4, x: -600, y: -1300 },
            caret: { ...CARET, y: 0.975 },
            force: false,
        })!;
        expect(t.y).toBeCloseTo(-1750.78125, 6);
        expect(t.y + 4 * 528.9453125, 'the caret is exactly on its target').toBeCloseTo(PY, 6);
        const pictureBottom = t.y + 4 * (OFF_Y + DISP_H);
        expect(pictureBottom).toBeCloseTo(375.96875, 6);
        const blankBelow = STRIP.bottom - pictureBottom;
        expect(blankBelow).toBeCloseTo(124.03125, 6);
        expect(blankBelow, 'bounded by the slack, never unbounded').toBeLessThanOrEqual(
            (STRIP.bottom - STRIP.top) * CARET_BOTTOM_SLACK,
        );

        // THE "BEFORE", in the same test. The ordinary whole-surface clamp pins
        // y at 844 - 4*531.6875 = -1282.75, which puts the caret at 833 — 333px
        // BELOW the keyboard's top edge, i.e. completely hidden. That is the bug.
        const pinned = clampPanTo(BOX, VIEW.pict, 4, PX - 4 * CXC, PY - 4 * 528.9453125);
        expect(pinned.y).toBeCloseTo(-1282.75, 6);
        expect(pinned.y + 4 * 528.9453125).toBeCloseTo(833.03125, 6);
        expect(pinned.y + 4 * 528.9453125).toBeGreaterThan(STRIP.bottom);
    });
});

describe('the top edge is NOT relaxed — no blank above, ever', () => {
    it('clamps a first-row caret to the band top instead of reaching its target', () => {
        // cyc = 312.3125 + 0.0125*219.375 = 315.0546875; the wanted pan is
        // -895.21875, above the bound -1049.25, so it clamps.
        const t = solve({
            current: { scale: 4, x: -600, y: -1300 },
            caret: { ...CARET, y: 0 },
            force: false,
        })!;
        expect(t.y).toBeCloseTo(-1049.25, 6);
        expect(t.y + 4 * OFF_Y, 'picture top sits exactly on the band top').toBeCloseTo(STRIP.top, 6);
        const caretAt = t.y + 4 * 315.0546875;
        expect(caretAt).toBeCloseTo(210.96875, 6);
        expect(caretAt, 'deliberately short of the 55% target').toBeLessThan(PY);
    });
});

describe('never zooms out', () => {
    it('keeps a zoom the user chose, and only pans', () => {
        const t = solve({ current: { scale: 12, x: 0, y: 0 }, force: false })!;
        expect(t.scale, 'a 12x reader is not dragged back to 4x').toBe(12);
        expect(t.x).toBeCloseTo(-2205.9375, 6);
        expect(t.y).toBeCloseTo(-4731.90625, 6);
    });

    it('not even on a forced solve', () => {
        expect(solve({ current: { scale: 20, x: 0, y: 0 }, force: true })!.scale).toBe(20);
    });

    it('but DOES zoom in when the line is under the readable floor', () => {
        // The positive control for the two above: at scale 2 the line is 10.97px,
        // under 22*0.6 = 13.2, so an unforced solve still zooms.
        const t = solve({ current: { scale: 2, x: 0, y: 0 }, force: false })!;
        expect(2 * LINE_AT_1).toBeLessThan(CARET_TARGET_LINE_PX * CARET_MIN_READABLE_RATIO);
        expect(t.scale).toBeCloseTo(NEED, 10);
    });

    it('and leaves a line that is merely BELOW target but still readable alone', () => {
        // 4 * 5.484375 = 21.94, which is 99% of target: no re-zoom, pan only.
        const t = solve({
            current: { scale: 4, x: -600, y: -1300 },
            caret: { ...CARET, y: 0.62 },
            force: false,
        })!;
        expect(t.scale).toBe(4);
    });
});

describe('once the user has taken the wheel, the camera only pans — and only when the caret is lost', () => {
    // The 0.8.88 field report: pinching out while typing was undone by the next
    // keystroke (the camera zoomed straight back to readable), so "zooming out
    // does not go back to All Displays" and "I cannot slide to the other
    // monitor". After a pinch/pan the solver must never change the scale again
    // and must leave a visible caret alone, however unreadable.
    it('leaves a caret that is visible at THEIR 1x alone, unreadable or not', () => {
        // At scale 1 the caret sits at (195.2, 424.7) with a 5.48px line —
        // inside the band, and 5.48 < 13.2 (the readable floor).
        expect(1 * LINE_AT_1).toBeLessThan(CARET_TARGET_LINE_PX * CARET_MIN_READABLE_RATIO);
        expect(solve({ current: { scale: 1, x: 0, y: 0 }, force: false, userDrove: true })).toBeNull();
        // POSITIVE CONTROL: without the flag the same state zooms to readable.
        const t = solve({ current: { scale: 1, x: 0, y: 0 }, force: false })!;
        expect(t.scale).toBeCloseTo(NEED, 10);
    });

    it('a forced solve does not take the wheel back either', () => {
        expect(solve({ current: { scale: 1, x: 0, y: 0 }, force: true, userDrove: true })).toBeNull();
    });

    it('pans at THEIR scale when the caret has gone under the keyboard', () => {
        // Caret at y = 0.9: cyc = 312.3125 + 0.9125*219.375 = 512.4921875, so at
        // scale 1 its centre is at 512.5, below the band's 500. Pan only: at
        // scale 1 the picture underfills the band (219.375 < 300) and centres
        // in it, y = 200 + (300 - 219.375)/2 - 312.3125 = -72 (as the
        // band-centring test derives), which puts the caret at 440.5.
        const t = solve({
            current: { scale: 1, x: 0, y: 0 },
            caret: { ...CARET, y: 0.9 },
            force: false, userDrove: true,
        })!;
        expect(t.scale, 'their scale, not readable').toBe(1);
        expect(t.x).toBe(0);
        expect(t.y).toBeCloseTo(-72, 6);
        expect(t.y + 512.4921875).toBeCloseTo(440.4921875, 6);
    });

    it('pans at THEIR 4x when the caret has gone under the keyboard', () => {
        // Bottom row at 4x from the bottom-edge fixture: sy = -1300 + 4*528.9453
        // = 815.8 > 500. Placed at the target with the relaxed clamp, scale
        // untouched: y = 365 - 4*528.9453125 = -1750.78125, x = 136.5 -
        // 4*195.203125 = -644.3125.
        const t = solve({
            current: { scale: 4, x: -600, y: -1300 },
            caret: { ...CARET, y: 0.975 },
            force: false, userDrove: true,
        })!;
        expect(t.scale).toBe(4);
        expect(t.y).toBeCloseTo(-1750.78125, 6);
        expect(t.x).toBeCloseTo(-644.3125, 6);
    });

    it('a caret the user panned away from is left alone until it moves off screen', () => {
        // They panned so the caret sits at the far right but still on screen
        // (sx = 380 of 390): outside the still zone, INSIDE the band → null.
        // x = 380 - 4*195.203125 = -400.8125.
        expect(solve({
            current: { scale: 4, x: -400.8125, y: -1300 },
            force: false, userDrove: true,
        })).toBeNull();
        // POSITIVE CONTROL: the same view without the flag re-places (x is
        // outside the 18% still zone).
        expect(solve({ current: { scale: 4, x: -400.8125, y: -1300 }, force: false })).not.toBeNull();
    });
});

describe('resolution and monitor changes are absorbed by using fractions', () => {
    it('2560x1440 in the same box gives the IDENTICAL transform', () => {
        // Both 16:9, so the picture box is the same 390x219.375 at 312.3125 and
        // h = 0.025 is 36 remote px instead of 27 — same fraction, same solve.
        const same = caretFollowTransform({
            box: BOX, strip: STRIP,
            view: { pict: VIEW.pict, videoW: 2560, videoH: 1440 },
            current: { scale: 1, x: 0, y: 0 },
            caret: CARET, force: true, minZoom: 1, maxZoom: 40,
        });
        expect(same).toEqual(solve());
    });

    it('1920x1200 needs LESS zoom, and the invariant is what crosses resolutions', () => {
        // 16:10: dispH = 1200*(390/1920) = 243.75, offY = 300.125,
        // lineAt1 = 6.09375, need = 22/6.09375 = 704/195.
        const view: View = {
            pict: { offX: 0, offY: 300.125, dispW: 390, dispH: 243.75 },
            videoW: 1920, videoH: 1200,
        };
        const t = caretFollowTransform({
            box: BOX, strip: STRIP, view,
            current: { scale: 1, x: 0, y: 0 },
            caret: CARET, force: true, minZoom: 1, maxZoom: 40,
        })!;
        expect(t.scale).toBeCloseTo(3.6102564102564103, 10);
        expect(t.scale * 6.09375, 'the target line height is the invariant').toBe(CARET_TARGET_LINE_PX);
    });
});

describe('an underfilled axis centres in the BAND, not in the box', () => {
    it('centres a picture too short to pan inside the visible strip', () => {
        // h = 0.12 is 129.6 remote px: lineAt1 = 26.325, so need = 0.836 and the
        // scale stays at the floor of 1. 219.375 < 300, so there is nowhere legal
        // to pan: y = 200 + (300-219.375)/2 - 312.3125 = -72.
        const t = solve({ caret: { ...CARET, h: 0.12 }, current: { scale: 1, x: 0, y: 0 } })!;
        expect(t).toEqual({ scale: 1, x: 0, y: -72 });
        // POSITIVE CONTROL that the BAND is what moved it: box-centring gives 0,
        // and -72 is exactly the difference between the box centre (422) and the
        // band centre (350).
        expect(clampPanTo(BOX, VIEW.pict, 1, 0, -10_000).y).toBe(0);
    });
});

describe('a band too small to aim at', () => {
    it('is refused', () => {
        expect(solve({ strip: { top: 200, bottom: 290 } })).toBeNull();
    });
    it('POSITIVE CONTROL: ten pixels more and it solves', () => {
        const t = solve({ strip: { top: 200, bottom: 300 } })!;
        expect(t).not.toBeNull();
        // py = 200 + 100*0.55 = 255, so y = 255 - 4.011396*424.7421875.
        expect(t.y).toBeCloseTo(-1448.8091168091169, 6);
    });
});

describe('bad input is refused rather than obeyed', () => {
    it('rejects an out-of-range or non-finite caret', () => {
        expect(solve({ caret: { ...CARET, y: 1.5 } })).toBeNull();
        expect(solve({ caret: { ...CARET, x: -0.01 } })).toBeNull();
        expect(solve({ caret: { ...CARET, h: Number.NaN } })).toBeNull();
        expect(solve({ strip: { top: 200, bottom: Number.NaN } })).toBeNull();
        expect(solve({ box: { w: 0, h: 844 } })).toBeNull();
    });
    it('POSITIVE CONTROL: the same call with a sane caret solves', () => {
        expect(solve()).not.toBeNull();
    });
});

describe("'field' — the focused element's box, not a caret", () => {
    it('uses the fallback line height and aims at the box\'s top third', () => {
        // A 400px-tall textarea: h = 400/1080 = 0.37. Taking that as a line would
        // solve to scale 22/(0.37*219.375) = 0.27 — a zoom OUT, past the floor,
        // and a text box whose centre is nowhere near the caret in it.
        const field = { x: 0.5, y: 0.3, w: 0.4, h: 400 / 1080, src: 'field' };
        const t = solve({ caret: field })!;
        // Fallback line: 20/1080 * 219.375 = 4.0625 CSS px, need = 22/4.0625
        // = 5.4153846...
        expect(t.scale).toBeCloseTo(5.415384615384616, 9);
        // Aim point: 0.3 + 0.37037.../3 = 0.4234567..., i.e.
        // cyc = 312.3125 + 0.4234567*219.375 = 405.2083333...
        const cyc = OFF_Y + (0.3 + (400 / 1080) / 3) * DISP_H;
        expect(cyc).toBeCloseTo(405.2083333333333, 9);
        expect(t.y + t.scale * cyc, 'the top third lands on the target').toBeCloseTo(PY, 6);
        expect(t.scale, 'and it never solves to a zoom-out').toBeGreaterThanOrEqual(1);
    });

    it('POSITIVE CONTROL: the same rect as a real caret solves differently', () => {
        const asCaret = solve({ caret: { x: 0.5, y: 0.3, w: 0.4, h: 400 / 1080, src: 'win32' } })!;
        expect(asCaret.scale, 'a 400px "line" is already far past readable').toBe(1);
    });
});

describe('the band itself — what the key bar and the keyboard leave visible', () => {
    /** A phone: the surface fills the screen, so its rect starts at 0. */
    const full = { top: 0, bottom: 844, height: 844 };

    it('POSITIVE CONTROL: a measured bar and a measured keyboard give the band', () => {
        // The unfolded key bar is ~190px and the IME's top edge is at 500.
        expect(caretBandFrom(full, 190, 500)).toEqual({ top: 190, bottom: 500 });
    });

    it('measures the bar\'s OVERLAP, not its height, when the surface starts lower', () => {
        // A desktop-shaped layout with a toolbar above the surface: the bar covers
        // the top 190px of the SCREEN, of which only 90 fall on the surface.
        expect(caretBandFrom({ top: 100, bottom: 944, height: 844 }, 190, 600))
            .toEqual({ top: 90, bottom: 500 });
    });

    it('is null until each edge has actually been measured', () => {
        expect(caretBandFrom(full, 0, 500), 'the bar has not reported yet').toBeNull();
        expect(caretBandFrom(full, 190, null), 'nothing has measured the keyboard').toBeNull();
        expect(caretBandFrom(null, 190, 500), 'no surface').toBeNull();
        expect(caretBandFrom({ top: 0, bottom: 0, height: 0 }, 190, 500)).toBeNull();
    });

    it('is null when the keyboard has eaten everything below the bar', () => {
        expect(caretBandFrom(full, 190, 190)).toBeNull();
        expect(caretBandFrom(full, 600, 500), 'the bar reaches past the keyboard').toBeNull();
    });

    it('refuses a band that is nearly the whole surface — that is no keyboard', () => {
        // A floating or split Gboard reports a zero-height IME inset, so the
        // assumed tier's "keyboard" is at the very bottom of the screen.
        expect(844 - 20 > 844 * CARET_NO_KEYBOARD_STRIP_RATIO).toBe(true);
        expect(caretBandFrom(full, 20, 844)).toBeNull();
        // POSITIVE CONTROL: just inside the ratio and it is a band again.
        // 844*0.85 = 717.4, so a 700px band passes.
        expect(caretBandFrom(full, 100, 800)).toEqual({ top: 100, bottom: 800 });
    });

    it('treats a keyboard past the surface as no intrusion at all', () => {
        // Android <= 14 resizes the WebView for the IME, so the surface already
        // excludes it and the bottom inset must come out as zero.
        expect(caretBandFrom({ top: 0, bottom: 500, height: 500 }, 190, 844))
            .toEqual({ top: 190, bottom: 500 });
    });
});

describe('the constants themselves cannot produce a pan loop', () => {
    // Each of these, violated, makes the solved placement fall OUTSIDE the dead
    // zone it just aimed at — a re-solve on every report, forever.
    it('the placement point sits strictly inside the dead zone', () => {
        expect(CARET_DEADZONE_X).toBeLessThan(CARET_PLACE_X);
        expect(CARET_PLACE_X).toBeLessThan(1 - CARET_DEADZONE_X);
        expect(CARET_DEADZONE_Y).toBeLessThan(CARET_PLACE_Y);
        expect(CARET_PLACE_Y).toBeLessThan(1 - CARET_DEADZONE_Y);
    });
    it('the slack is enough for the bottom row to reach its target', () => {
        expect(CARET_BOTTOM_SLACK).toBeGreaterThan(1 - CARET_PLACE_Y);
    });
    it('the minimum band holds several lines', () => {
        expect(CARET_MIN_STRIP_PX).toBeGreaterThan(4 * CARET_TARGET_LINE_PX);
    });
});
