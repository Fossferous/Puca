// DeepFilterNet MUSICAL NOISE (roughness) measurement + postFilterBeta A/B.
//
// Field report (2026-08-10/11, v0.8.56 diagnostics): DeepFilter mode produces
// "a bit of static in the background" and a warbly voice level while RNNoise
// on the same mic is clean. Every pipeline/boundary mechanism was ruled out by
// live counters (overBudget/dry/flips/nearSilent/seam all zero), which leaves
// a SPECTRAL artifact: isolated time-frequency bins switching on/off frame to
// frame — musical noise, the classic residual of mask-based suppressors.
//
// df-longrun.mjs cannot see this: its metrics (RMS ratio, HF ratio, zero%)
// are level/muffling measures, and a warbly output has the same power as a
// smooth one. This harness adds a roughness metric and FIRST proves it can
// see the artifact (positive control), per the standing rule that a detector
// without a positive control proves nothing.
//
// Metrics (computed on STFT log-magnitudes, 20 ms Hann window / 10 ms hop,
// 300 Hz - 10 kHz band). A first attempt used per-bin dB flux and
// isolated-single-frame peaks; its own positive control PROVED it blind
// (plain pink noise already fluctuates ~6 dB/bin Rayleigh-style, and 50%-
// overlap resynthesis smears any one-frame blip across 2-3 analysis frames).
// These two are the literature's musical-noise measures instead:
//  - kurt: kurtosis of the temporally-WHITENED power (each bin divided by its
//    own long-term mean) pooled over all active time-frequency cells — the
//    Uemura/Miyabe kurtosis measure. Stationary noise is exponential-ish
//    (kurt ~9); musical noise concentrates energy in few isolated cells,
//    fattening the tail. Compare as a RATIO between configs on identical
//    content — the absolute number also reflects speech sparsity.
//  - blipRate: fraction of cells >= 10 dB above the SAME bin's median over a
//    +/-5-frame window — a short-lived narrowband blip (1-3 frames survives
//    this test; steady tones raise the median and do not).
//
// Positive control: seeded pink noise resynthesized through a per-frame random
// binary spectral mask (keep 15% of bins, zero the rest) — the textbook
// spectral-subtraction musical-noise generator. The metric must separate the
// masked version from the plain one decisively or the harness ABORTS.
//
// A/B: production tuning vs production + postFilterBeta (upstream's perceptual
// post filter, Valin et al. — reshapes per-bin gains so low-gain residual bins
// get pushed further down while speech-dominated bins pass untouched; it
// exists precisely to suppress musical noise, upstream uses beta=0.02 when
// enabled). Documented tradeoff is over-attenuation of noisy sections, so the
// speech RMS ratio is tracked beside the roughness numbers.
//
// Scenarios reproduce the reporting user's operating point: speechGain is
// calibrated so the worker's levelEnv averages ~0.08 over a full speech-loop
// period (the value measured live in the field report), over steady seeded
// pink noise (musical noise needs noise to be born from). levelEnv is an
// instant-attack decay-max, so single reads swing with loop phase — the
// calibration averages a whole period AND re-verifies at the computed gain
// (±20% tolerance), because an earlier open-loop version landed 35% high
// while claiming the target.
//
// MEASURED 2026-08-11 (seeded; calibration verified: speechGain 0.346 ->
// loop-avg levelEnv 0.0838, +4.7% of the 0.08 target; per-scenario S-user
// loop-avg 0.0896, S-residual 0.0375; worker health accumulated over EVERY
// capture window: seamHops 0, nearSilentHops 0, dryHops 0 throughout):
//   positive control: plain noise kurt 9.34 / blip 0.550% vs masked 47.86 /
//   4.829% (x5.12 / x8.77) — each metric gated separately.
//   The artifact class is REAL on this fixture: S-residual mix kurt 13.70 ->
//   out kurt 4711 (the model's output is a vastly spikier T-F field than its
//   input; some of that is legitimate suppression sparsity, so only PAIRED
//   config comparisons on identical content are meaningful).
//   config                    S-user kurt/blip%/rms      S-residual kurt/blip%/rms
//   production (beta off)     462.26 / 2.952 / 0.904     4711.01 / 0.937 / 0.744
//   beta 0.02 (upstream on)   455.65 / 3.278 / 0.902     4058.03 / 0.982 / 0.715
//   beta 0.05                 479.82 / 3.158 / 0.901     5266.37 / 0.896 / 0.704
//   Verdict: at the VERIFIED operating point beta 0.02's S-user effect is
//   within run noise (kurt -1.4%, rms -0.2%); its measurable benefit is in
//   the noise-dominant regime (S-residual kurt -13.9% at -3.9% rms), where
//   0.05 is actively WORSE than off (+11.8%) — so 0.02, upstream's own
//   on-value, is the right beta. NOTE: an earlier mis-calibrated run (+35%
//   hot) showed "24% kurt reduction at the operating point"; the verified
//   re-run does not reproduce that — magnitude claims from this fixture must
//   come from a run whose calibration line printed inside tolerance. Neither
//   beta is transformative here, which is why the post filter ships as an
//   OPT-IN toggle (Settings -> Advanced -> Experimental) rather than a
//   default change: the reporting user A/Bs it in the room the artifact
//   actually lives in.
//
// Prereqs: vite dev server. Usage: node e2e/df-roughness.mjs
//   env: DF_BASE_URL (default :5173), DF_AB_S (seconds per scenario, default 60)
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DF_BASE_URL || 'http://localhost:5173';
const AB_S = Number(process.env.DF_AB_S || 60);
const SPEECH_WAV = fileURLToPath(new URL('./assets/df-test-speech.wav', import.meta.url));
const TARGET_LEVEL_ENV = 0.08; // field-measured levelEnv on the reporting mic

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [page exception]', String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 200)); });

