/**
 * DfCore — the DeepFilter AudioWorklet state machine, driven deterministically.
 *
 * This is where the crackle class of bug lives (framing, ring indexing, source
 * flips, underrun fallback), so these tests are strict: sample-EXACT equality
 * against an independently computed expectation wherever the expected source is
 * known a priori, plus a global sample-to-sample continuity bound that any
 * unmasked splice/zero-fill violates. A positive control proves the continuity
 * detector actually fires on an injected glitch of the kind the old
 * ScriptProcessor design produced.
 *
 * The "worker" here is scripted: the rig decides exactly when each hop's
 * response arrives, so every scenario (fast worker, slow worker, stalled
 * worker, dead worker) is reproducible to the sample.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain-JS worklet module (shipped raw via ?url); the test
// project is not typechecked by tsc -b, but eslint still parses this file.
import { DfCore } from '../api/dfWorklet.js';

const HOP = 480;
// 1440 — deepFilter.ts's latencySamples(hop, delayHops=0): (0 + 1 + 2) hops,
// i.e. a zero-delay model such as the bypass test path. The delayed-model
// block below adds the model delay on top, as deepFilter.ts does.
const LATENCY = 3 * HOP;
const QUANTUM = 128;
const FADE = 128; // mirrors the declick ramp in dfWorklet.js

type Signal = (i: number) => number;

/** Deterministic noise in [-0.45, 0.45] — unlikely to match anything by luck. */
const noiseSig: Signal = (i) => {
    let x = (i + 1) * 2654435761 % 4294967296;
    x = (x ^ (x >>> 13)) * 1103515245 % 4294967296;
    return ((x % 10000) / 10000 - 0.5) * 0.9;
};

/** 220 Hz sine, amplitude 0.9 — max natural |Δ| ≈ 0.026/sample @ 48 kHz. */
const sineSig: Signal = (i) => 0.9 * Math.sin((2 * Math.PI * 220 * i) / 48000);

/**
 * DfCore + a scripted worker. Responses are enqueued at send time and
 * delivered (FIFO, transform applied) before the quantum `delayQuanta` later.
 * `paused` freezes delivery entirely (a stalled worker); unpausing delivers
 * the whole backlog at once, like a real worker catching up.
 *
 * `modelDelayHops` scripts a model with an algorithmic delay (DFN3: 3): the
 * response to hop N is transform(hop N − modelDelayHops), zeros for the first
 * modelDelayHops responses (the model's zero state). `coreModelDelay` is what
 * DfCore is TOLD about it — separated so a test can prove the misalignment of
 * telling it 0 (the pre-0.8.88 behaviour) is visible.
 */
class Rig {
    core: InstanceType<typeof DfCore>;
    input: number[] = []; // f32-rounded, as the core saw it
    output: number[] = [];
    private pending: { deliverAt: number; data: Float32Array }[] = [];
    private modelQueue: Float32Array[] = [];
    private quantum = 0;
    paused = false;
    respond = true;
    dryFlag = false;

    constructor(
        private transform: (x: number) => number = (x) => x * 0.5,
        private delayQuanta = 0,
        private modelDelayHops = 0,
        coreModelDelay = modelDelayHops * HOP,
        latency = LATENCY + coreModelDelay,
    ) {
        for (let i = 0; i < modelDelayHops; i++) this.modelQueue.push(new Float32Array(HOP));
        this.core = new DfCore(HOP, latency, (hopView: Float32Array) => {
            if (!this.respond) return;
            // Contract: the view is scratch, valid only during the call.
            this.modelQueue.push(new Float32Array(hopView));
            const answers = this.modelQueue.shift()!;
            this.pending.push({ deliverAt: this.quantum + this.delayQuanta, data: answers });
        }, coreModelDelay);
    }

    private deliverDue() {
        while (this.pending.length > 0 && this.pending[0].deliverAt <= this.quantum && !this.paused) {
            const { data } = this.pending.shift()!;
            const enhanced = new Float32Array(data.length);
            for (let j = 0; j < data.length; j++) enhanced[j] = this.transform(data[j]);
            this.core.onEnhanced(enhanced, this.dryFlag);
        }
    }

