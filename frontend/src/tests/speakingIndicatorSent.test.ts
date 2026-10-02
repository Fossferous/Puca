/**
 * The speaking indicator must light for what the room HEARS, not for
 * transients the noise suppressor has already all but removed.
 *
 * Owner report (0.9.830, DeepFilter mode): "the voice indicator is showing my
 * voice as coming through when other people can't hear — micro noises such
 * as typing". The detector already taps the PUBLISHED stream (after the
 * suppressor, the gain stage and the mute gate — pinned below), so the fault
 * was not the tap but the MEASUREMENT: it read a 256-sample (5.3 ms) snapshot
 * once per 50 ms tick and lit on ONE snapshot over the threshold. A keystroke
 * the suppressor has cut by 30 dB (DeepFilter's attenuation limit) still
 * leaves a millisecond-scale tick behind, and a 5 ms window that happens to
 * land on it reads as loud as speech even though its energy over any 50 ms
 * of the sent track is well below speech level. Why it showed up now is an
 * inference, not a measurement: 0.9.830 put the owner's desk mic back at
 * 100 % (Chromium's AGC had been holding it at 7.8 %, 22 dB lower), so
 * whatever survives the suppressor arrives 22 dB hotter than before.
 *
 * Measured with the production DeepFilter wasm + level wrapper on clipped
 * keystrokes (offline, 20 s at 8-12/s): the sent track never reached speech
 * level in any 50 ms tick, while the 5 ms snapshot detector lit 6-14 % of the
 * time with 5-13 separate false onsets. In real Chromium
 * (e2e/vad-filtered-real-browser.mjs) the same residue as the sent track lit
 * the old detector ~20 % of the time at a 50 ms level of 0.012.
 *
 * These drive the REAL detector (MediaManager.createVoiceActivityDetector)
 * against a fake AnalyserNode that serves the most recent `fftSize` samples
 * of a scripted sent-track timeline, on fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MediaManager } from '../api/rtc/media';
import { SpeakingDecision, VAD_ATTACK_TICKS, VAD_RELEASE_TICKS, vadWindowSize } from '../api/rtc/speakingDecision';

// The suppressor graph is replaced by a stand-in that hands back a DIFFERENT
// track than the capture — which is what every Web Audio mode does — so the
// tap test below can tell the published track from the raw one.
const processAudioStream = vi.hoisted(() => vi.fn());
vi.mock('../api/noiseFilter', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/noiseFilter')>()),
    processAudioStream,
}));

const SR = 48000;
const THRESHOLD = 0.02; // what VoicePanel passes for local AND remote users
const TICK_MS = 50;

class FakeTrack {
    kind = 'audio';
    enabled = true;
    readyState: 'live' | 'ended' = 'live';
    label: string;
    signal: Float32Array;
    constructor(label: string, signal: Float32Array = new Float32Array(0)) {
        this.label = label;
        this.signal = signal;
    }
    stop() { this.readyState = 'ended'; }
}
class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return [] as FakeTrack[]; }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* scripted swaps never fire these */ }
    removeEventListener() { /* see above */ }
}

/** Every MediaStreamAudioSourceNode the detector built, by the track it read. */
let sourcesBuilt: FakeTrack[] = [];
let clockStart = 0;

class FakeAnalyser {
    fftSize = 2048;
    smoothingTimeConstant = 0.8;
    track: FakeTrack | null = null;
    /** The last `out.length` samples the track has rendered by now. A
     *  disabled track renders silence (the WebRTC/Web Audio contract). */
    getFloatTimeDomainData(out: Float32Array) {
        const end = Math.floor(((Date.now() - clockStart) * SR) / 1000);
        const t = this.track;
        for (let i = 0; i < out.length; i++) {
            const idx = end - out.length + i;
            out[i] = t && t.enabled && t.readyState === 'live' && idx >= 0 && idx < t.signal.length ? t.signal[idx] : 0;
        }
    }
    disconnect() { this.track = null; }
}
class FakeCtx {
    state = 'running';
    sampleRate = SR;
    createAnalyser() { return new FakeAnalyser(); }
    createMediaStreamSource(stream: FakeStream) {
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error('no audio track');
        sourcesBuilt.push(track);
        let target: FakeAnalyser | null = null;
        return {
            connect(an: FakeAnalyser) { target = an; an.track = track; },
            disconnect() { if (target && target.track === track) target.track = null; target = null; },
        };
    }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
}

