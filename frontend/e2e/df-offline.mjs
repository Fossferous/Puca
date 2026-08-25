// DeepFilterNet OFFLINE runner — the production wasm + the production level
// normalizer, driven from Node on WAV files at controlled SNRs. No browser.
//
// Why this exists (2026-08-17): three rounds of live diagnostics (v0.8.45,
// v0.8.56, v0.8.57) instrumented the PIPELINE and proved it innocent, then
// measured one lever (postFilterBeta) on a browser harness whose only fixture
// was speech buried in noise at roughly 0-6 dB SNR. The reporting user's mic
// is a headset in a room — 20-40 dB SNR — a regime nobody had measured. This
// runner measures it, with the model's per-hop local-SNR estimate exposed
// (DeepFilter.last_lsnr) so every hop can be attributed to the processing
// REGIME upstream's `apply_stages` picked for it:
//
//   lsnr <  min_db_thresh      -> "zero"  hard zero mask (silence, ×dry mix)
//   lsnr >  max_db_erb_thresh  -> "pass"  NO processing at all — raw through
//   lsnr >  max_db_df_thresh   -> "mask"  ERB gains only, deep filtering skipped
//   otherwise                  -> "full"  ERB gains + deep filtering
//
// Upstream's real-time defaults (RuntimeParams::default_with_ch, which our
// wasm inherits) are max_erb 30 / max_df 20: CPU-saving skips for the LADSPA
// plugin. Upstream's OFFLINE CLI — the one that makes their demos — uses
// 35 / 35, i.e. never skips (lsnr is clamped to lsnr_max = 35).
//
// Metrics, each with a positive control the run ABORTS without:
//  - regime histogram + toggle rate over speech-active hops
//  - floorJitter: hop-to-hop std (dB) of the pooled residual in SPEECH-FREE
//    time-frequency cells during speech-active frames. Stationary noise gives
//    ~0.5 dB; a residual that flickers between suppressed and raw gives many
//    dB. Speech-free cells are known exactly because the clean speech and the
//    noise are separate signals here.
//  - floorResidual: mean of that residual (dB re. the noise floor).
//  - speechWarble: hop-to-hop std (dB) of output/clean-speech energy over
//    speech-dominant cells; speechLevel: its mean (muffling).
//  - kurt: whitened spectral kurtosis (Uemura/Miyabe musical-noise measure,
//    same definition as e2e/df-roughness.mjs) over active cells.
//
// MEASURED 2026-08-17 (TTS speech at -26 dBFS active RMS, 2 loops, metrics
// over the steady-state second loop; controls: white toggled x7.1 / warbled
// x7.0, pink x6.1 / x3.9; the passthrough config reads bit-identical to the
// input at lag 0 and every model config measures lag 1440 = 3 hops):
//
//   config      SNR/noise   fR(dB)  fJ(dB)  sL(dB)  sW(dB)  regimes (active hops)      toggles
//   prod087     40 white   -19.22   3.28   -4.73   2.07   mask 31.0% full 69.0%       6.5/s
//   prod        40 white   -19.20   3.29   -0.44   0.25   full 100%                   0
//   upstreamCli 40 white   -21.40   4.79   -0.42   0.25   full 100%                   0
//   prod087     30 white   -19.36   2.78   -4.00   2.25   mask 25.5% full 74.5%       7.0/s
//   prod        30 white   -19.62   2.73   -0.38   0.34   full 100%                   0
//   upstreamCli 30 white   -21.86   3.75   -0.37   0.35   full 100%                   0
//   prod087     20 white   -21.63   2.04   -0.67   0.92   mask 0.3%  full 99.7%       0.4/s
//   prod        20 white   -21.63   2.04   -0.61   0.59   full 100%                   0
//   prod087     10 white   -23.47   1.59   -0.72   0.45   full 100%                   0   (identical to prod)
//   prod087     40 pink    -14.18   4.13   -6.40   2.70   pass 13.7% mask 53.1% full 33.2%  14.2/s
//   prod        40 pink    -16.40   3.59   -0.22   0.18   full 100%                   0
//   upstreamCli 40 pink    -17.37   4.39   -0.21   0.17   full 100%                   0
//   prod087     30 pink    -16.02   3.34   -7.13   2.36   mask 48.7% full 51.3%       8.6/s
//   prod        30 pink    -16.38   3.30   -0.32   0.39   full 100%                   0
//   prod087     20 pink    -18.89   2.56   -0.73   1.30   mask 1.6%  full 98.4%       1.5/s
//   prod        20 pink    -18.92   2.55   -0.45   0.50   full 100%                   0
//   prodPf (opt-in post filter): sL/sW identical to prod, fR ~1.5-2 dB lower, fJ ~0.7 dB higher.
//   speechLevel BY REGIME (pink): prod087 @30: mask -12.45 (n=464) full -0.78 (n=388);
//   @40: pass -0.02 (n=131) mask -10.87 (n=511) full -0.66 (n=253). prod087Floor
//   (30/20 + the near-silence floor) is identical to prod087 at both SNRs: the
//   thresholds alone are the effect, not the early-return transient.
//
//   Quiet mic (--speechRms 0.02, pink 40): prod087 pass 55.6% mask 31.6% (14.8/s,
//   sL -2.50 sW 2.44); prod sL -0.20 sW 0.16; upstreamCli (no level wrapper,
//   no floor) sW 11.28 — the near-silence early return; upstreamCliFloor sW 0.50.
//   One-factor attribution at 30 white against upstreamCli: cliSkip (30/20 only)
//   sL -5.47 sW 2.95; cliAtten30 / cliMin35 / cliNorm / cliNormCur all within
//   0.02 dB of upstreamCli. Inference: 1.45 -> 1.63 ms/hop for never-skip.
//
// Usage: node e2e/df-offline.mjs [--snr 40,30,20,10] [--noise white|pink|lp]
//          [--speechRms 0.05] [--configs prod,noskip,...] [--out <dir>]
//          [--loops 2] [--wav]   (writes 16-bit WAVs of mix + each output)
// Prereqs: the built wasm in src/wasm/df (see df-wasm/README.md), Node 24+.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initDf, { DeepFilter } from '../src/wasm/df/df_wasm.js';
import { LevelNormalizer } from '../src/api/dfLevel.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const HOP = 480;