    pump(quanta: number, gen: Signal | null) {
        const inBuf = new Float32Array(QUANTUM);
        const outBuf = new Float32Array(QUANTUM);
        for (let q = 0; q < quanta; q++) {
            this.deliverDue();
            if (gen) {
                const base = this.input.length;
                for (let i = 0; i < QUANTUM; i++) inBuf[i] = gen(base + i);
            }
            this.core.processQuantum(gen ? inBuf : null, outBuf);
            for (let i = 0; i < QUANTUM; i++) {
                this.input.push(gen ? inBuf[i] : 0);
                this.output.push(outBuf[i]);
            }
            this.quantum++;
        }
    }
}

/** Largest |output[p] − output[p−1]| over [from, to) — the crackle detector. */
function maxStep(out: number[], from = 1, to = out.length): number {
    let m = 0;
    for (let p = Math.max(1, from); p < to; p++) {
        const d = Math.abs(out[p] - out[p - 1]);
        if (d > m) m = d;
    }
    return m;
}

describe('DfCore steady state', () => {
    it('emits the processed stream sample-exactly (0.5× oracle), one flip, zero dry', () => {
        const rig = new Rig((x) => x * 0.5, 0);
        // 800 quanta = 102 400 samples ≈ 2.1 s — crosses the 32 768 ring 3×.
        rig.pump(800, noiseSig);

        // Startup lead-in: exactly `latency` silent samples.
        for (let p = 0; p < LATENCY; p++) expect(rig.output[p]).toBe(0);

        // After the single silent→processed flip and its declick ramp: exact.
        // (0.5× is exact in binary floating point, so `toBe`, not closeTo.)
        for (let p = LATENCY + FADE; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.5 * rig.input[p - LATENCY]);
        }

        const s = rig.core.stats();
        expect(s.flips).toBe(1);
        expect(s.drySamples).toBe(0);
        expect(s.silentSamples).toBe(LATENCY);
        expect(s.processedSamples).toBe(rig.output.length - LATENCY);
        expect(s.overloaded).toBe(false);
        expect(s.outstanding).toBeLessThanOrEqual(4); // ping-pong stays shallow
    });

    it('positive control: the oracle is not vacuous — processed ≠ raw', () => {
        const rig = new Rig((x) => x * 0.5, 0);
        rig.pump(200, noiseSig);
        // If the pipeline were secretly passing raw through, this would match.
        let diverged = 0;
        for (let p = LATENCY + FADE; p < rig.output.length; p++) {
            if (rig.output[p] !== rig.input[p - LATENCY]) diverged++;
        }
        expect(diverged).toBeGreaterThan(10000);
    });

    it('absorbs realistic worker latency (5 quanta) with zero dry samples', () => {
        const rig = new Rig((x) => x * 0.5, 5); // 640 samples < the 960 budget
        rig.pump(800, noiseSig);
        for (let p = LATENCY + FADE; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.5 * rig.input[p - LATENCY]);
        }
        expect(rig.core.stats().flips).toBe(1);
        expect(rig.core.stats().drySamples).toBe(0);
    });
});

