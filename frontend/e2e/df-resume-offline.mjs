// DeepFilter PAUSE -> RESUME, offline: does the model's stale state reach the
// output when DeepFilter takes over again? No browser, no audio device: the
// production wasm + the production level normalizer, driven from Node exactly
// as dfWorker.ts drives them (level gain in, near-silence floor, process(),
// inverse gain delayed by the model's 3 hops out).
//
// Why (2026-10-04): DeepFilter now pauses while nobody can hear the mic
// (dfPauseDecision.ts) and the Worker sleeps. DFN3 is stateful - an STFT
// overlap-add, two hops of lookahead and GRUs with long memory (see dfLevel.ts)
// - so a model resumed where it stopped has three kinds of stale state:
//   1. its lookahead still holds the last hops sent BEFORE the pause: the
//      first 3 answers after a resume are pre-pause audio;
//   2. the first resumed hop overlap-adds onto a pre-pause frame (a seam);
//   3. its recurrent state describes the room as it was, however long ago.
// dfWorklet.js's resume therefore re-feeds the model PRE-ROLL hops of real
// audio from its raw ring (the instants just before the resume) and discards
// everything it returns before the emit position, so (1) and (2) never reach
// the output and (3) has had the pre-roll to adapt. This runner measures what
// is left, from the first sample the worklet would emit as processed, on two
// yardsticks: the error against the CLEAN speech (how far the output is from
// what the talker said - the one that decides whether it sounds worse), and
// the difference from an UNPAUSED run of the same model on the same input
// (how different it is at all), next to a brand-new model at the resume (what
// every call starts with) and the model's own sensitivity (input nudged 70 dB
// down).
//
// Scenarios (pink noise at 20 dB SNR under looped speech): the noise steady
// across the pause, the noise 10 dB louder after it, and 10 dB quieter. A
// continuous model meets the same change and adapts as it goes; a resumed one
// meets it all at once at the resume - the transient is the cost being
// measured, against a positive control (no pre-roll, no discard: the stale
// answers go straight out) that the run REQUIRES to read clearly worse.
//
// Usage: node e2e/df-resume-offline.mjs [--preroll 16] [--sweep]
//        (--sweep prints PREROLLS=6,8,... x STEPS=0,10,-10 with no verdict)
// Exit 1 on any FAIL. Pure Node: no browser, no audio device, nothing audible.
// Prereqs: the built wasm in src/wasm/df, Node 24+ (imports dfLevel.ts directly).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import initDf, { DeepFilter } from '../src/wasm/df/df_wasm.js';
import { LevelNormalizer } from '../src/api/dfLevel.ts';
import { DEFAULT_TUNING } from '../src/api/dfTuning.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
const HOP = 480;
const DELAY = 3; // DFN3's algorithmic delay in hops (asserted against the wasm below)
// The worklet's emit latency in hops (deepFilter.ts latencySamples: delay + 1
// + 2 hops of round-trip slack). At a resume at input hop R the emitter is at
// hop R - EMIT_HOPS: nothing earlier is ever emitted again.
const EMIT_HOPS = DELAY + 1 + 2;

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => {
    if (!a.startsWith('--')) return [];
    const v = all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true';
    return [a.slice(2), v];
}).filter(p => p.length));
// Must match dfWorklet.js RESUME_PREROLL_HOPS (checked below by reading it).
const PREROLL = Number(args.preroll ?? 16);
const SWEEP = args.sweep === 'true';

function readWav(path) {
    const b = readFileSync(path);
    let off = 12; let fmt = null; let data = null;
    while (off + 8 <= b.length) {
        const id = b.toString('ascii', off, off + 4);
        const size = b.readUInt32LE(off + 4);
        if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
        else if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
        off += 8 + size + (size & 1);
    }
    if (!fmt || !data || fmt.sr !== SR || fmt.bits !== 16) throw new Error('need a 48 kHz 16-bit WAV');
    const n = data.length / 2 / fmt.ch;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < fmt.ch; c++) acc += data.readInt16LE((i * fmt.ch + c) * 2) / 32768;
        out[i] = acc / fmt.ch;
    }
    return out;
}
function pinkNoise(len, seed0) {
    let seed = seed0 | 0;
    const rand = () => {
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
    };
    const d = new Float32Array(len);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
        const w = rand();
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
        b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
    }
    return d;
}
const rms = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, b - a)); };

