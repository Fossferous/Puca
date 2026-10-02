/**
 * The speaking indicator's DECISION — pure, so it is testable without a
 * browser. MediaManager.createVoiceActivityDetector feeds it one level per
 * tick, read from the PUBLISHED track (after noise suppression, the gain stage
 * and the mute/PTT gate).
 *
 * What it measures: the RMS of (nearly) the whole tick, not a snapshot.
 * Through 0.9.830 the analyser window was 256 samples — 5.3 ms out of every
 * 50 ms — and one snapshot over the threshold lit the ring. That made it a
 * TRANSIENT detector: a keystroke the suppressor has cut by 30 dB (DeepFilter's
 * attenuation limit) still leaves a millisecond-scale tick, and a 5 ms window
 * that lands on it reads as loud as speech, although over any 50 ms of the
 * sent track it is well below speech level and the room hears nothing —
 * the owner's report after 0.9.830, which put his desk mic back at 100 %
 * (Chromium had been holding it at 7.8 %, 22 dB lower). See
 * tests/speakingIndicatorSent.test.ts and e2e/vad-filtered-real-browser.mjs.
 *
 * Two changes, each cheap:
 *  - the window covers the tick (vadWindowSize: 2048 samples ≈ 43 ms at
 *    48 kHz), so a tick's energy is averaged over the time it actually
 *    occupies instead of sampled at random phase;
 *  - ON needs the level over the threshold on ATTACK_TICKS consecutive ticks
 *    (~50-100 ms of sustained sound). A syllable lasts longer than that; a
 *    click does not. OFF is unchanged: RELEASE_TICKS quiet ticks (200 ms).
 */

/** How often the detector reads its analyser. */
export const VAD_TICK_MS = 50;
/** Consecutive loud ticks before the ring lights. */
export const VAD_ATTACK_TICKS = 2;
/** Consecutive quiet ticks before it goes dark (4 × 50 ms = 200 ms). */
export const VAD_RELEASE_TICKS = 4;

/**
 * Analyser window for a context at `sampleRate`: the largest power of two
 * (AnalyserNode.fftSize must be one, 32..32768) that fits inside one tick,
 * so consecutive reads cover the signal without counting any sample twice.
 * 2048 at 44.1 and 48 kHz.
 */
export function vadWindowSize(sampleRate: number): number {
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    const fit = Math.max(32, Math.floor((rate * VAD_TICK_MS) / 1000));
    return Math.min(32768, 2 ** Math.floor(Math.log2(fit)));
}

export class SpeakingDecision {
    private speaking = false;
    private loudTicks = 0;
    private quietTicks = 0;
    private readonly threshold: number;

    constructor(threshold: number) {
        this.threshold = threshold;
    }

    /** Feed one tick's RMS level. Returns the new state when it flips, else null. */
    update(level: number): boolean | null {
        if (level > this.threshold) {
            this.quietTicks = 0;
            this.loudTicks++;
            if (!this.speaking && this.loudTicks >= VAD_ATTACK_TICKS) {
                this.speaking = true;
                return true;
            }
        } else {
            this.loudTicks = 0;
            this.quietTicks++;
            if (this.speaking && this.quietTicks >= VAD_RELEASE_TICKS) {
                this.speaking = false;
                return false;
            }
        }
        return null;
    }
}
