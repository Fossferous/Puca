// DeepFilterNet pipeline verification: real Chromium, real AudioWorklet +
// inference Worker — the full graph applyDeepFilter builds, driven by real
// speech (a committed TTS wav) and measured at sample level.
//
// Two instances are exercised:
//
//   TRANSPORT (bypassInference): the Worker echoes hops unenhanced, so the
//   emitted stream must equal the input stream delayed by a constant integer
//   lag — verified SAMPLE-EXACT after alignment, through 4 s of steady state
//   AND 4 s of main-thread jam (70 ms busy bursts — the exact trigger that
//   made the old ScriptProcessor design crackle by browser zero-fill). Any
//   dropped/duplicated/zeroed sample anywhere in worklet ⇄ worker ⇄ timeline
//   reassembly fails this.
//
//   REAL MODEL: full DFN3 wasm. Proves inference keeps realtime (with jam),
//   100% processed samples (no dry fallback), no discontinuities, bounded
//   latency, real speech survives the model, and white noise is crushed.
//
// Detector positive controls: the zero-run and discontinuity detectors must
// fire on an injected 480-sample zero-fill (the old design's exact artifact),
// proving a clean pass is not a blind detector.
//
// Prereqs: vite dev server up (npm run dev). No backend, no login needed.
// Usage:   node e2e/deepfilter-verify.mjs   [DF_BASE_URL=http://localhost:5174]
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

// ---------- sample-level analysis (Node side) ----------

const b64ToF32 = (b64) => {
    const bin = Buffer.from(b64, 'base64');
    return new Float32Array(bin.buffer, bin.byteOffset, bin.byteLength / 4);
};

/** Runs of >= minRun EXACT zeros in `out` while `dry` carries energy at the
 *  same (aligned) position — the signature of a starved/zero-filled pipeline. */
function zeroRuns(out, dry, lag, minRun = 256) {
    let runs = 0;
    let run = 0;
    const energetic = (endIdx, len) => {
        const a = Math.max(0, endIdx - len - lag);
        const b = Math.max(0, endIdx - lag);
        for (let i = a; i < Math.min(dry.length, b); i++) if (Math.abs(dry[i]) > 0.05) return true;
        return false;
    };
    for (let i = 0; i < out.length; i++) {
        if (out[i] === 0) run++;
        else {
            if (run >= minRun && energetic(i, run)) runs++;
            run = 0;
        }
    }
    if (run >= minRun && energetic(out.length, run)) runs++;
    return runs;
}

/** Sample-to-sample steps larger than `thr` — clicks. Skips the first
 *  half-second (source start + prime fill). */
function discontinuities(out, thr) {
    let n = 0;
    for (let i = 24001; i < out.length; i++) {
        if (Math.abs(out[i] - out[i - 1]) > thr) n++;
    }
    return n;
}

const rms = (x, from = 0, to = x.length) => {
    let s = 0;
    for (let i = from; i < to; i++) s += x[i] * x[i];
    return Math.sqrt(s / Math.max(1, to - from));
};

/** Coarse (envelope) lag estimate of out vs dry, in samples. */
function coarseLag(dry, out, maxLag = 24000) {
    const W = 120;
    const env = (x) => {
        const e = new Float32Array(Math.floor(x.length / W));
        for (let i = 0; i < e.length; i++) {
            let s = 0;
            for (let j = i * W; j < (i + 1) * W; j++) s += Math.abs(x[j]);
            e[i] = s;
        }
        return e;
    };
    const de = env(dry);
    const oe = env(out);
    let best = 0;
    let bestCorr = -Infinity;
    for (let lag = 0; lag <= Math.ceil(maxLag / W); lag++) {
        let c = 0;
        for (let i = 0; i + lag < oe.length && i < de.length; i++) c += de[i] * oe[i + lag];
        if (c > bestCorr) { bestCorr = c; best = lag; }
    }
    return best * W;
}

/** Exact integer lag minimising mean |dry[i] − out[i+lag]| near a coarse lag. */
function exactLag(dry, out, coarse, halfWindow = 600) {
    const from = 48000;
    const to = Math.min(dry.length, 48000 * 3);
    let best = coarse;
    let bestErr = Infinity;
    for (let lag = Math.max(0, coarse - halfWindow); lag <= coarse + halfWindow; lag++) {
        let err = 0;
        for (let i = from; i < to; i += 7) { // stride: cheap, still ~14k points
            const j = i + lag;
            if (j >= out.length) { err = Infinity; break; }
            err += Math.abs(dry[i] - out[j]);
        }
        if (err < bestErr) { bestErr = err; best = lag; }
    }
    return best;
}