/** The Worker's per-hop pipeline (dfWorker.ts onHop), as a stateful object. */
function makeWorker() {
    const t = DEFAULT_TUNING;
    const df = new DeepFilter(t.attenLimDb, t.minDbThresh, t.postFilterBeta, t.maxDbErbThresh, t.maxDbDfThresh);
    if (df.delay_hops !== DELAY || df.hop_size !== HOP) throw new Error(`model is ${df.hop_size}/${df.delay_hops}, runner assumes ${HOP}/${DELAY}`);
    const level = new LevelNormalizer(df.delay_hops);
    const scratch = new Float32Array(HOP);
    let seed = 0x9E3779B9;
    const floorNoise = (buf) => {
        for (let i = 0; i < HOP; i++) {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            buf[i] += ((seed / 4294967296) * 2 - 1) * 6e-4 * Math.sqrt(3);
        }
    };
    // The worker's init warm-up: 8 hops of floor noise.
    const warm = new Float32Array(HOP);
    for (let i = 0; i < 8; i++) { warm.fill(0); floorNoise(warm); df.process(warm); }
    return {
        process(hop) {
            const g = level.gainForInput(hop);
            let ms = 0;
            for (let i = 0; i < HOP; i++) { const v = hop[i] * g; scratch[i] = v; ms += v * v; }
            if (ms / HOP < 2e-7) floorNoise(scratch);
            const enh = df.process(scratch);
            const inv = 1 / level.gainForOutput();
            const out = new Float32Array(HOP);
            for (let i = 0; i < HOP; i++) out[i] = enh[i] * inv;
            return out;
        },
        free() { df.free(); },
    };
}

/**
 * Feed `order` (input hop indices, in send order) through one worker and place
 * every answer the way DfCore does: the answer to call j lands DELAY hops
 * behind the hop sent at call j, within the epoch that call belongs to (an
 * epoch starts at every jump in `order`); an answer whose position is before
 * `validFrom[epoch]` (in hops) is discarded, as the worklet discards it.
 */
function run(mix, order, validFromByEpoch, fresh = null) {
    // (order may stop early: only the hops a comparison reads are processed.)
    const nHops = Math.floor(mix.length / HOP);
    const out = new Float32Array(nHops * HOP);
    const have = new Uint8Array(nHops);
    let w = makeWorker();
    let epoch = -1; let epochStart = 0; let epochCall = 0;
    for (let j = 0; j < order.length; j++) {
        const h = order[j];
        if (j === 0 || h !== order[j - 1] + 1) {
            epoch++; epochStart = h; epochCall = j;
            if (fresh && epoch > 0) { w.free(); w = makeWorker(); }
        }
        const ans = w.process(mix.subarray(h * HOP, (h + 1) * HOP));
        const pos = epochStart + (j - epochCall) - DELAY; // hop this answer belongs to
        if (pos >= validFromByEpoch[epoch] && pos < nHops) { out.set(ans, pos * HOP); have[pos] = 1; }
    }
    w.free();
    return { out, have };
}

const wasm = readFileSync(join(HERE, '..', 'src', 'wasm', 'df', 'df_wasm_bg.wasm'));
await initDf({ module_or_path: wasm });

