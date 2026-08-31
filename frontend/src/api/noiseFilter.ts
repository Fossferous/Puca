/**
 * Noise suppression — tiered. The mode picks the SUPPRESSOR only:
 *
 *  - 'off'        : no noise suppression.
 *  - 'standard'   : native WebRTC noise suppression. Zero latency, zero CPU
 *                   cost, works everywhere. Solid baseline.
 *  - 'rnnoise'    : RNNoise (ML) in an AudioWorklet (native NS off so RNNoise
 *                   does the suppression). Better at non-stationary noise —
 *                   keyboards, fans, background voices. Works in browser AND
 *                   desktop, ~10 ms latency, low CPU.
 *  - 'deepfilter' : DeepFilterNet (best quality) — DFN3 wasm in a dedicated
 *                   Worker fed by an AudioWorklet (deepFilter.ts). Gated behind
 *                   Settings → Advanced → Experimental; ~60 ms latency (30 of
 *                   it the model's own look-ahead), real CPU cost. Falls back
 *                   to 'rnnoise' if it can't initialise,
 *                   and downgrades live if inference can't keep up.
 *
 * Echo cancellation and auto-gain come from the Settings → Voice toggles in
 * EVERY mode (they used to be hardcoded per mode, which made those two
 * checkboxes affect only the settings-panel mic test). The Settings
 * noise-suppression toggle applies only in 'standard' — the ML modes replace
 * native NS by design, and 'off' means off.
 *
 * This module also owns the mic GAIN stage (Input Volume × Manual Gain from
 * Settings): a GainNode chained after the suppressor when one runs, or a
 * minimal source→gain→destination graph when the mode has no Web Audio pass.
 * At gain 1.0 with no ML mode, no graph is built at all — the default path
 * stays zero-cost.
 */
import { applyDeepFilter, isDeepFilterAvailable, deepFilterDiagnostics, captureDeepFilter, encodeWav16 } from './deepFilter';
import { DEFAULT_TUNING, POST_FILTER_BETA, type DfTuning } from './dfTuning';
import { inputGain, loadSettings, isDeveloperMode } from '../components/settingsStore';
import { saveAttachment } from './saveAttachment';

export type NoiseSuppressionMode = 'off' | 'standard' | 'rnnoise' | 'deepfilter';

let currentMode: NoiseSuppressionMode = 'standard';

// Web Audio graph state (used by the ML modes).
let audioContext: AudioContext | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
// AudioWorkletNode for RNNoise, ScriptProcessorNode for DeepFilter — both are
// AudioNodes; the optional destroy() releases mode-specific resources.
let workletNode: (AudioNode & { destroy?: () => void }) | null = null;
let destinationNode: MediaStreamAudioDestinationNode | null = null;
// The mic gain stage (Input Volume × Manual Gain). Kept at module level so a
// slider change in Settings can adjust a live call without rebuilding the
// graph — see the settingsChanged listener at the bottom of this file.
let micGainNode: GainNode | null = null;
// The raw getUserMedia stream feeding the graph — kept so cleanup can stop the
// mic (otherwise it stays live inside the graph after leaving voice).
let rawInputStream: MediaStream | null = null;
// Teardown generation. Bumped by cleanupNoiseFilter/snapshotGraph so an async
// graph build that finishes AFTER a teardown (user left voice mid-swap while
// the wasm loaded) detects staleness and releases itself instead of
// resurrecting module state — which left a hot mic running after the call.
let graphGeneration = 0;

/** Whether the Advanced → Experimental DeepFilterNet gate is on. */
export function isDeepFilterGateOpen(): boolean {
    try {
        return loadSettings().experimentalDeepFilter;
    } catch {
        return false; // no storage (tests) — the gate stays closed
    }
}

/** Get the current noise suppression mode. */
export function getNoiseSuppressionMode(): NoiseSuppressionMode {
    return currentMode;
}

/**
 * Fired on `window` whenever the mode changes, so every picker that shows it
 * (Settings → Voice, the voice panel) re-reads module truth. `apply` is true
 * only for a USER choice made through changeNoiseModeLive(): the voice panel
 * then swaps the live call's mic through the new pipeline. Automatic
 * downgrades (a dead graph) set the mode with apply=false — the code that
 * detected the death re-acquires itself, and must not be re-acquired again
 * off the sync event.
 */
export const NOISE_MODE_EVENT = 'sovereign:noise-mode-changed';
export type NoiseModeChange = { mode: NoiseSuppressionMode; apply: boolean };

