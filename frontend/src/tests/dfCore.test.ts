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
    /** The `fresh` flag of every hop sent, in order. */
    fresh: boolean[] = [];
    /** What input 1 (the RNNoise bridge) carries at timeline index i; null =
     *  nothing connected. Set it to model a bridge that is live, not loaded
     *  yet, or dies. */
    bridgeFn: ((i: number) => number) | null = null;
    private transform: (x: number) => number;
    private delayQuanta: number;

    constructor(
        transform: (x: number) => number = (x) => x * 0.5,
        delayQuanta = 0,
        modelDelayHops = 0,
        coreModelDelay = modelDelayHops * HOP,
        latency = LATENCY + coreModelDelay,
        bridgeDelay: number | null = null,
        prerollHops?: number,
    ) {
        this.transform = transform;
        this.delayQuanta = delayQuanta;
        for (let i = 0; i < modelDelayHops; i++) this.modelQueue.push(new Float32Array(HOP));
        this.core = new DfCore(HOP, latency, (hopView: Float32Array, fresh: boolean) => {
            this.fresh.push(fresh);
            if (!this.respond) return;
            // Contract: the view is scratch, valid only during the call.
            this.modelQueue.push(new Float32Array(hopView));
            const answers = this.modelQueue.shift()!;
            this.pending.push({ deliverAt: this.quantum + this.delayQuanta, data: answers });
        }, coreModelDelay, bridgeDelay, prerollHops);
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
        const bridgeBuf = new Float32Array(QUANTUM);
        for (let q = 0; q < quanta; q++) {
            this.deliverDue();
            const base = this.input.length;
            if (gen) {
                for (let i = 0; i < QUANTUM; i++) inBuf[i] = gen(base + i);
            }
            if (this.bridgeFn) {
                for (let i = 0; i < QUANTUM; i++) bridgeBuf[i] = this.bridgeFn(base + i);
            }
            this.core.processQuantum(gen ? inBuf : null, outBuf, this.bridgeFn ? bridgeBuf : null);
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

// The RNNoise worklet's latency (rnnoiseNode.ts): its output at timeline index
// i renders the input at i − 992. The scripted bridge below renders 0.25×, so
// every sample says which source produced it: 0.5× DeepFilter, 0.25× bridge,
// 1× raw.
const BRIDGE_DELAY = 992;
const BRIDGE_WARMUP = 1920; // mirrors dfWorklet.js
const liveBridge = (rig: Rig, from = 0, until = Infinity) => (i: number) =>
    i >= from && i < until && i >= BRIDGE_DELAY ? 0.25 * rig.input[i - BRIDGE_DELAY] : 0;
const bridgedRig = () => new Rig((x) => x * 0.5, 0, 0, 0, LATENCY, BRIDGE_DELAY);

describe('DfCore RNNoise bridge', () => {
    it('covers a stalled worker with the bridge, sample-aligned, and hands back exactly', () => {
        const rig = bridgedRig();
        rig.bridgeFn = liveBridge(rig);
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);
        rig.paused = false;
        rig.pump(400, sineSig);

        const s = rig.core.stats();
        expect(s.flips).toBe(3); // processed → bridge → processed
        expect(s.bridgeSamples).toBeGreaterThan(0);
        expect(s.drySamples).toBe(0); // not one unsuppressed sample
        expect(maxStep(rig.output, LATENCY + FADE)).toBeLessThan(0.06);

        // The stall interior is the bridge's rendering of the SAME instant.
        const stallEnd = 440 * QUANTUM;
        for (let p = stallEnd - 20 * QUANTUM; p < stallEnd; p++) {
            expect(rig.output[p]).toBe(0.25 * rig.input[p - LATENCY]);
        }
        // ...and DeepFilter is back, exactly, once the worker catches up.
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.5 * rig.input[p - LATENCY]);
        }
    });

    it('positive control: the oracle tells the three sources apart', () => {
        const x = sineSig(1000);
        expect(new Set([x, 0.5 * x, 0.25 * x]).size).toBe(3);
    });

    it('a bridge that has produced nothing (wasm still loading) is not trusted: raw covers', () => {
        const rig = bridgedRig();
        rig.bridgeFn = () => 0; // exactly what the RNNoise node emits before it loads
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);
        const s = rig.core.stats();
        expect(s.bridgeSamples).toBe(0);
        expect(s.drySamples).toBeGreaterThan(0);
        expect(s.bridgeLive).toBe(false);
        const end = rig.output.length;
        for (let p = end - 20 * QUANTUM; p < end; p++) {
            expect(rig.output[p]).toBe(rig.input[p - LATENCY]);
        }
    });

    it('a bridge that dies mid-stall hands over to raw at the last instant it rendered', () => {
        const rig = bridgedRig();
        const dies = 53_000; // inside the stall below
        rig.bridgeFn = liveBridge(rig, 0, dies);
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);

        // The bridge's last non-zero sample is at dies − 1 (the sine is not 0
        // there), so it renders every e with e + 992 ≤ dies − 1 and no later.
        const lastRendered = dies - 1 - BRIDGE_DELAY; // the last e it covers
        const flipAt = lastRendered + 1 + LATENCY; // first p on raw
        for (let p = flipAt - 400; p < flipAt; p++) {
            expect(rig.output[p]).toBe(0.25 * rig.input[p - LATENCY]);
        }
        for (let p = flipAt + FADE; p < flipAt + 1000; p++) {
            expect(rig.output[p]).toBe(rig.input[p - LATENCY]);
        }
        // Never a stretch of silence in between: dead RNNoise output is zeros.
        expect(maxStep(rig.output, LATENCY + FADE)).toBeLessThan(0.06);
    });

    it('waits out the RNNoise warm-up after it starts producing', () => {
        const rig = bridgedRig();
        const loads = 52_000; // the bridge comes alive during the stall
        rig.bridgeFn = liveBridge(rig, loads);
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);
        // bridgeFirst is the first non-zero sample at or after `loads`.
        const firstUsableE = loads + BRIDGE_WARMUP - BRIDGE_DELAY;
        const p0 = firstUsableE + LATENCY;
        expect(rig.output[p0 - FADE - 1]).toBe(rig.input[p0 - FADE - 1 - LATENCY]); // still raw
        for (let p = p0 + FADE; p < p0 + 1000; p++) {
            expect(rig.output[p]).toBe(0.25 * rig.input[p - LATENCY]);
        }
    });

    it('an unconnected bridge input leaves the raw fallback exactly as it was', () => {
        const rig = bridgedRig(); // bridge configured, nothing plugged into input 1
        rig.pump(400, sineSig);
        rig.paused = true;
        rig.pump(40, sineSig);
        expect(rig.core.stats().bridgeSamples).toBe(0);
        const end = rig.output.length;
        for (let p = end - 20 * QUANTUM; p < end; p++) {
            expect(rig.output[p]).toBe(rig.input[p - LATENCY]);
        }
    });
});