// ---------------------------------------------------------------- args ----
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const k = a.slice(2);
    const v = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true';
    return [k, v];
}).filter(p => p.length));
const SNRS = String(args.snr ?? '40,30,20,10').split(',').map(Number);
const NOISE = args.noise ?? 'white';
const SPEECH_RMS = Number(args.speechRms ?? 0.05); // active-speech RMS of the clean track
const LOOPS = Number(args.loops ?? 2);
const OUT_DIR = args.out ?? join(HERE, '..', 'node_modules', '.tmp', 'df-offline');
const WRITE_WAV = args.wav === 'true';
const SPEECH_WAV = args.speech ?? join(HERE, 'assets', 'df-test-speech.wav');
const NOISE_WAV = args.noiseWav ?? null;

// ------------------------------------------------------------- configs ----
// atten/min/beta/erb/df are the wasm constructor knobs; normalize = run the
// production level wrapper; inverse = how the wrapper's inverse gain is taken
// ('delayed' = by the model's 3-hop latency, the fix; 'current' = the pre-fix
// behaviour, dividing hop N-3's output by hop N's gain).
const CONFIGS = {
    // Production as shipped through v0.8.87: DEFAULT_TUNING + normalizer,
    // inverse by the current gain, upstream real-time skip thresholds, no
    // near-silence floor.
    prod087:       { atten: 30, min: -35, beta: 0,    erb: 30, df: 20, normalize: true,  inverse: 'current', floor: false },
    // Same, inverse correctly delayed (isolates the inverse-gain fix).
    prodDelayed:   { atten: 30, min: -35, beta: 0,    erb: 30, df: 20, normalize: true,  inverse: 'delayed', floor: false },
    // 30/20 with the floor + delayed inverse: ONLY the thresholds differ from
    // prod, so this isolates their effect from the early-return transients.
    prod087Floor:  { atten: 30, min: -35, beta: 0,    erb: 30, df: 20, normalize: true,  inverse: 'delayed', floor: true },
    // Never skip a stage (upstream LADSPA/CLI thresholds), otherwise prod087.
    noskip:        { atten: 30, min: -35, beta: 0,    erb: 35, df: 35, normalize: true,  inverse: 'delayed', floor: false },
    // PRODUCTION since 0.8.88: noskip + the near-silence floor (= DEFAULT_TUNING
    // through dfWorker.ts).
    prod:          { atten: 30, min: -35, beta: 0,    erb: 35, df: 35, normalize: true,  inverse: 'delayed', floor: true },
    // Skip DF only (keep the mask), never pass raw through.
    dfskip:        { atten: 30, min: -35, beta: 0,    erb: 35, df: 20, normalize: true,  inverse: 'delayed', floor: false },
    // Production + the opt-in post filter (Settings toggle).
    prodPf:        { atten: 30, min: -35, beta: 0.02, erb: 35, df: 35, normalize: true,  inverse: 'delayed', floor: true },
    noskipPf:      { atten: 30, min: -35, beta: 0.02, erb: 35, df: 35, normalize: true,  inverse: 'delayed', floor: false },
    // Upstream library-struct defaults, no wrapper (RuntimeParams::default_with_ch).
    upstreamRt:    { atten: 100, min: -10, beta: 0,   erb: 30, df: 20, normalize: false, inverse: 'none', floor: false },
    // Upstream offline CLI / LADSPA-port defaults, no wrapper (their demo path).
    upstreamCli:   { atten: 100, min: -15, beta: 0,   erb: 35, df: 35, normalize: false, inverse: 'none', floor: false },
    // upstreamCli + only the near-silence floor: isolates what the floor buys
    // on a quiet mic (run with --speechRms 0.02).
    upstreamCliFloor: { atten: 100, min: -15, beta: 0, erb: 35, df: 35, normalize: false, inverse: 'none', floor: true },
    // noskip without the level wrapper: does the wrapper itself cost anything?
    noskipNoNorm:  { atten: 30, min: -35, beta: 0,    erb: 35, df: 35, normalize: false, inverse: 'none', floor: false },
    // One-factor isolations against upstreamCli (attribution runs).
    prodNoNorm:    { atten: 30, min: -35, beta: 0,    erb: 30, df: 20, normalize: false, inverse: 'none', floor: false },
    cliAtten30:    { atten: 30, min: -15, beta: 0,    erb: 35, df: 35, normalize: false, inverse: 'none', floor: false },
    cliMin35:      { atten: 100, min: -35, beta: 0,   erb: 35, df: 35, normalize: false, inverse: 'none', floor: false },
    cliSkip:       { atten: 100, min: -15, beta: 0,   erb: 30, df: 20, normalize: false, inverse: 'none', floor: false },
    cliNorm:       { atten: 100, min: -15, beta: 0,   erb: 35, df: 35, normalize: true,  inverse: 'delayed', floor: false },
    cliNormCur:    { atten: 100, min: -15, beta: 0,   erb: 35, df: 35, normalize: true,  inverse: 'current', floor: false },
    // Passthrough control: the wasm with an attenuation limit of 0 dB copies
    // the input (tract.rs: atten_lim == 1 -> enh = noisy). Proves the runner's
    // alignment/metrics read ~0 change when the model changes nothing.
    passthrough:   { atten: 0, min: -35, beta: 0,     erb: 35, df: 35, normalize: false, inverse: 'none', floor: false, delay: 0 },
};
const CONFIG_NAMES = String(args.configs ?? 'passthrough,prod087,prod,prodPf,upstreamCli').split(',');