// Speech at -26 dBFS active RMS, looped to 30 s; pink noise at 20 dB SNR.
const clip = readWav(join(HERE, 'assets', 'df-test-speech.wav'));
// Reads 4.8 s after each resume (how long a resumed model takes to converge,
// not just whether its first hops are clean); LONG=0 reads only 600 ms.
const LONG = process.env.LONG !== '0';
const LEN = (LONG ? 20 : 16) * SR; // the last resume plus its read must fit
const S = new Float32Array(LEN);
for (let i = 0; i < LEN; i++) S[i] = clip[i % clip.length];
{
    const hr = []; let mx = 0;
    for (let h = 0; h < clip.length / HOP - 1; h++) { const r = rms(clip, h * HOP, (h + 1) * HOP); hr.push(r); mx = Math.max(mx, r); }
    const act = hr.filter(r => r > mx * 10 ** (-35 / 20));
    const k = 0.05 / Math.sqrt(act.reduce((s, r) => s + r * r, 0) / act.length);
    for (let i = 0; i < LEN; i++) S[i] *= k;
}
const NOISE_RMS = 0.05 / 10;
const PAUSE_AT = 4 * SR / HOP; // hop the pause starts at (the model has settled by then)
const totalHops = LEN / HOP;

function mixFor(stepDb) {
    // The noise changes level halfway through the pause (the model, paused,
    // never sees it happen; the unpaused reference adapts through it).
    const V = pinkNoise(LEN, 4242);
    const vr = rms(V, 0, LEN);
    const m = new Float32Array(LEN);
    const change = (PAUSE_AT + 200) * HOP;
    for (let i = 0; i < LEN; i++) m[i] = S[i] + V[i] * (NOISE_RMS / vr) * (i >= change ? 10 ** (stepDb / 20) : 1);
    return m;
}

// Resume points: every 37 hops through two speech-rich seconds after a 5 s
// pause, so onsets, mid-word and gaps are all represented. Each is its own
// run (its 600 ms reads overlap the next resume point's).
const RESUMES = Array.from({ length: 12 }, (_, i) => PAUSE_AT + 500 + i * 37);
// Windows after the first processed hop on air, in hops.
const WINDOWS = [[0, 5, '0-50 ms'], [5, 15, '50-150 ms'], [15, 30, '150-300 ms'], [30, 60, '300-600 ms'],
    ...(LONG ? [[60, 120, '0.6-1.2 s'], [120, 240, '1.2-2.4 s'], [240, 480, '2.4-4.8 s']] : [])];
const READ_HOPS = WINDOWS[WINDOWS.length - 1][1];

/** Accumulates, per window, the error of an output against the CLEAN speech
 *  (residual noise plus any distortion: how far from what the talker said)
 *  and its per-hop difference from the unpaused model. */
