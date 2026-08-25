/**
 * LevelNormalizer — the DeepFilter model-input level wrapper (dfLevel.ts).
 *
 * The property that matters is the INVERSE: the model returns hop N − D for
 * input hop N (D = delay_hops, 3 for DFN3), so the factor divided out of a
 * returned hop must be the one multiplied into hop N − D. Through 0.8.87 the
 * worker divided by the current hop's factor. These tests drive the exact
 * production class with a scripted delayed "model" (identity, D hops late)
 * and check the round trip is exact per hop under a MOVING gain — the
 * regime where "current" and "delayed" differ — with a positive control
 * proving the test can see the old behaviour.
 */
import { describe, it, expect } from 'vitest';
import {
    LevelNormalizer, LEVEL_GAIN_MAX, LEVEL_GAIN_MIN, LEVEL_PEAK_CEIL, LEVEL_TARGET_RMS,
} from '../api/dfLevel';

const HOP = 480;
const D = 3;

/** A hop of a 300 Hz sine at the given amplitude, phase-continuous by index. */
function hop(k: number, amp: number): Float32Array {
    const h = new Float32Array(HOP);
    for (let i = 0; i < HOP; i++) h[i] = amp * Math.sin((2 * Math.PI * 300 * (k * HOP + i)) / 48000);
    return h;
}

/**
 * Run `n` hops through the wrapper around an identity model with delay D:
 * returns per-hop max |out − in| when the inverse is taken `mode`-wise.
 */
function roundTrip(n: number, amp: (k: number) => number, mode: 'delayed' | 'current'): number[] {
    const norm = new LevelNormalizer(D);
    const queue: Float32Array[] = []; // the "model": returns the hop from D calls ago
    for (let i = 0; i < D; i++) queue.push(new Float32Array(HOP)); // zero-state warm-up
    const errs: number[] = [];
    const inputs: Float32Array[] = [];
    for (let k = 0; k < n; k++) {
        const x = hop(k, amp(k));
        inputs.push(x);
        const g = norm.gainForInput(x);
        const scaled = new Float32Array(HOP);
        for (let i = 0; i < HOP; i++) scaled[i] = x[i] * g;
        queue.push(scaled);
        const returned = queue.shift()!;
        const inv = 1 / (mode === 'delayed' ? norm.gainForOutput() : g);
        if (k >= D) {
            const ref = inputs[k - D];
            let e = 0;
            for (let i = 0; i < HOP; i++) e = Math.max(e, Math.abs(returned[i] * inv - ref[i]));
            errs.push(e);
        }
    }
    return errs;
}

describe('LevelNormalizer inverse', () => {
    it('is exact per hop while the gain slews, when taken D hops late', () => {
        // Quiet start (gain winds up toward the target), then a loud step
        // (instant attack pulls the target down; the peak clamp engages).
        const errs = roundTrip(600, (k) => (k < 300 ? 0.02 : 0.6), 'delayed');
        // Float32 scale + unscale round trip: a few ulps at most.
        expect(Math.max(...errs)).toBeLessThan(1e-6);
    });

    it('positive control: the pre-0.8.88 "current gain" inverse is NOT exact under a moving gain', () => {
        const errs = roundTrip(600, (k) => (k < 300 ? 0.02 : 0.6), 'current');
        // The slew alone puts g[N]/g[N-3] a percent or so off; the clamp at
        // the loud step is an arbitrary jump. Either way, well above ulps.
        expect(Math.max(...errs)).toBeGreaterThan(1e-3);
    });

    it('barely differs from "current" while the gain is steady — which is why steady-state runs never saw the bug', () => {
        // Same amplitude throughout: after convergence g creeps by ~1e-5 per
        // hop toward its asymptote, so g[N]/g[N−3] is 1 to a few 1e-5 and
        // "current" is off by that much (vs ulps for "delayed"). The bug only
        // bites on transitions — the quiet→loud step the first test drives.
        const late = roundTrip(1200, () => 0.1, 'delayed');
        const now = roundTrip(1200, () => 0.1, 'current');
        expect(late.length).toBeGreaterThan(800); // the slices below are not empty
        expect(Math.max(...late.slice(800))).toBeLessThan(1e-6);
        // Bounded, not compared against `late`: a LEVEL_SLEW retune could make
        // both read ulps and a strict ordering would flip on nothing real.
        expect(Math.max(...now.slice(800))).toBeLessThan(1e-4);
    });
});

describe('LevelNormalizer gain law', () => {
    it('tracks a quiet talker up toward the target and stays within [MIN, MAX]', () => {
        const norm = new LevelNormalizer(D);
        let g = 1;
        for (let k = 0; k < 3000; k++) g = norm.gainForInput(hop(k, 0.02)); // RMS ≈ 0.014
        // Target gain = TARGET / env ≈ 0.1 / 0.014 ≈ 7.07, under the cap.
        expect(g).toBeGreaterThan(6.5);
        expect(g).toBeLessThanOrEqual(LEVEL_GAIN_MAX);
        // Loud talker: gain drops toward TARGET / env, floored at MIN.
        for (let k = 0; k < 3000; k++) g = norm.gainForInput(hop(k, 0.9));
        expect(g).toBeGreaterThanOrEqual(LEVEL_GAIN_MIN);
        expect(g).toBeLessThan(0.6);
    });

    it('never pushes a hop past the peak ceiling into the model', () => {
        const norm = new LevelNormalizer(D);
        for (let k = 0; k < 2000; k++) norm.gainForInput(hop(k, 0.02)); // wind the gain up
        const loud = hop(0, 0.5);
        const g = norm.gainForInput(loud);
        expect(g * 0.5).toBeLessThanOrEqual(LEVEL_PEAK_CEIL + 1e-6);
        expect(g).toBeLessThan(norm.gain); // the clamp, not the slewed gain, was applied
    });

    it('freezes in silence: a long pause must not wind the gain up', () => {
        const norm = new LevelNormalizer(D);
        for (let k = 0; k < 1000; k++) norm.gainForInput(hop(k, 0.1)); // converge near unity
        const before = norm.gain;
        for (let k = 0; k < 5000; k++) norm.gainForInput(new Float32Array(HOP)); // 50 s of silence
        expect(norm.gain).toBe(before);
        expect(LEVEL_TARGET_RMS).toBe(0.1);
    });
});
