/**
 * DeepFilterNet bridge — the inference Worker.
 *
 * Owns the DFN3 wasm pipeline (tract runtime + embedded model, ~14 MB). Hops
 * arrive from the AudioWorklet over a MessagePort transferred in at init; each
 * one is enhanced and the SAME ArrayBuffer is transferred back (ping-pong — no
 * allocation churn on either side). Running here means main-thread stalls
 * (React renders, GC) can never starve the audio path — the crackle mechanism
 * of the ScriptProcessor design this replaced.
 *
 * Protocol (worker.postMessage to the main thread):
 *  - { type: 'ready', hop, delayHops }  wasm up, model warmed — safe to build
 *                                        the graph. delayHops is the model's
 *                                        algorithmic delay (3 for DFN3): the
 *                                        N-th returned hop is the enhanced
 *                                        input hop N − delayHops.
 *  - { type: 'error', message }    init failed — caller falls back to RNNoise
 *  - { type: 'stats', ... }        rolling inference timings, every ~2 s of audio
 * Hop port (both directions): { seq, buf } (+ dry: true on a processing error —
 * the input is returned unenhanced so the stream never gaps).
 */
import initDf, { DeepFilter } from '../wasm/df/df_wasm.js';
import wasmUrl from '../wasm/df/df_wasm_bg.wasm?url';
import { DEFAULT_TUNING, type DfTuning } from './dfTuning';
import { LevelNormalizer } from './dfLevel';

let df: DeepFilter | null = null;
let level: LevelNormalizer | null = null;

// A DRY hop (process() threw, or the wasm fail-opened) must still land where
// the worklet will place it — delayHops behind the hop it answers — so it
// carries the RAW input from delayHops ago, not the current hop. This ring
// holds the last delayHops + 1 raw hops for that. (Through 0.8.87 dry hops
// carried the current input; the worklet then placed every returned hop at
// its own index, so dry hops were the only ALIGNED ones and enhanced hops sat
// 30 ms late. Now it is the other way round by construction, and the ring
// keeps dry hops honest.)
let rawRing: Float32Array[] = [];
let rawRingPos = 0;
function rawRingPush(hop: Float32Array): void {
    rawRingPos = (rawRingPos + 1) % rawRing.length;
    rawRing[rawRingPos].set(hop);
}
/** The raw hop from `delayHops` pushes ago (zeros before the stream started). */
function rawRingDelayed(): Float32Array {
    return rawRing[(rawRingPos + 1) % rawRing.length];
}

// Rolling inference timings, reported every STATS_EVERY hops.
const STATS_EVERY = 200; // ~2 s of audio at 480-sample hops
let windowTotalMs = 0;
let windowMaxMs = 0;
let windowHops = 0;
let totalHops = 0;
// CRACKLE DIAGNOSIS (field report 2026-08-10, "still crackly sometimes").
// Three counters, each mapped to a candidate mechanism — captured live via
// (await __pucaVoiceDiag()).noise.deepFilter WHILE it crackles, per the
// instrument-first rule. A hop is 10ms of real time, so an inference over
// REALTIME_BUDGET_MS starves the worklet's latency budget toward a fallback
// flip (the worklet counts those seams as `flips`).
const REALTIME_BUDGET_MS = 10;
let windowOverBudgetHops = 0;
let totalDryHops = 0; // process() failures shipped unenhanced (was log-only)
// The slewed levelGain moves ≤0.5%/hop by construction — but the peak clip
// guard (LevelNormalizer's Math.min) is INSTANT and can step the model-input
// gain arbitrarily at a hop boundary. The output is inverted per hop with the
// matching (delayed) factor, yet the model SEES the step. Track how often the
// clamp engages and the largest hop-to-hop step of the gain actually applied.
let lastAppliedGain = 1;
let windowClampedHops = 0;
let windowMaxGainStepPct = 0;