function makeAcc() {
    return WINDOWS.map(() => ({ err: 0, sig: 0, diff: [], spOut: 0, spRef: 0, gapOut: 0, gapHops: 0, steps: [] }));
}
const SPEECH_HOP_ENERGY = 0.05 * 0.05 * HOP;
function accumulate(acc, out, ref, from) {
    WINDOWS.forEach(([a, b], w) => {
        let prevGain = null;
        for (let h = from + a; h < from + b; h++) {
            let d = 0;
            for (let i = h * HOP; i < (h + 1) * HOP; i++) {
                const e = out[i] - S[i];
                acc[w].err += e * e;
                acc[w].sig += S[i] * S[i];
                const x = out[i] - ref[i];
                d += x * x;
            }
            // dB re. the ACTIVE SPEECH level (an absolute yardstick: a ratio to
            // the reference hop's own energy reads a different residual-noise
            // texture in a speech gap as a huge error, 30-40 dB below anything
            // a listener hears).
            acc[w].diff.push(10 * Math.log10(Math.max(d, 1e-20) / SPEECH_HOP_ENERGY));
            // The two things a listener hears: is SPEECH kept at its level
            // (over-suppression = muffled, the 2026-08 field report), and how
            // much noise is left where nobody speaks.
            let so = 0; let ss = 0;
            for (let i = h * HOP; i < (h + 1) * HOP; i++) { so += out[i] * out[i]; ss += S[i] * S[i]; }
            if (ss > SPEECH_HOP_ENERGY * 10 ** (-20 / 10)) {
                acc[w].spOut += so; acc[w].spRef += ss;
                // WARBLE: the speech gain's hop-to-hop wobble (the time-domain
                // cousin of df-offline.mjs's speechWarble), over consecutive
                // speech hops only. A model fighting stale state pumps the
                // talker's level up and down from one hop to the next.
                const g = 10 * Math.log10(Math.max(so, 1e-20) / ss);
                if (prevGain !== null) acc[w].steps.push(g - prevGain);
                prevGain = g;
            } else {
                prevGain = null;
                if (ss < SPEECH_HOP_ENERGY * 10 ** (-50 / 10)) { acc[w].gapOut += so; acc[w].gapHops++; }
            }
        }
    });
}
const pct = (arr, p) => { const s = arr.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const cleanDb = (w) => 10 * Math.log10(Math.max(w.err, 1e-20) / Math.max(w.sig, 1e-20));
/** Speech kept: output energy over the clean speech's, on speech hops (0 dB = kept). */
const speechDb = (w) => 10 * Math.log10(Math.max(w.spOut, 1e-20) / Math.max(w.spRef, 1e-20));
/** Speech-gain wobble between consecutive speech hops, dB (std of the steps / sqrt 2). */
const warbleDb = (w) => {
    const d = w.steps; if (d.length < 4) return NaN;
    const m = d.reduce((x, y) => x + y, 0) / d.length;
    return Math.sqrt(d.reduce((x, y) => x + (y - m) * (y - m), 0) / d.length) / Math.SQRT2;
};
/** Noise left in the gaps, dB re. active speech. */
const gapDb = (w) => (w.gapHops ? 10 * Math.log10(Math.max(w.gapOut / w.gapHops, 1e-20) / SPEECH_HOP_ENERGY) : NaN);

/**
 * One noise scenario: the unpaused model as the reference, and at every
 * resume point the variants
 *  - 'fix'   what dfWorklet.js does: the stale model, PRE-ROLL hops of real
 *            audio re-fed, every answer before the emit position dropped;
 *  - 'fresh' a brand-new model at the resume (what every call starts with);
 *  - 'naive' the positive control: send from the resume instant, keep every
 *            answer, so the stale lookahead goes straight out;
 *  - 'nudged' the unpaused model on input nudged by white noise 70 dB under
 *            the speech: how small "the same" can be (the model is chaotic).
 * The fix, fresh, nudged and the reference are read from the fix's first
 * emitted processed hop; the naive control from where its stale answers land
 * (and the reference again on those same hops, to compare it with).
 */
function scenario(stepDb, preroll) {
    const mix = mixFor(stepDb);
    const lastHop = RESUMES[RESUMES.length - 1] + READ_HOPS + 4 + DELAY;
    if (lastHop > totalHops) throw new Error('the scenario does not fit the input');
    const order0 = Array.from({ length: lastHop }, (_, h) => h);
    const ref = run(mix, order0, [0]).out;
    const m2 = new Float32Array(mix);
    let sd = 99;
    for (let i = 0; i < m2.length; i++) { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; m2[i] += ((sd / 4294967296) * 2 - 1) * 0.05 * 10 ** (-70 / 20) * Math.sqrt(3); }
    const nudged = run(m2, order0, [0]).out;
    const acc = { unpaused: makeAcc(), fix: makeAcc(), fresh: makeAcc(), nudged: makeAcc(), naive: makeAcc(), unpausedAtNaive: makeAcc() };
    let coverHops = 0;
    for (const R of RESUMES) {
        const emitAt = R - EMIT_HOPS; // first hop the worklet could still emit
        const resumed = (start, validFrom, fresh) => run(mix, [...order0.slice(0, PAUSE_AT), ...order0.slice(start, R + READ_HOPS + 4 + DELAY)], [0, validFrom], fresh);
        // dfWorklet.js's guard (enhLow = sentPos + hop + modelDelay) and the
        // emit position: nothing before either is ever on air.
        const fixFrom = Math.max(emitAt, R - preroll + 1 + DELAY);
        const fix = resumed(R - preroll, fixFrom, null);
        let first = fixFrom; while (first < lastHop && !fix.have[first]) first++;
        coverHops = Math.max(coverHops, first - emitAt);
        accumulate(acc.fix, fix.out, ref, first);
        accumulate(acc.unpaused, ref, ref, first);
        accumulate(acc.nudged, nudged, ref, first);
        accumulate(acc.fresh, resumed(R - preroll, fixFrom, true).out, ref, first);
        accumulate(acc.naive, resumed(R, -Infinity, null).out, ref, R - DELAY);
        accumulate(acc.unpausedAtNaive, ref, ref, R - DELAY);
    }
    return { stepDb, preroll, coverHops, acc };
}

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : String(x)).padStart(6);
let failed = 0;
const fail = (msg) => { console.log('FAIL  ' + msg); failed++; };
const prerolls = SWEEP ? (process.env.PREROLLS ?? '6,8,12,16,24,32').split(',').map(Number) : [PREROLL];
if (!SWEEP) {
    // The constant this runner validates must be the one the worklet uses.
    const src = readFileSync(join(HERE, '..', 'src', 'api', 'dfWorklet.js'), 'utf8');
    const m = /const RESUME_PREROLL_HOPS = (\d+);/.exec(src);
    if (!m) throw new Error('dfWorklet.js has no RESUME_PREROLL_HOPS constant');
    if (!args.preroll && Number(m[1]) !== PREROLL) throw new Error(`runner default ${PREROLL} != dfWorklet.js ${m[1]}`);
    console.log(`dfWorklet.js RESUME_PREROLL_HOPS = ${m[1]}${args.preroll ? ` (this run: --preroll ${PREROLL})` : ''}`);
}
console.log(`${RESUMES.length} resumes after a ${(RESUMES[0] - PAUSE_AT) * HOP / SR} s+ pause; pink noise 20 dB under -26 dBFS speech.`);
console.log('CLEAN = error against the clean speech, dB re. its energy (lower = closer to what was said)');
console.log('DIFF  = p95 per-hop difference from the unpaused model, dB re. active speech (lower = closer)\n');
for (const step of (process.env.STEPS ?? '0,10,-10').split(',').map(Number)) {
    for (const p of prerolls) {
        const r = scenario(step, p);
        console.log(`noise ${step >= 0 ? '+' : ''}${step} dB during the pause, pre-roll ${p} hops: the bridge covers <= ${r.coverHops} hops past the emit point`);
        console.log('  window      | CLEAN unpaused    fix  fresh | naive: unpaused/naive | DIFF nudged    fix  fresh  naive | SPEECH unp    fix  fresh | WARBLE unp    fix  fresh | GAPS unp    fix  fresh');
        WINDOWS.forEach(([, , name], w) => {
            const a = r.acc;
            console.log(`  ${name.padEnd(11)} |     ${f1(cleanDb(a.unpaused[w]))} ${f1(cleanDb(a.fix[w]))} ${f1(cleanDb(a.fresh[w]))} |       ${f1(cleanDb(a.unpausedAtNaive[w]))}/${f1(cleanDb(a.naive[w]))} |   ${f1(pct(a.nudged[w].diff, 0.95))} ${f1(pct(a.fix[w].diff, 0.95))} ${f1(pct(a.fresh[w].diff, 0.95))} ${f1(pct(a.naive[w].diff, 0.95))}`
                + ` |  ${f1(speechDb(a.unpaused[w]))} ${f1(speechDb(a.fix[w]))} ${f1(speechDb(a.fresh[w]))}`
                + ` |  ${f1(warbleDb(a.unpaused[w]))} ${f1(warbleDb(a.fix[w]))} ${f1(warbleDb(a.fresh[w]))}`
                + ` | ${f1(gapDb(a.unpaused[w]))} ${f1(gapDb(a.fix[w]))} ${f1(gapDb(a.fresh[w]))}`);
        });
        if (SWEEP) continue;
        // THE FIX, against the model that never paused. Measured 2026-10-04:
        // a resumed model is NOT the unpaused one for its first second or so
        // - its waveform sits 3-10 dB further from the clean speech (CLEAN)
        // while it re-converges, the further when the room got quieter during
        // the pause - and a brand-new model is no better. What it must not
        // do, and what these pin:
        const A = r.acc;
        WINDOWS.forEach(([, , name], w) => {
            // No muffling: the talker's level within 1.5 dB of the unpaused model's.
            const sp = speechDb(A.fix[w]); const spu = speechDb(A.unpaused[w]);
            if (!(Math.abs(sp - spu) <= 1.5)) fail(`noise ${step} dB, ${name}: speech kept at ${sp.toFixed(1)} dB vs ${spu.toFixed(1)} unpaused`);
            // No noise burst: the gaps no louder than the unpaused model leaves them (+3 dB).
            const g = gapDb(A.fix[w]); const gu = gapDb(A.unpaused[w]);
            if (Number.isFinite(g) && !(g <= gu + 3)) fail(`noise ${step} dB, ${name}: ${g.toFixed(1)} dB of noise in the gaps vs ${gu.toFixed(1)} unpaused`);
            // No warble: the speech gain does not pump hop to hop (+1 dB).
            const wb = warbleDb(A.fix[w]); const wbu = warbleDb(A.unpaused[w]);
            if (!(wb <= wbu + 1)) fail(`noise ${step} dB, ${name}: speech-gain wobble ${wb.toFixed(2)} dB vs ${wbu.toFixed(2)} unpaused`);
        });
        // No take-over transient: its first 50 ms on air no further from the
        // clean speech than the 100 ms after (+3 dB) - stale audio would be.
        const c0 = cleanDb(A.fix[0]); const c1 = cleanDb(A.fix[1]);
        if (!(c0 <= c1 + 3)) fail(`noise ${step} dB: the first 50 ms on air are ${c0.toFixed(1)} dB from the clean speech vs ${c1.toFixed(1)} after - a transient`);
        // It converges: by 1.2-2.4 s it is within 1.5 dB of the unpaused model.
        const conv = WINDOWS.findIndex(([, , name]) => name === '1.2-2.4 s');
        if (conv >= 0) {
            const cf = cleanDb(A.fix[conv]); const cu = cleanDb(A.unpaused[conv]);
            if (!(cf <= cu + 1.5)) fail(`noise ${step} dB, 1.2-2.4 s: still ${cf.toFixed(1)} dB from the clean speech vs ${cu.toFixed(1)} unpaused - not converging`);
        }
        // POSITIVE CONTROL: the naive resume's stale answers must read clearly
        // worse on its first hops, on both yardsticks - else this cannot see
        // the defect it exists for.
        const n0 = cleanDb(r.acc.naive[0]); const u0 = cleanDb(r.acc.unpausedAtNaive[0]);
        if (!(n0 > u0 + 3)) fail(`noise ${step} dB: the naive resume is not clearly further from the clean speech (${n0.toFixed(1)} vs ${u0.toFixed(1)} dB) - the metric is blind`);
        const dn = pct(r.acc.naive[0].diff, 0.95); const df = pct(r.acc.fix[0].diff, 0.95);
        if (!(dn > df + 6)) fail(`noise ${step} dB: the naive resume does not differ clearly more than the fix (${dn.toFixed(1)} vs ${df.toFixed(1)} dB)`);
        if (r.coverHops > p) fail(`noise ${step} dB: the bridge would cover ${r.coverHops} hops, more than the pre-roll`);
    }
}
console.log(SWEEP ? '\n(sweep: no verdict)' : failed ? `\n${failed} FAILED` : '\nALL PASS');
process.exit(failed ? 1 : 0);