beforeEach(() => {
    sourcesBuilt = [];
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    clockStart = Date.now();
    vi.stubGlobal('AudioContext', FakeCtx);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ------------------------------------------------------------ fixtures ----
function seeded(seed0: number) {
    let s = seed0 | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
}
/** What a suppressor leaves of typing: a short mid-band tick per keystroke
 *  (peak 0.14, 1.5 ms decay), ~8 keystrokes a second. */
function residualTicks(seconds: number, peak = 0.14, rate = 8, seed = 3): Float32Array {
    const r = seeded(seed), n = seconds * SR, x = new Float32Array(n);
    let t = 0.1 * SR;
    while (t < n - 0.05 * SR) {
        const s0 = Math.round(t), f = 400 + 600 * Math.abs(r()), amp = peak * (0.8 + 0.2 * Math.abs(r()));
        for (let i = 0; i < 0.02 * SR && s0 + i < n; i++) {
            x[s0 + i] += amp * Math.exp(-i / (0.0015 * SR)) * Math.sin((2 * Math.PI * f * i) / SR);
        }
        t += (SR / rate) * (0.6 + 0.8 * Math.abs(r()));
    }
    return x;
}
/** A voiced burst (150 Hz fundamental + harmonics) of `ms` at `rms`. */
function voiced(seconds: number, atS: number, ms: number, rms: number): Float32Array {
    const x = new Float32Array(seconds * SR);
    const s0 = Math.round(atS * SR), len = Math.round((ms / 1000) * SR);
    let e = 0;
    const tmp = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        let v = 0;
        for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * 150 * h * i) / SR) / h;
        tmp[i] = v; e += v * v;
    }
    const k = rms / Math.sqrt(e / len);
    for (let i = 0; i < len; i++) x[s0 + i] = tmp[i] * k;
    return x;
}
function speechWav(gain = 1): Float32Array {
    const b = readFileSync(join(__dirname, '..', '..', 'e2e', 'assets', 'df-test-speech.wav'));
    let off = 12;
    while (b.toString('ascii', off, off + 4) !== 'data') off += 8 + b.readUInt32LE(off + 4);
    const n = b.readUInt32LE(off + 4) / 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = (b.readInt16LE(off + 8 + i * 2) / 32768) * gain;
    return x;
}
function windowRms(x: Float32Array, end: number, len: number): number {
    let s = 0;
    for (let i = Math.max(0, end - len); i < end; i++) s += x[i] * x[i];
    return Math.sqrt(s / len);
}

/** `x` delayed by `ms` (leading silence): moves the signal against the tick grid. */
function shifted(x: Float32Array, ms: number): Float32Array {
    const pad = Math.round((ms * SR) / 1000);
    const y = new Float32Array(x.length + pad);
    y.set(x, pad);
    return y;
}
/** The 0.9.830 detector, as a baseline: a 256-sample snapshot per 50 ms tick,
 *  ON at the first snapshot over the threshold, OFF after 4 quiet ticks. */
function oldDetector(x: Float32Array) {
    let on = false, quiet = 0, lit = 0, ticks = 0;
    const onsets: number[] = [];
    for (let e = 2400; e <= x.length; e += 2400) {
        ticks++;
        if (windowRms(x, e, 256) > THRESHOLD) {
            quiet = 0;
            if (!on) { on = true; onsets.push((e / SR) * 1000); }
        } else if (on && ++quiet >= 4) {
            on = false;
        }
        if (on) lit++;
    }
    return { onsets, litPct: (100 * lit) / ticks };
}
/** Ground truth for "the talker started an utterance": the first 10 ms frame
 *  over the threshold after at least 300 ms without one. */
