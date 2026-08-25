// Does RNNoise actually suppress anything? Reproduction harness, not a fix.
//
// "RNNoise doesn't seem to be working" has several causes that look identical
// to a user, and the app cannot currently tell them apart:
//
//   1. the worklet js / wasm fail to load, or addModule is rejected
//   2. the graph builds but the worklet's wasm fails on the AUDIO thread, and
//      the library's process() emits nothing — a live track of pure zeros
//   3. the graph builds and passes audio through WITHOUT suppressing it
//
// (1) throws out of processAudioStream, and media.ts catches it and carries on
// with a mic whose noise suppression is FULLY OFF — getMicConstraints turns
// native NS off whenever the mode is 'rnnoise'. So a failure is worse than
// never selecting RNNoise, and at one of the two call sites it isn't even
// logged. (2) is caught by the liveness watchdog. (3) is caught by nothing.
//
// NOTE ON EVIDENCE: `[NoiseFilter] RNNoise active` is printed right after
// connect(), before the worklet's wasm has initialised on the audio thread. It
// is not evidence that anything is being processed. Only measuring the output
// is.
//
// Drives the REAL module through Vite so it cannot drift from shipped code.
//
// Prereqs: vite dev server (no backend, no login).
// Usage: APP_ORIGIN=http://localhost:5174 node e2e/rnnoise-live.mjs
import { chromium } from '@playwright/test';

const ORIGIN = process.env.APP_ORIGIN || 'http://localhost:5173';

let failures = 0;
const check = (n, ok, d) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`);
    if (!ok) failures++;
};
const info = (n, d) => console.log(`INFO  ${n}${d !== undefined ? '  — ' + d : ''}`);

const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext()).newPage();
const consoleLines = [];
page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`));
page.on('pageerror', e => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));

