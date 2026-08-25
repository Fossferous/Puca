/**
 * DeepFilter model-input level normalization — the pure state machine.
 *
 * Lives outside dfWorker.ts so the SAME code runs in the inference Worker, in
 * vitest, and in the offline runner (e2e/df-offline.mjs, which Node imports
 * directly): a port would drift, and every measurement made against a port
 * would be a measurement of the port.
 *
 * Why it exists (field report 2026-08-05, "muffled and quieter as I was
 * talking"): DFN3 is NOT level-invariant. Its ERB features are normalized
 * against per-band running means (norm_tau = 1 s) and its GRUs carry
 * long-lived recurrent state. Measured in e2e/df-longrun.mjs: after
 * background noise rises and then falls, the model over-suppresses SPEECH to
 * 0.54× RMS and takes minutes to recover. A quiet speaker (−12 dB) sits near
 * the lsnr zero-mask gate and gets 40% of samples hard-muted.
 *
 * So: never let the model SEE a level shift. A slow speech-tracking gain
 * normalizes each hop to a stable target before inference, and the SAME
 * factor is divided back out after — the user's true level is preserved in
 * the ratio sense, while the model's adaptive states stay in the regime they
 * converged in.
 *
 * THE INVERSE MUST BE DELAYED BY THE MODEL'S OWN LATENCY. `DfTract::process`
 * for input hop N returns the enhanced samples of hop N − 3 (one hop of STFT
 * framing plus two hops of lookahead), so the factor to divide OUT of the
 * returned hop is the one that was multiplied INTO hop N − 3 — not the one
 * just computed for hop N. Dividing by the current gain (the pre-0.8.88
 * behaviour) makes the "exact inverse" off by g[N−3]/g[N], a slow level
 * error while the gain slews (up to ~1.5% at the slew limit) and an
 * arbitrary step whenever the instant peak clamp engages. `gainForOutput()`
 * returns the correctly delayed factor.
 */
export const LEVEL_TARGET_RMS = 0.1; // active-speech RMS the model likes (~−20 dBFS)
export const LEVEL_GATE_RMS = 0.004; // below this a hop is "silence": adapt nothing
export const LEVEL_ENV_DECAY = Math.exp(-0.01 / 5); // 5 s decay, active hops only
export const LEVEL_SLEW = 0.005; // per-hop gain slew (~2 s to close a gap)
export const LEVEL_GAIN_MIN = 0.5;
export const LEVEL_GAIN_MAX = 8;
export const LEVEL_PEAK_CEIL = 0.98; // never push the model input into clipping

export class LevelNormalizer {
    /** Recent active-speech RMS envelope (frozen in silence). */
    env = 0;
    /** Smoothed normalization gain (the slewed target, before the peak clamp). */
    gain = 1;
    /** The model's algorithmic delay in hops: how far back gainForOutput() looks. */
    readonly delayHops: number;
    /** Ring of the gains ACTUALLY applied to the last `delayHops + 1` hops. */
    private applied: Float64Array;
    private appliedPos = 0;

    /**
     * @param delayHops the model's algorithmic delay in hops (DeepFilter.delay_hops,
     *                  3 for DFN3). (Plain assignment, not a parameter property:
     *                  this file is imported by Node's native type-stripping in
     *                  the offline runner, which only accepts erasable syntax.)
     */
    constructor(delayHops: number) {
        this.delayHops = delayHops;
        // Before any hop has been applied, the model returns its zero-state
        // output (silence): a gain of 1 there is harmless.
        this.applied = new Float64Array(delayHops + 1).fill(1);
    }

    /**
     * Per-hop normalization factor for the samples about to enter the model;
     * adapts the envelope/gain state. Records the factor so the matching
     * inverse can be fetched `delayHops` hops later.
     */
    gainForInput(samples: Float32Array): number {
        let sumSq = 0;
        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
            const v = samples[i];
            sumSq += v * v;
            const a = Math.abs(v);
            if (a > peak) peak = a;
        }
        const rms = Math.sqrt(sumSq / samples.length);
        if (rms > LEVEL_GATE_RMS) {
            // Instant attack (a loud word must not be boosted into the model),
            // slow decay, and NO decay during silence — a long pause must not
            // wind the gain up and pump the first word after it.
            this.env = Math.max(this.env * LEVEL_ENV_DECAY, rms);
            const target = Math.min(LEVEL_GAIN_MAX,
                Math.max(LEVEL_GAIN_MIN, LEVEL_TARGET_RMS / this.env));
            this.gain += (target - this.gain) * LEVEL_SLEW;
        }
        // Hard clip guard: whatever the smoothed gain says, this hop must not
        // exceed |PEAK_CEIL| going into the model.
        const g = peak > 0 ? Math.min(this.gain, LEVEL_PEAK_CEIL / peak) : this.gain;
        this.appliedPos = (this.appliedPos + 1) % this.applied.length;
        this.applied[this.appliedPos] = g;
        return g;
    }

    /**
     * The factor that was applied to the hop the model is returning NOW —
     * i.e. `delayHops` calls of gainForInput() ago. Divide the model output
     * by this.
     */
    gainForOutput(): number {
        const idx = (this.appliedPos - this.delayHops + this.applied.length) % this.applied.length;
        return this.applied[idx];
    }
}