function utteranceOnsets(x: Float32Array): number[] {
    const out: number[] = [];
    let quietFrames = Infinity;
    for (let e = 480; e <= x.length; e += 480) {
        if (windowRms(x, e, 480) > THRESHOLD) {
            if (quietFrames >= 30) out.push((e / SR) * 1000);
            quietFrames = 0;
        } else {
            quietFrames++;
        }
    }
    return out;
}

/** Run the real detector over `track` for `seconds`; returns its state per tick
 *  and every ON edge (ms). */
function runDetector(track: FakeTrack, seconds: number) {
    clockStart = Date.now(); // each run's timeline starts now
    const m = new MediaManager();
    let speaking = false;
    const onsets: number[] = [];
    const stop = m.createVoiceActivityDetector(
        new FakeStream([track]) as unknown as MediaStream,
        (s) => { if (s && !speaking) onsets.push(Date.now() - clockStart); speaking = s; },
        THRESHOLD,
    );
    const states: boolean[] = [];
    for (let t = 0; t < seconds * 1000; t += TICK_MS) {
        vi.advanceTimersByTime(TICK_MS);
        states.push(speaking);
    }
    stop();
    m.closeVadContext();
    return { states, onsets, litPct: (100 * states.filter(Boolean).length) / states.length };
}

