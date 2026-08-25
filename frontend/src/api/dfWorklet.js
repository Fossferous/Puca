/**
 * DeepFilterNet bridge — the AudioWorklet half.
 *
 * This processor does NO inference. It frames the mic into hops, ships them to
 * the inference Worker over a MessagePort (transferred in by the main thread),
 * and emits the enhanced stream the Worker sends back. The heavy DFN3 wasm
 * lives entirely in the Worker, so neither the main thread (React/GC — the
 * crackle source in the ScriptProcessor design this replaced) nor the audio
 * thread ever runs it.
 *
 * Single-timeline design: every input sample gets an index on ONE clock.
 *  - `raw`   ring: the input as captured, indexed by that clock.
 *  - `enh`   ring: the Worker's enhanced output, placed on the SAME clock. The
 *             model has an algorithmic delay: DFN3's process() for hop N
 *             returns the enhanced samples of hop N − 3 (one hop of STFT
 *             framing + two hops of lookahead = 1440 samples), so the N-th
 *             returned hop is written at [(N−3)*hop, (N−2)*hop) — `modelDelay`
 *             samples BEHIND the hop it answers — and the first three returned
 *             hops (the model's zero-state warm-up) land at negative indices
 *             and are dropped. The port is FIFO, so the enhanced timeline is
 *             contiguous by construction. (Through 0.8.87 the returned hop was
 *             written at N*hop: the enhanced stream sat 30 ms behind the raw
 *             one, so every fallback flip was a 30 ms time jump, and the
 *             end-to-end latency was 30 ms more than documented.)
 *  - Output sample at position p emits index e = p - latency: enhanced if the
 *    Worker has delivered that far, otherwise the RAW sample at the SAME index
 *    (a time-aligned delay line, not "whatever the mic carries right now").
 * Because both fallback and enhanced audio sit on one clock, an underrun swap
 * is a crossfade between two aligned renderings of the same instant — there is
 * no time jump, and the two streams structurally cannot drift, so the old
 * design's drift guard (and its audible splices) has nothing to guard.
 *
 * Every source flip is declicked with a short carry ramp (~2.7 ms), and the
 * dry path means the mic keeps transmitting even if the Worker dies outright.
 *
 * This file is loaded raw via `?url` + `audioWorklet.addModule`, so it must
 * stay dependency-free. The state machine is exported (and `registerProcessor`
 * guarded) so vitest can drive it deterministically off the audio thread.
 */

const FADE = 128; // declick ramp length in samples (~2.7 ms @ 48 kHz)
const RING = 32768; // per-ring history, power of two (~0.68 s @ 48 kHz)
const RMASK = RING - 1;
// Hops in flight (sent, not yet returned) that mean the Worker can't keep up
// (or died): ~500 ms of backlog. Latched — the wrapper notifies once and the
// UI downgrades the mode; the dry path keeps audio flowing meanwhile.
const OVERLOAD_OUTSTANDING = 50;

// Emit sources, for flip detection.
const SRC_SILENT = 0;
const SRC_PROCESSED = 1;
const SRC_DRY = 2;

export class DfCore {
    /**
     * @param {number} hop      samples per inference hop (480 @ 48 kHz)
     * @param {number} latency  emit delay in samples — must cover the model
     *                          delay plus the hop framing plus the Worker
     *                          round trip, or indices fall back to the raw
     *                          delay line (deepFilter.ts sizes it)
     * @param {(hop: Float32Array) => void} sendHop  called with a SCRATCH view
     *                          valid only during the call — copy it out
     * @param {number} modelDelay  samples by which each returned hop TRAILS
     *                          the hop it answers (DFN3: 3 hops = 1440; the
     *                          bypass-inference test path: 0). Reported by the
     *                          Worker at handshake from the model itself.
     */
    constructor(hop, latency, sendHop, modelDelay = 0) {
        this.hop = hop;
        this.latency = latency;
        this.sendHop = sendHop;
        this.modelDelay = modelDelay;

        this.raw = new Float32Array(RING);
        this.enh = new Float32Array(RING);
        this.hopScratch = new Float32Array(hop);

        this.inPos = 0; // input samples consumed == output samples emitted
        this.sentPos = 0; // start index of the next hop to send
        // Enhanced timeline covers [0, enhHigh). Starts NEGATIVE by the model
        // delay: the first returned hops answer pre-stream (zero-state) input.
        this.enhHigh = -modelDelay;

        this.source = SRC_SILENT;
        this.carry = 0; // last emitted sample (ramp anchor)
        this.fadePos = FADE; // FADE => no ramp in progress
        this.fadeFrom = 0;

        this.hopsSent = 0;
        this.hopsReceived = 0;
        this.workerDryHops = 0; // hops the Worker returned unprocessed (df error)
        this.processedSamples = 0;
        this.drySamples = 0; // emitted from the raw delay line after startup
        this.silentSamples = 0; // startup lead-in (e < 0)
        this.emittedSamples = 0;
        this.flips = 0; // source changes (each one = one declick ramp)
        this.overloaded = false;
    }

    /**
     * Enhanced hop back from the Worker (FIFO ⇒ contiguous timeline). Lands
     * `modelDelay` samples behind the hop it answers; the model's warm-up
     * output (negative indices) is dropped.
     */
    onEnhanced(samples, workerDry) {
        this.hopsReceived++;
        if (workerDry) this.workerDryHops++;
        for (let j = 0; j < samples.length; j++) {
            const idx = this.enhHigh + j;
            if (idx >= 0) this.enh[idx & RMASK] = samples[j];
        }
        this.enhHigh += samples.length;
    }

