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
 * THE RNNOISE BRIDGE. The fallback used to be the raw mic, so a CPU spike
 * that starved the Worker sent the room unsuppressed noise until it caught
 * up. Input 1 now carries an RNNoise rendering of the same source
 * (deepFilter.ts builds it), placed on the same clock in a third ring. The
 * fallback prefers it, and falls to raw only where RNNoise was not producing
 * anything: before its wasm loads and after it crashes, it emits exact zeros.
 * A spike therefore swaps the suppressor for its duration and swaps back, per
 * sample, with no track change and no rebuild of the mic. (The room hears
 * RNNoise's character for those moments instead of unsuppressed noise.)
 *
 * OVERLOAD IS AN EPISODE, NOT A VERDICT. A Worker ~500 ms behind starts an
 * episode, and one that has stayed caught up for a second ends it. The
 * wrapper reports both edges; the main thread decides whether DeepFilter is
 * still worth running for this call (deepFilter.ts). Through 0.9.815 the
 * first episode was a one-shot latch that tore the graph down and rebuilt
 * the mic on RNNoise for the rest of the session, which made one spike
 * permanent.
 *
 * PAUSE, WHEN NOBODY CAN HEAR (2026-10-04). DFN3 inference is a core-fifth of
 * a desktop CPU on every 10 ms hop, and it used to run while the user was
 * muted, waiting on push-to-talk, or alone in the call. The main thread
 * (dfPause.ts) now pauses this core then: no hops are sent, so the Worker
 * sleeps, and the output is the bridge - the same fallback a CPU spike gets,
 * so whatever still reads the track (the speaking ring, a clip) keeps working.
 * Resuming re-feeds the model RESUME_PREROLL_HOPS of real audio from the raw
 * ring and never emits its first answers on that stretch: a model stopped
 * mid-stream still holds the last pre-pause hops in its lookahead (its first
 * answers after a resume are pre-pause audio) and its recurrent state
 * describes the room as it was. The bridge carries the call until DeepFilter
 * has answers for the instant on air, then the usual declicked switch hands
 * it back. Unlike standby this is reversible, and the Worker stays alive.
 * What a resumed model sounds like is measured in e2e/df-resume-offline.mjs:
 * no transient, the talker's level within ~1 dB, no extra noise or warble,
 * and converged on the never-paused model within 1-2 s.
 *
 * This file is loaded raw via `?url` + `audioWorklet.addModule`, so it must
 * stay dependency-free. The state machine is exported (and `registerProcessor`
 * guarded) so vitest can drive it deterministically off the audio thread.
 */

const FADE = 128; // declick ramp length in samples (~2.7 ms @ 48 kHz)
const RING = 32768; // per-ring history, power of two (~0.68 s @ 48 kHz)
const RMASK = RING - 1;
// Hops in flight (sent, not yet returned) that mean the Worker can't keep up
// (or died): ~500 ms of backlog. That starts an overload EPISODE. The audio
// never waits for it (anything past the round-trip budget is already coming
// from the fallback); it is the main thread's cue to weigh the call's options.
const OVERLOAD_OUTSTANDING = 50;
// The episode ends once the Worker has stayed caught up (at most this many
// hops in flight; ~1-2 is normal) for RECOVER_HOLD_SAMPLES in a row: one
// second at the 48 kHz every DeepFilter context runs at. The hold keeps a
// backlog that drains in bursts from ending and restarting episodes.
const RECOVERED_OUTSTANDING = 4;
const RECOVER_HOLD_SAMPLES = 48000;
// The RNNoise worklet's own 1920-sample ring: for its first ~40 ms after
// loading, its output still mixes in the zeros it started with.
const BRIDGE_WARMUP = 1920;
// Hops of REAL audio re-fed to the model when it resumes after a pause, taken
// from the raw ring (the instants just before the resume). Everything they
// produce lands before the emit position (the emit latency is 6 hops,
// deepFilter.ts), so this is how long the model re-adapts before anything it
// says is heard: 16 gives it 10 hops (100 ms) of the room as it is now. A
// pause no longer than this needs nothing: the model just continues. Longer
// buys little (e2e/df-resume-offline.mjs, 2026-10-04: 64 hops is 1-3 dB
// closer to the clean speech for the first ~600 ms, the talker's level the
// same within 0.2 dB) and costs a longer RNNoise stretch after every resume
// (the whole pre-roll is inferred before the model reaches "now") - and must
// stay well under OVERLOAD_OUTSTANDING, since it is all sent at once.
const RESUME_PREROLL_HOPS = 16;

// Emit sources, for flip detection.
const SRC_SILENT = 0;
const SRC_PROCESSED = 1;
const SRC_DRY = 2;
const SRC_BRIDGE = 3;

export class DfCore {
    /**
     * @param {number} hop      samples per inference hop (480 @ 48 kHz)
     * @param {number} latency  emit delay in samples — must cover the model
     *                          delay plus the hop framing plus the Worker
     *                          round trip, or indices fall back to the raw
     *                          delay line (deepFilter.ts sizes it)
     * @param {(hop: Float32Array, fresh: boolean) => void} sendHop  called with
     *                          a SCRATCH view valid only during the call — copy
     *                          it out. `fresh` marks the first hop of a stretch
     *                          that does not continue the previous one (the
     *                          pre-roll after a long pause): the Worker's seam
     *                          detector must not read that jump as a seam.
     * @param {number} modelDelay  samples by which each returned hop TRAILS
     *                          the hop it answers (DFN3: 3 hops = 1440; the
     *                          bypass-inference test path: 0). Reported by the
     *                          Worker at handshake from the model itself.
     * @param {number|null} bridgeDelay  samples by which the bridge input
     *                          (input 1, an RNNoise rendering of the same
     *                          source) TRAILS the raw input: 992 for the
     *                          RNNoise worklet deepFilter.ts builds. null = no
     *                          bridge, and the fallback is raw, as it was.
     * @param {number} prerollHops  hops re-fed on a resume after a long pause
     *                          (RESUME_PREROLL_HOPS; tests vary it).
     */
    constructor(hop, latency, sendHop, modelDelay = 0, bridgeDelay = null, prerollHops = RESUME_PREROLL_HOPS) {
        this.hop = hop;
        this.prerollHops = prerollHops;
        this.latency = latency;
        this.sendHop = sendHop;
        this.modelDelay = modelDelay;

        this.raw = new Float32Array(RING);
        this.enh = new Float32Array(RING);
        this.hopScratch = new Float32Array(hop);

        // The bridge ring holds input 1 at the SAME index as raw, so the
        // rendering of timeline index e sits at e + bridgeDelay. It is usable
        // only between its first live sample (plus the RNNoise warm-up) and
        // its LAST non-zero one: a worklet that has not loaded, or has
        // crashed, emits exact zeros, and speech or room noise through a live
        // one does not stay at exactly zero.
        this.bridgeDelay = bridgeDelay;
        this.bridge = bridgeDelay === null ? null : new Float32Array(RING);
        this.bridgeFirst = -1;
        this.bridgeLast = -1;

        this.inPos = 0; // input samples consumed == output samples emitted
        this.sentPos = 0; // start index of the next hop to send
        // Enhanced timeline covers [enhLow, enhHigh). enhHigh starts NEGATIVE
        // by the model delay: the first returned hops answer pre-stream
        // (zero-state) input. enhLow moves only at a resume (see resume()).
        this.enhHigh = -modelDelay;
        this.enhLow = 0;
        // Answers still owed for hops sent before the last resume: they
        // belong to a timeline the resume abandoned, and are dropped on
        // arrival (the port is FIFO, so they are exactly the next ones).
        this.staleReturns = 0;

        this.source = SRC_SILENT;
        this.carry = 0; // last emitted sample (ramp anchor)
        this.fadePos = FADE; // FADE => no ramp in progress
        this.fadeFrom = 0;

        this.hopsSent = 0;
        this.hopsReceived = 0;
        this.workerDryHops = 0; // hops the Worker returned unprocessed (df error)
        this.processedSamples = 0;
        this.drySamples = 0; // emitted from the raw delay line after startup
        this.bridgeSamples = 0; // emitted from the RNNoise bridge
        this.silentSamples = 0; // startup lead-in (e < 0)
        this.emittedSamples = 0;
        this.flips = 0; // source changes (each one = one declick ramp)
        this.overloaded = false; // an overload episode is in progress
        this.overloadEpisodes = 0;
        this.caughtUpSince = -1; // timeline position the Worker caught up at
        // Standby: the main thread gave up on DeepFilter for this graph and
        // terminated the Worker. No more hops are sent, and everything from
        // here is fallback (the bridge, where it is live).
        this.standby = false;
        // Paused: nobody can hear this mic right now (dfPause.ts), so no hops
        // are sent and the Worker sleeps; the bridge carries the output.
        // Reversible, unlike standby: resume() hands back to DeepFilter.
        this.paused = false;
        this.pauses = 0;
        this.resumes = 0;
        this.pausedSamples = 0; // emitted while paused
        // Timeline position of the last resume until the first processed
        // sample after it is emitted (-1 otherwise), and how many samples the
        // bridge covered in between: the resume's cost, in time.
        this.resumeAt = -1;
        this.lastResumeCover = -1;
        this.freshNext = false; // the next hop sent starts a new stretch
        // Raw samples carrying sound emitted while the bridge was supposed to
        // be carrying the call: during an overload episode, after standby, or
        // while paused. Live RNNoise never emits exact zeros for a non-silent
        // mic, so a run of these means it has died or never loaded. (Digital
        // silence in gives zeros out of both, and is not counted: s === 0
        // there. Its warm-up can leak at most BRIDGE_WARMUP of them.)
        this.rawUncovered = 0;
    }

    enterStandby() {
        this.standby = true;
    }

    /** Stop feeding the Worker: nobody can hear this mic. Hops already in
     *  flight still land (they are the true continuation); after them the
     *  bridge carries the output. A no-op in standby or when already paused.
     *  Returns whether anything changed. */
    pause() {
        if (this.standby || this.paused) return false;
        this.paused = true;
        this.pauses++;
        // Paused again before DeepFilter came back: that resume never ended.
        if (this.resumeAt >= 0) this.lastResumeCover = -1;
        this.resumeAt = -1;
        return true;
    }

    /**
     * Feed the Worker again. A pause shorter than the pre-roll is simply
     * continued: the hops the model missed are still in the raw ring and go
     * out on the next quantum, contiguous with what it last saw. A longer one
     * starts a fresh stretch of the timeline the pre-roll back from now, drops
     * every answer still in flight from before, and refuses the model's first
     * answers on the new stretch: they are its pre-pause LOOKAHEAD (the last
     * hops it saw before the pause, placed on the instants just after the
     * jump) and the frame that overlap-adds onto one (a seam). With the
     * pre-roll at its length all of that lands before the emit position
     * anyway; the guard keeps it so at any length. Until a fresh answer
     * arrives the bridge keeps carrying the call, exactly as through a CPU
     * spike. Returns whether anything changed.
     */
    resume() {
        if (this.standby || !this.paused) return false;
        this.paused = false;
        this.resumes++;
        const preroll = this.prerollHops * this.hop;
        if (this.inPos - this.sentPos > preroll) {
            // Everything in flight answers the abandoned stretch.
            this.staleReturns = this.hopsSent - this.hopsReceived;
            this.sentPos = this.inPos - preroll;
            this.enhHigh = this.sentPos - this.modelDelay;
            // Answers landing below sentPos are the lookahead the model held
            // at the pause (pre-pause audio on post-pause instants); the hop
            // at sentPos overlap-adds onto a pre-pause frame. Neither may ever
            // be emitted, nor the model's own delay's worth of warm-up after.
            this.enhLow = this.sentPos + this.hop + this.modelDelay;
            this.freshNext = true;
        }
        this.resumeAt = this.inPos;
        return true;
    }

    /** The bridge was meant to be covering, and the raw mic has been on air
     *  instead for ~100 ms (48 kHz): the main thread must fall back for real. */
    bridgeFailed() {
        return this.bridge !== null && this.rawUncovered >= 4800;
    }

    /** Whether the mic carried sound in the 100 ms the bridge has had time to
     *  render: the window bridgeLive looks at, shifted back by the bridge's
     *  own latency. (The same window unshifted reads a sound onset as a dead
     *  bridge for the 20 ms before RNNoise's output reaches it.) Scans the
     *  ring, so it is for stats(), not per sample. */
    inputLiveForBridge() {
        const end = this.inPos - (this.bridgeDelay ?? 0);
        for (let i = Math.max(0, end - 4800); i < end; i++) {
            if (this.raw[i & RMASK] !== 0) return true;
        }
        return false;
    }

    /**
     * Enhanced hop back from the Worker (FIFO ⇒ contiguous timeline). Lands
     * `modelDelay` samples behind the hop it answers; the model's warm-up
     * output (before enhLow: negative indices at the start, the resume
     * warm-up after a pause) is dropped, and so is an answer to a hop sent
     * before the last resume.
     */
    onEnhanced(samples, workerDry) {
        this.hopsReceived++;
        if (this.staleReturns > 0) {
            this.staleReturns--;
            return;
        }
        if (workerDry) this.workerDryHops++;
        for (let j = 0; j < samples.length; j++) {
            const idx = this.enhHigh + j;
            if (idx >= this.enhLow) this.enh[idx & RMASK] = samples[j];
        }
        this.enhHigh += samples.length;
    }

    /**
     * Consume one input quantum, produce one output quantum (equal length).
     * `input` may be null when the source is disconnected — treated as zeros
     * so the timeline (and the enhanced stream behind it) keeps advancing.
     * `bridgeInput` is input 1 (the RNNoise rendering), null when absent.
     */
    processQuantum(input, output, bridgeInput = null) {
        const n = output.length;
        // 1) Input (and the bridge beside it) onto the timeline.
        for (let i = 0; i < n; i++) {
            this.raw[(this.inPos + i) & RMASK] = input ? input[i] : 0;
        }
        if (this.bridge !== null) {
            for (let i = 0; i < n; i++) {
                const v = bridgeInput ? bridgeInput[i] : 0;
                this.bridge[(this.inPos + i) & RMASK] = v;
                if (v !== 0) {
                    if (this.bridgeFirst < 0) this.bridgeFirst = this.inPos + i;
                    this.bridgeLast = this.inPos + i;
                }
            }
        }
        this.inPos += n;

        // 2) Ship every completed hop (at 128-sample quanta and hop 480, at
        // most one completes per call, but stay general; the first quantum
        // after a resume sends the whole pre-roll). None in standby: nobody
        // is listening, and a queue nobody drains only grows. None while
        // paused: that is the point of pausing.
        while (!this.standby && !this.paused && this.inPos - this.sentPos >= this.hop) {
            const start = this.sentPos;
            for (let j = 0; j < this.hop; j++) {
                this.hopScratch[j] = this.raw[(start + j) & RMASK];
            }
            this.sentPos += this.hop;
            this.hopsSent++;
            const fresh = this.freshNext;
            this.freshNext = false;
            this.sendHop(this.hopScratch, fresh);
        }
        const outstanding = this.hopsSent - this.hopsReceived;
        if (!this.overloaded) {
            if (outstanding >= OVERLOAD_OUTSTANDING) {
                this.overloaded = true;
                this.overloadEpisodes++;
                this.caughtUpSince = -1;
            }
        } else if (!this.standby) {
            if (outstanding > RECOVERED_OUTSTANDING) {
                this.caughtUpSince = -1;
            } else if (this.caughtUpSince < 0) {
                this.caughtUpSince = this.inPos;
            } else if (this.inPos - this.caughtUpSince >= RECOVER_HOLD_SAMPLES) {
                this.overloaded = false;
                this.caughtUpSince = -1;
            }
        }

        // 3) Emit the delayed timeline: enhanced where available, else the
        // bridge where RNNoise was live for that instant, else raw. Every
        // source change is declicked.
        for (let i = 0; i < n; i++) {
            const e = this.inPos - n + i - this.latency;
            let src;
            let s;
            if (e < 0) {
                src = SRC_SILENT;
                s = 0;
            } else if (e >= this.enhLow && e < this.enhHigh) {
                src = SRC_PROCESSED;
                s = this.enh[e & RMASK];
                if (this.resumeAt >= 0) {
                    // First DeepFilter sample since the resume.
                    this.lastResumeCover = this.inPos - n + i - this.resumeAt;
                    this.resumeAt = -1;
                }
            } else if (
                this.bridge !== null
                && this.bridgeFirst >= 0
                && e + this.bridgeDelay >= this.bridgeFirst + BRIDGE_WARMUP
                && e + this.bridgeDelay <= this.bridgeLast
            ) {
                src = SRC_BRIDGE;
                s = this.bridge[(e + this.bridgeDelay) & RMASK];
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
            else if (src === SRC_BRIDGE) this.bridgeSamples++;
            else {
                this.drySamples++;
                if ((this.overloaded || this.standby || this.paused) && s !== 0) this.rawUncovered++;
            }
            if (this.paused) this.pausedSamples++;
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
            bridgeSamples: this.bridgeSamples,
            silentSamples: this.silentSamples,
            flips: this.flips,
            overloaded: this.overloaded,
            overloadEpisodes: this.overloadEpisodes,
            standby: this.standby,
            paused: this.paused,
            pauses: this.pauses,
            resumes: this.resumes,
            pausedSamples: this.pausedSamples,
            // Samples the bridge carried between the last resume and the first
            // DeepFilter sample after it (-1: none yet).
            lastResumeCover: this.lastResumeCover,
            rawUncovered: this.rawUncovered,
            // null = no bridge built; otherwise whether RNNoise produced
            // anything in the last 100 ms (48 kHz).
            bridgeLive: this.bridge === null ? null : this.bridgeLast >= this.inPos - 4800,
            // ...and whether the mic did, over the window the bridge has
            // rendered (a digitally silent mic gives a silent bridge that is
            // not broken).
            inputLive: this.inputLiveForBridge(),
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
            this.wasOverloaded = false; // edge detector for episode reports
            this.bridgeFailSent = false;
            this.resumesReported = 0; // resumes whose outcome was posted
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
                this.core = new DfCore(msg.hop, msg.latency, (hopView, fresh) => {
                    const buf = this.pool.pop() ?? new ArrayBuffer(hopView.length * 4);
                    new Float32Array(buf).set(hopView);
                    this.workerPort.postMessage({ seq: this.seq++, buf, fresh }, [buf]);
                }, msg.modelDelay ?? 0, msg.bridgeDelay ?? null);
            } else if (msg?.type === 'pause') {
                // Nobody can hear this mic (dfPause.ts): stop feeding the
                // Worker; the bridge carries the output until 'resume'.
                this.core?.pause();
            } else if (msg?.type === 'resume') {
                this.core?.resume();
            } else if (msg?.type === 'standby') {
                // The Worker is being terminated: stop feeding it, keep
                // emitting (the bridge carries the call from here).
                this.core?.enterStandby();
                try { this.workerPort?.close(); } catch { /* already closed */ }
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
            const bridge = inputs[1]?.[0] ?? null; // RNNoise, when connected
            this.core.processQuantum(input, output, bridge);

            // Both edges of every episode, so the main thread can tell a spike
            // (it ends) from a DeepFilter that has stopped keeping up at all.
            if (this.core.overloaded !== this.wasOverloaded) {
                this.wasOverloaded = this.core.overloaded;
                this.port.postMessage({
                    type: this.core.overloaded ? 'overloaded' : 'recovered',
                    episode: this.core.overloadEpisodes,
                    stats: this.core.stats(),
                });
            }
            // The bridge was meant to be carrying the call (an episode, or
            // standby) and the raw mic is on air instead: it never loaded, or
            // died since. Once, so the main thread can fall back for real.
            if (!this.bridgeFailSent && this.core.bridgeFailed()) {
                this.bridgeFailSent = true;
                this.port.postMessage({ type: 'bridge-failed', stats: this.core.stats() });
            }
            // A resume has ended (DeepFilter is on air again, or it was paused
            // again first: cover -1): say how long the bridge carried it.
            if (this.core.resumes > this.resumesReported && this.core.resumeAt < 0) {
                this.resumesReported = this.core.resumes;
                this.port.postMessage({ type: 'resumed', coverSamples: this.core.lastResumeCover });
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