// ----------------------------------------------------------------- wav ----
function readWav(path) {
    const b = readFileSync(path);
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV: ' + path);
    let off = 12; let fmt = null; let data = null;
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const size = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
        else if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
        off += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('WAV missing fmt/data: ' + path);
    if (fmt.sr !== SR) throw new Error(`WAV must be ${SR} Hz, got ${fmt.sr}: ${path}`);
    const n = data.length / (fmt.bits / 8) / fmt.ch;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < fmt.ch; c++) {
            const idx = (i * fmt.ch + c);
            if (fmt.format === 3 && fmt.bits === 32) acc += data.readFloatLE(idx * 4);
            else if (fmt.bits === 16) acc += data.readInt16LE(idx * 2) / 32768;
            else if (fmt.bits === 24) { const v = (data[idx * 3] | (data[idx * 3 + 1] << 8) | (data[idx * 3 + 2] << 16)) << 8 >> 8; acc += v / 8388608; }
            else if (fmt.bits === 32) acc += data.readInt32LE(idx * 4) / 2147483648;
            else throw new Error('unsupported WAV bit depth ' + fmt.bits);
        }
        out[i] = acc / fmt.ch;
    }
    return out;
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

// --------------------------------------------------------------- noise ----
function seededRand(seed0) {
    let seed = seed0 | 0;
    return () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
}
function makeNoise(kind, len, seed) {
    const rand = seededRand(seed);
    const d = new Float32Array(len);
    if (kind === 'white') {
        for (let i = 0; i < len; i++) d[i] = rand();
    } else if (kind === 'lp') { // the browser harnesses' "pink-ish" one-pole
        let y = 0;
        for (let i = 0; i < len; i++) { y = 0.86 * y + 0.14 * rand(); d[i] = y * 2.2; }
    } else if (kind === 'pink') { // Paul Kellet's economy pink filter
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
            const w = rand();
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
            d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
            b6 = w * 0.115926;
        }
    } else throw new Error('unknown noise ' + kind);
    return d;
}
const rmsOf = (x, from = 0, to = x.length) => { let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, to - from)); };
const db = (r) => 20 * Math.log10(Math.max(r, 1e-12));
const dbP = (p) => 10 * Math.log10(Math.max(p, 1e-24));