describe('DfCore underrun', () => {
    it('falls back to the time-aligned raw delay line, declicked, and recovers exactly', () => {
        const rig = new Rig((x) => x * 0.5, 0);
        rig.pump(400, sineSig); // steady processed
        const before = rig.core.stats();
        expect(before.flips).toBe(1);

        rig.paused = true; // worker stalls: sends continue, deliveries stop
        rig.pump(40, sineSig); // 5 120 samples ≫ latency → guaranteed underrun
        rig.paused = false; // worker catches the whole backlog up at once
        rig.pump(400, sineSig);

        const s = rig.core.stats();
        // Exactly one excursion: processed → dry → processed.
        expect(s.flips).toBe(3);
        expect(s.drySamples).toBeGreaterThan(0);

        // THE crackle assertion: every source flip is declicked, so the whole
        // run — including both flips and the backlog splice — stays under the
        // continuity bound. (Natural sine step ≈ 0.026; an unmasked 0.5×→1×
        // flip would step ~0.45; an old-style zero-fill would step ~0.9.)
        expect(maxStep(rig.output, LATENCY + FADE)).toBeLessThan(0.06);

        // Recovery is exact: the tail is pure processed stream again.
        const tail = rig.output.length - 200 * QUANTUM;
        for (let p = tail; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.5 * rig.input[p - LATENCY]);
        }
    });

    it('during the stall the fallback is the SAME instant of audio, not the live mic', () => {
        const rig = new Rig((x) => x * 0.5, 0);
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);

        // Interior of the stalled region (skip FADE after the flip): raw at
        // the SAME timeline index — identical content, aligned in time.
        const s = rig.core.stats();
        expect(s.flips).toBe(2); // → dry happened, no recovery yet
        const end = rig.output.length;
        let aligned = 0;
        for (let p = end - 20 * QUANTUM; p < end; p++) {
            if (rig.output[p] === rig.input[p - LATENCY]) aligned++;
        }
        expect(aligned).toBe(20 * QUANTUM); // exact, every sample
    });
});

describe('DfCore dead worker', () => {
    it('keeps emitting aligned raw audio forever and latches overload at 50 outstanding', () => {
        const rig = new Rig();
        rig.respond = false; // worker never answers a single hop
        // Pump until just before the overload threshold.
        while (rig.core.stats().hopsSent < 49) rig.pump(1, sineSig);
        expect(rig.core.stats().overloaded).toBe(false); // not a hair early
        while (rig.core.stats().hopsSent < 50) rig.pump(1, sineSig);
        expect(rig.core.stats().overloaded).toBe(true); // latched exactly at 50

        rig.pump(200, sineSig);
        const s = rig.core.stats();
        expect(s.processedSamples).toBe(0);
        // Silence lead-in, then raw delay line — mic never goes dead.
        for (let p = LATENCY + FADE; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(rig.input[p - LATENCY]);
        }
        expect(maxStep(rig.output, LATENCY + FADE)).toBeLessThan(0.06);
    });

    it('null input (disconnected source) advances the timeline as zeros', () => {
        const rig = new Rig();
        rig.respond = false;
        rig.pump(100, null);
        const s = rig.core.stats();
        expect(s.hopsSent).toBeGreaterThan(20); // framing kept running
        for (const v of rig.output) expect(v).toBe(0);
    });
});

describe('DfCore worker-dry hops', () => {
    it('counts them and carries their (unenhanced) content without a gap', () => {
        const rig = new Rig((x) => x, 0); // identity — what a dry return is
        rig.dryFlag = true;
        rig.pump(400, sineSig);
        const s = rig.core.stats();
        expect(s.workerDryHops).toBe(s.hopsReceived);
        expect(s.workerDryHops).toBeGreaterThan(0);
        for (let p = LATENCY + FADE; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(rig.input[p - LATENCY]);
        }
    });
});

