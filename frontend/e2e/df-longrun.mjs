// DeepFilterNet long-run drift reproduction: does the model get quieter /
// more muffled the longer it runs on continuous speech?
//
// Field report (2026-08-05): "mic was getting muffled and quieter as I was
// talking with deepfilter enabled". Candidate mechanisms, from upstream
// libDF/src/tract.rs @ v0.5.6:
//   - lsnr < min_db_thresh (-10 dB) => the frame gets a hard ZERO mask;
//   - atten_lim default 100 => None => unlimited suppression (no dry mix-in);
//   - ERB feature normalization keeps adaptive running state (norm_alpha/tau)
//     that tracks the input stream — cumulative, so it can DRIFT.
//
// Method: loop the committed TTS speech wav through the REAL model for
// LONG_S seconds; in-page, accumulate per-WINDOW_S-window metrics (no giant
// captures): dry/out RMS, ~2 kHz-high-passed RMS (muffling = HF loss), and
// exact-zero output samples (the zero-mask signature). Then tear down, build
// a FRESH instance, and measure the same content again — long-run tail vs
// fresh head on identical audio isolates STATE drift from content.
//
// Prereqs: vite dev server. Usage: node e2e/df-longrun.mjs
//   env: DF_BASE_URL (default :5173), DF_LONG_S (default 150)
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DF_BASE_URL || 'http://localhost:5173';
const LONG_S = Number(process.env.DF_LONG_S || 150);
const WINDOW_S = 10;
const SPEECH_WAV = fileURLToPath(new URL('./assets/df-test-speech.wav', import.meta.url));

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [page exception]', String(e).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 160)); });

const speechB64 = readFileSync(SPEECH_WAV).toString('base64');

