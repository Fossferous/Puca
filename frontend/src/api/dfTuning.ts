/**
 * DeepFilter model runtime tuning — shared between the inference Worker
 * (dfWorker.ts, which passes these to the wasm constructor) and the main
 * bundle (noiseFilter.ts, which builds the per-user tuning object). A separate
 * module because importing dfWorker.ts from the main bundle would pull the
 * worker's wasm glue into the main chunk graph.
 */
export type DfTuning = {
    attenLimDb?: number;
    minDbThresh?: number;
    postFilterBeta?: number;
    maxDbErbThresh?: number;
    maxDbDfThresh?: number;
};

/**
 * Production defaults. MEASURED constants — change only with new sweep data.
 *
 * - attenLimDb 30 / minDbThresh -35: the 2026-08-05 seeded A/B sweep
 *   (e2e/df-longrun.mjs) against the reproduced "muffled and quieter" field
 *   failure — see the knob docs in dfWorker.ts and the pin in dfTuning.test.ts.
 *
 * - maxDbErbThresh 35 / maxDbDfThresh 35: NEVER skip a processing stage. These
 *   are upstream's per-frame CPU-saving switches: when the model's local-SNR
 *   estimate exceeds maxDbDfThresh the deep-filtering stage is skipped (ERB
 *   mask only), and above maxDbErbThresh the frame is passed through RAW. The
 *   library struct default (RuntimeParams::default_with_ch) is 30 / 20, and
 *   that is what this build inherited through v0.8.87 — but no upstream
 *   real-time surface ships it: the LADSPA plugin's control ports default to
 *   35 / 35 (the maintainer's own hotfix for "[LADSPA] real-time processing
 *   produces bad quality", DeepFilterNet issue #353) and so does the offline
 *   CLI that makes their demos. lsnr is clamped to lsnr_max = 35, so 35 means
 *   the branch is unreachable.
 *
 *   Measured 2026-08-17 with e2e/df-offline.mjs (production wasm + the
 *   production level wrapper, TTS speech at -26 dBFS active RMS, steady-state
 *   loop, three noise colours). At the SNRs a headset in a room actually
 *   produces the skips toggle frame to frame as lsnr dithers across 20 (and,
 *   with pink/lp noise or a quiet mic, across 30):
 *
 *     SNR 40 pink   30/20: pass 13.7% mask 53.1% full 33.2%, 14.2 toggles/s,
 *                   speech level -6.40 dB, speech warble 2.70 dB (hop-to-hop)
 *                   35/35: speech level -0.22 dB, warble 0.18 dB
 *     SNR 30 white  30/20: mask 25.5%, 7.0 toggles/s, -4.96 dB, warble 2.52 dB
 *                   35/35: -0.22 dB, warble 0.18 dB  (upstream CLI: -0.21/0.19)
 *     SNR 20 white  30/20: mask 0.3%, 0.4 toggles/s, warble 1.03 dB
 *                   35/35: warble 0.20 dB
 *     SNR ≤ 10      identical (lsnr never reaches 20 — the switches are inert)
 *
 *   One-factor attribution at SNR 30 (upstream CLI config with ONE knob moved):
 *   only the 30/20 switches reproduce the damage (-5.47 dB / 2.95 dB warble);
 *   attenLimDb 30, minDbThresh -35, and the level wrapper (either inverse
 *   mode) each measure within run noise of upstream. Cost of never skipping:
 *   ~1.45 -> ~1.63 ms/hop inference (+12%) against a 10 ms budget.
 *
 *   Per regime (df-offline.mjs "speechLevel by regime", pink noise,
 *   speech-dominant cells): frames where the DF stage was skipped carry
 *   speech at -12.45 dB (SNR 30) / -10.87 dB (SNR 40), deep-filtered frames
 *   -0.78 / -0.66 dB, raw pass-through -0.02 dB — the ERB mask alone
 *   under-reconstructs the low band the DF stage was trained to carry — so at
 *   7-14 switches a second the voice level pumps by ~11-12 dB and the
 *   low-band residual flickers: the field report's "static in the background"
 *   and "voice volume varies", on exactly the good mic / quiet room where
 *   RNNoise (which has no such switch) stays clean. A 30/20 config WITH the
 *   near-silence floor measures identically, so none of this is the
 *   early-return transient — it is the thresholds alone.
 */
export const DEFAULT_TUNING: DfTuning = {
    attenLimDb: 30,
    minDbThresh: -35,
    maxDbErbThresh: 35,
    maxDbDfThresh: 35,
};

/**
 * Beta used when the user opts into the perceptual post filter (Settings →
 * Advanced → Experimental → "DeepFilter background smoothing") — upstream's
 * anti-musical-noise gain reshaping (Valin et al.): speech-dominated bins pass
 * untouched, low-gain residual bins get pushed further down, which is what
 * suppresses the watery/warbly "musical noise" texture a mask-based suppressor
 * can leave in steady background noise (field report 2026-08-11).
 *
 * 0.02 is upstream's own value when the filter is on, and the e2e/df-roughness
 * sweep measured it against 0.05 — see the results table in that file's
 * header. df-offline.mjs (2026-08-17) agrees: about 1 dB more residual
 * suppression for ~0.5 dB more floor jitter, speech untouched. Not
 * transformative either way, so it stays an OPT-IN toggle.
 */
export const POST_FILTER_BETA = 0.02;