/** Set the noise suppression mode. Persisted unless `persist` is false —
 *  automatic downgrades (a dead graph falling back to Standard) must not
 *  silently rewrite the user's saved preference: the next launch retries their
 *  chosen mode, and falls back again if it really is broken on this machine.
 *  Dispatches NOISE_MODE_EVENT with apply=false (UI sync only). */
export function setNoiseSuppressionMode(mode: NoiseSuppressionMode, persist = true): void {
    currentMode = mode;
    if (persist) localStorage.setItem('noiseSuppressionMode', mode);
    console.log('[NoiseFilter] Mode set to:', mode, persist ? '' : '(this session only)');
    dispatchModeChange({ mode, apply: false });
}

/**
 * The user picked a mode (in Settings or the voice panel): persist it and ask
 * whoever owns the live call to apply it. One entry point for both pickers,
 * so neither needs to know whether a call is running or import the other.
 */
export function changeNoiseModeLive(mode: NoiseSuppressionMode): void {
    currentMode = mode;
    localStorage.setItem('noiseSuppressionMode', mode);
    console.log('[NoiseFilter] Mode chosen:', mode);
    dispatchModeChange({ mode, apply: true });
}

function dispatchModeChange(detail: NoiseModeChange): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<NoiseModeChange>(NOISE_MODE_EVENT, { detail }));
}

/** Load the saved mode, migrating old mode names to the current set. */
function loadSavedMode(): void {
    const saved = localStorage.getItem('noiseSuppressionMode');
    if (!saved) return;
    const migrated: Record<string, NoiseSuppressionMode> = {
        off: 'off',
        standard: 'standard',
        rnnoise: 'rnnoise',
        // DeepFilter (rebuilt off the main thread after the 0.5.76-era crackle)
        // is honoured only while its Advanced → Experimental gate is on;
        // saved-but-ungated lands on RNNoise, the nearest ML tier.
        deepfilter: isDeepFilterGateOpen() ? 'deepfilter' : 'rnnoise',
        // legacy -> nearest equivalent
        basic: 'rnnoise',
        high: 'rnnoise',
    };
    currentMode = migrated[saved] ?? 'standard';
}

// Migrate/restore on module init.
loadSavedMode();

/** The user's selected input device, or null when they're on the OS default. */
export function selectedInputDeviceId(): string | null {
    const id = loadSettings().inputDeviceId;
    return id && id !== 'default' ? id : null;
}

/**
 * getUserMedia audio constraints for the current mode + the user's Settings.
 * Honors the input device selected in Settings — calls used to always capture
 * the OS default while the settings mic test used the selected device, so a
 * silent default device transmitted zeros forever and the test still "worked".
 * `ignoreSelectedDevice` is the fallback path when that device disappears.
 *
 * Echo Cancellation and Auto Gain Control follow the Settings → Voice toggles
 * in every mode — they used to be hardcoded per mode, which made those two
 * checkboxes purely cosmetic in real calls. Native noise suppression is on
 * only for 'standard' AND the Settings toggle: the ML modes replace it, and
 * 'off' means no suppression.
 */
export function getMicConstraints(
    mode: NoiseSuppressionMode = currentMode,
    opts?: { ignoreSelectedDevice?: boolean },
): MediaTrackConstraints {
    // Voice is mono — force a single channel so we don't ship (or process) a
    // needless stereo track, and the ML worklets (maxChannels: 1) get what they
    // expect.
    const s = loadSettings();
    const base: MediaTrackConstraints = { channelCount: 1 };
    const deviceId = opts?.ignoreSelectedDevice ? null : selectedInputDeviceId();
    if (deviceId) base.deviceId = { exact: deviceId };
    return {
        ...base,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
        noiseSuppression: mode === 'standard' && s.noiseSuppression,
    };
}

/** Whether the mode needs a Web Audio processing pass after getUserMedia. */
export function modeUsesWebAudio(mode: NoiseSuppressionMode = currentMode): boolean {
    return mode === 'rnnoise' || mode === 'deepfilter';
}

/** True for any mode that suppresses noise (i.e. not 'off'). */
export function isNoiseSuppressionEnabled(): boolean {
    return currentMode !== 'off';
}

/**
 * The DeepFilter tuning the user's Settings imply: production defaults, plus
 * the opt-in perceptual post filter when its toggle is on. The worker MERGES a
 * passed tuning over DEFAULT_TUNING (since 0.8.88 — it used to replace it
 * wholesale, so beta alone would have silently reverted the other knobs to
 * upstream values); the spread keeps the object complete on its own too.
 */
