/**
 * DeepFilterNet (DFN3) noise suppression — the "max quality" tier.
 *
 * Second architecture. The first ran the DFN3 wasm on the MAIN thread inside a
 * ScriptProcessorNode; whenever React/GC/WebRTC stalled the thread past the
 * buffer deadline the browser zero-filled the output BEFORE our callback ran,
 * which no in-callback fallback can mask — that was the audible crackle, and
 * it is why the tier shipped disabled from 0.5.76 until this rewrite.
 *
 * Now the pipeline never touches the main thread:
 *
 *   mic → AudioWorklet (framing + time-aligned fallback + declick, dfWorklet.js)
 *           ⇅ MessagePort (hops as transferred ArrayBuffers, ping-ponged)
 *         Worker (DFN3 wasm inference, dfWorker.ts)
 *
 * The worklet and Worker talk DIRECTLY over a MessageChannel — no SharedArray-
 * Buffer, so no COEP/cross-origin isolation, which is the constraint that
 * ruled out the classic SAB design (COEP would break remote image embeds).
 * Main-thread stalls are structurally irrelevant: the audio thread only frames
 * and buffers, the Worker only infers, and if the Worker ever falls behind the
 * worklet emits the SAME time-aligned samples from its raw delay line instead
 * (crossfaded, no time jump), then flags sustained overload so the UI can
 * downgrade the mode. End-to-end added latency is 60 ms — the model's own
 * 30 ms (STFT framing + lookahead) plus a 30 ms framing/round-trip budget —
 * vs ~170 ms for the old design. (Through 0.8.87 this comment said "~30 ms":
 * the model delay was real but unaccounted for, which also mis-aligned the
 * raw fallback by 30 ms. See LATENCY below.)
 *
 * The wasm module (~14 MB, embedded model) is fetched only when someone
 * actually selects DeepFilter — which is itself gated behind Settings →
 * Advanced → Experimental.
 */
import workletUrl from './dfWorklet.js?url';
import type { DfTuning } from './dfTuning';

export type DeepFilterNodes = {
    source: MediaStreamAudioSourceNode;
    worklet: AudioNode & { destroy?: () => void };
    /** Mic gain stage (Input Volume × Manual Gain), post-suppressor. */
    gain: GainNode;
    destination: MediaStreamAudioDestinationNode;
};

// Emit-side delay, in hops, on top of the model's own algorithmic delay
// (reported by the Worker at handshake: 3 hops for DFN3, 0 for the bypass
// test path). A raw sample in hop k comes back enhanced with returned hop
// k + delayHops, which is sent once hop k + delayHops is COMPLETE (one more
// hop) and then needs the Worker round trip. So the emit latency is
//   (delayHops + 1 + RTT_SLACK_HOPS) × hop
// and RTT_SLACK_HOPS is the round-trip budget a hop has before its indices
// fall back to the aligned raw delay line. Field-measured inference is
// 1.5-3.5 ms avg / ≤6 ms max per hop with ~2 hops in flight, so 2 hops
// (20 ms) of slack keeps flips rare — it is exactly the slack the pre-0.8.88
// build had, once its unaccounted 30 ms model delay is netted out — and the
// total, 6 hops = 60 ms for the real model, is the same end-to-end delay that
// build actually had. In bypass (delayHops 0) this reproduces its 3-hop
// budget exactly, so e2e/deepfilter-verify.mjs's transport oracle holds.
const RTT_SLACK_HOPS = 2;
const latencySamples = (hop: number, delayHops: number) => (delayHops + 1 + RTT_SLACK_HOPS) * hop;
// First selection fetches ~14 MB of wasm and builds the tract graph; the old
// graph keeps transmitting during the wait (build-before-teardown in
// noiseFilter.ts), so patience beats a spurious RNNoise fallback. Sized for a
// slow first-use link (14 MB at 2-3 Mbps ≈ 40-55 s); cached loads take ~200 ms.
const READY_TIMEOUT_MS = 60000;

/** Latest pipeline telemetry, for __pucaVoiceDiag() via noiseFilter. */
let lastWorkletStats: Record<string, unknown> | null = null;
let lastWorkerStats: Record<string, unknown> | null = null;

export function deepFilterDiagnostics(): Record<string, unknown> {
    return { worklet: lastWorkletStats, worker: lastWorkerStats, captureAvailable: liveWorker !== null };
}