// CRACKLE DIAGNOSIS ROUND 2 (field report 2026-08-11: "crackles while I am
// talking", with EVERY round-1 counter reading zero and RNNoise clean on the
// same mic). Round 1 instrumented the PIPELINE — scheduling, fallback flips,
// gain steps — and proved it innocent. So the artifact is in the samples the
// model returns, and these two counters look THERE instead.
//
// 1. nearSilentHops — hops whose model input fell below DFN3's own
//    near-silence early return (tract.rs: `if rms < 1e-7 { enh.fill(0.);
//    return }`, where `rms` is really MEAN-SQUARE, so ~-70 dBFS). That path
//    returns a zero hop IMMEDIATELY while every other hop comes back 3 hops
//    late, and it skips the STFT analysis AND overlap-add state updates: the
//    hops already inside the model then come out AFTER the silence, 50 ms
//    late, and the model's OLA memory is one hop stale when speech resumes.
//    Measured in e2e/df-offline.mjs on a quiet mic (-34 dBFS speech, 40 dB
//    SNR): 11 dB of hop-to-hop speech warble from this path alone. Since
//    0.8.88 the worker FLOORS the model input so the branch is unreachable
//    (see NEAR_SILENT_FLOOR); this counter now reports how often the floor
//    had to catch a hop, i.e. how much digital silence the mic delivers.
// 2. seam ratio — mechanism-AGNOSTIC. Whatever breaks (stale OLA, a lookahead
//    gain-inverse mismatch, dry-mix phase cancellation), an audible click is a
//    step discontinuity. Compare the jump ACROSS the hop boundary with the
//    largest step WITHIN the hop: clean audio gives ~1, a seam gives >>1. This
//    catches the artifact without having to guess its cause first.
const NEAR_SILENT_MS = 1e-7; // mirrors tract.rs's threshold exactly
// Deterministic white noise added to a hop that would otherwise trip the
// early return: RMS 6e-4 (mean-square 3.6e-7, 3.6× the threshold; -64 dBFS).
// It sits below any real microphone's floor, the model suppresses it like any
// other noise, and what survives is scaled by the attenuation-limit dry mix
// (~3%) and the inverse level gain — far below audibility. The point is not
// the noise, it is that the model's frame pipeline never skips a beat.
const NEAR_SILENT_FLOOR = 6e-4;
let floorSeed = 0x9E3779B9;
let windowNearSilentHops = 0;
let lastOutSample = 0;
let windowMaxSeamRatio = 0;
let windowSeamHops = 0;

// PROCESSING-REGIME TELEMETRY (2026-08-17). Upstream's apply_stages picks one
// of four per-frame paths from the model's local-SNR estimate; the 30/20
// stage skips this build inherited toggled between them at 7-14 Hz on a good
// mic and were the field-reported "static / volume varies" (see dfTuning.ts
// for the measurements). Counting the regimes live makes the next report
// answerable from numbers: with production tuning zero/pass/mask must all be
// zero, and lsnrAvg says how clean the mic actually is.
let windowRegimeZero = 0;
let windowRegimePass = 0;
let windowRegimeMask = 0;
let windowRegimeFull = 0;
let windowLsnrSum = 0;

// FIELD CAPTURE (2026-08-17). Three rounds of live diagnostics on this tier
// produced counters and adjectives ("crackle", "static", "warbly") but never
// a recording; the offline reproduction that finally isolated the cause had
// to be built from a synthetic fixture. So the worker keeps the last
// CAPTURE_S seconds of what the mic delivered (pre-gain, exactly what the
// hop port carried) and the aligned enhanced output, in rings that cost
// ~11.5 MB here and nothing on the audio thread. `{type:'capture'}` from the
// main thread returns both, oldest-first — __pucaDfCapture() in
// noiseFilter.ts turns them into two WAVs. Local only; nothing leaves the
// machine unless the user attaches the files to a report.
const CAPTURE_S = 30;
let captureRaw: Float32Array | null = null;
let captureEnh: Float32Array | null = null;
let captureHops = 0; // ring capacity in hops
let captureDelayHops = 0;

function captureStoreRaw(raw: Float32Array, hopIndex: number): void {
    if (!captureRaw) return;
    captureRaw.set(raw, (hopIndex % captureHops) * raw.length);
}
function captureStoreEnh(enh: Float32Array, hopIndex: number): void {
    if (!captureEnh) return;
    // The enhanced hop answers input hop `hopIndex - delay`: store it THERE so
    // the two files line up sample for sample.
    const alignedHop = hopIndex - captureDelayHops;
    if (alignedHop >= 0) captureEnh.set(enh, (alignedHop % captureHops) * enh.length);
}