// ----------------------------------------------------------------- fft ----
const N = 1024; const WIN = 960;
// 4-term Blackman-Harris (sidelobes -92 dB): a Hann window's -31 dB sidelobes
// leak a 30-dB-above-floor speech harmonic straight into the neighbouring
// "speech-free" bins at the noise-floor level, flooring the residual measure.
const hann = new Float64Array(WIN);
for (let i = 0; i < WIN; i++) {
    const t = (2 * Math.PI * i) / (WIN - 1);
    hann[i] = 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
}
function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = (-2 * Math.PI) / len; const wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let j = 0; j < len / 2; j++) {
                const ur = re[i + j], ui = im[i + j];
                const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
                const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
                re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
                const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}
/** Power spectrogram frames (N/2 bins each) on the model's hop grid, frame f covering samples [f*HOP, f*HOP+WIN). */
function stftPow(x, nFrames) {
    const frames = new Array(nFrames);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let f = 0; f < nFrames; f++) {
        re.fill(0); im.fill(0);
        const s = f * HOP;
        for (let i = 0; i < WIN && s + i < x.length; i++) re[i] = x[s + i] * hann[i];
        fft(re, im);
        const p = new Float64Array(N / 2);
        for (let k = 0; k < N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
        frames[f] = p;
    }
    return frames;
}
const K_LO = Math.round(300 * N / SR);   // 300 Hz
const K_HI = Math.round(12000 * N / SR); // 12 kHz

// ------------------------------------------------------------- metrics ----
/**
 * Given clean speech S, noise V (both aligned with the output Y on the same
 * sample grid) and a frame range, compute the floor/speech metrics.
 * activeFrames: indices of frames where clean speech is active.
 */