function dfTuningFromSettings(): DfTuning | undefined {
    return loadSettings().deepFilterPostFilter
        ? { ...DEFAULT_TUNING, postFilterBeta: POST_FILTER_BETA }
        : undefined;
}

/** Build an output stream = processed audio (from dest) + untouched video. */
function buildOutput(dest: MediaStreamAudioDestinationNode, input: MediaStream): MediaStream {
    const out = new MediaStream();
    dest.stream.getAudioTracks().forEach(t => out.addTrack(t));
    input.getVideoTracks().forEach(t => out.addTrack(t));
    return out;
}

/** The nodes of a suppressor graph: source → worklet → gain → destination. */
type SuppressorNodes = {
    source: MediaStreamAudioSourceNode;
    worklet: AudioNode & { destroy?: () => void };
    gain: GainNode;
    destination: MediaStreamAudioDestinationNode;
};

/**
 * Resume a context that came up suspended, and if autoplay policy still holds
 * it, retry on the next gesture. A suspended context makes the destination
 * track pure silence — this was a permanent mic-death after mid-call
 * deepfilter→rnnoise swaps. Every AudioContext creation site uses this.
 */
async function ensureRunning(ctx: AudioContext): Promise<void> {
    if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch { /* retried below */ }
    }
    if (ctx.state === 'suspended') {
        const retry = () => { ctx.resume().catch(() => { /* closed */ }); };
        window.addEventListener('pointerdown', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
    }
}

/**
 * Build an RNNoise graph on `ctx` — the pure builder, no module state. Used
 * by the live call (applyRnnoise, which then installs the nodes and the
 * watchdogs) and by the Settings mic test (a PRIVATE graph that must not
 * disturb a call). The RNNoise package + wasm are loaded lazily (dynamic
 * import) so they're only fetched when this mode is actually used, and so the
 * package (which subclasses AudioWorkletNode at eval time) doesn't load in
 * non-audio contexts.
 *
 * `onCrash` fires if the worklet processor dies on the audio thread — the
 * library's process() then silently emits nothing: a live, unmuted track of
 * pure zeros with a healthy-looking console. The caller decides what a crash
 * means (the live call downgrades the mode; the mic test shows a notice).
 */
async function buildRnnoiseGraph(
    ctx: AudioContext,
    inputStream: MediaStream,
    initialGain: number,
    onCrash: () => void,
): Promise<SuppressorNodes> {
    const [lib, workletMod, wasmMod, wasmSimdMod] = await Promise.all([
        import('@sapphi-red/web-noise-suppressor'),
        import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'),
        import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'),
        import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'),
    ]);
    const wasmBinary = await lib.loadRnnoise({ url: wasmMod.default, simdUrl: wasmSimdMod.default });
    await ctx.audioWorklet.addModule(workletMod.default);
    await ensureRunning(ctx);

    const source = ctx.createMediaStreamSource(inputStream);
    const worklet = new lib.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary });
    // Force the graph MONO end to end. Chromium can deliver a 2-channel mic
    // track (the channelCount:1 constraint is only an ideal hint), and the
    // RNNoise worklet writes ONLY output channel 0 — so a stereo input yields
    // a left-only track that LiveKit then negotiates as stereo Opus and every
    // receiver hears in one ear. Explicit mono makes the worklet process the
    // proper (L+R)/2 mix and the destination emit symmetric audio. (Verified
    // live in Chromium: settable post-construction, no exceptions.)
    worklet.channelCount = 1;
    worklet.channelCountMode = 'explicit';
    // Mic gain (Input Volume × Manual Gain) sits AFTER the suppressor: RNNoise
    // expects speech at natural level, and a pre-suppressor boost would also
    // boost the noise it's trying to model.
    const gain = ctx.createGain();
    gain.gain.value = initialGain;
    gain.channelCount = 1;
    gain.channelCountMode = 'explicit';
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    (worklet as AudioWorkletNode).onprocessorerror = onCrash;
    source.connect(worklet);
    worklet.connect(gain);
    gain.connect(destination);
    return { source, worklet, gain, destination };
}

/**
 * Apply RNNoise to the LIVE call: build the graph on a fresh 48 kHz context,
 * install it as module state, and arm the watchdogs.
 */