describe('DfCore with a delayed model (DFN3: 3 hops)', () => {
    const D = 3;
    const LAT = LATENCY + D * HOP; // what deepFilter.ts computes: (3 + 1 + 2) hops

    it('places each returned hop on the raw timeline where its INPUT was: output = 0.5× input[p − latency]', () => {
        const rig = new Rig((x) => x * 0.5, 0, D);
        rig.pump(800, noiseSig);
        for (let p = 0; p < LAT; p++) expect(rig.output[p]).toBe(0);
        for (let p = LAT + FADE; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.5 * rig.input[p - LAT]);
        }
        const s = rig.core.stats();
        expect(s.flips).toBe(1);
        expect(s.drySamples).toBe(0);
        expect(s.silentSamples).toBe(LAT);
    });

    it('positive control: told delay 0 (pre-0.8.88), the same model reads 30 ms LATE against the raw clock', () => {
        // Same scripted 3-hop model, but DfCore believes there is no delay and
        // uses the old 3-hop latency: what comes out is the enhanced input
        // from D*HOP samples EARLIER than the raw delay line at that index.
        const rig = new Rig((x) => x * 0.5, 0, D, 0, LATENCY);
        rig.pump(800, noiseSig);
        let alignedToRaw = 0, alignedLate = 0;
        for (let p = LATENCY + FADE + D * HOP; p < rig.output.length; p++) {
            if (rig.output[p] === 0.5 * rig.input[p - LATENCY]) alignedToRaw++;
            if (rig.output[p] === 0.5 * rig.input[p - LATENCY - D * HOP]) alignedLate++;
        }
        const n = rig.output.length - (LATENCY + FADE + D * HOP);
        expect(alignedLate).toBe(n);
        expect(alignedToRaw).toBeLessThan(n * 0.01); // chance equality (zero samples) only
    });

    it('under a stall the raw fallback is the SAME instant as the enhanced stream it replaces', () => {
        const rig = new Rig((x) => x * 0.5, 0, D);
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);
        const s = rig.core.stats();
        expect(s.flips).toBe(2);
        // Interior of the stall: raw at the SAME timeline index the enhanced
        // stream was being read from — with the pre-0.8.88 offset this would
        // be a 30 ms time jump (a repeated 30 ms of audio).
        const end = rig.output.length;
        let aligned = 0;
        for (let p = end - 20 * QUANTUM; p < end; p++) {
            if (rig.output[p] === rig.input[p - LAT]) aligned++;
        }
        expect(aligned).toBe(20 * QUANTUM);
        // And the whole run — both flips included — stays under the crackle bound.
        rig.paused = false;
        rig.pump(400, sineSig);
        expect(rig.core.stats().flips).toBe(3);
        expect(maxStep(rig.output, LAT + FADE)).toBeLessThan(0.06);
        const tail = rig.output.length - 200 * QUANTUM;
        for (let p = tail; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.5 * rig.input[p - LAT]);
        }
    });

    it('positive control: with the pre-0.8.88 offset the stall fallback IS a time jump', () => {
        const rig = new Rig((x) => x * 0.5, 0, D, 0, LATENCY);
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);
        // Enhanced was 0.5× input[p − LATENCY − D*HOP]; the fallback is
        // input[p − LATENCY]: two different instants of the sine. The declick
        // ramp hides the seam, but the content 30 ms later in the stall is
        // NOT what the enhanced path would have carried at that index.
        const end = rig.output.length;
        let sameInstant = 0;
        for (let p = end - 20 * QUANTUM; p < end; p++) {
            if (rig.output[p] === rig.input[p - LATENCY - D * HOP]) sameInstant++;
        }
        expect(sameInstant).toBeLessThan(100);
    });

    it('absorbs the same worker round-trip budget as before: 2 hops of slack', () => {
        // A worker taking 7 quanta (896 samples < 2 hops = 960) never underruns...
        const ok = new Rig((x) => x * 0.5, 7, D);
        ok.pump(800, noiseSig);
        expect(ok.core.stats().drySamples).toBe(0);
        // ...and one taking 8 quanta (1024 > 960) does — the budget is exactly
        // the 2 hops deepFilter.ts documents, no more.
        const late = new Rig((x) => x * 0.5, 8, D);
        late.pump(800, noiseSig);
        expect(late.core.stats().drySamples).toBeGreaterThan(0);
    });
});

describe('crackle detector positive control', () => {
    it('fires on an injected zero-filled hop — the exact artifact of the old design', () => {
        const rig = new Rig((x) => x * 0.5, 0);
        rig.pump(400, sineSig);
        // Cleanly under the bound to start with.
        expect(maxStep(rig.output, LATENCY + FADE)).toBeLessThan(0.06);

        // Inject what the browser used to do: zero-fill one 480-sample hop in
        // the middle of the emitted stream, no ramp.
        const glitched = rig.output.slice();
        const at = 30000;
        for (let p = at; p < at + HOP; p++) glitched[p] = 0;
        expect(maxStep(glitched, LATENCY + FADE)).toBeGreaterThan(0.2);
    });
});