function analyse(S, V, Y, frameFrom, frameTo, regimeOfFrame = null) {
    const nF = frameTo;
    const PS = stftPow(S, nF), PV = stftPow(V, nF), PY = stftPow(Y, nF);
    // Long-term mean noise power per bin (over the analysed range).
    const vMean = new Float64Array(N / 2);
    for (let f = frameFrom; f < frameTo; f++) for (let k = 0; k < N / 2; k++) vMean[k] += PV[f][k];
    for (let k = 0; k < N / 2; k++) vMean[k] /= (frameTo - frameFrom);
    // Speech-active frames: clean speech band power within 30 dB of the clip's
    // loudest frame (SNR-independent — the clean track is known exactly).
    const bandPow = (p) => { let s = 0; for (let k = K_LO; k < K_HI; k++) s += p[k]; return s; };
    let sMax = 0; for (let f = frameFrom; f < frameTo; f++) sMax = Math.max(sMax, bandPow(PS[f]));
    const active = [];
    for (let f = frameFrom; f < frameTo; f++) if (bandPow(PS[f]) > sMax * 1e-3) active.push(f);
    // Only bins where the noise actually carries energy (within 40 dB of its
    // loudest bin) can host a meaningful "speech-free" residual measurement;
    // with lowpassed noise the upper band is empty and would only add variance.
    let vMax = 0; for (let k = K_LO; k < K_HI; k++) vMax = Math.max(vMax, vMean[k]);
    const floorDb = [], speechDb = [], floorCells = [];
    // Speech level split by the processing regime the frame's output took
    // (regime names: 0 zero, 1 pass, 2 mask, 3 full, 4 silent-path).
    const speechByRegime = { 0: [], 1: [], 2: [], 3: [], 4: [] };
    for (const f of active) {
        let yFree = 0, vFree = 0, nFree = 0, ySp = 0, sSp = 0, nSp = 0;
        for (let k = K_LO; k < K_HI; k++) {
            const s = PS[f][k], v = vMean[k];
            if (s < v * 0.05 && v > vMax * 1e-4) { yFree += PY[f][k]; vFree += v; nFree++; } // speech ≥ 13 dB below a real noise floor
            else if (s > v * 10) { ySp += PY[f][k]; sSp += s; nSp++; }                        // speech ≥ 10 dB above the noise floor
        }
        if (nFree >= 12) { floorDb.push(dbP(yFree / vFree)); floorCells.push(nFree); }
        if (nSp >= 12) {
            const lv = dbP(ySp / sSp);
            speechDb.push(lv);
            if (regimeOfFrame) speechByRegime[regimeOfFrame(f)]?.push(lv);
        }
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const std = (a) => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) * (x - m)))); };
    // Hop-to-hop jitter: std of consecutive differences / sqrt(2) (robust to slow drift).
    const jit = (a) => { const d = []; for (let i = 1; i < a.length; i++) d.push(a[i] - a[i - 1]); return std(d) / Math.SQRT2; };
    // Whitened kurtosis over active cells (per-bin mean over active frames), band-limited.
    const yMean = new Float64Array(N / 2);
    for (const f of active) for (let k = K_LO; k < K_HI; k++) yMean[k] += PY[f][k];
    for (let k = K_LO; k < K_HI; k++) yMean[k] /= Math.max(1, active.length);
    let m2 = 0, m4 = 0, cnt = 0;
    for (const f of active) for (let k = K_LO; k < K_HI; k++) { const w = PY[f][k] / (yMean[k] + 1e-24); m2 += w * w; m4 += w * w * w * w; cnt++; }
    m2 /= cnt; m4 /= cnt;
    const byRegime = {};
    for (const [k, v] of Object.entries(speechByRegime)) if (v.length) byRegime[['zero', 'pass', 'mask', 'full', 'silent'][k]] = { n: v.length, speechLevelDb: mean(v) };
    return {
        activeFrames: active.length,
        floorResidualDb: mean(floorDb), floorJitterDb: jit(floorDb), floorFramesUsed: floorDb.length, floorCellsAvg: mean(floorCells),
        speechLevelDb: mean(speechDb), speechWarbleDb: jit(speechDb),
        speechByRegime: byRegime,
        kurt: m4 / (m2 * m2),
    };
}

// ------------------------------------------------------------- process ----
/**
 * Measured lag (samples) of `y` behind `x` by normalized cross-correlation
 * over the loudest 1 s of `x`, lags [0, maxLag]. This is how the 3-hop model
 * delay is PROVEN per config rather than assumed: a config whose output the
 * runner has aligned wrongly reads a non-zero residual lag here.
 */
function measureLag(x, y, maxLag = 2400) {
    // Loudest 1 s window of x (by RMS over 100 ms blocks).
    const blk = SR / 10; let best = 0, bestAt = 0;
    for (let s = 0; s + SR <= x.length - maxLag; s += blk) { const r = rmsOf(x, s, s + SR); if (r > best) { best = r; bestAt = s; } }
    let bestLag = -1, bestC = -Infinity;
    const xs = x.subarray(bestAt, bestAt + SR);
    let xx = 0; for (let i = 0; i < SR; i++) xx += xs[i] * xs[i];
    for (let lag = 0; lag <= maxLag; lag++) {
        let xy = 0, yy = 0;
        const ys = y.subarray(bestAt + lag, bestAt + lag + SR);
        for (let i = 0; i < SR; i++) { xy += xs[i] * ys[i]; yy += ys[i] * ys[i]; }
        const c = xy / Math.sqrt(xx * yy + 1e-30);
        if (c > bestC) { bestC = c; bestLag = lag; }
    }
    return { lag: bestLag, corr: bestC };
}