async function applyRnnoise(inputStream: MediaStream): Promise<MediaStream> {
    // Captured BEFORE the awaits: if this build goes stale mid-await, the
    // generation has moved on and the crash handler below must know it.
    const gen = graphGeneration;
    const ctx = new AudioContext({ sampleRate: 48000 });
    let nodes: SuppressorNodes;
    try {
        // Generation-gated crash handler: a REPLACED graph runs until
        // releaseGraph (build-before-teardown), and its late crash must not
        // downgrade the mode the user just switched to (mirror of the same
        // guard in applyDeepFilter).
        nodes = await buildRnnoiseGraph(ctx, inputStream, inputGain(), () => {
            if (gen !== graphGeneration) {
                console.warn('[NoiseFilter] stale RNNoise worklet crashed — ignored (already replaced)');
                return;
            }
            console.error('[NoiseFilter] RNNoise worklet crashed — audio would be silent');
            window.dispatchEvent(new CustomEvent('sovereign:noise-graph-dead'));
        });
    } catch (err) {
        ctx.close().catch(() => { /* never started */ });
        throw err;
    }
    audioContext = ctx;
    rawInputStream = inputStream;
    sourceNode = nodes.source;
    workletNode = nodes.worklet;
    micGainNode = nodes.gain;
    destinationNode = nodes.destination;
    // The liveness watchdog reads the worklet's PRE-gain output — an Input
    // Volume of 0 is the user's choice, not a dead worklet.
    watchGraphLiveness(ctx, nodes.source, nodes.worklet, graphGeneration);
    watchRawInputSignal(ctx, nodes.source, graphGeneration);
    // "graph built", NOT "processing": the worklet's wasm instantiates on the
    // audio thread after this returns, and can still fail there. The liveness
    // watchdog above is what proves it actually processes.
    console.log('[NoiseFilter] RNNoise graph built (worklet wasm still initialising)');
    return buildOutput(nodes.destination, inputStream);
}

/**
 * Minimal source→gain→destination graph for the modes with no Web Audio
 * suppressor ('off'/'standard') when the Settings mic gain is not 1.0 — the
 * only way to apply Input Volume / Manual Gain to what actually transmits.
 * Skipped entirely at gain 1.0 so the default path stays raw.
 */
function applyGainOnly(inputStream: MediaStream): MediaStream {
    audioContext = new AudioContext({ sampleRate: 48000 });
    rawInputStream = inputStream;

    // Same suspended-context guard as applyRnnoise: a suspended context emits
    // pure silence, which here would mean a permanently dead mic.
    if (audioContext.state === 'suspended') {
        const ctx = audioContext;
        ctx.resume().catch(() => { /* retried on next gesture below */ });
        const retry = () => { ctx.resume().catch(() => { /* closed */ }); };
        window.addEventListener('pointerdown', retry, { once: true });
        window.addEventListener('keydown', retry, { once: true });
    }

    sourceNode = audioContext.createMediaStreamSource(inputStream);
    micGainNode = audioContext.createGain();
    micGainNode.gain.value = inputGain();
    micGainNode.channelCount = 1;
    micGainNode.channelCountMode = 'explicit';
    destinationNode = audioContext.createMediaStreamDestination();
    destinationNode.channelCount = 1;
    sourceNode.connect(micGainNode);
    micGainNode.connect(destinationNode);
    console.log('[NoiseFilter] Mic gain stage active:', micGainNode.gain.value);
    return buildOutput(destinationNode, inputStream);
}

/**
 * Has the RAW microphone — before any processing — ever carried speech-level
 * signal on the current graph? Reset whenever the graph is rebuilt.
 *
 * This exists to stop the "silent published track" detector convicting the wrong
 * suspect. Pure digital silence going out has two very different causes: the
 * noise-suppression graph died, or the microphone itself is producing nothing
 * (hardware mute switch, OS mute, wrong device). They are indistinguishable
 * downstream, and assuming the former means a user with a muted headset is told
 * RNNoise is broken AND silently loses noise suppression for the session.
 */
let rawInputEverHadSignal = false;

export function rawInputHasHadSignal(): boolean {
    return rawInputEverHadSignal;
}

