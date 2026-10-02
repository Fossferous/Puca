// The speaking indicator against what is actually SENT, in real Chromium,
// through the REAL capture pipeline — silently.
//
// Owner report (0.9.830): "the voice indicator is showing my voice as coming
// through when other people can't hear — micro noises such as typing". The
// indicator (MediaManager.createVoiceActivityDetector) taps the PUBLISHED
// local stream, i.e. after the noise suppressor and the gain stage, and the
// mute/PTT gate (track.enabled) — so this rig asks the only question that
// matters: does the indicator light for audio the sent track does not carry
// at speech level?
//
// Each scenario launches a fresh headless Chromium with --mute-audio and a
// FAKE capture device fed by a WAV this script generates (no downloads, no
// microphone, no speakers): Chromium's own capture + audio processing, then
// MediaManager.getLocalStream() in the chosen noise mode (DeepFilter is the
// real DFN3 wasm in its Worker + AudioWorklet + RNNoise bridge, exactly as a
// call builds it), then the production detector on that stream. Beside it, an
// independent analyser measures the sent track's level over each 50 ms tick.
//
//   clicks  — keyboard clicks (press + release transients, peaks clipped at
//             full scale: a mic at 100 % next to a mechanical keyboard).
//   thocks  — mechanical switches bottoming out, 300-800 Hz, clipped.
//   residue — what a suppressor LEAVES of typing (short ticks, below speech
//             level over any 50 ms), played through 'off' so it is exactly
//             the sent track. The 5 ms-snapshot detector lit for it.
//   speech  — the committed TTS clip (e2e/assets/df-test-speech.wav).
//
// Verdicts, per mode:
//   clicks/thocks: the indicator may light only while the sent track carries the
//             typing at speech level (< 1 % of ticks lit with nothing sent).
//   residue : must never light.
//   speech  : POSITIVE CONTROL — the indicator must light (> 40 %), so a dark
//             typing run cannot be a blind detector.
//   muted   : speech with the sent track disabled — must stay dark.
// And, reported for every run: the % of ticks whose SENT level reached speech
// level (50 ms RMS > 0.02), which is what "other people can hear it" means.
//
// What it did NOT reproduce: in DeepFilter mode the real model removes both
// keyboard fixtures entirely (sent level ~0.003-0.008), so the old detector
// stayed dark there too. The owner's own keyboard and room are not these
// fixtures; 'residue' stands in for what survives the suppressor.
//
// DeepFilter runs in real time here: on a loaded machine the RNNoise bridge
// covers part of a run (the fallback counters printed per run say how much).
// The verdicts hold either way — they judge the indicator against whatever
// was actually sent.
//
// Prereqs: a vite dev server on THIS tree (npm run dev -- --port 5193).
// Usage:   node e2e/vad-filtered-real-browser.mjs  [VAD_BASE_URL=http://localhost:5193]
//          [VAD_MODES=deepfilter,rnnoise,standard,off] [VAD_SECONDS=8]
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.VAD_BASE_URL || 'http://localhost:5193';
const MODES = (process.env.VAD_MODES || 'deepfilter,rnnoise,standard,off').split(',');
const SECONDS = Number(process.env.VAD_SECONDS || 8);
const SR = 48000;
/** "Speech level" for the sent track: the indicator's own threshold (VoicePanel). */
const SPEECH_RMS = 0.02;
const OUT = join(tmpdir(), 'puca-vad-rig');
mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures++;
};