/** The Worker of the graph currently live (null between graphs). */
let liveWorker: Worker | null = null;
let pendingCapture: ((c: DeepFilterCapture | null) => void) | null = null;

export type DeepFilterCapture = {
    sampleRate: number;
    hop: number;
    hops: number;
    delayHops: number;
    /** What the mic delivered to the model, oldest first (pre level-gain). */
    raw: Float32Array;
    /** The enhanced output, aligned sample-for-sample with `raw`; the last
     *  `delayHops` hops are zero (their input is still inside the model). */
    enh: Float32Array;
};

/**
 * The last ~30 s of raw mic and aligned enhanced output from the live
 * DeepFilter Worker (see dfWorker.ts FIELD CAPTURE) — a report can be a
 * recording instead of an adjective. Resolves null when no DeepFilter graph is
 * live or the Worker does not answer within 5 s.
 */
export function captureDeepFilter(): Promise<DeepFilterCapture | null> {
    const w = liveWorker;
    if (!w) return Promise.resolve(null);
    return new Promise((resolve) => {
        // A second call while one is pending supersedes it: the superseded
        // promise settles null from its own timer (never orphaned), and only
        // the newest resolver receives the Worker's reply.
        const timer = setTimeout(() => { if (pendingCapture === done) pendingCapture = null; resolve(null); }, 5000);
        const done = (c: DeepFilterCapture | null) => { clearTimeout(timer); resolve(c); };
        pendingCapture = done;
        w.postMessage({ type: 'capture' });
    });
}

/** 16-bit PCM mono WAV of a float signal (clipped to ±1). */
export function encodeWav16(samples: Float32Array, sampleRate: number): Blob {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
    return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Whether DeepFilterNet can run here: Web Audio with AudioWorklet plus module
 * Workers — every modern browser/WebView2/Android WebView has both; the vitest
 * node env has neither. Fetching/instantiating the wasm is deferred to
 * `applyDeepFilter`; if it fails there, the caller falls back to RNNoise.
 */
export async function isDeepFilterAvailable(): Promise<boolean> {
    return typeof window !== 'undefined'
        && typeof window.AudioContext !== 'undefined'
        && typeof window.AudioWorkletNode !== 'undefined'
        && typeof window.Worker !== 'undefined';
}

/**
 * Spawn the inference Worker, hand it the worklet-facing port, and wait for
 * its ready/error handshake. The init message (with the port) must be posted
 * BEFORE waiting: the worker only starts fetching the wasm when it has the
 * port to eventually serve. Messages posted before the worker script has
 * evaluated are queued by the port machinery, so there is no race.
 */
function startWorker(
    hopPort: MessagePort,
    bypassInference?: boolean,
    tuning?: DfTuning,
): Promise<{ worker: Worker; hop: number; delayHops: number }> {
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./dfWorker.ts', import.meta.url), { type: 'module' });
        worker.postMessage({ type: 'init', port: hopPort, bypassInference, tuning }, [hopPort]);
        const timer = setTimeout(() => {
            worker.terminate();
            reject(new Error('DeepFilter worker init timed out'));
        }, READY_TIMEOUT_MS);
        worker.onmessage = (e: MessageEvent) => {
            const d = e.data as { type?: string; hop?: number; delayHops?: number; message?: string };
            if (d?.type === 'ready' && typeof d.hop === 'number' && typeof d.delayHops === 'number') {
                clearTimeout(timer);
                worker.onmessage = null;
                resolve({ worker, hop: d.hop, delayHops: d.delayHops });
            } else if (d?.type === 'error') {
                clearTimeout(timer);
                worker.terminate();
                reject(new Error('DeepFilter wasm init failed: ' + d.message));
            }
        };
        worker.onerror = (e: ErrorEvent) => {
            clearTimeout(timer);
            worker.terminate();
            reject(new Error('DeepFilter worker failed to start: ' + e.message));
        };
    });
}

/**
 * Build the DeepFilterNet processing graph:
 *   mic source → df worklet (⇄ inference Worker) → gain → MediaStreamDestination
 * Throws if the Worker/wasm/worklet can't initialise (caller falls back to
 * RNNoise). The returned worklet node's destroy() releases the Worker.
 */
