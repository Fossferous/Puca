// DeepFilter's RNNoise bridge, in real Chromium with the real RNNoise wasm:
// is the bridge on the SAME timeline as DeepFilter?
//
// The bridge's alignment rests on RNNOISE_WORKLET_LATENCY (rnnoiseNode.ts),
// read out of the library's processor. dfBridge.test.ts pins the library
// version; this proves the number against the running library. A wrong value
// would not fail anything else: the swap would still happen, as a time jump.
//
//   1. Bypass-inference DeepFilter (the Worker echoes hops unenhanced), speech
//      looping in. The output-vs-input lag is DeepFilter's own.
//   2. Put the worklet in standby: no more hops, so every emitted sample is
//      the bridge's (the counters must say so: bridge > 0, dry = 0).
//   3. The output-vs-input lag must be the same, within 2 samples. RNNoise
//      changes the waveform, so the lag is found by correlation, not by
//      exact match, and the correlation peak of filtered speech can sit a
//      sample off the true delay. A wrong latency constant is off by hundreds.
//
// Positive control: the same correlation finds a known 512-sample shift of the
// input against itself, so a bridge misaligned by the RNNoise latency could
// not pass as aligned.
//
// Muted (--mute-audio), and nothing is connected to the speakers but a
// recorder that emits silence. Prereqs: vite dev server on this tree.
// Usage:   node e2e/df-bridge-verify.mjs   [DF_BASE_URL=http://localhost:5173]
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DF_BASE_URL || 'http://localhost:5173';
const SPEECH_WAV = fileURLToPath(new URL('./assets/df-test-speech.wav', import.meta.url));

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
    if (!ok) failures++;
};

const b64ToF32 = (b64) => {
    const bin = Buffer.from(b64, 'base64');
    return new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
};

