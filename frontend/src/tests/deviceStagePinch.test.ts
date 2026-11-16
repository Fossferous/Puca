/**
 * A two-finger step on the remote-control stage is one per TOUCH EVENT, not
 * one per finger (components/deviceStagePinch.ts). The browser hands a touch
 * event to the page as a pointermove per finger, so between the first
 * finger's move and the second's the stage sees a spread the hand never
 * made; clamped there, a pan into an edge stopped short of it and the edge's
 * hop arrow never came up (2026-11-16: the device-stage walk's sideways
 * corner, and every two-finger pan toward the right and bottom edges).
 *
 * The rig: a 400x300 surface the picture fills at scale 1, so the pan clamp
 * is plain: the picture's left edge (x) between 400 - 400 * scale and 0.
 */
import { describe, it, expect } from 'vitest';
import { pinchStep, type FingerMove, type PinchLimits, type StageView } from '../components/deviceStagePinch';

const W = 400, H = 300;
const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const limits: PinchLimits = {
    minZoom: 1, maxZoom: 40,
    clampPan: (scale, x, y) => ({ x: clampTo(x, W - W * scale, 0), y: clampTo(y, H - H * scale, 0) }),
};

type Pt = { x: number; y: number };
const mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const gap = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Two fingers; `move` puts one of them somewhere and returns that finger's
 *  pointermove as the stage reads it (the pair before and after). */
function hand(a: Pt, b: Pt) {
    const f: Record<number, Pt> = { 1: a, 2: b };
    return (finger: 1 | 2, to: Pt, at: number): FingerMove => {
        const before = { d: gap(f[1], f[2]), c: mid(f[1], f[2]) };
        f[finger] = to;
        return { at, finger, prevDist: before.d, dist: gap(f[1], f[2]), prevCenter: before.c, center: mid(f[1], f[2]) };
    };
}

/** Both fingers carried `dx` to the right, `steps` times, one touch event
 *  per step: finger `first` handed over first. `sameEvent` false is the stage
 *  as it was: each finger's move a step of its own. */
function pan(start: StageView, first: 1 | 2, steps: number, dx: number, sameEvent = true): StageView {
    const p = { 1: { x: 100, y: 150 }, 2: { x: 160, y: 150 } };
    const move = hand(p[1], p[2]);
    let t = start;
    for (let i = 1; i <= steps; i++) {
        const order = first === 1 ? [1, 2] as const : [2, 1] as const;
        for (const [k, finger] of order.entries()) {
            const at = sameEvent ? i * 16 : i * 16 + k * 8;
            t = pinchStep(t, move(finger, { x: p[finger].x + dx * i, y: p[finger].y }, at), limits);
        }
    }
    return t;
}