export async function applyDeepFilter(
    ctx: AudioContext,
    input: MediaStream,
    initialGain = 1,
    opts?: {
        // TEST HARNESS ONLY: bypassInference makes the Worker echo hops
        // unenhanced so e2e/deepfilter-verify.mjs can prove the transport
        // sample-exact. Never set on a user path — see the note in dfWorker.ts.
        bypassInference?: boolean;
        // Is this graph still the live one? A graph that has been replaced
        // (build-before-teardown keeps it RUNNING during its successor's
        // build) must not dispatch noise-graph-dead: the handler would read
        // the CURRENT mode and downgrade the tier the user just picked, with
        // a false diagnosis. noiseFilter passes a generation check here.
        stillCurrent?: () => boolean;
        // Model runtime-knob override (the opt-in post filter; df-longrun.mjs
        // A/B sweeps). Merged over DEFAULT_TUNING in the worker.
        tuning?: DfTuning;
        // A PRIVATE graph (the Settings mic test): its death is reported to
        // this callback instead of the global 'sovereign:noise-graph-dead'
        // event (which would downgrade the LIVE CALL's mode), and it never
        // registers as the worker __pucaDfCapture() records from.
        local?: { onDead: (why: string) => void };
    },
): Promise<DeepFilterNodes> {
    // A suspended context transmits permanent silence — resume, and if autoplay
    // policy wants a gesture, retry on the next interaction (same guard as
    // every other AudioContext creation site).
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch { /* retried below */ } }
    if (ctx.state === 'suspended') {
        const retry = () => { ctx.resume().catch(() => { /* closed */ }); };
        window.addEventListener('pointerdown', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
    }

    // Wire the worklet to the Worker directly — hops never cross the main
    // thread. port1 goes to the Worker at spawn; port2 to the worklet below.
    const channel = new MessageChannel();
    const { worker, hop, delayHops } = await startWorker(channel.port1, opts?.bypassInference, opts?.tuning);
    const latency = latencySamples(hop, delayHops);
    // From here to return, ANY throw must release the Worker — the caller only
    // knows how to fall back to RNNoise, not that a thread is still running.
    let source: MediaStreamAudioSourceNode;
    let node: AudioWorkletNode;
    let gain: GainNode;
    let destination: MediaStreamAudioDestinationNode;
    try {
        await ctx.audioWorklet.addModule(workletUrl);

        // The call's telemetry (read by __pucaVoiceDiag): a private
        // mic-test graph must neither reset nor overwrite it.
        if (!opts?.local) {
            lastWorkletStats = null;
            lastWorkerStats = null;
        }

        source = ctx.createMediaStreamSource(input);
        // Mono end to end: Chromium can deliver a 2-channel mic track
        // regardless of the channelCount:1 constraint, and LiveKit would
        // negotiate stereo Opus for an inherently mono voice track (see the
        // same fix in noiseFilter.ts).
        node = new AudioWorkletNode(ctx, 'sovereign-df-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
        });
        gain = ctx.createGain();
        gain.gain.value = initialGain;
        gain.channelCount = 1;
        gain.channelCountMode = 'explicit';
        destination = ctx.createMediaStreamDestination();
        destination.channelCount = 1;

        node.port.postMessage(
            { type: 'init', hop, latency, modelDelay: hop * delayHops, port: channel.port2 },
            [channel.port2],
        );
    } catch (err) {
        worker.terminate();
        throw err;
    }

    // A dead/overloaded pipeline must be REPORTED, not silently dry: the
    // worklet's raw fallback keeps the mic transmitting either way, but the
    // user chose this tier for the suppression, so let the UI downgrade.
    let alive = true;
    const reportDead = (why: string) => {
        if (!alive) return;
        alive = false;
        if (opts?.local) {
            console.warn('[DeepFilter] private graph: ' + why);
            opts.local.onDead(why);
            return;
        }
        if (opts?.stillCurrent && !opts.stillCurrent()) {
            // Replaced graph dying during its successor's build — expected
            // (that's often WHY the user switched); log, don't downgrade.
            console.warn('[DeepFilter] stale graph: ' + why + ' — ignored (already replaced)');
            return;
        }
        console.error('[DeepFilter] ' + why + ' — requesting mode fallback');
        window.dispatchEvent(new CustomEvent('sovereign:noise-graph-dead'));
    };
    node.port.onmessage = (e: MessageEvent) => {
        const d = e.data as { type?: string; stats?: Record<string, unknown> };
        if (d?.type === 'stats' && d.stats) { if (!opts?.local) lastWorkletStats = d.stats; }
        else if (d?.type === 'overloaded') {
            if (!opts?.local) lastWorkletStats = d.stats ?? lastWorkletStats;
            reportDead('inference cannot keep up on this device (worker ~500 ms behind)');
        }
    };
    worker.onmessage = (e: MessageEvent) => {
        const d = e.data as {
            type?: string; avgMs?: number; maxMs?: number; hops?: number;
            levelGain?: number; levelEnv?: number;
            overBudgetHops?: number; clampedHops?: number;
            maxGainStepPct?: number; dryHops?: number;
            nearSilentHops?: number; seamHops?: number; maxSeamRatio?: number;
            regimeZero?: number; regimePass?: number; regimeMask?: number;
            regimeFull?: number; lsnrAvg?: number;
            sampleRate?: number; hop?: number; delayHops?: number;
            raw?: Float32Array; enh?: Float32Array;
        };
        if (d?.type === 'capture') {
            const cb = pendingCapture;
            pendingCapture = null;
            if (cb && d.raw && d.enh) {
                cb({
                    sampleRate: d.sampleRate ?? 48000, hop: d.hop ?? 480, hops: d.hops ?? 0,
                    delayHops: d.delayHops ?? 0, raw: d.raw, enh: d.enh,
                });
            } else cb?.(null);
            return;
        }
        if (d?.type === 'stats') {
            if (opts?.local) return; // private graph: not the call's telemetry
            lastWorkerStats = {
                avgMs: d.avgMs, maxMs: d.maxMs, hops: d.hops,
                levelGain: d.levelGain, levelEnv: d.levelEnv,
                // Crackle diag (per ~2s window; see dfWorker.ts counter block):
                // capture WHILE it crackles — overBudgetHops>0 points at
                // inference starvation (check worklet flipsDelta beside it),
                // clampedHops/maxGainStepPct at the un-slewed peak guard,
                // dryHops (cumulative) at process() failures shipping raw.
                overBudgetHops: d.overBudgetHops, clampedHops: d.clampedHops,
                maxGainStepPct: d.maxGainStepPct, dryHops: d.dryHops,
                // Round 2: nearSilentHops = hops the near-silence floor had to
                // catch (digital silence from the mic); seamHops/maxSeamRatio
                // say a step discontinuity reached the output whatever the
                // cause. These MUST be forwarded explicitly — a field this
                // destructure omits is silently undefined downstream.
                nearSilentHops: d.nearSilentHops, seamHops: d.seamHops,
                maxSeamRatio: d.maxSeamRatio,
                // Processing regimes per window (dfWorker.ts): production
                // tuning never skips a stage, so zero/pass/mask must be 0 and
                // regimeFull == the window's hop count; lsnrAvg is the model's
                // own read of how clean the mic is (dB, clamped to [-15, 35]).
                regimeZero: d.regimeZero, regimePass: d.regimePass,
                regimeMask: d.regimeMask, regimeFull: d.regimeFull,
                lsnrAvg: d.lsnrAvg,
            };
        }
    };
    worker.onerror = (e: ErrorEvent) => reportDead('inference worker crashed: ' + e.message);
    // A throw inside DfProcessor.process() makes the browser permanently
    // disable the processor — the node then emits pure silence and, because
    // process() no longer runs, neither the overload latch nor stats can ever
    // fire again. This is the only detector for that death. (Same guard as the
    // RNNoise node in noiseFilter.ts.)
    node.onprocessorerror = () => reportDead('worklet processor crashed — output would be silence');

    source.connect(node);
    node.connect(gain);
    gain.connect(destination);
    // Only the CALL's graph is what __pucaDfCapture() records from; a
    // private mic-test graph must not displace it.
    if (!opts?.local) liveWorker = worker;

    const worklet = node as AudioNode & { destroy?: () => void };
    // cleanupNoiseFilter() calls destroy() before disconnecting.
    worklet.destroy = () => {
        alive = false; // a torn-down graph must not request a mode fallback
        if (liveWorker === worker) liveWorker = null;
        try { node.port.postMessage({ type: 'stop' }); } catch { /* context closed */ }
        worker.terminate();
    };
    console.log('[DeepFilter] pipeline up: hop', hop, '- model delay', hop * delayHops, '- emit latency', latency, 'samples');
    return { source, worklet, gain, destination };
}