/** Latch `rawInputEverHadSignal` for the life of one graph generation. */
function watchRawInputSignal(ctx: AudioContext, input: AudioNode, gen: number): void {
    rawInputEverHadSignal = false;
    let analyser: AnalyserNode;
    try {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        input.connect(analyser);
    } catch {
        return; // no signal evidence available; callers fail safe (see below)
    }
    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
        if (gen !== graphGeneration || ctx.state === 'closed') {
            clearInterval(timer);
            try { input.disconnect(analyser); } catch { /* graph gone */ }
            return;
        }
        if (ctx.state === 'suspended') return;
        analyser.getFloatTimeDomainData(buf);
        // Same speech-level threshold the liveness watchdog uses: a working
        // suppressor legitimately zeroes faint room noise, so only real speech
        // proves the mic is delivering.
        for (const v of buf) {
            if (Math.abs(v) > 0.02) {
                rawInputEverHadSignal = true;
                clearInterval(timer);
                try { input.disconnect(analyser); } catch { /* graph gone */ }
                return;
            }
        }
    }, 1000);
}

/**
 * Watch a freshly built NS graph for the silent-death signature: real speech
 * energy at the input while the worklet output stays EXACTLY zero (a working
 * suppressor passes speech through; only a dead processor emits pure digital
 * silence against a talking user). Fires 'sovereign:noise-graph-dead' so the
 * UI can fall back to a mode that transmits. Self-cancels when the graph is
 * torn down/replaced (generation bump), when the output proves alive, or
 * after a 30 s inconclusive window (user never spoke).
 */
function watchGraphLiveness(ctx: AudioContext, input: AudioNode, output: AudioNode, gen: number, label = 'RNNoise'): void {
    let inAnalyser: AnalyserNode;
    let outAnalyser: AnalyserNode;
    try {
        inAnalyser = ctx.createAnalyser();
        outAnalyser = ctx.createAnalyser();
        inAnalyser.fftSize = 2048;
        outAnalyser.fftSize = 2048;
        input.connect(inAnalyser);
        output.connect(outAnalyser);
    } catch {
        return; // no watchdog, but the graph itself is unaffected
    }
    const inBuf = new Float32Array(inAnalyser.fftSize);
    const outBuf = new Float32Array(outAnalyser.fftSize);
    // The worklet's wasm instantiates on the AUDIO thread after construction,
    // and emits zeros until it finishes. Ignore the first few seconds so a slow
    // init can't be mistaken for a dead processor.
    const GRACE_TICKS = 12; // 12 × 250 ms = 3 s
    let speechTicks = 0;
    let ticks = 0;
    const finish = (dead: boolean) => {
        clearInterval(timer);
        try { input.disconnect(inAnalyser); } catch { /* graph gone */ }
        try { output.disconnect(outAnalyser); } catch { /* graph gone */ }
        if (dead) {
            console.error(`[NoiseFilter] ${label} graph is emitting pure silence against live input — dead worklet`);
            window.dispatchEvent(new CustomEvent('sovereign:noise-graph-dead'));
        }
    };
    const timer = setInterval(() => {
        if (gen !== graphGeneration || ctx.state === 'closed') return finish(false);
        if (ctx.state === 'suspended') return; // no data flows; wait for resume
        ticks++;
        inAnalyser.getFloatTimeDomainData(inBuf);
        outAnalyser.getFloatTimeDomainData(outBuf);
        let inPeak = 0;
        for (const v of inBuf) { const a = Math.abs(v); if (a > inPeak) inPeak = a; }
        let outPeak = 0;
        for (const v of outBuf) { const a = Math.abs(v); if (a > outPeak) outPeak = a; }
        // Any nonzero output = the processor is writing samples → healthy.
        if (outPeak > 1e-7) return finish(false);
        if (ticks <= GRACE_TICKS) return; // still-initialising window
        // Count only speech-level input: a working RNNoise legitimately zeroes
        // faint background noise, so quiet input proves nothing.
        if (inPeak > 0.02) speechTicks++;
        if (speechTicks >= 6) return finish(true); // ~1.5 s of speech, zero out
        if (ticks >= 120) return finish(false);    // 30 s, user never spoke
    }, 250);
}

/** Detached snapshot of a live graph (see processAudioStream's swap order). */
type GraphSnapshot = {
    worklet: (AudioNode & { destroy?: () => void }) | null;
    source: MediaStreamAudioSourceNode | null;
    context: AudioContext | null;
    rawInput: MediaStream | null;
};

/** Move the current graph out of the module registry without stopping it. */
function snapshotGraph(): GraphSnapshot {
    const snap: GraphSnapshot = {
        worklet: workletNode,
        source: sourceNode,
        context: audioContext,
        rawInput: rawInputStream,
    };
    workletNode = null;
    sourceNode = null;
    destinationNode = null;
    micGainNode = null; // released with its context in releaseGraph
    audioContext = null;
    rawInputStream = null;
    graphGeneration++;
    return snap;
}