// ---------- browser side ----------

const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => {
    if (m.type() === 'error') { consoleErrors.push(m.text()); console.log('  [page err]', m.text().slice(0, 160)); }
});
page.on('pageerror', (e) => { consoleErrors.push(String(e)); console.log('  [page exception]', String(e).slice(0, 160)); });

const speechB64 = readFileSync(SPEECH_WAV).toString('base64');

try {
    console.log('== setup ==', BASE);
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // Shared in-page rig: builds a DF instance (bypass or real) with a dry
    // reference tap and a processed tap into one capture worklet.
    await page.evaluate(async ({ wavB64 }) => {
        const mod = await import('/src/api/deepFilter.ts');
        const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));

        window.__rig = {
            mod,
            wavBytes,
            async build(bypass) {
                const ctx = new AudioContext({ sampleRate: 48000 });
                await ctx.resume();
                const speech = await ctx.decodeAudioData(wavBytes.slice().buffer);
                const recSrc = `
                    class Rec extends AudioWorkletProcessor {
                        constructor() { super(); this.on = false; this.port.onmessage = (e) => { this.on = e.data === 'on'; }; }
                        process(inputs) {
                            if (this.on) {
                                const a = inputs[0]?.[0]; const b = inputs[1]?.[0];
                                this.port.postMessage({
                                    a: a ? new Float32Array(a) : new Float32Array(128),
                                    b: b ? new Float32Array(b) : new Float32Array(128),
                                });
                            }
                            return true;
                        }
                    }
                    registerProcessor('df-e2e-rec', Rec);
                `;
                await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([recSrc], { type: 'text/javascript' })));
                const rec = new AudioWorkletNode(ctx, 'df-e2e-rec', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
                rec.connect(ctx.destination);
                const cap = { a: [], b: [] };
                rec.port.onmessage = (e) => { cap.a.push(e.data.a); cap.b.push(e.data.b); };

                const msDest = ctx.createMediaStreamDestination();
                const t0 = performance.now();
                const nodes = await mod.applyDeepFilter(ctx, msDest.stream, 1, bypass ? { bypassInference: true } : undefined);
                const initMs = performance.now() - t0;
                nodes.gain.connect(rec, 0, 1);

                let srcNode = null;
                const playInto = (buffer) => {
                    if (srcNode) { try { srcNode.stop(); srcNode.disconnect(); } catch { /* replaced */ } }
                    srcNode = ctx.createBufferSource();
                    srcNode.buffer = buffer;
                    srcNode.loop = true;
                    srcNode.connect(msDest);
                    srcNode.connect(rec, 0, 0);
                    srcNode.start();
                };

                window.__inst = {
                    ctx, nodes, rec, cap, playInto, speech, msDest,
                    record: (on) => rec.port.postMessage(on ? 'on' : 'off'),
                    drain: () => {
                        const total = cap.a.reduce((s, c) => s + c.length, 0);
                        const A = new Float32Array(total);
                        const B = new Float32Array(total);
                        let o = 0;
                        for (let i = 0; i < cap.a.length; i++) { A.set(cap.a[i], o); B.set(cap.b[i], o); o += cap.a[i].length; }
                        cap.a.length = 0; cap.b.length = 0;
                        const b64 = (f32) => {
                            const u8 = new Uint8Array(f32.buffer);
                            let s = '';
                            for (let i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768));
                            return btoa(s);
                        };
                        return { a: b64(A), b: b64(B) };
                    },
                    stats: () => JSON.parse(JSON.stringify(mod.deepFilterDiagnostics())),
                    teardown: async () => {
                        try { srcNode?.stop(); } catch { /* stopped */ }
                        window.__inst.nodes.worklet.destroy?.();
                        await ctx.close();
                    },
                };
                return { initMs: Math.round(initMs) };
            },
            jam(on) {
                if (on) {
                    window.__jam = { stop: false, maxGap: 0 };
                    let last = performance.now();
                    const mon = setInterval(() => {
                        const now = performance.now();
                        if (now - last > window.__jam.maxGap) window.__jam.maxGap = now - last;
                        last = now;
                        if (window.__jam.stop) clearInterval(mon);
                    }, 10);
                    (function jamLoop() {
                        if (window.__jam.stop) return;
                        const t0 = performance.now();
                        while (performance.now() - t0 < 70) { /* burn the main thread */ }
                        setTimeout(jamLoop, 50);
                    })();
                } else if (window.__jam) {
                    window.__jam.stop = true;
                }
                return window.__jam?.maxGap ?? 0;
            },
        };
    }, { wavB64: speechB64 });

    // ================= TRANSPORT (bypass) =================
    console.log('== transport: bypass instance — sample-exact through steady + jam ==');
    const tInit = await page.evaluate(() => window.__rig.build(true));
    check('transport: graph built', true, `init ${tInit.initMs} ms`);

    await page.evaluate(() => { window.__inst.playInto(window.__inst.speech); window.__inst.record(true); });
    await page.waitForTimeout(4000);
    await page.evaluate(() => window.__rig.jam(true));
    await page.waitForTimeout(4000);
    const tRes = await page.evaluate(() => {
        const maxGap = window.__rig.jam(false);
        window.__inst.record(false);
        return { ...window.__inst.drain(), stats: window.__inst.stats(), maxGap };
    });
    const tDry = b64ToF32(tRes.a);
    const tOut = b64ToF32(tRes.b);
    console.log(`  captured ${tOut.length} samples; jam max gap ${tRes.maxGap.toFixed(0)} ms; worklet:`, JSON.stringify(tRes.stats.worklet));

    check('transport jam control: main thread REALLY stalled (gap >= 60 ms)', tRes.maxGap >= 60, `${tRes.maxGap.toFixed(0)} ms`);
    {
        const lag = exactLag(tDry, tOut, coarseLag(tDry, tOut));
        // Compare everything after spin-up (skip 1 s) — through the jam too.
        let mismatches = 0;
        let compared = 0;
        let maxDev = 0;
        for (let i = 48000; i + lag < tOut.length && i < tDry.length; i++) {
            const d = Math.abs(tDry[i] - tOut[i + lag]);
            compared++;
            if (d > 1e-6) mismatches++;
            if (d > maxDev) maxDev = d;
        }
        console.log(`  aligned at lag ${lag} (${(lag / 48).toFixed(1)} ms), compared ${compared} samples`);
        check('transport: emitted stream is SAMPLE-EXACT vs input (steady AND jam)', compared > 300000 && mismatches === 0, `mismatches=${mismatches}, maxDev=${maxDev.toExponential(2)}`);
        check('transport: latency within budget (<= 60 ms)', lag <= 2880, `${(lag / 48).toFixed(1)} ms`);
        check('transport: no zero-runs', zeroRuns(tOut, tDry, lag) === 0);
        const ws = tRes.stats.worklet;
        check('transport: zero dry-fallback samples through the jam', ws && ws.drySamples === 0, ws ? `dry=${ws.drySamples}` : 'no stats');

        // Detector positive controls: inject the old design's exact artifact
        // (a zero-filled hop) into the capture — a glitch in silence is
        // inaudible and undetectable, which is fine, so place it DIRECTLY
        // after the largest-|sample| peak: the step from that peak to 0 is
        // then >= peak amplitude (~0.75 for this wav), deterministically over
        // the 0.35 threshold. (A loudest-RMS-window heuristic was measured to
        // fire only ~65% of runs — boundary samples can sit near zero
        // crossings even in a loud window.)
        const glitched = Float32Array.from(tOut);
        let at = 48001;
        let peak = 0;
        for (let i = 48000; i < glitched.length - 4800; i++) {
            const a = Math.abs(glitched[i]);
            if (a > peak) { peak = a; at = i + 1; }
        }
        check('control precondition: peak sample >= 0.5 (wav peaks ~0.77)', peak >= 0.5, `peak ${peak.toFixed(3)}`);
        for (let i = at; i < at + 480; i++) glitched[i] = 0;
        check('control: zero-run detector fires on injected zero-filled hop', zeroRuns(glitched, tDry, lag) >= 1);
        check('control: discontinuity detector fires on injected zero-filled hop', discontinuities(glitched, 0.35) >= 1);
        check('control: clean capture passes the discontinuity detector', discontinuities(tOut, 0.35) === 0);
    }
    await page.evaluate(() => window.__inst.teardown());

    // ================= REAL MODEL =================
    console.log('== real model: full DFN3 wasm ==');
    const rInit = await page.evaluate(() => window.__rig.build(false));
    check('real: graph built (wasm + warmup)', true, `init ${rInit.initMs} ms`);

    console.log('== real steady: 8 s speech ==');
    await page.evaluate(() => { window.__inst.playInto(window.__inst.speech); window.__inst.record(true); });
    await page.waitForTimeout(8000);
    const rSteady = await page.evaluate(() => {
        window.__inst.record(false);
        return { ...window.__inst.drain(), stats: window.__inst.stats() };
    });
    const rDry = b64ToF32(rSteady.a);
    const rOut = b64ToF32(rSteady.b);
    const rwk = rSteady.stats.worklet;
    const rwr = rSteady.stats.worker;
    console.log(`  captured ${rOut.length} samples; worklet:`, JSON.stringify(rwk), 'worker:', JSON.stringify(rwr));

    check('real steady: no discontinuities (|step| > 0.35)', discontinuities(rOut, 0.35) === 0, `count=${discontinuities(rOut, 0.35)}`);
    if (rwk) {
        const processedPct = (100 * rwk.processedSamples) / Math.max(1, rwk.processedSamples + rwk.drySamples);
        check('real steady: >= 99% processed (not dry fallback)', processedPct >= 99, `${processedPct.toFixed(2)}%`);
        check('real steady: not overloaded', rwk.overloaded === false);
    } else {
        check('real steady: worklet stats present', false);
    }
    check('real steady: inference realtime headroom (avg < 8 ms per 10 ms hop)', !!rwr && rwr.avgMs < 8, rwr ? `avg ${rwr.avgMs.toFixed(2)} ms, max ${rwr.maxMs.toFixed(2)} ms` : 'no stats');
    {
        const lag = coarseLag(rDry, rOut);
        check('real steady: end-to-end latency <= 120 ms', lag <= 5760, `${(lag / 48).toFixed(1)} ms`);
        const ratio = rms(rOut, 48000) / Math.max(1e-9, rms(rDry, 48000));
        check('real steady: SPEECH SURVIVES the model (out RMS >= 25% of dry)', ratio >= 0.25, `ratio ${ratio.toFixed(3)}`);
        // Level fidelity from above: the level wrapper's forward gain must be
        // exactly inverted on the way out (a dropped inverse ships the mic at
        // the wrong loudness while every lower-bound check still passes).
        check('real steady: level-faithful from ABOVE (out RMS <= 120% of dry)', ratio <= 1.2, `ratio ${ratio.toFixed(3)}`);
        const zr = zeroRuns(rOut, rDry, lag);
        console.log(`  real steady zero-runs (informational — model gating can zero pauses): ${zr}`);
    }

    console.log('== real jam: 8 s of 70 ms main-thread busy bursts ==');
    await page.evaluate(() => { window.__inst.record(true); window.__rig.jam(true); });
    await page.waitForTimeout(8000);
    const rJam = await page.evaluate(() => {
        const maxGap = window.__rig.jam(false);
        window.__inst.record(false);
        return { ...window.__inst.drain(), stats: window.__inst.stats(), maxGap };
    });
    const jDry = b64ToF32(rJam.a);
    const jOut = b64ToF32(rJam.b);
    console.log(`  captured ${jOut.length} samples; jam max gap ${rJam.maxGap.toFixed(0)} ms; worklet:`, JSON.stringify(rJam.stats.worklet));
    check('real jam control: main thread REALLY stalled (gap >= 60 ms)', rJam.maxGap >= 60, `${rJam.maxGap.toFixed(0)} ms`);
    check('real jam: no discontinuities (|step| > 0.35)', discontinuities(jOut, 0.35) === 0, `count=${discontinuities(jOut, 0.35)}`);
    // Signal-presence floor: without it a DEAD node (recorder substitutes
    // zeros) passes the discontinuity check trivially — all-zero output has no
    // steps. The speech keeps playing through the jam, so the output must
    // still carry it.
    const jRatio = rms(jOut) / Math.max(1e-9, rms(jDry));
    check('real jam: output still carries the speech (RMS >= 15% of dry)', jRatio >= 0.15 && rms(jOut) > 0.01, `ratio ${jRatio.toFixed(3)}`);
    if (rJam.stats.worklet && rwk) {
        const dryDelta = rJam.stats.worklet.drySamples - rwk.drySamples;
        check('real jam: zero NEW dry-fallback samples (audio thread + worker unaffected)', dryDelta === 0, `delta=${dryDelta}`);
        check('real jam: still not overloaded', rJam.stats.worklet.overloaded === false);
        // Frozen telemetry (a worklet whose process() stopped running) would
        // pass both checks above — prove the counters ADVANCED through the jam.
        const emitDelta = rJam.stats.worklet.emittedSamples - rwk.emittedSamples;
        check('real jam: worklet telemetry advanced through the jam (~8 s of samples)', emitDelta >= 300000, `delta=${emitDelta}`);
    } else {
        check('real jam: worklet stats present', false);
    }

    console.log('== real noise: 5 s white noise — must be crushed ==');
    const rNoise = await page.evaluate(async () => {
        const ctx = window.__inst.ctx;
        const noise = ctx.createBuffer(1, 48000 * 4, 48000);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.25;
        const statsBefore = window.__inst.stats();
        window.__inst.playInto(noise);
        await new Promise((r) => setTimeout(r, 1500)); // model settle
        window.__inst.record(true);
        await new Promise((r) => setTimeout(r, 5000));
        window.__inst.record(false);
        return { ...window.__inst.drain(), statsBefore, statsAfter: window.__inst.stats() };
    });
    const nDry = b64ToF32(rNoise.a);
    const nOut = b64ToF32(rNoise.b);
    const attDb = 20 * Math.log10(Math.max(1e-9, rms(nOut)) / Math.max(1e-9, rms(nDry)));
    check('real noise: attenuated by >= 8 dB', attDb <= -8, `${attDb.toFixed(1)} dB`);
    // One-sidedness guard: a DEAD graph (silent output) would "pass" the
    // attenuation check spectacularly — and output RMS can NOT arbitrate,
    // because a healthy DFN3 (unlimited attenuation) legitimately gates pure
    // noise to exact digital zero (observed live: run-to-run it lands
    // anywhere from ~-33 dB residual to true 0.0). Telemetry can: a dead
    // node's counters freeze, a live one advances ~6.5 s of samples here.
    {
        const b = rNoise.statsBefore?.worklet;
        const a = rNoise.statsAfter?.worklet;
        const emitDelta = a && b ? a.emittedSamples - b.emittedSamples : -1;
        const dryDelta = a && b ? a.drySamples - b.drySamples : -1;
        check('real noise: worklet PROCESSED through the phase (telemetry advanced, zero dry)',
            emitDelta >= 250000 && dryDelta === 0, `emitDelta=${emitDelta}, dryDelta=${dryDelta}`);
    }

    // ---- tuning pin: quiet speaker over fan noise --------------------------
    // Pins the "quieter" half of the 2026-08-05 field report. What each check
    // actually discriminates (mutation-tested — be precise, two earlier
    // wordings overclaimed):
    //  - SOFT-EATEN: gross lsnr-gate regressions (a FULL revert to upstream
    //    defaults). A minDbThresh-ONLY revert moves this just 0.9%→2.6% (with
    //    attenLimDb set, gated frames render at ~3% of dry, and most upstream
    //    gating lands in pauses) — single-knob edits are pinned by the
    //    literal unit test in src/tests/dfTuning.test.ts instead.
    //  - tail ratio BAND: the level wrapper's exact-inverse (a dropped
    //    inverse measures 1.385, outside [0.3, 1.2] — mutation-verified) and
    //    quiet-speech survival.
    //  - levelGain: the level wrapper being alive and boosting.
    console.log('== tuning pin: quiet speaker (-12 dB) over fan noise, 14 s ==');
    const quiet = await page.evaluate(async () => {
        const ctx = window.__inst.ctx;
        const scaled = ctx.createBuffer(1, window.__inst.speech.length, 48000);
        const src = window.__inst.speech.getChannelData(0);
        const dst = scaled.getChannelData(0);
        for (let i = 0; i < src.length; i++) dst[i] = src[i] * 0.25;
        // Seeded pink-ish fan noise at ~5 dB SNR against the quiet speech.
        const noise = ctx.createBuffer(1, 48000 * 4, 48000);
        {
            const d = noise.getChannelData(0);
            let seed = 0x5eed1234;
            const rand = () => {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
            };
            let y = 0;
            for (let i = 0; i < d.length; i++) { y = 0.86 * y + 0.14 * rand(); d[i] = y * 2.2 * 0.06; }
        }
        window.__inst.playInto(scaled);
        const noiseNode = ctx.createBufferSource();
        noiseNode.buffer = noise;
        noiseNode.loop = true;
        noiseNode.connect(window.__inst.msDest);
        noiseNode.start();
        await new Promise((r) => setTimeout(r, 2000)); // settle
        window.__inst.record(true);
        await new Promise((r) => setTimeout(r, 12000));
        window.__inst.record(false);
        noiseNode.stop();
        return { ...window.__inst.drain(), stats: window.__inst.stats() };
    });
    const qDry = b64ToF32(quiet.a);
    const qOut = b64ToF32(quiet.b);
    {
        // Align, then SLIDING 60-sample windows (step 60) over speech-ACTIVE
        // dry audio: an "eaten" window kept <10% of the dry RMS (the lsnr
        // gate renders gated hops at ~3% under attenLimDb 30; healthy windows
        // sit ~90%). Windows must be much smaller than the 480-sample hop:
        // the capture grid sits at an arbitrary phase against the model's hop
        // grid, so hop-sized frames straddle gate boundaries and dilute the
        // signal below any threshold (mutation-tested — that version missed a
        // minDbThresh revert entirely).
        const lag = exactLag(qDry, qOut, coarseLag(qDry, qOut));
        const W = 60;
        // Two dry-level bands: the lsnr gate bites SOFT speech (word edges,
        // quiet syllables — the field complaint), while loud cores clear the
        // threshold in any config. Assert on the soft band; report both.
        const bands = { soft: { n: 0, eaten: 0 }, loud: { n: 0, eaten: 0 } };
        for (let f = 48000; f + W + lag < qOut.length && f + W < qDry.length; f += W) {
            const dr = rms(qDry, f, f + W);
            if (dr < 0.006) continue; // pause/breath — not speech
            const band = dr < 0.02 ? bands.soft : bands.loud;
            band.n++;
            if (rms(qOut, f + lag, f + lag + W) < 0.1 * dr) band.eaten++;
        }
        const pct = (b) => (100 * b.eaten) / Math.max(1, b.n);
        console.log(`  eaten windows: soft ${bands.soft.eaten}/${bands.soft.n} (${pct(bands.soft).toFixed(1)}%), loud ${bands.loud.eaten}/${bands.loud.n} (${pct(bands.loud).toFixed(1)}%), lag ${lag}`);
        check('tuning pin: SOFT speech not eaten by the lsnr gate (< 10% of soft windows)',
            bands.soft.n > 300 && pct(bands.soft) < 10, `${pct(bands.soft).toFixed(1)}%`);
        // Level fidelity, measured on the LAST 6 s where levelGain has
        // converged high (~1.6): the exact-inverse pin. Forward gain without
        // the inverse lands ~1.5× here; averaging the whole capture would
        // dilute that below any usable bound (also mutation-tested).
        const tail = Math.max(48000, qDry.length - 6 * 48000 - lag);
        const tailLen = Math.min(qDry.length - tail, qOut.length - tail - lag);
        const qTailRatio = rms(qOut, tail + lag, tail + lag + tailLen)
            / Math.max(1e-9, rms(qDry, tail, tail + tailLen));
        check('tuning pin: quiet speech survives, level-faithful (tail out/dry in [0.3, 1.2])',
            qTailRatio >= 0.3 && qTailRatio <= 1.2, `tail ratio ${qTailRatio.toFixed(3)}`);
        const qGain = quiet.stats.worker?.levelGain;
        check('tuning pin: level wrapper ALIVE and boosting the quiet speaker (levelGain > 1.5)',
            typeof qGain === 'number' && qGain > 1.5, `levelGain ${qGain?.toFixed?.(2)}`);
    }

    await page.evaluate(() => window.__inst.teardown());
    check('teardown clean', true);

    const relevantErr = consoleErrors.filter((t) => /deepfilter|worklet|dfworker|wasm/i.test(t));
    check('no DF-related console errors', relevantErr.length === 0, relevantErr.slice(0, 2).join(' | '));
} catch (e) {
    console.error('HARNESS ERROR:', e);
    failures++;
} finally {
    await browser.close();
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
