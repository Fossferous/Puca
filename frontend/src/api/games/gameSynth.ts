/**
 * The card table's sounds, synthesized with Web Audio - no recordings, so no
 * third-party audio and nothing to license. Each sound is a few hundred
 * milliseconds of filtered noise and short tones under a fast envelope:
 *
 *   deal   a card sliding across the felt  (band-passed noise, 90 ms)
 *   flip   a card snapped face up          (high-passed noise + a tick)
 *   chips  chips set down                   (three short clicks)
 *   check  two knuckle taps on the table    (a falling low thump, twice)
 *   fold   cards pushed away                (noise under a closing filter)
 *   win    a small rising arpeggio
 *   turn   a two-note "your turn" chime
 *
 * `level` is the PEAK gain any one sound reaches (the caller multiplies the
 * game level by the master Output Volume); the parts of a sound are scaled
 * so their sum stays at or under it.
 *
 * No imports and no globals: e2e/game-sounds-offline-real-browser.mjs bundles
 * this file alone and renders every sound in an OfflineAudioContext (to a
 * buffer, never a speaker) to measure its peak and length.
 */

export type SynthCue = 'deal' | 'flip' | 'chips' | 'check' | 'fold' | 'win' | 'turn';

/** How long each sound lasts, in seconds (the offline render checks it). */
export const CUE_SECONDS: Record<SynthCue, number> = {
    deal: 0.1,
    flip: 0.08,
    chips: 0.14,
    check: 0.26,
    fold: 0.24,
    win: 0.6,
    turn: 0.34,
};

const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>();

/** Half a second of white noise per context, made once. */
function noise(ctx: BaseAudioContext): AudioBuffer {
    let b = noiseBuffers.get(ctx);
    if (!b) {
        const len = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
        b = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = b.getChannelData(0);
        // A fixed LCG, not Math.random: every render of a sound is the same.
        let x = 0x2545f491;
        for (let i = 0; i < len; i++) {
            x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
            data[i] = (x / 0xffffffff) * 2 - 1;
        }
        noiseBuffers.set(ctx, b);
    }
    return b;
}

/** A gain node shaped as attack -> exponential decay, peaking at `peak`. */
function envelope(ctx: BaseAudioContext, out: AudioNode, when: number, peak: number, attack: number, decay: number): GainNode {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, when + attack + decay);
    g.connect(out);
    return g;
}

function noiseBurst(
    ctx: BaseAudioContext,
    out: AudioNode,
    when: number,
    peak: number,
    attack: number,
    decay: number,
    filter: { type: BiquadFilterType; freq: number; q?: number; sweepTo?: number },
) {
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.setValueAtTime(filter.freq, when);
    if (filter.sweepTo !== undefined) f.frequency.exponentialRampToValueAtTime(filter.sweepTo, when + attack + decay);
    f.Q.setValueAtTime(filter.q ?? 0.7, when);
    src.connect(f);
    f.connect(envelope(ctx, out, when, peak, attack, decay));
    src.start(when);
    src.stop(when + attack + decay + 0.02);
}

function tone(
    ctx: BaseAudioContext,
    out: AudioNode,
    when: number,
    peak: number,
    freq: number,
    attack: number,
    decay: number,
    type: OscillatorType = 'sine',
    glideTo?: number,
) {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    if (glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(glideTo, when + attack + decay);
    osc.connect(envelope(ctx, out, when, peak, attack, decay));
    osc.start(when);
    osc.stop(when + attack + decay + 0.02);
}

/** Schedule one sound at `when` (context time), peaking at `level`. */
export function synthCue(ctx: BaseAudioContext, out: AudioNode, cue: SynthCue, when: number, level: number): void {
    if (!(level > 0)) return;
    switch (cue) {
        case 'deal':
            noiseBurst(ctx, out, when, level, 0.004, 0.085, { type: 'bandpass', freq: 2600, q: 0.9 });
            break;
        case 'flip':
            noiseBurst(ctx, out, when, level * 0.7, 0.002, 0.05, { type: 'highpass', freq: 1800 });
            tone(ctx, out, when, level * 0.3, 1400, 0.002, 0.03, 'triangle');
            break;
        case 'chips':
            [0, 0.035, 0.075].forEach((dt, i) => {
                tone(ctx, out, when + dt, level * 0.55, [3200, 2750, 3550][i], 0.002, 0.04, 'triangle');
                noiseBurst(ctx, out, when + dt, level * 0.4, 0.001, 0.02, { type: 'bandpass', freq: 5200, q: 1.2 });
            });
            break;
        case 'check':
            [0, 0.12].forEach(dt => {
                tone(ctx, out, when + dt, level * 0.7, 170, 0.003, 0.11, 'sine', 90);
                noiseBurst(ctx, out, when + dt, level * 0.3, 0.002, 0.05, { type: 'lowpass', freq: 700 });
            });
            break;
        case 'fold':
            noiseBurst(ctx, out, when, level * 0.75, 0.025, 0.2, { type: 'lowpass', freq: 3200, sweepTo: 380 });
            break;
        case 'win':
            [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
                tone(ctx, out, when + i * 0.09, level * 0.7, f, 0.01, 0.28, 'triangle');
            });
            break;
        case 'turn':
            tone(ctx, out, when, level * 0.8, 659.25, 0.01, 0.16);
            tone(ctx, out, when + 0.12, level * 0.8, 987.77, 0.01, 0.2);
            break;
    }
}
