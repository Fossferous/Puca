/**
 * imageZoom — the viewer's zoom maths, on hand-checkable numbers.
 *
 * Fixture: a 400x800 (portrait phone) surface showing a 1000x500 (landscape)
 * picture. object-fit:contain scales it by min(400/1000, 800/500) = 0.4 →
 * drawn 400x200, letterboxed at offY = (800−200)/2 = 300, offX = 0.
 * Every expected number below can be verified on paper from that.
 */
import { describe, it, expect } from 'vitest';
import { pictureBox } from '../api/devices/pointerMapping';
import { clampPanTo } from '../components/deviceZoomFollow';
import {
    zoomAt, isDoubleTap,
    MIN_SCALE, MAX_SCALE, DOUBLE_TAP_SCALE, DOUBLE_TAP_MS, DOUBLE_TAP_SLOP_PX,
} from '../components/imageZoom';

const BOX = { w: 400, h: 800 };
const PICT = pictureBox(1000, 500, BOX.w, BOX.h)!;
const FIT = { scale: 1, x: 0, y: 0 };

describe('fixture sanity', () => {
    it('the picture is a 400x200 strip centred vertically', () => {
        expect(PICT).toEqual({ offX: 0, offY: 300, dispW: 400, dispH: 200 });
    });
});

describe('zoomAt', () => {
    it('a double-tap zoom keeps the tapped point under the finger', () => {
        // x: 200 − 200·2.5 = −300, inside [−600, 0] → unchanged.
        // y: the picture UNDERFILLS vertically even at 2.5x (500 px tall in an
        //    800 px box), so the clamp centres it: (800−500)/2 − 2.5·300 = −600.
        // A transform-origin:center implementation gets neither of these.
        expect(zoomAt(FIT, { x: 200, y: 400 }, DOUBLE_TAP_SCALE, BOX, PICT))
            .toEqual({ scale: 2.5, x: -300, y: -600 });
    });

    it('a tap at a different point re-anchors there', () => {
        // x: 50 − 50·2.5 = −75, inside [−600, 0].
        expect(zoomAt(FIT, { x: 50, y: 400 }, DOUBLE_TAP_SCALE, BOX, PICT).x).toBe(-75);
    });

    it('zooming back to 1 recentres, whatever the pan was', () => {
        expect(zoomAt({ scale: 2.5, x: -300, y: -600 }, { x: 0, y: 0 }, 1, BOX, PICT)).toEqual(FIT);
        expect(zoomAt({ scale: 8, x: -1234, y: -99 }, { x: 350, y: 20 }, 0.2, BOX, PICT)).toEqual(FIT);
    });

    it('the ceiling holds and the floor is the identity', () => {
        expect(zoomAt(FIT, { x: 200, y: 400 }, 99, BOX, PICT).scale).toBe(MAX_SCALE);
        expect(zoomAt(FIT, { x: 200, y: 400 }, 0.2, BOX, PICT)).toEqual({ scale: MIN_SCALE, x: 0, y: 0 });
    });

    it('returns the same object when the scale would not move (no spurious re-render)', () => {
        const t = { scale: 2.5, x: -300, y: -600 };
        expect(zoomAt(t, { x: 10, y: 10 }, 2.5, BOX, PICT)).toBe(t);
        expect(zoomAt(FIT, { x: 10, y: 10 }, 0.5, BOX, PICT)).toEqual(FIT); // clamped to 1 → identity
    });

    it('a zoomed picture can never be panned off the surface', () => {
        // Far bound on x: 400 − 2.5·400 = −600. y is the underfilled axis → centred at −600.
        expect(clampPanTo(BOX, PICT, 2.5, -99_999, -99_999)).toEqual({ scale: 2.5, x: -600, y: -600 });
        const nearEdge = clampPanTo(BOX, PICT, 2.5, 99_999, 99_999);
        expect(nearEdge.x === 0).toBe(true); // may be −0 (hi = −scale·offX with offX 0)
        expect(nearEdge.y).toBe(-600);
        // Fed the CANVAS box instead of the picture, the strip could leave the
        // viewport entirely (the 2026-08-11 "black bars" failure) — pin that
        // the picture clamp is the tighter one on the letterboxed axis.
        expect(clampPanTo(BOX, null, 2.5, -99_999, -99_999).y).toBe(-1200);
    });

    it('a pinch through intermediate scales lands where a single jump would', () => {
        const a = zoomAt(FIT, { x: 200, y: 400 }, 1.5, BOX, PICT);
        const b = zoomAt(a, { x: 200, y: 400 }, 2.5, BOX, PICT);
        expect(b).toEqual(zoomAt(FIT, { x: 200, y: 400 }, 2.5, BOX, PICT));
    });
});

describe('isDoubleTap', () => {
    const first = { at: 1000, x: 100, y: 100 };
    it('needs a previous tap', () => {
        expect(isDoubleTap(null, 1100, { x: 100, y: 100 })).toBe(false);
    });
    it('inside the window and the slop → double-tap', () => {
        expect(isDoubleTap(first, 1000 + DOUBLE_TAP_MS - 1, { x: 110, y: 100 })).toBe(true);
        expect(isDoubleTap(first, 1000 + DOUBLE_TAP_MS, { x: 100, y: 100 })).toBe(true); // inclusive
    });
    it('too late → two single taps', () => {
        expect(isDoubleTap(first, 1000 + DOUBLE_TAP_MS + 1, { x: 100, y: 100 })).toBe(false);
    });
    it('too far → two single taps', () => {
        expect(isDoubleTap(first, 1100, { x: 100 + DOUBLE_TAP_SLOP_PX + 1, y: 100 })).toBe(false);
        expect(isDoubleTap(first, 1100, { x: 100 + DOUBLE_TAP_SLOP_PX, y: 100 })).toBe(true);
    });
});