try {
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const run = await page.evaluate(async () => {
        const nf = await import('/src/api/noiseFilter.ts');

        const src = new AudioContext({ sampleRate: 48000 });
        if (src.state === 'suspended') await src.resume().catch(() => {});

        // 2 s of white noise on a loop — the thing RNNoise exists to remove.
        const noiseBuf = src.createBuffer(1, src.sampleRate * 2, src.sampleRate);
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.25;

        /**
         * A fresh, independent input stream per measurement.
         *
         * They cannot be shared: cleanupNoiseFilter() STOPS the tracks of the
         * stream it was given (rawInputStream), so reusing one destination for
         * a second run measures a dead track and reads 0.0000 — which looks
         * exactly like total suppression. That is a harness trap, not a product
         * bug, and it invalidated the first version of this comparison.
         */
        const makeInput = (kind) => {
            const dest = src.createMediaStreamDestination();
            if (kind === 'noise') {
                const n = src.createBufferSource();
                n.buffer = noiseBuf;
                n.loop = true;
                n.connect(dest);
                n.start();
            } else {
                const osc = src.createOscillator();
                osc.frequency.value = 440;
                const g = src.createGain();
                g.gain.value = 0.5;
                osc.connect(g);
                g.connect(dest);
                osc.start();
            }
            return dest.stream;
        };

        /** Peak amplitude of a MediaStream over `ms`, after `settleMs`. */
        const measure = async (stream, settleMs, ms) => {
            const meter = new AudioContext({ sampleRate: 48000 });
            if (meter.state === 'suspended') await meter.resume().catch(() => {});
            const s = meter.createMediaStreamSource(stream);
            const an = meter.createAnalyser();
            an.fftSize = 2048;
            s.connect(an);
            const buf = new Float32Array(an.fftSize);
            const freq = new Float32Array(an.frequencyBinCount);
            await new Promise(r => setTimeout(r, settleMs));
            let peak = 0, rms = 0, n = 0;
            const end = performance.now() + ms;
            while (performance.now() < end) {
                an.getFloatTimeDomainData(buf);
                let sum = 0;
                for (const v of buf) {
                    const a = Math.abs(v);
                    if (a > peak) peak = a;
                    sum += v * v;
                }
                rms += Math.sqrt(sum / buf.length);
                n++;
                await new Promise(r => setTimeout(r, 50));
            }
            // Spectral tilt: mean dB of the top eighth of the spectrum minus
            // the middle eighth. White noise is FLAT, so a pass-through leaves
            // this near 0. RNNoise applies per-band gains and drives the top
            // bands far down, which no pass-through can do at any volume.
            an.getFloatFrequencyData(freq);
            const bandDb = (i) => {
                const lo = Math.floor(freq.length * i / 8), hi = Math.floor(freq.length * (i + 1) / 8);
                let sum = 0;
                for (let j = lo; j < hi; j++) sum += freq[j];
                return sum / (hi - lo);
            };
            const tilt = bandDb(7) - bandDb(3);
            await meter.close().catch(() => {});
            return { peak, rms: n ? rms / n : 0, tilt };
        };

        const out = { threw: null };

        // --- RNNoise on white noise -----------------------------------------
        nf.setNoiseSuppressionMode('rnnoise', false);
        const nsIn = makeInput('noise');
        const t0 = performance.now();
        let nsOut;
        try {
            nsOut = await nf.processAudioStream(nsIn);
        } catch (e) {
            out.threw = String(e).slice(0, 400);
            return out;
        }
        out.buildMs = Math.round(performance.now() - t0);
        out.passedThrough = nsOut.getAudioTracks()[0] === nsIn.getAudioTracks()[0];
        // 3 s settle: the worklet's wasm instantiates on the audio thread after
        // construction and emits zeros until it finishes.
        // 10 s settle, NOT 3. RNNoise's noise estimate ADAPTS: measured on
        // white noise, output rms falls 0.111 -> 0.089 -> 0.077 -> 0.064 over
        // ~14 s. A 3 s settle caught it mid-curve at ratio 0.74 and read as
        // "not suppressing", which is how this harness first accused a working
        // worklet of being a pass-through.
        out.rnnoiseNoise = await measure(nsOut, 10000, 3000);
        out.mode = nf.getNoiseSuppressionMode();
        nf.cleanupNoiseFilter();

        // --- RNNoise on a 440 Hz tone ---------------------------------------
        // Separates "suppressing everything (dead)" from "suppressing noise".
        nf.setNoiseSuppressionMode('rnnoise', false);
        const toneOut = await nf.processAudioStream(makeInput('tone'));
        out.rnnoiseTone = await measure(toneOut, 3000, 2500);
        nf.cleanupNoiseFilter();

        // --- The SAME noise with no suppression at all -----------------------
        // The assumption-free baseline: how much RNNoise *should* attenuate
        // synthetic noise is a judgement call; that it must attenuate it
        // relative to mode 'off' is not.
        nf.setNoiseSuppressionMode('off', false);
        const offOut = await nf.processAudioStream(makeInput('noise'));
        out.offNoise = await measure(offOut, 500, 2500);
        nf.cleanupNoiseFilter();

        await src.close().catch(() => {});
        return out;
    });

    if (run.threw) {
        check('processAudioStream builds an rnnoise graph', false, run.threw);
    } else {
        check('processAudioStream builds an rnnoise graph', true, `${run.buildMs} ms`);
        check('it returns a PROCESSED track, not the input passed straight back',
            run.passedThrough === false);
        check('the mode stayed rnnoise (no silent fallback)', run.mode === 'rnnoise', run.mode);

        info('noise through RNNoise  peak/rms',
            `${run.rnnoiseNoise.peak.toFixed(4)} / ${run.rnnoiseNoise.rms.toFixed(4)}`);
        info('tone  through RNNoise  peak/rms',
            `${run.rnnoiseTone.peak.toFixed(4)} / ${run.rnnoiseTone.rms.toFixed(4)}`);
        info('noise through mode OFF peak/rms',
            `${run.offNoise.peak.toFixed(4)} / ${run.offNoise.rms.toFixed(4)}`);

        // Control: the baseline must be non-zero, or every ratio below is
        // meaningless (a dead input reads as perfect suppression).
        check('control: the OFF baseline actually carries audio',
            run.offNoise.rms > 0.01, `rms ${run.offNoise.rms.toFixed(4)}`);

        check('the graph is not emitting pure silence (tone passes)',
            run.rnnoiseTone.peak > 1e-4, `tone peak ${run.rnnoiseTone.peak.toFixed(6)}`);

        const supp = run.offNoise.rms > 0 ? run.rnnoiseNoise.rms / run.offNoise.rms : Infinity;
        // Reported, NOT gated. Measured across runs this wandered 0.74-0.80 at
        // 3 s and 10 s settle alike, while a one-off probe saw it fall to 0.44
        // over 14 s. Too unstable to assert on, and a flapping gate is as
        // useless as one that cannot fail.
        info('RNNoise / OFF  noise rms ratio (informational)', supp.toFixed(3));

        // THE RELIABLE SIGNAL. White noise is spectrally flat, so any large
        // tilt in the output can only come from per-band gains being applied.
        // Measured: OFF ~0 dB, RNNoise ~-135 dB. There is no volume setting or
        // resampling artefact that turns a pass-through into that.
        info('spectral tilt  OFF   (dB, top band - mid band)', run.offNoise.tilt.toFixed(1));
        info('spectral tilt  RNNoise', run.rnnoiseNoise.tilt.toFixed(1));
        check('control: OFF leaves the noise spectrum roughly flat',
            Math.abs(run.offNoise.tilt) < 25, `${run.offNoise.tilt.toFixed(1)} dB`);
        check('RNNoise SHAPES the spectrum (per-band gains are being applied)',
            run.rnnoiseNoise.tilt < -40,
            `${run.rnnoiseNoise.tilt.toFixed(1)} dB — near the OFF value means PASS-THROUGH`);
    }

    const relevant = consoleLines.filter(l => /NoiseFilter|rnnoise|worklet|wasm/i.test(l));
    if (relevant.length) {
        console.log('\n--- page console ---');
        relevant.slice(0, 20).forEach(l => console.log('   ' + l));
    }
} catch (e) {
    console.log('EXCEPTION:', String(e).split('\n').slice(0, 4).join(' | '));
    failures++;
} finally {
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
    await browser.close();
    process.exit(failures === 0 ? 0 : 1);
}