/** Tear down a snapshotted graph (stop its raw mic, close its context). */
function releaseGraph(snap: GraphSnapshot): void {
    if (snap.worklet) {
        try { snap.worklet.destroy?.(); } catch { /* not all nodes have destroy */ }
        snap.worklet.disconnect();
    }
    snap.source?.disconnect();
    snap.context?.close().catch(() => { /* already closed */ });
    snap.rawInput?.getTracks().forEach(t => t.stop());
}

/**
 * Run the current mode's Web Audio pass. 'rnnoise' uses the worklet;
 * 'deepfilter' uses the in-process DFN3 wasm and falls back to RNNoise when
 * unavailable. 'off'/'standard' are pass-throughs — unless the Settings mic
 * gain is not 1.0, in which case they get a minimal gain-only graph.
 *
 * Swap order matters: the OLD graph keeps producing audio while the new one
 * builds (a wasm load can take seconds) and is torn down only once the new
 * graph is live — a mid-call mode change must never transmit a dead track
 * while the replacement pipeline loads.
 */
export async function processAudioStream(inputStream: MediaStream): Promise<MediaStream> {
    if (!modeUsesWebAudio(currentMode)) {
        if (inputGain() === 1) {
            // No processing needed. Tear down any previous graph (a mid-call
            // switch away from an ML mode or a gain reset lands here) so its
            // raw mic doesn't stay live behind the scenes.
            cleanupNoiseFilter();
            return inputStream;
        }
        const old = snapshotGraph();
        try {
            return applyGainOnly(inputStream);
        } finally {
            releaseGraph(old);
        }
    }
    const old = snapshotGraph();
    // A teardown (cleanupNoiseFilter — e.g. the user left voice) or a newer
    // build (another snapshotGraph) during our awaits makes THIS build stale:
    // it must release itself, never install into module state.
    const gen = graphGeneration;
    const stale = () => gen !== graphGeneration;
    try {
        if (currentMode === 'deepfilter' && await isDeepFilterAvailable()) {
            const ctx = new AudioContext({ sampleRate: 48000 });
            try {
                const result = await applyDeepFilter(ctx, inputStream, inputGain(), {
                    // Once a newer build (or a teardown) bumps the generation,
                    // this graph keeps RUNNING until releaseGraph — but its
                    // death reports must be ignored: the graph-dead handler
                    // reads the CURRENT mode and would downgrade the tier the
                    // user just switched TO, blaming the wrong suppressor.
                    stillCurrent: () => gen === graphGeneration,
                    tuning: dfTuningFromSettings(),
                });
                if (stale()) {
                    try { result.worklet.destroy?.(); } catch { /* no destroy */ }
                    ctx.close().catch(() => { /* already closed */ });
                    throw new Error('noise graph torn down during build');
                }
                audioContext = ctx;
                rawInputStream = inputStream;
                sourceNode = result.source;
                workletNode = result.worklet;
                micGainNode = result.gain;
                destinationNode = result.destination;
                // Same watchdogs as RNNoise: prove the graph PROCESSES (the
                // worklet emits its raw delay line while broken, which is
                // audible-but-unsuppressed rather than silent — the dedicated
                // overload/crash reporting lives in deepFilter.ts; this one
                // catches the graph wedging some other way).
                watchGraphLiveness(ctx, result.source, result.worklet, graphGeneration, 'DeepFilter');
                watchRawInputSignal(ctx, result.source, graphGeneration);
                console.log('[NoiseFilter] DeepFilterNet active (worklet + inference worker)');
                return buildOutput(result.destination, inputStream);
            } catch (err) {
                if (stale()) throw err; // don't fall through to a stale rnnoise build
                console.warn('[NoiseFilter] DeepFilterNet failed, falling back to RNNoise:', err);
                ctx.close().catch(() => { /* never started */ });
            }
        }
        const out = await applyRnnoise(inputStream);
        if (stale()) {
            // applyRnnoise installed module state after a teardown — release it.
            cleanupNoiseFilter();
            throw new Error('noise graph torn down during build');
        }
        return out;
    } finally {
        releaseGraph(old);
    }
}

/**
 * A PRIVATE processing graph for the Settings → Voice mic test: exactly the
 * pipeline a call would run for `mode` — suppressor (if any) then the mic gain
 * stage — on its own context, touching none of the module state above, so it
 * can run while a call is live without swapping the call's mic. What comes
 * out of `output` is what the room would hear.
 */