/** Lag (out trails dry) in [lo, hi] with the highest normalised correlation. */
function bestLag(dry, out, lo, hi, from, len) {
    let best = -1, bestC = -Infinity;
    for (let lag = lo; lag <= hi; lag++) {
        let xy = 0, xx = 0, yy = 0;
        for (let i = from; i < from + len; i++) {
            const x = dry[i - lag], y = out[i];
            xy += x * y; xx += x * x; yy += y * y;
        }
        const c = xy / Math.sqrt(xx * yy + 1e-20);
        if (c > bestC) { bestC = c; best = lag; }
    }
    return { lag: best, corr: bestC };
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const wavB64 = readFileSync(SPEECH_WAV).toString('base64');
    const built = await page.evaluate(async ({ wavB64 }) => {
        const mod = await import('/src/api/deepFilter.ts');
        const ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.resume();
        const wav = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));
        const speech = await ctx.decodeAudioData(wav.buffer);
        const recSrc = `class Rec extends AudioWorkletProcessor {
            constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data === 'on'; }; }
            process(inputs) {
                if (this.on) this.port.postMessage({
                    a: new Float32Array(inputs[0]?.[0] ?? 128), b: new Float32Array(inputs[1]?.[0] ?? 128) });
                return true;
            }
        }
        registerProcessor('df-bridge-rec', Rec);`;
        await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'text/javascript' })));
        const rec = new AudioWorkletNode(ctx, 'df-bridge-rec', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
        rec.connect(ctx.destination); // never writes its output: silence
        const cap = { a: [], b: [] };
        rec.port.onmessage = (e) => { cap.a.push(e.data.a); cap.b.push(e.data.b); };
        const msDest = ctx.createMediaStreamDestination();
        const nodes = await mod.applyDeepFilter(ctx, msDest.stream, 1, { bypassInference: true });
        nodes.gain.connect(rec, 0, 1);
        const src = ctx.createBufferSource();
        src.buffer = speech;
        src.loop = true;
        src.connect(msDest);
        src.connect(rec, 0, 0);
        src.start();
        const b64 = (f32) => {
            const u8 = new Uint8Array(f32.buffer);
            let s = '';
            for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
            return btoa(s);
        };
        window.__b = {
            nodes, rec, cap, ctx,
            record: (on) => rec.port.postMessage(on ? 'on' : 'off'),
            drain: () => {
                const n = cap.a.reduce((s, c) => s + c.length, 0);
                const A = new Float32Array(n), B = new Float32Array(n);
                let o = 0;
                for (let i = 0; i < cap.a.length; i++) { A.set(cap.a[i], o); B.set(cap.b[i], o); o += cap.a[i].length; }
                cap.a.length = 0; cap.b.length = 0;
                return { a: b64(A), b: b64(B) };
            },
            stats: () => JSON.parse(JSON.stringify(mod.deepFilterDiagnostics().worklet ?? {})),
        };
        return { ok: true };
    }, { wavB64 });
    check('graph built with the bridge', built.ok);

    // 1) DeepFilter (bypass) steady: its own lag.
    await page.waitForTimeout(1500); // past the startup lead-in and the RNNoise warm-up
    await page.evaluate(() => window.__b.record(true));
    await page.waitForTimeout(3000);
    const steady = await page.evaluate(() => { window.__b.record(false); return window.__b.drain(); });
    const dA = b64ToF32(steady.a), oA = b64ToF32(steady.b);
    const lagDf = bestLag(dA, oA, 0, 6000, 8000, 96000);
    check('DeepFilter lag found, exact copy (bypass)', lagDf.corr > 0.999, `lag ${lagDf.lag}, corr ${lagDf.corr.toFixed(5)}`);

    // 2) Standby: everything from here is the bridge.
    await page.evaluate(() => window.__b.nodes.worklet.port.postMessage({ type: 'standby' }));
    await page.waitForTimeout(1500); // drain what was in flight
    await page.evaluate(() => window.__b.record(true));
    await page.waitForTimeout(3000);
    const bridged = await page.evaluate(() => { window.__b.record(false); return window.__b.drain(); });
    await page.waitForTimeout(2200); // one stats report after the capture
    const st = await page.evaluate(() => window.__b.stats());
    check('standby: the bridge carried the audio, the raw mic never did',
        st.standby === true && st.bridgeSamples > 0 && st.drySamples === 0,
        `bridge=${st.bridgeSamples} dry=${st.drySamples} live=${st.bridgeLive}`);

    // 3) Same timeline.
    const dB = b64ToF32(bridged.a), oB = b64ToF32(bridged.b);
    const lagBridge = bestLag(dB, oB, 0, 6000, 8000, 96000);
    // Within 2 samples (42 µs): RNNoise filters the speech, so the correlation
    // peak of its output against the raw input can sit a sample off the true
    // delay. A wrong latency constant is off by hundreds (the first version,
    // 512 without RNNoise's own 480-sample frame, measured 479 late).
    check('the bridge is on DeepFilter\'s timeline (within 2 samples)',
        Math.abs(lagBridge.lag - lagDf.lag) <= 2, `bridge lag ${lagBridge.lag} vs DeepFilter ${lagDf.lag}, corr ${lagBridge.corr.toFixed(3)}`);
    let exact = 0;
    for (let i = 8000; i < 104000; i++) if (oB[i] === dB[i - lagDf.lag]) exact++;
    check('the bridge is RNNoise, not a raw copy', exact < 1000, `${exact} of 96000 samples identical to raw`);

    // Positive control: the estimator resolves a 512-sample shift.
    const shifted = new Float32Array(dB.length);
    for (let i = 512; i < dB.length; i++) shifted[i] = dB[i - 512];
    const ctrl = bestLag(dB, shifted, 0, 6000, 8000, 96000);
    check('control: the correlation finds a known 512-sample shift', ctrl.lag === 512, `found ${ctrl.lag}`);

    check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} finally {
    await browser.close();
}
console.log(failures ? `${failures} FAILED` : 'ALL PASS');
process.exit(failures ? 1 : 0);