describe('speaking indicator: what is sent, not what a 5 ms window caught', () => {
    it('fixture sanity: the residual never reaches speech level over a 50 ms tick, but a 5 ms window does', () => {
        const x = residualTicks(10);
        let max50 = 0, max5 = 0;
        for (let e = 2400; e <= x.length; e += 120) {
            max50 = Math.max(max50, windowRms(x, e, 2400));
            max5 = Math.max(max5, windowRms(x, e, 256));
        }
        expect(max50).toBeLessThan(THRESHOLD);
        expect(max5).toBeGreaterThan(THRESHOLD * 1.5);
    });

    it('residual keystroke ticks left by the suppressor never light the indicator', () => {
        const r = runDetector(new FakeTrack('sent', residualTicks(10)), 10);
        expect(r.onsets).toEqual([]);
        expect(r.litPct).toBe(0);
    });

    it('fast typing (16 ticks a second) does not light it either: the window, not luck, decides', () => {
        // At this density a 5 ms snapshot lands on a tick again and again;
        // averaging each tick over the time it covers is what keeps the
        // residue below speech level.
        const x = residualTicks(10, 0.14, 16, 9);
        let max50 = 0;
        for (let e = 2400; e <= x.length; e += 120) max50 = Math.max(max50, windowRms(x, e, 2400));
        expect(max50).toBeLessThan(THRESHOLD);
        expect(runDetector(new FakeTrack('sent', x), 10).onsets).toEqual([]);
    });

    it('a lone short sound lights it exactly when a tick of the SENT track carries it at speech level', () => {
        // 20 ms at RMS 0.035: when it falls inside one 43 ms window that tick
        // reads ~0.024 (over 0.02) — the room hears a sound at speech level,
        // so the ring lights; split across two windows it reads ~0.017 in
        // each and stays dark. The ring follows the tick level, at every phase.
        let lit = 0, dark = 0;
        for (const atS of [1.0, 1.004, 1.011, 1.019, 1.026, 1.033, 1.041]) {
            const x = voiced(3, atS, 20, 0.035);
            let loudTick = false;
            for (let e = 2400; e <= x.length; e += 2400) {
                if (windowRms(x, e, vadWindowSize(SR)) > THRESHOLD) loudTick = true;
            }
            const onsets = runDetector(new FakeTrack('sent', x), 3).onsets;
            expect(onsets.length).toBe(loudTick ? 1 : 0);
            if (loudTick) lit++; else dark++;
        }
        // Both branches were exercised, so this cannot pass on one side alone.
        expect(lit).toBeGreaterThan(0);
        expect(dark).toBeGreaterThan(0);
    });

    it('POSITIVE CONTROL: real speech lights it, promptly and for most of the talk', () => {
        const x = speechWav();
        const r = runDetector(new FakeTrack('sent', x), 6);
        // First 50 ms tick whose window carries speech-level energy.
        let firstLoudMs = -1;
        for (let e = 2400; e <= x.length; e += 2400) {
            if (windowRms(x, e, 2400) > THRESHOLD) { firstLoudMs = (e / SR) * 1000; break; }
        }
        expect(firstLoudMs).toBeGreaterThan(0);
        expect(r.onsets.length).toBeGreaterThan(0);
        expect(r.onsets[0] - firstLoudMs).toBeLessThanOrEqual(150);
        expect(r.litPct).toBeGreaterThan(50);
    });

    // The speech fixture is TTS at ~-17.5 dBFS active RMS. "-18 dB" puts it at
    // ~-35.5 dBFS — an ordinary quiet talker, a few dB over the threshold —
    // where a slower onset would cost the ring most of what they say.
    for (const gainDb of [-12, -18]) {
        it(`POSITIVE CONTROL: quiet speech (${gainDb} dB, ~${(-17.5 + gainDb).toFixed(1)} dBFS) lights as much and as soon as it did before the fix`, () => {
            const g = 10 ** (gainDb / 20);
            const base = speechWav(g);
            let litNew = 0, litOld = 0;
            const delayNew: number[] = [], delayOld: number[] = [];
            const PHASES = [0, 10, 20, 30, 40];
            for (const ph of PHASES) {
                const x = shifted(base, ph);
                const secs = Math.ceil(x.length / SR);
                const r = runDetector(new FakeTrack('sent', x), secs);
                const o = oldDetector(x);
                litNew += r.litPct / PHASES.length;
                litOld += o.litPct / PHASES.length;
                for (const t of utteranceOnsets(x)) {
                    const hitNew = r.onsets.find(v => v >= t && v < t + 1000);
                    const hitOld = o.onsets.find(v => v >= t && v < t + 1000);
                    expect(hitNew, `utterance at ${t} ms (phase ${ph}) never lit`).toBeDefined();
                    delayNew.push((hitNew as number) - t);
                    if (hitOld !== undefined) delayOld.push(hitOld - t);
                }
            }
            const q = (a: number[], p: number) => [...a].sort((m, n) => m - n)[Math.floor(a.length * p)];
            // Lit share: within a few points of the 0.9.830 detector on the
            // same signal (the 43 ms window averages away a little of the
            // quietest syllables; it must not cost more than that).
            expect(litNew).toBeGreaterThan(litOld - 5);
            // Onset: the ring follows the talker's first syllable within a
            // tick or so, as before — not a quarter-second later.
            expect(q(delayNew, 0.5)).toBeLessThanOrEqual(60);
            expect(q(delayNew, 0.9)).toBeLessThanOrEqual(q(delayOld, 0.9) + 30);
        });
    }

    it('POSITIVE CONTROL: a single short word (120 ms) lights it within 150 ms', () => {
        for (const atS of [1.0, 1.013, 1.027, 1.041]) { // every phase against the tick
            const r = runDetector(new FakeTrack('sent', voiced(3, atS, 120, 0.05)), 3);
            expect(r.onsets.length).toBe(1);
            expect(r.onsets[0] - atS * 1000).toBeLessThanOrEqual(150);
        }
    });

    it('the same residual ticks, typed into speech, do not keep the ring lit after the speech ends', () => {
        const ticks = residualTicks(6);
        const word = voiced(6, 1, 600, 0.06);
        const x = new Float32Array(ticks.length);
        for (let i = 0; i < x.length; i++) x[i] = ticks[i] + word[i];
        const r = runDetector(new FakeTrack('sent', x), 6);
        // Lit during the word, dark from ~release after it: ticks after 1.6 s + 250 ms.
        const after = r.states.slice(Math.ceil(1850 / TICK_MS));
        expect(r.onsets.length).toBe(1);
        expect(after.some(Boolean)).toBe(false);
    });

    // FAKE-CONTRACT check, not a mute test: FakeAnalyser renders a disabled
    // track as silence, which is the Web Audio/WebRTC rule the real mute and
    // PTT gate rely on (applyMicGate -> track.enabled = false). That the
    // browser really does so is measured by e2e/vad-filtered-real-browser.mjs
    // ('muted' scenario, every noise mode). This pins only the detector half:
    // a track that renders silence never lights the ring.
    it('a disabled sent track renders silence, and silence never lights it (fake contract; browser half is the rig)', () => {
        const t = new FakeTrack('sent', speechWav());
        t.enabled = false;
        expect(runDetector(t, 4).onsets).toEqual([]);
    });
});