export type MicTestGraph = {
    /** The mode actually running (a DeepFilter build failure cascades to
     *  RNNoise, and an RNNoise failure to the plain gain stage). */
    mode: NoiseSuppressionMode;
    /** Processed audio, ready to play back / meter. */
    output: MediaStream;
    /** Meter what the room would hear: connect an AnalyserNode here. */
    meterNode: AudioNode;
    context: AudioContext;
    /** Live-adjust the mic gain (Input Volume × Manual Gain). */
    setGain: (g: number) => void;
    destroy: () => void;
};

export async function buildMicTestGraph(
    inputStream: MediaStream,
    mode: NoiseSuppressionMode,
    hooks: {
        /** The running suppressor died mid-test (worklet crash / DeepFilter overload). */
        onDead: (why: string) => void;
        /** A requested tier could not be built; `mode` says what runs instead. */
        onFallback: (from: NoiseSuppressionMode, to: NoiseSuppressionMode, why: string) => void;
    },
): Promise<MicTestGraph> {
    const ctx = new AudioContext({ sampleRate: 48000 });
    let destroyed = false;
    const finish = (running: NoiseSuppressionMode, nodes: SuppressorNodes | null): MicTestGraph => {
        let source = nodes?.source;
        let gain = nodes?.gain;
        let destination = nodes?.destination;
        if (!nodes) {
            // 'off' / 'standard' (and the last-resort fallback): the same
            // source → gain → destination the call builds when a gain is set,
            // built unconditionally here so the test always plays the gain.
            source = ctx.createMediaStreamSource(inputStream);
            gain = ctx.createGain();
            gain.gain.value = inputGain();
            gain.channelCount = 1;
            gain.channelCountMode = 'explicit';
            destination = ctx.createMediaStreamDestination();
            destination.channelCount = 1;
            source.connect(gain);
            gain.connect(destination);
        }
        const g = gain!;
        const d = destination!;
        return {
            mode: running,
            output: d.stream,
            meterNode: g,
            context: ctx,
            setGain: (v) => { g.gain.value = v; },
            destroy: () => {
                if (destroyed) return;
                destroyed = true;
                try { nodes?.worklet.destroy?.(); } catch { /* no destroy */ }
                try { nodes?.worklet.disconnect(); } catch { /* gone */ }
                try { source?.disconnect(); } catch { /* gone */ }
                ctx.close().catch(() => { /* already closed */ });
            },
        };
    };
    if (mode === 'deepfilter' && await isDeepFilterAvailable()) {
        try {
            const nodes = await applyDeepFilter(ctx, inputStream, inputGain(), {
                tuning: dfTuningFromSettings(),
                local: { onDead: hooks.onDead },
            });
            return finish('deepfilter', nodes);
        } catch (err) {
            console.warn('[NoiseFilter] mic test: DeepFilter failed, testing RNNoise instead:', err);
            hooks.onFallback('deepfilter', 'rnnoise', err instanceof Error ? err.message : String(err));
            mode = 'rnnoise';
        }
    } else if (mode === 'deepfilter') {
        hooks.onFallback('deepfilter', 'rnnoise', 'DeepFilter is not available in this browser');
        mode = 'rnnoise';
    }
    if (mode === 'rnnoise') {
        try {
            const nodes = await buildRnnoiseGraph(ctx, inputStream, inputGain(),
                () => hooks.onDead('RNNoise worklet crashed'));
            return finish('rnnoise', nodes);
        } catch (err) {
            console.warn('[NoiseFilter] mic test: RNNoise failed, testing without ML suppression:', err);
            hooks.onFallback('rnnoise', 'standard', err instanceof Error ? err.message : String(err));
            mode = 'standard';
        }
    }
    await ensureRunning(ctx);
    return finish(mode, null);
}

/** Tear down the Web Audio graph + stop the raw mic. Safe to call repeatedly.
 *  Also invalidates any in-flight graph build (see graphGeneration). */
export function cleanupNoiseFilter(): void {
    graphGeneration++;
    if (workletNode) {
        try { workletNode.destroy?.(); } catch { /* not all nodes have destroy */ }
        workletNode.disconnect();
        workletNode = null;
    }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    destinationNode = null;
    micGainNode = null; // its context is closed below
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (rawInputStream) {
        rawInputStream.getTracks().forEach(t => t.stop());
        rawInputStream = null;
    }
}

