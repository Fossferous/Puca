/**
 * Pins the DeepFilter model tuning to MEASURED values.
 *
 * These are not style choices — each number bought a measured behavior:
 *  - minDbThresh -35 (upstream -10): stops the lsnr gate from hard-muting
 *    pauses (37.8% of samples → 0% in the quiet-speaker scenario — the choppy
 *    gated texture) and from eating soft word edges (2.6% → 0.9% of soft
 *    speech windows). (2026-08-05, e2e/df-longrun.mjs seeded sweep against
 *    the "mic gets muffled and quieter as I was talking" field report.)
 *  - attenLimDb 30 (upstream unlimited): floors ANY model mistake — including
 *    the intrinsic ~40 s post-noise recurrent-state latch — at −30 dB with
 *    ~3% dry mixed back, so over-suppression can never reach digital silence.
 *  - maxDbErbThresh 35 / maxDbDfThresh 35: NEVER skip a processing stage.
 *    lsnr is clamped to 35 by the model, so 35 makes upstream's per-frame
 *    CPU-saving skips unreachable. The inherited library defaults (30 / 20)
 *    toggled the deep-filtering stage on and off 7-14 times a second on a
 *    good mic at 30-40 dB SNR: speech −5..−7 dB with 2-3 dB hop-to-hop
 *    warble, vs −0.2 dB / 0.2 dB with 35 / 35 — the 2026-08-17 field report
 *    ("static in the background, voice volume varies"). Measured in
 *    e2e/df-offline.mjs; full table in dfTuning.ts. Upstream's own LADSPA
 *    plugin ships 35 / 35 for the same reason (issue #353).
 *
 * The e2e harness (deepfilter-verify.mjs) catches a full revert to upstream
 * defaults at runtime; a SINGLE-knob edit is not robustly separable by its
 * output metrics, which is exactly what this literal pin is for. If you
 * change these values, bring new sweep data.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_TUNING, POST_FILTER_BETA } from '../api/dfWorker';

describe('DeepFilter production tuning', () => {
    it('matches the measured values (muffled-mic sweep + never-skip thresholds)', () => {
        expect(DEFAULT_TUNING).toEqual({
            attenLimDb: 30,
            minDbThresh: -35,
            maxDbErbThresh: 35,
            maxDbDfThresh: 35,
        });
    });

    it('never lets a stage-skip threshold drop below the lsnr ceiling', () => {
        // The model clamps lsnr to [-15, 35]. Any max threshold below 35 makes
        // upstream's frame-by-frame stage skips reachable, and those are the
        // measured cause of the 2026-08-17 warble — see dfTuning.ts. A future
        // "CPU saving" edit must come with a df-offline.mjs table showing the
        // speech warble at 30-40 dB SNR stays under 0.5 dB.
        expect(DEFAULT_TUNING.maxDbErbThresh).toBeGreaterThanOrEqual(35);
        expect(DEFAULT_TUNING.maxDbDfThresh).toBeGreaterThanOrEqual(35);
    });

    it('keeps the post filter OUT of the defaults and its beta at the measured value', () => {
        // The perceptual post filter is an OPT-IN (Settings → Advanced →
        // Experimental → "DeepFilter background smoothing") targeting the
        // 2026-08-11 musical-noise field report. It must never slide into
        // DEFAULT_TUNING silently — its documented cost is over-attenuation
        // of noisy sections — and 0.02 is upstream's on-value, A/B'd against
        // 0.05 in e2e/df-roughness.mjs. Bring new sweep data to change it.
        expect(DEFAULT_TUNING).not.toHaveProperty('postFilterBeta');
        expect(POST_FILTER_BETA).toBe(0.02);
    });
});