    /**
     * Consume one input quantum, produce one output quantum (equal length).
     * `input` may be null when the source is disconnected — treated as zeros
     * so the timeline (and the enhanced stream behind it) keeps advancing.
     */
    processQuantum(input, output) {
        const n = output.length;
        // 1) Input onto the raw timeline.
        for (let i = 0; i < n; i++) {
            this.raw[(this.inPos + i) & RMASK] = input ? input[i] : 0;
        }
        this.inPos += n;

        // 2) Ship every completed hop (at 128-sample quanta and hop 480, at
        // most one completes per call, but stay general).
        while (this.inPos - this.sentPos >= this.hop) {
            const start = this.sentPos;
            for (let j = 0; j < this.hop; j++) {
                this.hopScratch[j] = this.raw[(start + j) & RMASK];
            }
            this.sentPos += this.hop;
            this.hopsSent++;
            this.sendHop(this.hopScratch);
        }
        if (this.hopsSent - this.hopsReceived >= OVERLOAD_OUTSTANDING) {
            this.overloaded = true;
        }

        // 3) Emit the delayed timeline, enhanced where available, raw where
        // not, declicking every source change.
        for (let i = 0; i < n; i++) {
            const e = this.inPos - n + i - this.latency;
            let src;
            let s;
            if (e < 0) {
                src = SRC_SILENT;
                s = 0;
            } else if (e < this.enhHigh) {
                src = SRC_PROCESSED;
                s = this.enh[e & RMASK];
            } else {
                src = SRC_DRY;
                s = this.raw[e & RMASK];
            }
            if (src !== this.source) {
                this.source = src;
                this.fadePos = 0;
                this.fadeFrom = this.carry;
                this.flips++;
            }
            if (src === SRC_SILENT) this.silentSamples++;
            else if (src === SRC_PROCESSED) this.processedSamples++;
            else this.drySamples++;
            if (this.fadePos < FADE) {
                const t = ++this.fadePos / FADE;
                s = this.fadeFrom * (1 - t) + s * t;
            }
            output[i] = s;
            this.carry = s;
        }
        this.emittedSamples += n;
    }

    stats() {
        return {
            hopsSent: this.hopsSent,
            hopsReceived: this.hopsReceived,
            outstanding: this.hopsSent - this.hopsReceived,
            workerDryHops: this.workerDryHops,
            emittedSamples: this.emittedSamples,
            processedSamples: this.processedSamples,
            drySamples: this.drySamples,
            silentSamples: this.silentSamples,
            flips: this.flips,
            overloaded: this.overloaded,
        };
    }
}

// The wrapper below only exists on the audio thread; vitest imports DfCore.
if (typeof registerProcessor === 'function') {
    const STATS_INTERVAL_SAMPLES = 96000; // ~2 s @ 48 kHz

    class DfProcessor extends AudioWorkletProcessor {
        constructor() {
            super();
            this.core = null; // built when the init config arrives
            this.workerPort = null;
            this.stopped = false;
            this.pool = []; // recycled transfer buffers (ping-pong, no GC churn)
            this.seq = 0;
            this.overloadSent = false;
            this.sinceStats = 0;
            // Crackle diag: the cumulative counters answer "how bad has it
            // ever been"; catching it IN THE ACT needs per-window rates.
            // Every flip is one declick crossfade — an audible seam candidate
            // — so "flipsDelta jumped in the window where it crackled" is the
            // signature that distinguishes fallback churn from a model
            // artifact. Deltas live HERE so DfCore stays the pure, pinned
            // state machine.
            this.lastFlips = 0;
            this.lastDrySamples = 0;
            this.port.onmessage = (e) => this.onControl(e.data);
        }

        onControl(msg) {
            if (msg?.type === 'init') {
                this.workerPort = msg.port;
                this.workerPort.onmessage = (e) => {
                    const d = e.data;
                    if (this.core && d?.buf) {
                        this.core.onEnhanced(new Float32Array(d.buf), d.dry === true);
                        if (this.pool.length < 8) this.pool.push(d.buf);
                    }
                };
                this.core = new DfCore(msg.hop, msg.latency, (hopView) => {
                    const buf = this.pool.pop() ?? new ArrayBuffer(hopView.length * 4);
                    new Float32Array(buf).set(hopView);
                    this.workerPort.postMessage({ seq: this.seq++, buf }, [buf]);
                }, msg.modelDelay ?? 0);
            } else if (msg?.type === 'stop') {
                this.stopped = true;
                try { this.workerPort?.close(); } catch { /* already closed */ }
            }
        }

        process(inputs, outputs) {
            if (this.stopped) return false;
            const output = outputs[0]?.[0];
            if (!output) return true;
            if (!this.core) {
                // Config not here yet (it arrives within the first quanta):
                // silence, and don't start the timeline early.
                output.fill(0);
                return true;
            }
            const input = inputs[0]?.[0] ?? null;
            this.core.processQuantum(input, output);

            if (this.core.overloaded && !this.overloadSent) {
                this.overloadSent = true;
                this.port.postMessage({ type: 'overloaded', stats: this.core.stats() });
            }
            this.sinceStats += output.length;
            if (this.sinceStats >= STATS_INTERVAL_SAMPLES) {
                this.sinceStats = 0;
                const stats = this.core.stats();
                stats.flipsDelta = stats.flips - this.lastFlips;
                stats.dryDelta = stats.drySamples - this.lastDrySamples;
                this.lastFlips = stats.flips;
                this.lastDrySamples = stats.drySamples;
                this.port.postMessage({ type: 'stats', stats });
            }
            return true;
        }
    }

    registerProcessor('sovereign-df-processor', DfProcessor);
}