function runConfig(cfg, mix, delayHops) {
    const dfn = new DeepFilter(cfg.atten, cfg.min, cfg.beta, cfg.erb, cfg.df);
    if (dfn.hop_size !== HOP) throw new Error('unexpected hop ' + dfn.hop_size);
    if (dfn.delay_hops !== delayHops) throw new Error(`model delay_hops ${dfn.delay_hops} != expected ${delayHops}`);
    const norm = new LevelNormalizer(delayHops);
    const nHops = Math.floor(mix.length / HOP);
    const out = new Float32Array(nHops * HOP);
    const lsnr = new Float32Array(nHops);
    const regime = new Uint8Array(nHops); // 0 zero, 1 pass, 2 mask, 3 full, 4 silentPath
    const gainIn = new Float32Array(nHops), gainOut = new Float32Array(nHops);
    const scratch = new Float32Array(HOP);
    let floorSeed = 0x9E3779B9; let floored = 0;
    for (let h = 0; h < nHops; h++) {
        const hop = mix.subarray(h * HOP, (h + 1) * HOP);
        let gIn = 1, gOut = 1;
        if (cfg.normalize) {
            gIn = norm.gainForInput(hop);
            gOut = cfg.inverse === 'delayed' ? norm.gainForOutput() : gIn;
        }
        let ms = 0;
        for (let i = 0; i < HOP; i++) { const v = hop[i] * gIn; scratch[i] = v; ms += v * v; }
        // The worker's near-silence floor (dfWorker.ts NEAR_SILENT_FLOOR): keep the
        // model off its zero-delay early-return path.
        if (cfg.floor && ms / HOP < 1e-7) {
            floored++;
            for (let i = 0; i < HOP; i++) {
                floorSeed = (Math.imul(floorSeed, 1664525) + 1013904223) >>> 0;
                scratch[i] += ((floorSeed / 4294967296) * 2 - 1) * 6e-4 * Math.sqrt(3);
            }
        }
        const enh = dfn.process(scratch);
        const l = dfn.last_lsnr;
        lsnr[h] = l; gainIn[h] = gIn; gainOut[h] = gOut;
        regime[h] = (ms / HOP < 1e-7) ? 4 : l < cfg.min ? 0 : l > cfg.erb ? 1 : l > cfg.df ? 2 : 3;
        const inv = 1 / gOut;
        for (let i = 0; i < HOP; i++) out[h * HOP + i] = enh[i] * inv;
    }
    dfn.free();
    // Delay-compensate: output hop h is the enhanced input hop h - delayHops
    // (the atten-lim-0 passthrough shortcut copies BEFORE the STFT: delay 0).
    const d = cfg.delay ?? delayHops;
    const measured = measureLag(mix, out);
    const aligned = new Float32Array(out.length);
    aligned.set(out.subarray(d * HOP), 0);
    return { out: aligned, lsnr, regime, gainIn, gainOut, nHops, envFinal: norm.env, gainFinal: norm.gain, lag: measured, delayUsed: d * HOP, floored };
}

// ---------------------------------------------------------------- main ----
const wasmBytes = readFileSync(join(HERE, '..', 'src', 'wasm', 'df', 'df_wasm_bg.wasm'));
await initDf({ module_or_path: wasmBytes });
{
    const probe = new DeepFilter(undefined, undefined, undefined, undefined, undefined);
    console.log(`wasm up: hop ${probe.hop_size}, model delay ${probe.delay_hops} hops`);
    probe.free();
}
const DELAY_HOPS = 3;

// Speech: loop the clip, scale to the requested ACTIVE rms (hops with rms above
// -35 dB re. the loudest hop count as active).
const clip = readWav(SPEECH_WAV);
const clipHops = Math.floor(clip.length / HOP);
{
    let maxRms = 0; const hr = [];
    for (let h = 0; h < clipHops; h++) { const r = rmsOf(clip, h * HOP, (h + 1) * HOP); hr.push(r); if (r > maxRms) maxRms = r; }
    const act = hr.filter(r => r > maxRms * 10 ** (-35 / 20));
    const actRms = Math.sqrt(act.reduce((s, r) => s + r * r, 0) / act.length);
    const k = SPEECH_RMS / actRms;
    for (let i = 0; i < clip.length; i++) clip[i] *= k;
    console.log(`speech: ${(clip.length / SR).toFixed(1)} s, active hops ${act.length}/${clipHops}, scaled ×${k.toFixed(3)} to active RMS ${SPEECH_RMS} (${db(SPEECH_RMS).toFixed(1)} dBFS)`);
}
const totalLen = clipHops * HOP * LOOPS;
const S = new Float32Array(totalLen);
for (let l = 0; l < LOOPS; l++) S.set(clip.subarray(0, clipHops * HOP), l * clipHops * HOP);
// The delay-compensated output's last DELAY_HOPS hops are zeros (their input
// is still inside the model), and a frame spans 2 hops: keep every analysed
// frame clear of that tail so a trailing active frame cannot read -inf.
const nFrames = Math.floor((totalLen - WIN) / HOP) - (DELAY_HOPS + 2);
const analyseFrom = Math.floor(((LOOPS - 1) * clipHops * HOP) / HOP); // steady state: last loop only