/** True when a live graph carries a gain stage a slider change can adjust. */
export function hasLiveGainStage(): boolean {
    return micGainNode !== null;
}

/**
 * Everything known about the noise-suppression graph right now.
 *
 * "RNNoise isn't working" was unanswerable: the only console evidence was
 * `[NoiseFilter] RNNoise active`, which is printed immediately after connect()
 * — BEFORE the worklet's wasm has initialised on the audio thread — so it says
 * a graph was wired up, not that anything is being processed. A user could not
 * distinguish "never selected the mode", "graph failed to build and silently
 * fell back", "worklet died", or "working fine but the noise is speech-like".
 *
 * Surfaced through window.__pucaVoiceDiag() so it can be read from
 * DevTools while the problem is happening.
 */
export function noiseDiagnostics(): Record<string, unknown> {
    const s = loadSettings();
    return {
        mode: currentMode,
        savedMode: typeof localStorage !== 'undefined'
            ? localStorage.getItem('noiseSuppressionMode') : null,
        // The distinction that matters: a mode that needs a Web Audio graph,
        // with no graph, means the build failed and we fell back.
        modeNeedsGraph: modeUsesWebAudio(currentMode),
        graphLive: audioContext !== null,
        contextState: audioContext?.state ?? null,
        contextSampleRate: audioContext?.sampleRate ?? null,
        workletConnected: workletNode !== null,
        gainStage: micGainNode?.gain.value ?? null,
        // Native constraints actually requested. In an ML mode native NS is
        // deliberately off, so `graphLive: false` here means NOTHING is
        // suppressing.
        requestedNativeNS: currentMode === 'standard' && s.noiseSuppression,
        echoCancellation: s.echoCancellation,
        autoGainControl: s.autoGainControl,
        rawMicHasHadSignal: rawInputEverHadSignal,
        inputDeviceId: selectedInputDeviceId() ?? 'default',
        deepFilterGateOpen: isDeepFilterGateOpen(),
        // Pipeline telemetry (hop counts, dry ratio, inference timings) — only
        // meaningful while a DeepFilter graph is (or recently was) live.
        ...(currentMode === 'deepfilter' ? { deepFilter: deepFilterDiagnostics() } : {}),
    };
}

// Apply Input Volume / Manual Gain changes to a live call instantly. When no
// graph is running (gain was 1.0 at call start in 'off'/'standard'), the
// change can't be retrofitted here — VoicePanel listens for the same event and
// re-acquires the mic through the pipeline when that transition happens.
if (typeof window !== 'undefined') {
    window.addEventListener('settingsChanged', () => {
        if (micGainNode) micGainNode.gain.value = inputGain();
    });

    // Field capture for DeepFilter reports. From DevTools, WHILE the artifact is
    // audible and DeepFilter is the live mode:
    //     await __pucaDfCapture()
    // saves the last ~30 s as two aligned WAVs — what the mic delivered and
    // what the model returned — through the same path attachments are saved
    // by (desktop: <Downloads>/Puca/, web: a browser download). Nothing
    // is uploaded; the user decides what to do with the files. Play them
    // through e2e/df-offline.mjs's metrics or just listen.
    //
    // DEVELOPER MODE ONLY since the 0.8.130 security pass. Installed
    // unconditionally, this put a function on `window` that writes 30 seconds of
    // the user's raw microphone audio to disk, reachable by any script running
    // in the webview — which on desktop is exactly where an XSS would land. The
    // worker's rings are gated by the same flag, so with developer mode off
    // there is no buffer for it to read either.
    (window as unknown as Record<string, unknown>).__pucaDfCapture = async () => {
        if (!isDeveloperMode()) return 'turn on Developer mode in Settings first';
        if (currentMode !== 'deepfilter') return 'DeepFilter is not the live mode (' + currentMode + ')';
        const c = await captureDeepFilter();
        if (!c) return 'no DeepFilter graph is live (or the worker did not answer)';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const out: Record<string, unknown> = { seconds: (c.hops * c.hop) / c.sampleRate, delayHops: c.delayHops };
        for (const [name, data] of [['raw', c.raw], ['enhanced', c.enh]] as const) {
            const url = URL.createObjectURL(encodeWav16(data, c.sampleRate));
            // The web path starts a browser download from the URL and returns
            // at once; revoking immediately can abort it. Give it a minute.
            setTimeout(() => URL.revokeObjectURL(url), 60_000);
            out[name] = await saveAttachment(url, `puca-deepfilter-${stamp}-${name}.wav`);
        }
        return out;
    };
}