// ------------------------------------------------------------ fixtures ----
function rng(seed) {
    let s = seed | 0;
    return () => {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
}
function writeWav16(path, x) {
    const n = x.length;
    const b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
    b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
    writeFileSync(path, b);
}
/** Keyboard noise at ~`rate` keystrokes/s over a -60 dBFS room floor.
 *  'click': a press click and a softer release ~70-110 ms later, each a
 *           ~1.5 ms-decay burst of noise + a 2-4 kHz ring.
 *  'thock': a mechanical switch bottoming out — a 300-800 Hz ring with a
 *           4 ms decay. `peak` above 1 clips, as a hot desk mic does. */
function keyboardWav(kind, sec, peak, rate, seed = 7) {
    const r = rng(seed), n = sec * SR, x = new Float32Array(n);
    let t = 0.2 * SR;
    while (t < n - SR * 0.2) {
        const hits = kind === 'click'
            ? [[0, 1], [Math.round((0.07 + 0.04 * Math.abs(r())) * SR), 0.6]]
            : [[0, 1]];
        for (const [off, a] of hits) {
            const s0 = Math.round(t + off), amp = peak * a * (0.7 + 0.3 * Math.abs(r()));
            if (kind === 'click') {
                const f = 2000 + 2000 * Math.abs(r()), tau = 0.0015 * SR, len = Math.round(0.012 * SR);
                for (let i = 0; i < len && s0 + i < n; i++) {
                    x[s0 + i] += amp * Math.exp(-i / tau) * (0.6 * r() + 0.4 * Math.sin(2 * Math.PI * f * i / SR));
                }
            } else {
                const f = 300 + 500 * Math.abs(r()), tau = 0.004 * SR, len = Math.round(0.03 * SR);
                for (let i = 0; i < len && s0 + i < n; i++) {
                    x[s0 + i] += amp * Math.exp(-i / tau) * (0.3 * r() + 0.7 * Math.sin(2 * Math.PI * f * i / SR));
                }
            }
        }
        t += SR / rate * (0.6 + 0.8 * Math.abs(r()));
    }
    for (let i = 0; i < n; i++) x[i] = Math.max(-1, Math.min(1, x[i] + 0.001 * r()));
    return x;
}

const FIXTURES = {
    clicks: join(OUT, 'typing-clicks.wav'),
    thocks: join(OUT, 'typing-thocks.wav'),
};
writeWav16(FIXTURES.clicks, keyboardWav('click', 12, 1.6, 8));
writeWav16(FIXTURES.thocks, keyboardWav('thock', 12, 3, 10, 5));
// What a suppressor LEAVES of typing: one short mid-band tick per keystroke
// (peak 0.14, 1.5 ms decay, ~8/s) — the shape the production DeepFilter wasm
// leaves of clipped keystrokes. Played through mode 'off' (a pass-through), so
// it is exactly what the sent track carries: every 50 ms of it is below
// speech level, but a 5 ms window landing on a tick is not.
const residualPath = join(OUT, 'typing-residual.wav');
{
    const r = rng(3), n = 12 * SR, x = new Float32Array(n);
    let t = 0.1 * SR;
    while (t < n - 0.05 * SR) {
        const s0 = Math.round(t), f = 400 + 600 * Math.abs(r()), amp = 0.14 * (0.8 + 0.2 * Math.abs(r()));
        for (let i = 0; i < 0.02 * SR && s0 + i < n; i++) x[s0 + i] += amp * Math.exp(-i / (0.0015 * SR)) * Math.sin(2 * Math.PI * f * i / SR);
        t += (SR / 8) * (0.6 + 0.8 * Math.abs(r()));
    }
    writeWav16(residualPath, x);
}
const speechPath = fileURLToPath(new URL('./assets/df-test-speech.wav', import.meta.url));
readFileSync(speechPath); // must exist

// ---------------------------------------------------------------- page ----
/** In-page: the real pipeline + the production detector + an independent
 *  sent-level meter. Returns one row per 50 ms tick. */
async function pageRun({ mode, seconds, mute, settings }) {
    const nf = await import('/src/api/noiseFilter.ts');
    const { MediaManager } = await import('/src/api/rtc/media.ts');
    try {
        // A fresh profile would otherwise have its first explicit mic toggles
        // reset by the one-time migration in settingsStore.ts.
        localStorage.setItem('micProcessingTogglesReset_v1', '1');
        const raw = JSON.parse(localStorage.getItem('sovereign_settings') || '{}');
        localStorage.setItem('sovereign_settings', JSON.stringify({ ...raw, experimentalDeepFilter: true, ...settings }));
    } catch { /* storage unavailable */ }
    nf.setNoiseSuppressionMode(mode, false);
    const m = new MediaManager();
    const stream = await m.getLocalStream(true, false);
    const track = stream.getAudioTracks()[0];
    if (!track) return { error: 'no audio track' };
    // Let the graph come up (DeepFilter: wasm + model warm-up) before measuring.
    await new Promise(r => setTimeout(r, 2500));
    if (mute) track.enabled = false;

    let speaking = false;
    const stopVad = m.createVoiceActivityDetector(stream, (s) => { speaking = s; }, 0.02);

    // Independent meter over the SENT stream: a full 50 ms window per tick.
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 4096;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    const rows = [];
    const t0 = performance.now();
    await new Promise((resolve) => {
        const iv = setInterval(() => {
            an.getFloatTimeDomainData(buf);
            let s = 0;
            for (let i = buf.length - 2400; i < buf.length; i++) s += buf[i] * buf[i];
            rows.push({ speaking, sent: Math.sqrt(s / 2400) });
            if (performance.now() - t0 > seconds * 1000) { clearInterval(iv); resolve(); }
        }, 50);
    });
    stopVad();
    src.disconnect();
    await ctx.close();
    const diag = mode === 'deepfilter'
        ? JSON.parse(JSON.stringify((await import('/src/api/deepFilter.ts')).deepFilterDiagnostics()))
        : null;
    const actualMode = nf.getNoiseSuppressionMode();
    m.stopLocalStream();
    return { rows, actualMode, worklet: diag?.worklet ?? null };
}

async function scenario(mode, wav, { mute = false, settings = {} } = {}) {
    const browser = await chromium.launch({
        args: [
            '--mute-audio',
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-audio-capture=${wav}`,
        ],
    });
    try {
        const page = await browser.newPage();
        page.on('pageerror', (e) => console.log('  [page exception]', String(e).slice(0, 160)));
        await page.goto(BASE, { waitUntil: 'domcontentloaded' });
        const r = await page.evaluate(pageRun, { mode, seconds: SECONDS, mute, settings });
        if (r.error) throw new Error(r.error);
        const rows = r.rows;
        const n = rows.length;
        const lit = rows.filter(x => x.speaking).length;
        const loud = rows.filter(x => x.sent > SPEECH_RMS).length;
        // A lit tick is JUSTIFIED when the sent track carried speech-level
        // energy within the indicator's own on-time (this tick or the 200 ms
        // release before it, plus one tick of slack: the meter and the
        // detector sample on different clocks).
        let unjustified = 0;
        for (let i = 0; i < n; i++) {
            if (!rows[i].speaking) continue;
            let ok = false;
            for (let j = Math.max(0, i - 6); j <= i; j++) if (rows[j].sent > SPEECH_RMS * 0.75) ok = true;
            if (!ok) unjustified++;
        }
        const maxSent = Math.max(...rows.map(x => x.sent));
        const w = r.worklet;
        return {
            mode: r.actualMode, n,
            litPct: 100 * lit / n,
            sentLoudPct: 100 * loud / n,
            unjustifiedPct: 100 * unjustified / n,
            maxSent,
            fallback: w ? `processed=${w.processedSamples} dry=${w.drySamples} bridge=${w.bridgeSamples}` : '',
        };
    } finally {
        await browser.close();
    }
}

const fmt = (s) => `${s.mode}: lit ${s.litPct.toFixed(1)}%, sent at speech level ${s.sentLoudPct.toFixed(1)}%, lit with nothing sent ${s.unjustifiedPct.toFixed(1)}%, max sent 50ms RMS ${s.maxSent.toFixed(4)}${s.fallback ? `, ${s.fallback}` : ''}`;

console.log('== speaking indicator vs the sent track ==', BASE);
for (const mode of MODES) {
    for (const [name, wav] of Object.entries(FIXTURES)) {
        const typing = await scenario(mode, wav);
        console.log(`  ${name.padEnd(7)} ${fmt(typing)}`);
        check(`${mode}: ${name} light the indicator only while the sent track carries them`,
            typing.mode === mode && typing.unjustifiedPct < 1, `lit with nothing sent ${typing.unjustifiedPct.toFixed(1)}%`);
    }

    if (mode === 'off') {
        // Chromium's auto-gain would lift the ticks (it is BEFORE the sent
        // track), so it is off here: the sent track must be the fixture itself.
        const residual = await scenario(mode, residualPath, { settings: { autoGainControl: false, echoCancellation: false } });
        console.log(`  residue ${fmt(residual)}`);
        check('off: a suppressor leftover keystroke ticks never light the indicator',
            residual.litPct === 0 && residual.sentLoudPct === 0, `lit ${residual.litPct.toFixed(1)}%`);
    }

    const speech = await scenario(mode, speechPath);
    console.log(`  speech  ${fmt(speech)}`);
    check(`${mode}: speech lights the indicator (positive control)`, speech.mode === mode && speech.litPct > 40, `lit ${speech.litPct.toFixed(1)}%`);

    const muted = await scenario(mode, speechPath, { mute: true });
    console.log(`  muted   ${fmt(muted)}`);
    check(`${mode}: muted speech stays dark`, muted.litPct === 0 && muted.sentLoudPct === 0, `lit ${muted.litPct.toFixed(1)}%`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