describe('DfCore overload episodes', () => {
    const stallUntilOverloaded = (rig: Rig) => {
        rig.paused = true;
        while (rig.core.stats().outstanding < 50) rig.pump(1, sineSig);
    };

    it('an episode starts at 50 hops in flight and ends only after a second caught up', () => {
        const rig = bridgedRig();
        rig.bridgeFn = liveBridge(rig);
        rig.pump(100, sineSig);
        expect(rig.core.stats().overloaded).toBe(false);

        stallUntilOverloaded(rig);
        expect(rig.core.stats().overloaded).toBe(true);
        expect(rig.core.stats().overloadEpisodes).toBe(1);

        rig.paused = false;
        rig.pump(1, sineSig); // the whole backlog lands at once
        expect(rig.core.stats().outstanding).toBeLessThanOrEqual(4);
        rig.pump(370, sineSig); // 0.99 s caught up: not yet
        expect(rig.core.stats().overloaded).toBe(true);
        rig.pump(10, sineSig); // past 48 000 samples
        expect(rig.core.stats().overloaded).toBe(false);

        // The next stall is a NEW episode. The old design latched once.
        stallUntilOverloaded(rig);
        expect(rig.core.stats().overloaded).toBe(true);
        expect(rig.core.stats().overloadEpisodes).toBe(2);
    });

    it('a backlog that keeps building again does not end the episode', () => {
        const rig = bridgedRig();
        rig.pump(100, sineSig);
        stallUntilOverloaded(rig);
        // Catch up for half a second, stall again for 0.1 s, repeatedly: each
        // stall pushes more than 4 hops back in flight.
        for (let k = 0; k < 6; k++) {
            rig.paused = false;
            rig.pump(190, sineSig);
            rig.paused = true;
            rig.pump(40, sineSig);
        }
        expect(rig.core.stats().overloaded).toBe(true);
        expect(rig.core.stats().overloadEpisodes).toBe(1);
    });

    it('standby over a dead bridge reports it once the raw mic has been on air for 100 ms', () => {
        const rig = bridgedRig();
        const dies = 60_000;
        rig.bridgeFn = liveBridge(rig, 0, dies);
        rig.pump(400, sineSig);
        rig.core.enterStandby();
        rig.pump(20, sineSig); // bridge still live: it carries the call
        expect(rig.core.bridgeFailed()).toBe(false);
        rig.pump(200, sineSig); // bridge died at 60 000: raw on air
        expect(rig.core.stats().rawUncovered).toBeGreaterThanOrEqual(4800);
        expect(rig.core.bridgeFailed()).toBe(true);
    });

    it('positive control: a live bridge in standby, or a silent mic, never reports it', () => {
        const live = bridgedRig();
        live.bridgeFn = liveBridge(live);
        live.pump(400, sineSig);
        live.core.enterStandby();
        live.pump(400, sineSig);
        expect(live.core.bridgeFailed()).toBe(false);

        const muted = bridgedRig();
        muted.bridgeFn = liveBridge(muted, 0, 40_000);
        muted.pump(400, sineSig);
        muted.core.enterStandby();
        muted.pump(400, () => 0); // OS-muted mic: zeros in, zeros from both
        expect(muted.core.stats().inputLive).toBe(false);
        expect(muted.core.bridgeFailed()).toBe(false);
    });

    it('a bridge that dies DURING an episode (no standby yet) is reported too', () => {
        const rig = bridgedRig();
        rig.bridgeFn = liveBridge(rig, 0, 60_000);
        rig.pump(400, sineSig); // to 51 200
        stallUntilOverloaded(rig); // bridge still live and covering
        expect(rig.core.bridgeFailed()).toBe(false);
        rig.pump(120, sineSig); // past 60 000 plus 100 ms of raw on air
        expect(rig.core.stats().standby).toBe(false);
        expect(rig.core.bridgeFailed()).toBe(true);
    });

    it('positive control: a live bridge through a long episode never reports', () => {
        const rig = bridgedRig();
        rig.bridgeFn = liveBridge(rig);
        rig.pump(400, sineSig);
        stallUntilOverloaded(rig);
        rig.pump(400, sineSig);
        expect(rig.core.stats().overloaded).toBe(true);
        expect(rig.core.stats().bridgeSamples).toBeGreaterThan(0);
        expect(rig.core.bridgeFailed()).toBe(false);
    });

    it('judges the mic over the window the bridge has rendered, so a sound onset is not a dead bridge', () => {
        const rig = bridgedRig();
        rig.bridgeFn = liveBridge(rig);
        const onset = 60_000;
        const sig: Signal = (i) => (i < onset ? 0 : sineSig(i));
        rig.pump(Math.ceil(onset / QUANTUM) + 4, sig); // ~500 samples past the onset
        const s = rig.core.stats();
        // The bridge has not rendered the onset yet (992 behind), so it is
        // silent, and so is the mic over the window it HAS rendered.
        expect(s.bridgeLive).toBe(false);
        expect(s.inputLive).toBe(false);
        // POSITIVE CONTROL: the unshifted window does hold sound already, so
        // judging it there would have called a healthy bridge dead.
        const recent = rig.input.slice(-500);
        expect(recent.some((v) => v !== 0)).toBe(true);
        // Once RNNoise's output reaches the onset, both are live.
        rig.pump(20, sig);
        expect(rig.core.stats().bridgeLive).toBe(true);
        expect(rig.core.stats().inputLive).toBe(true);
    });

    it('standby stops feeding the worker and the bridge carries everything after', () => {
        const rig = bridgedRig();
        rig.bridgeFn = liveBridge(rig);
        rig.pump(400, sineSig);
        const sent = rig.core.stats().hopsSent;
        rig.core.enterStandby();
        rig.pump(400, sineSig);
        const s = rig.core.stats();
        expect(s.hopsSent).toBe(sent);
        expect(s.standby).toBe(true);
        expect(s.drySamples).toBe(0);
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(0.25 * rig.input[p - LATENCY]);
        }
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

/**
 * PAUSE / RESUME (2026-10-04): while nobody can hear the mic, dfPause.ts
 * pauses DeepFilter. These run the DFN3-shaped rig (3-hop model delay, emit
 * latency 6 hops, live RNNoise bridge) and pin what the room hears across a
 * pause: the bridge from the first sample, never raw, never silence; on
 * resume, the bridge until DeepFilter has answers for the instant on air,
 * then the declicked switch back; and never one sample of the model's stale
 * state (its lookahead still holds the hops sent before the pause).
 */
describe('DfCore pause / resume', () => {
    const MODEL = 3; // DFN3's delay in hops
    const L = LATENCY + MODEL * HOP; // 2880: deepFilter.ts's emit latency for DFN3
    const dfnRig = (delayQuanta = 0, prerollHops?: number) => {
        const rig = new Rig((x) => x * 0.5, delayQuanta, MODEL, MODEL * HOP, L, BRIDGE_DELAY, prerollHops);
        rig.bridgeFn = liveBridge(rig);
        return rig;
    };
    const processedAt = (rig: Rig, p: number) => 0.5 * rig.input[p - L];
    const bridgeAt = (rig: Rig, p: number) => 0.25 * rig.input[p - L];
    /** Every output sample from `from` on, classified against the two
     *  renderings of the SAME instant. Anything else is either a declick ramp
     *  (at most FADE samples after a flip) or a defect: stale audio. */
    const classify = (rig: Rig, from: number) => {
        let processed = 0; let bridge = 0; const other: number[] = [];
        for (let p = from; p < rig.output.length; p++) {
            if (rig.output[p] === processedAt(rig, p)) processed++;
            else if (rig.output[p] === bridgeAt(rig, p)) bridge++;
            else other.push(p);
        }
        return { processed, bridge, other };
    };
    /** The ramps: every unclassified sample sits within FADE after the start
     *  of a run of unclassified samples, and there are at most `flips` runs. */
    const onlyRamps = (other: number[], flips: number) => {
        const runs: number[][] = [];
        for (const p of other) {
            const run = runs[runs.length - 1];
            if (run && p === run[run.length - 1] + 1) run.push(p); else runs.push([p]);
        }
        return runs.length <= flips && runs.every(r => r.length <= FADE);
    };
    /** The resume a naive design would do: carry on from NOW (skip the paused
     *  stretch), keep every answer. The model's lookahead still holds the
     *  last pre-pause hops, so its first answers are stale audio, placed on
     *  the instants just after the resume. */
    const naiveResume = (core: InstanceType<typeof DfCore>) => {
        core.paused = false;
        core.sentPos += Math.floor((core.inPos - core.sentPos) / HOP) * HOP;
        core.enhHigh = core.sentPos - MODEL * HOP;
    };

    it('paused: not one hop goes to the Worker, and the bridge carries every sample (no raw, no silence)', () => {
        const rig = dfnRig();
        rig.pump(400, sineSig);
        const before = rig.core.stats();
        expect(rig.core.pause()).toBe(true);
        rig.pump(400, sineSig);
        const s = rig.core.stats();
        expect(s.hopsSent).toBe(before.hopsSent);
        expect(s.paused).toBe(true);
        expect(s.pausedSamples).toBe(400 * QUANTUM);
        expect(s.drySamples).toBe(0);
        expect(s.silentSamples).toBe(before.silentSamples);
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(bridgeAt(rig, p));
        }
        expect(maxStep(rig.output, L + FADE)).toBeLessThan(0.06);
    });

    it('a long pause resumes on fresh audio only: every sample is DeepFilter or the bridge of the SAME instant, never stale', () => {
        const rig = dfnRig();
        rig.pump(400, noiseSig);
        rig.core.pause();
        rig.pump(400, noiseSig); // ~1 s: far past the pre-roll
        const flips0 = rig.core.stats().flips;
        const resumeP = rig.output.length;
        expect(rig.core.resume()).toBe(true);
        rig.pump(400, noiseSig);
        const s = rig.core.stats();
        const c = classify(rig, resumeP);
        // One flip back to DeepFilter, its ramp the only unclassified stretch.
        expect(s.flips - flips0).toBe(1);
        expect(onlyRamps(c.other, 1)).toBe(true);
        expect(c.bridge).toBeGreaterThan(0); // the bridge covered the resume
        expect(s.drySamples).toBe(0);
        // ...and DeepFilter is back, exactly.
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(processedAt(rig, p));
        }
    });

    it('positive control: a naive resume puts the model\'s stale lookahead on air, and the oracle sees it', () => {
        const rig = dfnRig();
        rig.pump(400, noiseSig);
        rig.core.pause();
        rig.pump(400, noiseSig);
        const flips0 = rig.core.stats().flips;
        const resumeP = rig.output.length;
        naiveResume(rig.core);
        rig.pump(400, noiseSig);
        const c = classify(rig, resumeP);
        expect(onlyRamps(c.other, rig.core.stats().flips - flips0)).toBe(false);
        expect(c.other.length).toBeGreaterThanOrEqual(MODEL * HOP - FADE);
    });

    it('the guard alone keeps the stale lookahead off air: with a 4-hop pre-roll it would land after the emit point', () => {
        // At 16 hops the stale answers land in the past anyway; at 4 they land
        // ~20 ms AHEAD of what is on air, so only enhLow keeps them off.
        const rig = dfnRig(0, 4);
        rig.pump(400, noiseSig);
        rig.core.pause();
        rig.pump(400, noiseSig);
        const resumeP = rig.output.length;
        rig.core.resume();
        rig.pump(400, noiseSig);
        const c = classify(rig, resumeP);
        expect(onlyRamps(c.other, 1)).toBe(true);
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(processedAt(rig, p));
        }
    });

    it('positive control: the same 4-hop resume without the guard puts stale audio on air', () => {
        const rig = dfnRig(0, 4);
        rig.pump(400, noiseSig);
        rig.core.pause();
        rig.pump(400, noiseSig);
        const flips0 = rig.core.stats().flips;
        const resumeP = rig.output.length;
        rig.core.resume();
        rig.core.enhLow = -Infinity; // no guard
        rig.pump(400, noiseSig);
        const c = classify(rig, resumeP);
        expect(onlyRamps(c.other, rig.core.stats().flips - flips0)).toBe(false);
    });

    it('answers still in flight from before a long pause are dropped, not placed on the new stretch', () => {
        const rig = dfnRig();
        rig.pump(400, noiseSig);
        rig.paused = true; // the Worker stalls: answers pile up undelivered
        rig.pump(20, noiseSig);
        const owed = rig.core.stats().outstanding;
        expect(owed).toBeGreaterThan(0);
        rig.core.pause();
        rig.pump(300, noiseSig);
        const resumeP = rig.output.length;
        rig.core.resume();
        rig.pump(1, noiseSig);
        rig.paused = false; // the backlog lands, oldest first
        rig.pump(400, noiseSig);
        const c = classify(rig, resumeP);
        expect(onlyRamps(c.other, 1)).toBe(true);
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(processedAt(rig, p));
        }
    });

    it('positive control: placing those stale answers instead is visible to the same oracle', () => {
        const rig = dfnRig();
        rig.pump(400, noiseSig);
        rig.paused = true;
        rig.pump(20, noiseSig);
        rig.core.pause();
        rig.pump(300, noiseSig);
        const flips0 = rig.core.stats().flips;
        const resumeP = rig.output.length;
        rig.core.resume();
        rig.core.staleReturns = 0; // as if the resume kept them
        rig.pump(1, noiseSig);
        rig.paused = false;
        rig.pump(400, noiseSig);
        const c = classify(rig, resumeP);
        expect(onlyRamps(c.other, rig.core.stats().flips - flips0)).toBe(false);
    });

    it('a short pause (under the pre-roll) just continues: the missed hops go out at once, contiguous, no fresh start', () => {
        const rig = dfnRig();
        rig.pump(400, noiseSig);
        rig.core.pause();
        const sentAtPause = rig.core.sentPos;
        rig.pump(10, noiseSig); // 1280 samples: well under 16 hops
        const n0 = rig.fresh.length;
        rig.core.resume();
        rig.pump(1, noiseSig);
        expect(rig.core.sentPos).toBe(sentAtPause + Math.floor((rig.core.inPos - sentAtPause) / HOP) * HOP);
        expect(rig.core.staleReturns).toBe(0);
        expect(rig.fresh.slice(n0).every(f => f === false)).toBe(true);
        rig.pump(400, noiseSig);
        expect(rig.core.stats().drySamples).toBe(0);
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(processedAt(rig, p));
        }
    });

    it('a long resume marks exactly its first hop fresh (the Worker\'s seam detector skips that jump)', () => {
        const rig = dfnRig();
        rig.pump(400, noiseSig);
        rig.core.pause();
        rig.pump(400, noiseSig);
        const n0 = rig.fresh.length;
        rig.core.resume();
        rig.pump(50, noiseSig);
        const after = rig.fresh.slice(n0);
        expect(after[0]).toBe(true);
        expect(after.slice(1).every(f => f === false)).toBe(true);
        expect(after.length).toBeGreaterThanOrEqual(16); // the whole pre-roll went out
    });

    it('no click either way: sine continuity holds through pause and resume, two flips, all bridged', () => {
        const rig = dfnRig();
        rig.pump(400, sineSig);
        const f0 = rig.core.stats().flips;
        rig.core.pause();
        rig.pump(300, sineSig);
        rig.core.resume();
        rig.pump(300, sineSig);
        const s = rig.core.stats();
        expect(s.flips - f0).toBe(2); // processed -> bridge -> processed
        expect(s.drySamples).toBe(0);
        expect(maxStep(rig.output, L + FADE)).toBeLessThan(0.06);
    });

    it('reports how long the bridge carried a resume: exactly until the first DeepFilter sample', () => {
        const rig = dfnRig(4); // a Worker answering 4 quanta (~11 ms) late
        rig.pump(400, noiseSig);
        rig.core.pause();
        rig.pump(400, noiseSig);
        const resumeP = rig.output.length;
        rig.core.resume();
        rig.pump(200, noiseSig);
        let firstNotBridge = resumeP;
        while (rig.output[firstNotBridge] === bridgeAt(rig, firstNotBridge)) firstNotBridge++;
        const cover = rig.core.stats().lastResumeCover;
        expect(cover).toBe(firstNotBridge - resumeP);
        // A pre-roll answered ~11 ms late is on air within a few tens of ms.
        expect(cover).toBeGreaterThan(0);
        expect(cover).toBeLessThan(48 * 30); // 30 ms at 48 kHz
    });

    it('push-to-talk chatter (50 short presses) stays exact, click-free and never trips an overload episode', () => {
        const rig = dfnRig(2);
        rig.pump(400, sineSig);
        for (let k = 0; k < 50; k++) {
            rig.core.pause();
            rig.pump(20 + (k % 7) * 30, sineSig); // 50 ms .. 500 ms released
            rig.core.resume();
            rig.pump(40 + (k % 5) * 20, sineSig); // 100 ms .. 300 ms held
        }
        rig.pump(400, sineSig);
        const s = rig.core.stats();
        expect(s.overloadEpisodes).toBe(0);
        expect(s.drySamples).toBe(0);
        expect(s.pauses).toBe(50);
        expect(s.resumes).toBe(50);
        expect(maxStep(rig.output, L + FADE)).toBeLessThan(0.06);
        for (let p = rig.output.length - 200 * QUANTUM; p < rig.output.length; p++) {
            expect(rig.output[p]).toBe(processedAt(rig, p));
        }
    });

    it('pause and resume are idempotent, and no-ops once in standby', () => {
        const rig = dfnRig();
        rig.pump(100, sineSig);
        expect(rig.core.resume()).toBe(false); // not paused
        expect(rig.core.pause()).toBe(true);
        expect(rig.core.pause()).toBe(false);
        expect(rig.core.resume()).toBe(true);
        expect(rig.core.resume()).toBe(false);
        rig.core.enterStandby();
        expect(rig.core.pause()).toBe(false);
        expect(rig.core.resume()).toBe(false);
        const sent = rig.core.stats().hopsSent;
        rig.pump(100, sineSig);
        expect(rig.core.stats().hopsSent).toBe(sent);
    });

    it('a bridge that dies while paused is reported once the raw mic has been on air for 100 ms', () => {
        const rig = dfnRig();
        const dies = 400 * QUANTUM + 20_000;
        rig.bridgeFn = liveBridge(rig, 0, dies);
        rig.pump(400, sineSig);
        rig.core.pause();
        rig.pump(150, sineSig);
        // ~40 ms of raw so far (it died 20 000 samples in): not yet.
        expect(rig.core.bridgeFailed()).toBe(false);
        rig.pump(150, sineSig);
        expect(rig.core.bridgeFailed()).toBe(true);
    });

    it('positive control: a live bridge through a long pause never reports', () => {
        const rig = dfnRig();
        rig.pump(400, sineSig);
        rig.core.pause();
        rig.pump(800, sineSig);
        expect(rig.core.bridgeFailed()).toBe(false);
        expect(rig.core.stats().rawUncovered).toBe(0);
    });
});