function captureRead(hop: number): { raw: Float32Array; enh: Float32Array; hops: number } {
    const have = Math.min(totalHops, captureHops);
    const raw = new Float32Array(have * hop);
    const enh = new Float32Array(have * hop);
    if (captureRaw && captureEnh && have > 0) {
        // Oldest hop first. The newest `captureDelayHops` enhanced hops have not
        // been produced yet (their input is still inside the model): zeros.
        const first = totalHops - have;
        for (let i = 0; i < have; i++) {
            const src = ((first + i) % captureHops) * hop;
            raw.set(captureRaw.subarray(src, src + hop), i * hop);
            if (first + i < totalHops - captureDelayHops) enh.set(captureEnh.subarray(src, src + hop), i * hop);
        }
    }
    return { raw, enh, hops: have };
}

// TEST HARNESS ONLY (e2e/deepfilter-verify.mjs): echo hops back unenhanced so
// the transport (worklet ⇄ worker ⇄ timeline reassembly) can be proven
// sample-exact in a real browser, independent of what the model does to the
// signal. Never set on a user path — it would be a no-op suppressor.
let bypass = false;

/**
 * Runtime model tuning (see the knob docs in df-wasm/src/lib.rs and the
 * measurements in dfTuning.ts). A tuning object passed at init is MERGED over
 * the production defaults, so a caller enabling one knob (the opt-in post
 * filter) cannot silently revert the others to upstream values.
 */
export { DEFAULT_TUNING, POST_FILTER_BETA, type DfTuning } from './dfTuning';
let tuning: DfTuning = DEFAULT_TUNING;

/** Which of upstream's per-frame processing paths a hop with this lsnr took. */
function regimeOf(lsnr: number): 0 | 1 | 2 | 3 {
    if (lsnr < (tuning.minDbThresh ?? -10)) return 0; // zero mask
    if (lsnr > (tuning.maxDbErbThresh ?? 30)) return 1; // raw passthrough
    if (lsnr > (tuning.maxDbDfThresh ?? 20)) return 2; // ERB mask only
    return 3; // mask + deep filtering
}