const speechB64 = readFileSync(SPEECH_WAV).toString('base64');

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    // ---- In-page DSP toolkit: FFT, STFT roughness metrics, seeded noise. ----
    await page.evaluate(() => {
        const N = 1024; // FFT size (window 960 zero-padded)
        const WIN = 960; // 20 ms @ 48 kHz
        const HOP = 480; // 10 ms — matches the model's hop
        // Band 300 Hz - 10 kHz: bin = f * N / 48000
        const K_LO = 7, K_HI = 213;

        // Iterative radix-2 complex FFT (in-place, re/im arrays).
        const fft = (re, im) => {
            const n = re.length;
            for (let i = 1, j = 0; i < n; i++) {
                let bit = n >> 1;
                for (; j & bit; bit >>= 1) j ^= bit;
                j ^= bit;
                if (i < j) {
                    [re[i], re[j]] = [re[j], re[i]];
                    [im[i], im[j]] = [im[j], im[i]];
                }
            }
            for (let len = 2; len <= n; len <<= 1) {
                const ang = (-2 * Math.PI) / len;
                const wr = Math.cos(ang), wi = Math.sin(ang);
                for (let i = 0; i < n; i += len) {
                    let cr = 1, ci = 0;
                    for (let j = 0; j < len / 2; j++) {
                        const ur = re[i + j], ui = im[i + j];
                        const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
                        const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                        re[i + j] = ur + vr; im[i + j] = ui + vi;
                        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
                        const ncr = cr * wr - ci * wi;
                        ci = cr * wi + ci * wr; cr = ncr;
                    }
                }
            }
        };
        const ifft = (re, im) => {
            for (let i = 0; i < im.length; i++) im[i] = -im[i];
            fft(re, im);
            const n = re.length;
            for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
        };
        const hann = new Float64Array(WIN);
        for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN);

        /** Log-magnitude spectrogram frames of a Float32Array signal. */
        const stftLog = (x) => {
            const frames = [];
            const re = new Float64Array(N), im = new Float64Array(N);
            for (let s = 0; s + WIN <= x.length; s += HOP) {
                re.fill(0); im.fill(0);
                for (let i = 0; i < WIN; i++) re[i] = x[s + i] * hann[i];
                fft(re, im);
                const L = new Float64Array(K_HI - K_LO + 1);
                for (let k = K_LO; k <= K_HI; k++) {
                    L[k - K_LO] = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-7);
                }
                frames.push(L);
            }
            return frames;
        };

        /**
         * Roughness of a signal: { kurt, blipRate (%), frames }.
         * Frames whose band-mean level is under -85 dB are silence — skipped,
         * so the metric judges audible content only.
         */
        window.__roughness = (x) => {
            const F = stftLog(x);
            const nk = K_HI - K_LO + 1;
            const mean = (L) => { let s = 0; for (let i = 0; i < nk; i++) s += L[i]; return s / nk; };
            const active = F.map((L) => mean(L) >= -85);
            const idx = [];
            for (let t = 0; t < F.length; t++) if (active[t]) idx.push(t);
            if (idx.length < 12) return { kurt: 0, blipRate: 0, frames: idx.length };

            // Whitening: each bin's power divided by its own long-term mean
            // (over active frames) — removes the spectral tilt (pink noise,
            // speech formants) so the kurtosis judges FLUCTUATION shape only.
            const meanP = new Float64Array(nk);
            for (const t of idx) {
                for (let k = 0; k < nk; k++) meanP[k] += Math.pow(10, F[t][k] / 10);
            }
            for (let k = 0; k < nk; k++) meanP[k] /= idx.length;

            let m1 = 0, m2 = 0, m3 = 0, m4 = 0, n = 0;
            for (const t of idx) {
                for (let k = 0; k < nk; k++) {
                    const p = Math.pow(10, F[t][k] / 10) / (meanP[k] + 1e-30);
                    m1 += p; m2 += p * p; m3 += p * p * p; m4 += p * p * p * p; n++;
                }
            }
            m1 /= n; m2 /= n; m3 /= n; m4 /= n;
            const varr = Math.max(1e-12, m2 - m1 * m1);
            const kurt = (m4 - 4 * m3 * m1 + 6 * m2 * m1 * m1 - 3 * m1 ** 4) / (varr * varr);

            // Blip rate: cell >= 10 dB above the same bin's median over the
            // +/-5 ACTIVE-frame neighborhood (self excluded). A 1-3 frame blip
            // beats the median of 10 neighbors; a sustained tone raises it.
            let blips = 0, cells = 0;
            const W = 5;
            const neigh = [];
            for (let i = W; i < idx.length - W; i++) {
                const t = idx[i];
                for (let k = 0; k < nk; k++) {
                    neigh.length = 0;
                    for (let j = i - W; j <= i + W; j++) {
                        if (j !== i) neigh.push(F[idx[j]][k]);
                    }
                    neigh.sort((a, b) => a - b);
                    const med = neigh[neigh.length >> 1];
                    cells++;
                    if (F[t][k] >= med + 10) blips++;
                }
            }
            return {
                kurt,
                blipRate: cells ? (100 * blips) / cells : 0,
                frames: idx.length,
            };
        };

        /** Seeded pink-ish noise, IDENTICAL generator to df-longrun's rig. */
        window.__makeNoise = (len, seed0) => {
            const d = new Float32Array(len);
            let seed = seed0 | 0;
            const rand = () => {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
            };
            let y = 0;
            for (let i = 0; i < len; i++) {
                y = 0.86 * y + 0.14 * rand();
                d[i] = y * 2.2;
            }
            return d;
        };

        /**
         * Synthetic musical noise: STFT the signal, keep each bin with
         * probability `keep` (fresh seeded coin per frame per bin), zero the
         * rest, overlap-add back. This is the canonical spectral-subtraction
         * artifact generator — the positive control for the metric.
         */
        window.__maskResynth = (x, keep, seed0) => {
            let seed = seed0 | 0;
            const rand = () => {
                seed = (seed + 0x6D2B79F5) | 0;
                let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
            const out = new Float32Array(x.length);
            const re = new Float64Array(N), im = new Float64Array(N);
            for (let s = 0; s + WIN <= x.length; s += HOP) {
                re.fill(0); im.fill(0);
                for (let i = 0; i < WIN; i++) re[i] = x[s + i] * hann[i];
                fft(re, im);
                for (let k = 1; k < N / 2; k++) {
                    if (rand() >= keep) {
                        re[k] = 0; im[k] = 0;
                        re[N - k] = 0; im[N - k] = 0; // conjugate mirror
                    }
                }
                ifft(re, im);
                // Hann at 50% overlap sums to a constant — plain OLA is exact.
                for (let i = 0; i < WIN; i++) out[s + i] += re[i];
            }
            return out;
        };
    });

    // ---- Positive control: prove the metric can SEE musical noise. ----------
    console.log('== positive control: plain vs binary-masked pink noise ==');
    const pc = await page.evaluate(() => {
        const noise = window.__makeNoise(48000 * 10, 0x5eed1234);
        // Scale to a realistic residual level (~-40 dBFS).
        for (let i = 0; i < noise.length; i++) noise[i] *= 0.03;
        const masked = window.__maskResynth(noise, 0.15, 0xabc123);
        return { plain: window.__roughness(noise), masked: window.__roughness(masked) };
    });
    const kurtRatio = pc.masked.kurt / Math.max(1e-9, pc.plain.kurt);
    const blipRatio = pc.masked.blipRate / Math.max(1e-9, pc.plain.blipRate);
    console.log(`  plain  noise: kurt ${pc.plain.kurt.toFixed(2)}  blipRate ${pc.plain.blipRate.toFixed(3)}%`);
    console.log(`  masked noise: kurt ${pc.masked.kurt.toFixed(2)}  blipRate ${pc.masked.blipRate.toFixed(3)}%`);
    console.log(`  separation: kurt x${kurtRatio.toFixed(2)}  blipRate x${blipRatio.toFixed(2)}`);
    // EACH metric is quoted independently in verdicts, so EACH needs its own
    // control gate — with a combined check, one metric could go blind after a
    // future edit and its column would still be read as evidence.
    if (kurtRatio < 2) {
        throw new Error('POSITIVE CONTROL FAILED for kurt (x' + kurtRatio.toFixed(2)
            + '): the kurtosis metric cannot separate synthetic musical noise from plain noise.');
    }
    if (blipRatio < 2) {
        throw new Error('POSITIVE CONTROL FAILED for blipRate (x' + blipRatio.toFixed(2)
            + '): the blip metric cannot separate synthetic musical noise from plain noise.');
    }

    // ---- Rig: real model graph + raw capture of speech / mix / output. ------
    await page.evaluate(async ({ wavB64 }) => {
        const mod = await import('/src/api/deepFilter.ts');
        const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));
        window.__rig = {
            /** opts: speechGain, noise0, tuning (worker replaces its defaults
             *  with EXACTLY this object — spell out every knob). */
            async build(opts = {}) {
                const ctx = new AudioContext({ sampleRate: 48000 });
                await ctx.resume();
                const speech = await ctx.decodeAudioData(wavBytes.slice().buffer);

                // Capture worklet: in0 speech-only (dry ref), in1 mix (what
                // the model hears), in2 processed output. Raw chunks cross to
                // the page so the STFT metrics run on the actual samples.
                const src = `
                    class Cap extends AudioWorkletProcessor {
                        process(inputs) {
                            const pick = (i) => {
                                const c = inputs[i]?.[0];
                                return c ? c.slice() : new Float32Array(128);
                            };
                            this.port.postMessage([pick(0), pick(1), pick(2)]);
                            return true;
                        }
                    }
                    registerProcessor('df-cap', Cap);
                `;
                await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
                const cap = new AudioWorkletNode(ctx, 'df-cap', { numberOfInputs: 3, numberOfOutputs: 1, outputChannelCount: [1] });
                cap.connect(ctx.destination);
                let chunks = [[], [], []];
                let capturing = false;
                cap.port.onmessage = (e) => {
                    if (!capturing) return;
                    for (let i = 0; i < 3; i++) chunks[i].push(e.data[i]);
                };

                const msDest = ctx.createMediaStreamDestination();
                const nodes = await mod.applyDeepFilter(ctx, msDest.stream, 1,
                    opts.tuning ? { tuning: opts.tuning } : undefined);
                nodes.gain.connect(cap, 0, 2);

                const speechGainNode = ctx.createGain();
                speechGainNode.gain.value = opts.speechGain ?? 1;
                const srcNode = ctx.createBufferSource();
                srcNode.buffer = speech;
                srcNode.loop = true;
                srcNode.connect(speechGainNode);
                speechGainNode.connect(msDest);
                speechGainNode.connect(cap, 0, 0);
                srcNode.start();

                const noiseBuf = ctx.createBuffer(1, 48000 * 4, 48000);
                noiseBuf.getChannelData(0).set(window.__makeNoise(48000 * 4, 0x5eed1234));
                const noiseGainNode = ctx.createGain();
                noiseGainNode.gain.value = opts.noise0 ?? 0;
                const noiseNode = ctx.createBufferSource();
                noiseNode.buffer = noiseBuf;
                noiseNode.loop = true;
                noiseNode.connect(noiseGainNode);
                noiseGainNode.connect(msDest);
                noiseNode.start();
                // The mix tap mirrors what msDest receives.
                speechGainNode.connect(cap, 0, 1);
                noiseGainNode.connect(cap, 0, 1);

                window.__inst = {
                    startCapture: () => { chunks = [[], [], []]; capturing = true; },
                    /** Stop capturing and compute metrics on the captured audio. */
                    async measure() {
                        capturing = false;
                        const cat = (list) => {
                            let n = 0;
                            for (const c of list) n += c.length;
                            const out = new Float32Array(n);
                            let o = 0;
                            for (const c of list) { out.set(c, o); o += c.length; }
                            return out;
                        };
                        const [dry, mix, out] = chunks.map(cat);
                        chunks = [[], [], []];
                        const rms = (x) => {
                            let s = 0;
                            for (let i = 0; i < x.length; i++) s += x[i] * x[i];
                            return Math.sqrt(s / Math.max(1, x.length));
                        };
                        return {
                            seconds: dry.length / 48000,
                            rmsRatio: rms(out) / Math.max(1e-9, rms(dry)),
                            mixRough: window.__roughness(mix),
                            outRough: window.__roughness(out),
                        };
                    },
                    stats: () => JSON.parse(JSON.stringify(mod.deepFilterDiagnostics())),
                    teardown: async () => {
                        try { srcNode.stop(); noiseNode.stop(); } catch { /* stopped */ }
                        nodes.worklet.destroy?.();
                        await ctx.close();
                    },
                };
            },
        };
    }, { wavB64: speechB64 });

    // ---- Worker-stats accumulation. -----------------------------------------
    // The worker posts stats every ~2 s of audio and RESETS its per-window
    // counters (seamHops etc.) after each post; deepFilterDiagnostics() keeps
    // only the LATEST window. So a single post-capture stats() read describes
    // ~2 s of a 45-60 s run — and if it is taken after measure()'s main-thread
    // block, it describes POST-capture audio. Health must be accumulated by
    // polling DURING the capture, deduped by the cumulative hop counter.
    const newHealth = () => ({
        hops: -1, windows: 0, seamHops: 0, nearSilentHops: 0, overBudgetHops: 0,
        clampedHops: 0, maxSeamRatio: 0, dryFirst: null, dryLast: 0, levelEnvSamples: [],
    });
    const foldHealth = (h, w) => {
        if (!w || typeof w.hops !== 'number' || w.hops === h.hops) return; // same window as last poll
        h.hops = w.hops;
        h.windows++;
        h.seamHops += w.seamHops ?? 0;
        h.nearSilentHops += w.nearSilentHops ?? 0;
        h.overBudgetHops += w.overBudgetHops ?? 0;
        h.clampedHops += w.clampedHops ?? 0;
        if ((w.maxSeamRatio ?? 0) > h.maxSeamRatio) h.maxSeamRatio = w.maxSeamRatio;
        h.dryFirst ??= w.dryHops ?? 0; // cumulative counter: delta = last - first
        h.dryLast = w.dryHops ?? 0;
        if (typeof w.levelEnv === 'number') h.levelEnvSamples.push(w.levelEnv);
    };
    /** Poll worker stats into `health` for `seconds` (1 s cadence vs the ~2 s
     *  window cadence, deduped by hops, so no window is counted twice). */
    const watchStats = async (seconds, health) => {
        for (let t = 0; t < seconds; t++) {
            await page.waitForTimeout(1000);
            const s = await page.evaluate(() => window.__inst.stats());
            foldHealth(health, s.worker);
        }
    };
    const avgOf = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

    // ---- Calibrate speechGain to the field-measured levelEnv ~= 0.08. -------
    // levelEnv is an instant-attack decay-max sampled per ~2 s stats window, so
    // any SINGLE read depends on where the 13.8 s speech loop happens to be —
    // calibrate against the average over a full loop period, then REBUILD at
    // the computed gain and verify the same way (open-loop trust in one sample
    // put a previous run 35% off its documented operating point).
    console.log('== calibrating speechGain for levelEnv ~= 0.08 ==');
    await page.evaluate(() => window.__rig.build({ speechGain: 1, noise0: 0.06 }));
    await page.waitForTimeout(4000); // spin-up
    const calHealth = newHealth();
    await watchStats(14, calHealth); // one full speech-loop period
    await page.evaluate(() => window.__inst.teardown());
    const envAt1 = avgOf(calHealth.levelEnvSamples);
    if (!envAt1 || envAt1 <= 0) throw new Error('calibration failed: no levelEnv from worker');
    // levelEnv tracks per-hop RMS of the mix — linear in speechGain to ~2%
    // (the unscaled noise bed contributes that little at these levels).
    const speechGain = TARGET_LEVEL_ENV / envAt1;
    console.log(`  loop-avg levelEnv@gain1 = ${envAt1.toFixed(4)} -> speechGain ${speechGain.toFixed(3)}`);
    await page.evaluate((g) => window.__rig.build({ speechGain: g, noise0: 0.06 }), speechGain);
    await page.waitForTimeout(4000);
    const verHealth = newHealth();
    await watchStats(14, verHealth);
    await page.evaluate(() => window.__inst.teardown());
    const achievedEnv = avgOf(verHealth.levelEnvSamples);
    const envErrPct = (100 * (achievedEnv - TARGET_LEVEL_ENV)) / TARGET_LEVEL_ENV;
    console.log(`  verified loop-avg levelEnv@${speechGain.toFixed(3)} = ${achievedEnv.toFixed(4)} (${envErrPct >= 0 ? '+' : ''}${envErrPct.toFixed(1)}% of target)`);
    if (Math.abs(envErrPct) > 20) {
        throw new Error(`calibration missed: achieved levelEnv ${achievedEnv.toFixed(4)} is `
            + `${envErrPct.toFixed(1)}% off the ${TARGET_LEVEL_ENV} target — fix the rig before trusting the A/B`);
    }

    // ---- A/B: production vs postFilterBeta. ---------------------------------
    // Since 0.8.88 the worker MERGES a passed tuning object over the production
    // defaults (dfTuning.ts), so the beta configs are production + beta. The
    // recorded table above was measured against the pre-0.8.88 production
    // (stage-skip thresholds 30/20); production is now never-skip 35/35, and
    // e2e/df-offline.mjs is the faster instrument for the same question.
    const CONFIGS = [
        { name: 'production (beta off)', tuning: undefined },
        { name: 'beta 0.02 (upstream on)', tuning: { postFilterBeta: 0.02 } },
        { name: 'beta 0.05', tuning: { postFilterBeta: 0.05 } },
    ];
    const SCENARIOS = [
        // The reporting user: normal speech level over steady room noise.
        { name: 'S-user (speech+noise)', opts: { speechGain, noise0: 0.06 }, seconds: AB_S },
        // Noise-dominant: where residual musical noise is most audible.
        { name: 'S-residual (quiet speech, more noise)', opts: { speechGain: speechGain * 0.25, noise0: 0.08 }, seconds: Math.min(AB_S, 45) },
    ];

    const results = [];
    for (const cfg of CONFIGS) {
        for (const sc of SCENARIOS) {
            console.log(`==== ${cfg.name} / ${sc.name} ====`);
            const health = newHealth();
            await page.evaluate((o) => window.__rig.build(o), { ...sc.opts, tuning: cfg.tuning });
            await page.waitForTimeout(4000); // spin-up: warmup + level slew settle
            await page.evaluate(() => window.__inst.startCapture());
            await watchStats(sc.seconds, health);
            // Final read BEFORE measure(): measure() blocks the main thread for
            // seconds while the audio graph keeps running, so anything sampled
            // after it describes post-capture audio.
            foldHealth(health, (await page.evaluate(() => window.__inst.stats())).worker);
            const m = await page.evaluate(() => window.__inst.measure());
            await page.evaluate(() => window.__inst.teardown());
            console.log(`  captured ${m.seconds.toFixed(1)}s  out/dry RMS ${m.rmsRatio.toFixed(3)}`);
            console.log(`  mix  roughness: kurt ${m.mixRough.kurt.toFixed(2)}  blipRate ${m.mixRough.blipRate.toFixed(3)}%`);
            console.log(`  out  roughness: kurt ${m.outRough.kurt.toFixed(2)}  blipRate ${m.outRough.blipRate.toFixed(3)}%`);
            console.log(`  worker (accumulated over ${health.windows} windows): loop-avg levelEnv ${avgOf(health.levelEnvSamples).toFixed(4)}`
                + `  seamHops ${health.seamHops}  nearSilent ${health.nearSilentHops}  overBudget ${health.overBudgetHops}`
                + `  clamped ${health.clampedHops}  maxSeamRatio ${health.maxSeamRatio.toFixed(3)}  dryHops ${health.dryLast - (health.dryFirst ?? 0)}`);
            results.push({ config: cfg.name, scenario: sc.name, ...m });
        }
    }

    console.log('== A/B verdict (lower kurt/blipRate = smoother; rmsRatio prices over-attenuation) ==');
    for (const r of results) {
        console.log(`  ${r.config.padEnd(24)} ${r.scenario.padEnd(38)} kurt ${r.outRough.kurt.toFixed(2)}  blipRate ${r.outRough.blipRate.toFixed(3)}%  out/dry RMS ${r.rmsRatio.toFixed(3)}`);
    }
} catch (e) {
    console.error('HARNESS ERROR:', e);
    process.exitCode = 1;
} finally {
    await browser.close();
}