const results = [];
mkdirSync(OUT_DIR, { recursive: true });

// Positive controls for the metrics, computed once (SNR 30, the regime of interest).
{
    const V = NOISE_WAV ? readWav(NOISE_WAV) : makeNoise(NOISE, totalLen, 12345);
    const vRms = rmsOf(V); const scale = SPEECH_RMS / (vRms * 10 ** (30 / 20));
    for (let i = 0; i < totalLen; i++) V[i] *= scale;
    const mix = new Float32Array(totalLen); for (let i = 0; i < totalLen; i++) mix[i] = S[i] + V[i];
    const plain = analyse(S, V, mix, analyseFrom, nFrames);
    // Toggled floor: noise alternately raw / attenuated 30 dB in random runs of 1-4 hops.
    const rand = seededRand(777); const tog = new Float32Array(totalLen);
    let g = 1, left = 0;
    for (let h = 0; h < totalLen / HOP; h++) {
        if (left-- <= 0) { g = rand() > 0 ? 1 : 10 ** (-30 / 20); left = 1 + Math.floor((rand() + 1) * 2); }
        for (let i = 0; i < HOP; i++) tog[h * HOP + i] = S[h * HOP + i] + V[h * HOP + i] * g;
    }
    const toggled = analyse(S, V, tog, analyseFrom, nFrames);
    // Warbled speech: speech gain ±1 dB random per hop, noise untouched.
    const wob = new Float32Array(totalLen);
    for (let h = 0; h < totalLen / HOP; h++) { const gw = 10 ** ((rand()) / 20); for (let i = 0; i < HOP; i++) wob[h * HOP + i] = S[h * HOP + i] * gw + V[h * HOP + i]; }
    const warbled = analyse(S, V, wob, analyseFrom, nFrames);
    console.log(`\n== positive controls (SNR 30, ${NOISE}) ==`);
    console.log(`  plain mix   : floorJitter ${plain.floorJitterDb.toFixed(2)} dB, floorResidual ${plain.floorResidualDb.toFixed(2)} dB, speechWarble ${plain.speechWarbleDb.toFixed(2)} dB, kurt ${plain.kurt.toFixed(1)}`);
    console.log(`  toggled floor: floorJitter ${toggled.floorJitterDb.toFixed(2)} dB  (x${(toggled.floorJitterDb / plain.floorJitterDb).toFixed(1)}, must be >= x3)`);
    console.log(`  warbled speech: speechWarble ${warbled.speechWarbleDb.toFixed(2)} dB  (x${(warbled.speechWarbleDb / plain.speechWarbleDb).toFixed(1)}, must be >= x3)`);
    // Each metric gated on ITS OWN control (a combined gate lets a blind metric
    // ride on the other's separation — a prior harness had exactly that bug).
    if (!(toggled.floorJitterDb > plain.floorJitterDb * 3)) throw new Error('floorJitter metric is BLIND to a toggled floor — aborting');
    if (!(warbled.speechWarbleDb > plain.speechWarbleDb * 3)) throw new Error('speechWarble metric is BLIND to warbled speech — aborting');
}