function onHop(port: MessagePort, msg: { seq: number; buf: ArrayBuffer }): void {
    const samples = new Float32Array(msg.buf);
    let dry = false;
    const t0 = performance.now();
    try {
        if (!bypass) {
            captureStoreRaw(samples, totalHops);
            rawRingPush(samples);
            // Level-normalize into the model, exact-inverse back out (see
            // dfLevel.ts). The scratch copy keeps `samples` pristine until
            // the output is written.
            const g = level!.gainForInput(samples);
            // Crackle diag: the clamp engaging means g was pulled below the
            // slewed gain THIS hop — the one un-slewed step in the pipeline.
            if (g < level!.gain) windowClampedHops++;
            const stepPct = Math.abs(g / lastAppliedGain - 1) * 100;
            if (stepPct > windowMaxGainStepPct) windowMaxGainStepPct = stepPct;
            lastAppliedGain = g;
            const scratch = levelScratch(samples.length);
            let msAcc = 0;
            for (let i = 0; i < samples.length; i++) {
                const v = samples[i] * g;
                scratch[i] = v;
                msAcc += v * v;
            }
            // Would THIS hop trip DFN3's near-silence early return? Measured on
            // exactly the buffer handed to the model, against its threshold
            // with a 2× margin: upstream sums in f32 and this sum is f64, so
            // a hop sitting exactly on 1e-7 could read as safe here and trip
            // there. If so, floor it — the model must never take that path.
            if (msAcc / samples.length < NEAR_SILENT_MS * 2) {
                windowNearSilentHops++;
                for (let i = 0; i < samples.length; i++) {
                    floorSeed = (Math.imul(floorSeed, 1664525) + 1013904223) >>> 0;
                    // Uniform in [-1, 1) has RMS 1/√3 → scale by √3 for RMS 6e-4.
                    scratch[i] += ((floorSeed / 4294967296) * 2 - 1) * NEAR_SILENT_FLOOR * Math.sqrt(3);
                }
            }
            // process() allocates its result on the wasm boundary; copy it into
            // the incoming buffer so the transfer back reuses it. The hop it
            // returns is the enhanced input from delayHops ago, so the factor
            // to divide out is the one applied THEN — not `g`.
            const enhanced = df!.process(scratch);
            // The wasm fail-opens (returns its INPUT, i.e. hop N unenhanced)
            // on any internal error — which the worklet would place 3 hops
            // early. Same remedy as a throw: ship the aligned raw hop, dry.
            if (!df!.last_ok) throw new Error('DfTract::process fail-opened');
            const inv = 1 / level!.gainForOutput();
            for (let i = 0; i < samples.length; i++) samples[i] = enhanced[i] * inv;
            captureStoreEnh(samples, totalHops);
            // Regime telemetry from the model's own lsnr for this frame.
            const lsnr = df!.last_lsnr;
            windowLsnrSum += lsnr;
            switch (regimeOf(lsnr)) {
                case 0: windowRegimeZero++; break;
                case 1: windowRegimePass++; break;
                case 2: windowRegimeMask++; break;
                default: windowRegimeFull++;
            }
            // Seam detector: the step ACROSS the hop boundary against the worst
            // step WITHIN the hop. Scale-free by construction, so it stays
            // meaningful for a quiet talker where absolute thresholds do not.
            let maxIntra = 0;
            for (let i = 1; i < samples.length; i++) {
                const d = Math.abs(samples[i] - samples[i - 1]);
                if (d > maxIntra) maxIntra = d;
            }
            const boundary = Math.abs(samples[0] - lastOutSample);
            // Ignore hops that are essentially silent on both sides: a boundary
            // step of 1e-9 against an intra step of 1e-12 is a huge RATIO and
            // an inaudible nothing. Only judge hops with real signal in them.
            if (maxIntra > 1e-6) {
                const ratio = boundary / maxIntra;
                if (ratio > windowMaxSeamRatio) windowMaxSeamRatio = ratio;
                if (ratio > 3) windowSeamHops++;
            }
            lastOutSample = samples[samples.length - 1];
        }
    } catch (err) {
        // Ship the hop unenhanced — a gap would be worse — but the RAW hop
        // that belongs at the position this return will occupy: the input
        // from delayHops ago, not the one just received (see rawRing).
        dry = true;
        totalDryHops++;
        if (!bypass && rawRing.length) {
            samples.set(rawRingDelayed());
            captureStoreEnh(samples, totalHops);
        }
        console.warn('[DfWorker] process() failed — returning hop dry:', err);
    }
    const ms = performance.now() - t0;
    windowTotalMs += ms;
    if (ms > windowMaxMs) windowMaxMs = ms;
    if (ms > REALTIME_BUDGET_MS) windowOverBudgetHops++;
    windowHops++;
    totalHops++;
    port.postMessage({ seq: msg.seq, buf: msg.buf, dry }, [msg.buf]);

    if (windowHops >= STATS_EVERY) {
        self.postMessage({
            type: 'stats',
            avgMs: windowTotalMs / windowHops,
            maxMs: windowMaxMs,
            hops: totalHops,
            levelGain: level?.gain ?? 1, // current model-input normalization (1 = passthrough)
            levelEnv: level?.env ?? 0, // tracked active-speech RMS the gain is derived from
            // Crackle diag, per ~2s window (see the counter block up top):
            overBudgetHops: windowOverBudgetHops, // inferences slower than real time
            clampedHops: windowClampedHops, // peak guard pulled the gain (un-slewed)
            maxGainStepPct: windowMaxGainStepPct, // largest hop-to-hop applied-gain step
            dryHops: totalDryHops, // cumulative process() failures shipped dry
            // Round 2 (see the counter block up top): where the artifact is, not
            // whether the pipeline kept up.
            nearSilentHops: windowNearSilentHops, // hops the near-silence floor had to catch
            seamHops: windowSeamHops, // hops whose boundary step exceeded 3x the worst intra-hop step
            maxSeamRatio: windowMaxSeamRatio, // worst boundary/intra step ratio (~1 = clean)
            // Processing regimes (see the telemetry block up top). Production
            // tuning never skips, so zero/pass/mask must read 0.
            regimeZero: windowRegimeZero,
            regimePass: windowRegimePass,
            regimeMask: windowRegimeMask,
            regimeFull: windowRegimeFull,
            lsnrAvg: windowLsnrSum / windowHops, // model's mean local-SNR estimate, dB
        });
        windowTotalMs = 0;
        windowMaxMs = 0;
        windowHops = 0;
        windowOverBudgetHops = 0;
        windowClampedHops = 0;
        windowMaxGainStepPct = 0;
        windowNearSilentHops = 0;
        windowSeamHops = 0;
        windowMaxSeamRatio = 0;
        windowRegimeZero = 0;
        windowRegimePass = 0;
        windowRegimeMask = 0;
        windowRegimeFull = 0;
        windowLsnrSum = 0;
    }
}