describe('a two-finger step is one per touch event', () => {
    // At x4 on the picture's left edge (x = 0), carried right by two fingers
    // 60 px apart, side by side: the picture has nowhere further to go.
    const atEdge: StageView = { scale: 4, x: 0, y: -450 };

    it('a pan into an edge ENDS on it when the finger closing the gap moves first', () => {
        const t = pan(atEdge, 1, 4, 25);
        expect(t.scale).toBeCloseTo(4, 9);
        expect(t.x, 'on the edge: the hop offer needs it within 1 px').toBe(0);
        expect(t.y).toBeCloseTo(-450, 9);
    });

    it('CONTROL: the same moves, each finger a step of its own (the stage as it was), end short of the edge', () => {
        const t = pan(atEdge, 1, 4, 25, false);
        expect(t.scale).toBeCloseTo(4, 9);
        // 60 px apart, the first finger's 25 px leaves them 35 apart: a
        // pinch to 35/60 and back, clamped half way.
        expect(t.x, 'if this reaches the edge, the rig cannot tell the fix from the bug').toBeLessThan(-50);
    });

    it('either finger first, the same view', () => {
        const start: StageView = { scale: 4, x: -300, y: -450 };
        const a = pan(start, 1, 14, 25);
        const b = pan(start, 2, 14, 25);
        expect(a.x).toBeCloseTo(b.x, 9);
        expect(a.y).toBeCloseTo(b.y, 9);
        expect(a.scale).toBeCloseTo(b.scale, 9);
        // 14 x 25 px from -300, clamped at the edge.
        expect(a.x).toBe(0);
    });

    it('away from every edge it is the plain pan: the picture moves with the fingers', () => {
        const start: StageView = { scale: 4, x: -800, y: -450 };
        const t = pan(start, 1, 4, 25);
        expect(t.x).toBeCloseTo(-700, 9);
        expect(t.scale).toBeCloseTo(4, 9);
    });

    it('BETWEEN events the clamp holds: pushed past the edge, the way back moves at once', () => {
        const pushed = pan(atEdge, 1, 6, 25);            // 150 px further than the edge allows
        expect(pushed.x).toBe(0);
        const back = pan(pushed, 2, 1, -25);              // one event back
        expect(back.x, 'no dead zone: the picture moves back with the fingers').toBeCloseTo(-25, 9);
    });

    it('a finger moving twice under one timeStamp is two events, clamped between them', () => {
        const move = hand({ x: 100, y: 150 }, { x: 160, y: 150 });
        // Finger 1 alone, in and back out, the other finger still: no browser
        // hands one finger over twice in a touch event, so the second is a
        // new event and starts from the clamped view. (Back to its start, so
        // the half-step stays above the zoom floor, which would reset the
        // view to the same place either way.)
        const once = pinchStep(atEdge, move(1, { x: 125, y: 150 }, 16), limits);
        const second = move(1, { x: 100, y: 150 }, 16);
        const t = pinchStep(once, second, limits);
        expect(t).toEqual(pinchStep(once, { ...second, at: 99 }, limits));
        // CONTROL: composed as one event, the in-and-out would be no move at
        // all and the view would be back on the edge.
        expect(t.x, 'if this is on the edge the guard did nothing').toBeLessThan(-50);
    });

    it('a view another writer made (the zoom-follow landing, the wheel) is where the next step starts', () => {
        const move = hand({ x: 100, y: 150 }, { x: 160, y: 150 });
        const first = pinchStep(atEdge, move(1, { x: 125, y: 150 }, 16), limits);
        const second = move(2, { x: 185, y: 150 }, 16);
        // Not a view pinchStep returned: nothing of the gesture carries over.
        const landed: StageView = { ...first };
        const next = pinchStep(landed, second, limits);
        expect(next).toEqual(pinchStep(landed, { ...second, at: 99 }, limits));
        // CONTROL: from the view the first finger's step returned, the event
        // does carry over, and lands somewhere else (on the edge).
        expect(pinchStep(first, second, limits).x).toBe(0);
        expect(next.x).toBeLessThan(-50);
    });

    it('the zoom floor is not hit by a half-step: a fingers-together slide at x1.05 stays at x1.05', () => {
        const near1: StageView = { scale: 1.05, x: -10, y: -7.5 };
        const t = pan(near1, 1, 1, 25);
        expect(t.scale).toBeCloseTo(1.05, 9);
        // CONTROL: the stage as it was floored the half-step at x1 and came
        // back out from there, x1.71 from one sideways slide.
        const old = pan(near1, 1, 1, 25, false);
        expect(old.scale).toBeGreaterThan(1.5);
    });

    it('one finger alone is the step it always was (the zoom limits about the fingers, then the clamp)', () => {
        const start: StageView = { scale: 4, x: -800, y: -450 };
        const m: FingerMove = { at: 5, finger: 2, prevDist: 60, dist: 90, prevCenter: { x: 130, y: 150 }, center: { x: 145, y: 150 } };
        const t = pinchStep(start, m, limits);
        // The old formula: scale x1.5, the midpoint keeps its picture point.
        expect(t.scale).toBeCloseTo(6, 9);
        expect(t.x).toBeCloseTo(145 - (130 + 800) * 1.5, 9);
        expect(t.y).toBeCloseTo(150 - (150 + 450) * 1.5, 9);
        // Capped at the ceiling about the same point.
        const big = pinchStep({ scale: 30, x: -5000, y: -4000 }, { ...m, at: 6, dist: 120 }, limits);
        expect(big.scale).toBe(40);
        expect(big.x).toBeCloseTo(145 - (130 + 5000) * (40 / 30), 9);
    });
});