for (const snr of SNRS) {
    const V = NOISE_WAV ? readWav(NOISE_WAV) : makeNoise(NOISE, totalLen, 12345);
    const vRms = rmsOf(V);
    const scale = SPEECH_RMS / (vRms * 10 ** (snr / 20));
    for (let i = 0; i < totalLen; i++) V[i] *= scale;
    const mix = new Float32Array(totalLen);
    for (let i = 0; i < totalLen; i++) mix[i] = S[i] + V[i];
    console.log(`\n== SNR ${snr} dB (${NOISE} noise at ${db(vRms * scale).toFixed(1)} dBFS) ==`);
    if (WRITE_WAV) writeWav16(join(OUT_DIR, `mix_${NOISE}_snr${snr}.wav`), mix);
    const base = analyse(S, V, mix, analyseFrom, nFrames);
    console.log(`  input mix    : floorResidual ${base.floorResidualDb.toFixed(2)} floorJitter ${base.floorJitterDb.toFixed(2)} speechLevel ${base.speechLevelDb.toFixed(2)} speechWarble ${base.speechWarbleDb.toFixed(2)} kurt ${base.kurt.toFixed(1)}`);
    for (const name of CONFIG_NAMES) {
        const cfg = CONFIGS[name];
        if (!cfg) throw new Error('unknown config ' + name);
        const r = runConfig(cfg, mix, DELAY_HOPS);
        // The compensated output at hop j is the model's answer at call j + delay,
        // whose regime was recorded at that call; a metric frame f spans hops f, f+1.
        const dHops = r.delayUsed / HOP;
        const m = analyse(S, V, r.out, analyseFrom, nFrames, (f) => r.regime[Math.min(r.nHops - 1, f + dHops)]);
        // A config whose measured lag disagrees with the compensation the runner
        // applied would have every metric read against the wrong instant — a
        // hard error, not a footnote (the passthrough control declares delay 0).
        if (r.lag.lag !== r.delayUsed) throw new Error(`${name}: measured lag ${r.lag.lag} != compensated ${r.delayUsed} (r=${r.lag.corr.toFixed(3)}) — alignment assumption broken`);
        // Regime stats over the analysed (steady-state) hops, split by speech activity.
        const hopFrom = analyseFrom;
        const hist = { zero: 0, pass: 0, mask: 0, full: 0, silent: 0 };
        const names = ['zero', 'pass', 'mask', 'full', 'silent'];
        let toggles = 0, activeHops = 0, prev = -1;
        let lsnrSum = 0;
        for (let h = hopFrom; h < r.nHops - DELAY_HOPS; h++) {
            // Regime recorded at call h applies to the output hop h (= input hop h-3, but the
            // lsnr is the model's estimate for that frame — attribute by call index).
            const sHop = rmsOf(S, h * HOP, (h + 1) * HOP);
            const isActive = sHop > SPEECH_RMS * 10 ** (-25 / 20);
            if (!isActive) { prev = -1; continue; }
            activeHops++;
            hist[names[r.regime[h]]]++;
            lsnrSum += r.lsnr[h];
            if (prev >= 0 && prev !== r.regime[h]) toggles++;
            prev = r.regime[h];
        }
        const pct = (n) => (100 * n / Math.max(1, activeHops)).toFixed(1).padStart(5);
        const secs = activeHops * HOP / SR;
        const silentNote = hist.silent ? ` silent${pct(hist.silent)}%` : '';
        const floorNote = r.floored ? ` floored ${r.floored}` : '';
        const byReg = Object.entries(m.speechByRegime).length > 1
            ? ' | speechLevel by regime ' + Object.entries(m.speechByRegime).map(([k, v]) => `${k} ${v.speechLevelDb.toFixed(2)} (n=${v.n})`).join(', ')
            : '';
        console.log(`  ${name.padEnd(13)}: floorResidual ${m.floorResidualDb.toFixed(2).padStart(7)} floorJitter ${m.floorJitterDb.toFixed(2).padStart(6)} speechLevel ${m.speechLevelDb.toFixed(2).padStart(6)} speechWarble ${m.speechWarbleDb.toFixed(2).padStart(5)} kurt ${m.kurt.toFixed(1).padStart(7)} | active-hop regimes zero${pct(hist.zero)}% pass${pct(hist.pass)}% mask${pct(hist.mask)}% full${pct(hist.full)}%${silentNote} toggles ${(toggles / secs).toFixed(1)}/s lsnr avg ${(lsnrSum / Math.max(1, activeHops)).toFixed(1)}${cfg.normalize ? ` env ${r.envFinal.toFixed(3)} gain ${r.gainFinal.toFixed(2)}` : ''}${floorNote} | lag ${r.lag.lag} (r=${r.lag.corr.toFixed(3)})${byReg}`);
        results.push({ snr, name, ...m, hist, toggles, activeHops, lag: r.lag, floored: r.floored });
        if (WRITE_WAV) writeWav16(join(OUT_DIR, `out_${NOISE}_snr${snr}_${name}.wav`), r.out);
    }
}
writeFileSync(join(OUT_DIR, `results_${NOISE}.json`), JSON.stringify(results, null, 1));
console.log(`\nresults: ${join(OUT_DIR, `results_${NOISE}.json`)}${WRITE_WAV ? ` + WAVs in ${OUT_DIR}` : ''}`);