let scratchBuf: Float32Array | null = null;
function levelScratch(n: number): Float32Array {
    if (!scratchBuf || scratchBuf.length !== n) scratchBuf = new Float32Array(n);
    return scratchBuf;
}

self.onmessage = async (e: MessageEvent) => {
    const data = e.data as {
        type?: string;
        port?: MessagePort;
        bypassInference?: boolean;
        tuning?: DfTuning;
        /** Allocate the 30 s raw-microphone diagnostic rings (developer mode only). */
        capture?: boolean;
    } | null;
    if (data?.type === 'capture') {
        const hop = df?.hop_size ?? 480;
        const c = captureRead(hop);
        // This file is typechecked against the DOM lib, where `self` is a
        // Window; in the Worker it is a DedicatedWorkerGlobalScope whose
        // postMessage takes a transfer list.
        (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(
            { type: 'capture', sampleRate: 48000, hop, hops: c.hops, delayHops: captureDelayHops, raw: c.raw, enh: c.enh },
            [c.raw.buffer as ArrayBuffer, c.enh.buffer as ArrayBuffer],
        );
        return;
    }
    if (data?.type !== 'init' || !data.port) return;
    const port = data.port;
    if (data.bypassInference) {
        bypass = true;
        port.onmessage = (ev: MessageEvent) => onHop(port, ev.data as { seq: number; buf: ArrayBuffer });
        // Echoing hops has no delay: the worklet must not offset the timeline.
        self.postMessage({ type: 'ready', hop: 480, delayHops: 0 });
        return;
    }
    if (data.tuning) tuning = { ...DEFAULT_TUNING, ...data.tuning };
    try {
        await initDf({ module_or_path: wasmUrl });
        df = new DeepFilter(
            tuning.attenLimDb, tuning.minDbThresh, tuning.postFilterBeta,
            tuning.maxDbErbThresh, tuning.maxDbDfThresh,
        );
        level = new LevelNormalizer(df.delay_hops);
        captureDelayHops = df.delay_hops;
        // OPT-IN since the 0.8.130 security pass. These rings hold the last 30
        // seconds of RAW, pre-gain microphone audio and were allocated and kept
        // filling for every DeepFilter call, for everyone — a rolling recording
        // of the user's microphone sitting in memory, reachable from a single
        // window global. It is a genuinely useful diagnostic, so it survives,
        // but only when the user has turned developer mode on.
        if (data.capture) {
            captureHops = CAPTURE_S * Math.round(48000 / df.hop_size);
            captureRaw = new Float32Array(captureHops * df.hop_size);
            captureEnh = new Float32Array(captureHops * df.hop_size);
        } else {
            captureHops = 0;
            captureRaw = null;
            captureEnh = null;
        }
        const hopSize = df.hop_size;
        rawRing = Array.from({ length: df.delay_hops + 1 }, () => new Float32Array(hopSize));
        rawRingPos = 0;
        // Warm up: the first inferences pay one-off allocation/plan costs that
        // would otherwise land mid-call as a burst of late hops. NOT with
        // zeros — a silent hop takes upstream's near-silence early return
        // and never touches the tract graph (the pre-0.8.89 warm-up warmed
        // nothing; review finding). Use the same -64 dBFS floor noise the
        // real path substitutes for digital silence, so the encoder, both
        // decoders and the STFT all run, then leave the model as a call's
        // first hops would: a few hops of near-silence.
        const warm = new Float32Array(df.hop_size);
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < warm.length; j++) {
                floorSeed = (Math.imul(floorSeed, 1664525) + 1013904223) >>> 0;
                warm[j] = ((floorSeed / 4294967296) * 2 - 1) * NEAR_SILENT_FLOOR * Math.sqrt(3);
            }
            df.process(warm);
        }
        port.onmessage = (ev: MessageEvent) => onHop(port, ev.data as { seq: number; buf: ArrayBuffer });
        self.postMessage({ type: 'ready', hop: df.hop_size, delayHops: df.delay_hops });
    } catch (err) {
        self.postMessage({ type: 'error', message: String(err) });
    }
};