// What this pins: MediaManager hands back the PROCESSED track (getLocalStream,
// and reacquireAudioTrack after a noise-mode swap), and a detector built on
// that stream reads it and rebuilds its source onto the new processed track
// after a swap. What it does NOT pin: which stream VoicePanel passes in — that
// is VoicePanel.tsx's createVoiceActivityDetector(localStream, ...) call, the
// same localStream the SFU publishes and the mesh sends.
describe('speaking indicator: MediaManager hands the detector the processed track', () => {
    it('getLocalStream/reacquireAudioTrack return the processed track, and a detector on it reads it across a noise-mode swap, never the raw capture', async () => {
        const raw1 = new FakeTrack('raw-1'), sent1 = new FakeTrack('processed-1');
        const raw2 = new FakeTrack('raw-2'), sent2 = new FakeTrack('processed-2');
        processAudioStream
            .mockResolvedValueOnce(new FakeStream([sent1]) as unknown as MediaStream)
            .mockResolvedValueOnce(new FakeStream([sent2]) as unknown as MediaStream);
        const gum = vi.fn()
            .mockResolvedValueOnce(new FakeStream([raw1]))
            .mockResolvedValueOnce(new FakeStream([raw2]));
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: gum } });
        const m = new MediaManager();
        {
            const published = await m.getLocalStream(true, false);
            expect(published.getAudioTracks()[0]).toBe(sent1);
            const stop = m.createVoiceActivityDetector(published, () => { /* state not needed */ }, THRESHOLD);
            expect(sourcesBuilt).toEqual([sent1]);

            const swap = await m.reacquireAudioTrack();
            expect(swap?.newTrack).toBe(sent2);
            // The rebuild after the swap reads the NEW published track.
            expect(sourcesBuilt[sourcesBuilt.length - 1]).toBe(sent2);
            expect(sourcesBuilt).not.toContain(raw1);
            expect(sourcesBuilt).not.toContain(raw2);
            stop();
            m.stopLocalStream();
        }
    });
});

describe('SpeakingDecision', () => {
    it('sizes the analyser window to fit inside one tick at the context rate', () => {
        expect(vadWindowSize(48000)).toBe(2048);
        expect(vadWindowSize(44100)).toBe(2048);
        expect(vadWindowSize(96000)).toBe(4096);
        expect(vadWindowSize(16000)).toBe(512);
        expect(vadWindowSize(Number.NaN)).toBe(2048); // a stub context with no rate
    });

    it('lights after ATTACK consecutive loud ticks and goes dark after RELEASE quiet ones', () => {
        const d = new SpeakingDecision(0.02);
        const flips: Array<boolean | null> = [];
        for (let i = 0; i < VAD_ATTACK_TICKS; i++) flips.push(d.update(0.05));
        expect(flips.slice(0, -1).every(f => f === null)).toBe(true);
        expect(flips[flips.length - 1]).toBe(true);
        // A one-tick dip inside speech does not end it.
        expect(d.update(0)).toBeNull();
        expect(d.update(0.05)).toBeNull();
        const off: Array<boolean | null> = [];
        for (let i = 0; i < VAD_RELEASE_TICKS; i++) off.push(d.update(0.001));
        expect(off.slice(0, -1).every(f => f === null)).toBe(true);
        expect(off[off.length - 1]).toBe(false);
    });

    it('one tick at speech level lights it at once: a quiet talker is not made to wait', () => {
        // A window already spans ~43 ms, so one loud tick IS a sound the room
        // heard at speech level. Requiring two cost quiet talkers ~240 ms per
        // onset and a third of their lit time (the -18 dB test above).
        const d = new SpeakingDecision(0.02);
        expect(d.update(0.021)).toBe(true);
        expect(d.update(0.001)).toBeNull();
    });
});