try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });

    await page.evaluate(async ({ wavB64 }) => {
        const mod = await import('/src/api/deepFilter.ts');
        const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0));
        window.__rig = {
            /**
             * opts: speechGain (default 1), noise0/noise1 (pink-ish noise gain
             * at ramp start/end, default 0 = no noise), rampS (seconds to
             * linearly ramp noise0→noise1; further setNoise() calls override),
             * tuning (model runtime knobs, passed through to the worker).
             */
            async build(opts = {}) {
                const ctx = new AudioContext({ sampleRate: 48000 });
                await ctx.resume();
                const speech = await ctx.decodeAudioData(wavBytes.slice().buffer);

                // Metering worklet: in0 dry, in1 processed. Accumulates
                // window sums on the audio thread — nothing big crosses out.
                const src = `
                    class Meter extends AudioWorkletProcessor {
                        constructor() {
                            super();
                            this.reset();
                            this.hpD = { x: 0, y: 0 };
                            this.hpO = { x: 0, y: 0 };
                            this.port.onmessage = () => {
                                this.port.postMessage(this.snap());
                                this.reset();
                            };
                        }
                        reset() {
                            this.n = 0; this.dry2 = 0; this.out2 = 0;
                            this.dryHp2 = 0; this.outHp2 = 0; this.outZero = 0;
                        }
                        snap() {
                            return { n: this.n, dry2: this.dry2, out2: this.out2,
                                dryHp2: this.dryHp2, outHp2: this.outHp2, outZero: this.outZero };
                        }
                        process(inputs) {
                            const d = inputs[0]?.[0];
                            const o = inputs[1]?.[0];
                            const N = (d ?? o)?.length ?? 0;
                            // 1-pole high-pass, fc ~2 kHz @48 k: a = 0.77
                            const A = 0.77;
                            for (let i = 0; i < N; i++) {
                                const dv = d ? d[i] : 0;
                                const ov = o ? o[i] : 0;
                                this.dry2 += dv * dv;
                                this.out2 += ov * ov;
                                const hd = A * (this.hpD.y + dv - this.hpD.x);
                                this.hpD.x = dv; this.hpD.y = hd;
                                this.dryHp2 += hd * hd;
                                const ho = A * (this.hpO.y + ov - this.hpO.x);
                                this.hpO.x = ov; this.hpO.y = ho;
                                this.outHp2 += ho * ho;
                                if (ov === 0) this.outZero++;
                            }
                            this.n += N;
                            return true;
                        }
                    }
                    registerProcessor('df-meter', Meter);
                `;
                await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
                const meter = new AudioWorkletNode(ctx, 'df-meter', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
                meter.connect(ctx.destination);
                let pending = null;
                meter.port.onmessage = (e) => { pending?.(e.data); pending = null; };

                const msDest = ctx.createMediaStreamDestination();
                const nodes = await mod.applyDeepFilter(ctx, msDest.stream, 1,
                    opts.tuning ? { tuning: opts.tuning } : undefined);
                nodes.gain.connect(meter, 0, 1);

                const speechGainNode = ctx.createGain();
                speechGainNode.gain.value = opts.speechGain ?? 1;
                const srcNode = ctx.createBufferSource();
                srcNode.buffer = speech;
                srcNode.loop = true;
                srcNode.connect(speechGainNode);
                speechGainNode.connect(msDest);
                speechGainNode.connect(meter, 0, 0); // dry ref = speech only
                srcNode.start();

                // Pink-ish background noise (white through a 1-pole low-pass at
                // ~1.2 kHz — steady "fan/room" texture), mixed into the mic
                // path AFTER the dry tap: the meter's dry stays speech-only, so
                // out/dry RMS measures what the model does to the SPEECH.
                // Deterministic (seeded) noise so runs and configs compare
                // apples to apples — Math.random cost a misleading A/B once.
                const noiseBuf = ctx.createBuffer(1, 48000 * 4, 48000);
                {
                    const d = noiseBuf.getChannelData(0);
                    let seed = 0x5eed1234;
                    const rand = () => {
                        seed = (seed + 0x6D2B79F5) | 0;
                        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
                        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
                        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
                    };
                    let y = 0;
                    for (let i = 0; i < d.length; i++) {
                        y = 0.86 * y + 0.14 * rand();
                        d[i] = y * 2.2;
                    }
                }
                const noiseGainNode = ctx.createGain();
                noiseGainNode.gain.value = opts.noise0 ?? 0;
                if ((opts.rampS ?? 0) > 0 && opts.noise1 !== undefined) {
                    noiseGainNode.gain.linearRampToValueAtTime(
                        opts.noise1, ctx.currentTime + opts.rampS);
                }
                const noiseNode = ctx.createBufferSource();
                noiseNode.buffer = noiseBuf;
                noiseNode.loop = true;
                noiseNode.connect(noiseGainNode);
                noiseGainNode.connect(msDest);
                noiseNode.start();

                window.__inst = {
                    ctx, nodes, meter,
                    window: () => new Promise((res) => { pending = res; meter.port.postMessage('snap'); }),
                    stats: () => JSON.parse(JSON.stringify(mod.deepFilterDiagnostics())),
                    setNoise: (g) => { noiseGainNode.gain.cancelScheduledValues(ctx.currentTime); noiseGainNode.gain.setValueAtTime(g, ctx.currentTime); },
                    teardown: async () => {
                        try { srcNode.stop(); noiseNode.stop(); } catch { /* stopped */ }
                        nodes.worklet.destroy?.();
                        await ctx.close();
                    },
                };
            },
        };
    }, { wavB64: speechB64 });

    const fmtWin = (w) => {
        const ratio = Math.sqrt(w.out2 / Math.max(1e-12, w.dry2));
        const hfRatio = Math.sqrt(w.outHp2 / Math.max(1e-12, w.dryHp2));
        const zeroPct = (100 * w.outZero) / Math.max(1, w.n);
        return { ratio, hfRatio, zeroPct };
    };

    const runWindows = async (seconds, label) => {
        const out = [];
        for (let t = 0; t < seconds; t += WINDOW_S) {
            await page.waitForTimeout(WINDOW_S * 1000);
            const w = await page.evaluate(() => window.__inst.window());
            const m = fmtWin(w);
            out.push(m);
            console.log(`  [${label}] t=${String(t + WINDOW_S).padStart(4)}s  out/dry RMS ${m.ratio.toFixed(3)}  HF ${m.hfRatio.toFixed(3)}  zero-samples ${m.zeroPct.toFixed(2)}%`);
        }
        return out;
    };
    const spinUp = async (opts) => {
        await page.evaluate((o) => window.__rig.build(o), opts);
        await page.waitForTimeout(3000);
        await page.evaluate(() => window.__inst.window()); // discard spin-up
    };
    const avg = (a, k) => a.reduce((s, w) => s + w[k], 0) / a.length;

    // A/B sweep over the model's runtime knobs, against the two reproduced
    // field failures:
    //   S2: noise rises for 120 s then drops — the recovery windows measure
    //       the post-noise over-suppression latch (bug shape: stuck low).
    //   S3: quiet speaker (-12 dB) over fan noise — zero-mask gate eating
    //       words (bug shape: high zero%, low HF).
    // NOTE: production defaults live in dfTuning.ts (DEFAULT_TUNING) and apply
    // when NO tuning is passed. Since 0.8.88 the worker MERGES a passed object
    // over those defaults (a partial object no longer means "upstream for the
    // rest"), so every non-production rung spells out ALL its knobs. The
    // stage-skip thresholds are held at the values in effect when this sweep
    // was recorded (upstream 30/20) so the rungs keep isolating what they
    // isolated; production carries 35/35 (see dfTuning.ts).
    const UP = { attenLimDb: 100, minDbThresh: -10, maxDbErbThresh: 30, maxDbDfThresh: 20 };
    const CONFIGS = [
        { name: 'upstream-defaults', tuning: { ...UP } },
        { name: 'minDb-35', tuning: { ...UP, minDbThresh: -35 } },
        { name: 'production (minDb-35+atten30, never-skip)', tuning: undefined },
        { name: 'atten30', tuning: { ...UP, attenLimDb: 30 } },
    ];
    const results = [];
    for (const cfg of CONFIGS) {
        console.log(`==== config: ${cfg.name} ====`);
        console.log('== S2: rising noise then back to quiet — latch check ==');
        await spinUp({ noise0: 0.01, noise1: 0.2, rampS: 120, tuning: cfg.tuning });
        const s2rise = await runWindows(120, `${cfg.name} S2-rise`);
        await page.evaluate(() => window.__inst.setNoise(0.01));
        const s2rec = await runWindows(40, `${cfg.name} S2-recovery`);
        const wstats = await page.evaluate(() => window.__inst.stats());
        console.log('  worker:', JSON.stringify(wstats.worker));
        await page.evaluate(() => window.__inst.teardown());

        console.log('== S3: quiet speaker over fan noise (~5 dB SNR), 60 s ==');
        await spinUp({ speechGain: 0.25, noise0: 0.06, tuning: cfg.tuning });
        const s3 = await runWindows(60, `${cfg.name} S3`);
        await page.evaluate(() => window.__inst.teardown());

        results.push({
            name: cfg.name,
            s2Baseline: avg(s2rise.slice(0, 3), 'ratio'),
            s2RiseTail: avg(s2rise.slice(-3), 'ratio'),
            s2Recovery: avg(s2rec.slice(1), 'ratio'),
            s2RecoveryWorst: Math.min(...s2rec.map((w) => w.ratio)),
            s3Rms: avg(s3, 'ratio'),
            s3Hf: avg(s3, 'hfRatio'),
            s3Zeros: avg(s3, 'zeroPct'),
        });
    }

    console.log('== A/B verdict ==');
    for (const r of results) {
        const latch = r.s2Recovery < r.s2Baseline - 0.08;
        console.log(`  ${r.name.padEnd(20)} S2 base ${r.s2Baseline.toFixed(3)} riseTail ${r.s2RiseTail.toFixed(3)} recovery ${r.s2Recovery.toFixed(3)} (worst ${r.s2RecoveryWorst.toFixed(3)}) latch=${latch ? 'YES' : 'no'}   S3 rms ${r.s3Rms.toFixed(3)} HF ${r.s3Hf.toFixed(3)} zeros ${r.s3Zeros.toFixed(1)}%`);
    }
} catch (e) {
    console.error('HARNESS ERROR:', e);
} finally {
    await browser.close();
}
