/**
 * The voice indicator measured the wrong thing.
 *
 * It averaged getByteFrequencyData across all 128 bins and divided by 128 —
 * a dB-MAPPED scale on which silence is not near zero, and on which broadband
 * noise (energy in every bin) outscores speech (energy in a few harmonics).
 * Measured in a real AudioContext at 48 kHz:
 *
 *     signal                     old metric     RMS
 *     digital silence               0.0000    0.00000
 *     quiet room, -60 dBFS          0.0698    0.00058
 *     audible hiss, -40 dBFS        0.5966    0.00577
 *     speech, -20 dBFS              0.0492    0.07071
 *     loud speech, -12 dBFS         0.0568    0.17678
 *
 * Room noise scored HIGHER than speech. The indicator was a noise meter, so it
 * lit for audio noise suppression had already removed — "it seems as though a
 * lot more audio is coming through than what it is".
 *
 * These tests pin the property that matters: speech must outrank noise by a
 * wide margin, and the shipped thresholds must sit between them.
 */
import { describe, it, expect } from 'vitest';
import { rmsAmplitude } from '../api/rtc/media';

/** Local indicator threshold (VoicePanel passes 0.02); 0.01 is the default. */
const LOCAL_THRESHOLD = 0.02;
const DEFAULT_THRESHOLD = 0.01;

const SAMPLES = 2048;

function tone(amplitude: number, hz = 200): Float32Array {
    const a = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) a[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / 48000);
    return a;
}

/** Deterministic pseudo-noise — a seeded LCG, so this can never flake. */
function noise(amplitude: number): Float32Array {
    const a = new Float32Array(SAMPLES);
    let seed = 12345;
    for (let i = 0; i < SAMPLES; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        a[i] = amplitude * ((seed / 0x7fffffff) * 2 - 1);
    }
    return a;
}

describe('rmsAmplitude', () => {
    it('reports zero for digital silence', () => {
        expect(rmsAmplitude(new Float32Array(SAMPLES))).toBe(0);
        expect(rmsAmplitude(new Float32Array(0))).toBe(0);
    });

    it('is the true RMS of a sine (amplitude / sqrt 2)', () => {
        expect(rmsAmplitude(tone(1))).toBeCloseTo(1 / Math.SQRT2, 2);
        expect(rmsAmplitude(tone(0.1))).toBeCloseTo(0.1 / Math.SQRT2, 3);
    });

    it('scales linearly with amplitude, unlike the dB-mapped metric it replaced', () => {
        const quiet = rmsAmplitude(tone(0.01));
        const loud = rmsAmplitude(tone(0.1));
        expect(loud / quiet).toBeCloseTo(10, 1);
    });
});

describe('the thresholds actually separate noise from speech', () => {
    it('suppressed residual and quiet room noise stay BELOW both thresholds', () => {
        // These are the levels that were lighting the indicator before.
        expect(rmsAmplitude(noise(0.0001))).toBeLessThan(DEFAULT_THRESHOLD);
        expect(rmsAmplitude(noise(0.001))).toBeLessThan(DEFAULT_THRESHOLD);
    });

    it('even audible hiss stays below the local threshold', () => {
        expect(rmsAmplitude(noise(0.01))).toBeLessThan(LOCAL_THRESHOLD);
    });

    it('speech clears both thresholds with room to spare', () => {
        const speech = rmsAmplitude(tone(0.1));
        expect(speech).toBeGreaterThan(LOCAL_THRESHOLD);
        expect(speech).toBeGreaterThan(DEFAULT_THRESHOLD);
        // The margin is the whole point: a 10x separation is what stops the
        // indicator reacting to a noise floor.
        expect(speech / rmsAmplitude(noise(0.01))).toBeGreaterThan(10);
    });

    it('speech outranks noise — the inversion that caused the bug', () => {
        // Under the OLD metric this was false: hiss (0.5966) beat speech
        // (0.0492) more than tenfold.
        expect(rmsAmplitude(tone(0.1))).toBeGreaterThan(rmsAmplitude(noise(0.01)));
    });
});
