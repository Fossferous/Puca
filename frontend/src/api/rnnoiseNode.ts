/**
 * One RNNoise AudioWorkletNode, mono in and mono out.
 *
 * Shared by the RNNoise tier (noiseFilter.ts) and DeepFilter's bridge
 * (deepFilter.ts), which runs RNNoise beside the model so a starved inference
 * Worker is covered by suppressed audio rather than the raw mic. Dynamic
 * imports, because the package subclasses AudioWorkletNode at eval time and
 * does not load outside a Web Audio context.
 *
 * The node emits exact zeros until its wasm has instantiated on the audio
 * thread, and after its processor crashes. Callers that need to know it is
 * live must watch its output (dfWorklet.js does) or `onprocessorerror`.
 */

/**
 * Samples by which this node's output trails its input: 992 at the 128-sample
 * render quantum, in two parts.
 *
 * - 512 from the library's framing. It frames 480-sample RNNoise hops out of
 *   a 1920-sample ring and reads its output 640 samples behind its write
 *   position (`delay = (floor(480 / 128) + 1) * 128 + 128` in its
 *   processor.ts), which is 512 behind the start of the quantum being written.
 * - 480 from RNNoise itself. Each processFrame analyses a two-frame window and
 *   overlap-adds, so the 480 samples it writes back in place are the PREVIOUS
 *   frame's audio.
 *
 * The first version of the bridge used 512 alone, from reading the JS. The
 * real-Chromium check (e2e/df-bridge-verify.mjs) measured the bridge 479
 * samples behind DeepFilter's timeline, which is the second term (the
 * correlation peak of filtered speech lands within a sample of it). Re-derive
 * this when @sapphi-red/web-noise-suppressor changes version (the pin in
 * dfBridge.test.ts fails on purpose) and re-run that e2e: a wrong value
 * misaligns the bridge against DeepFilter, and each swap becomes a time jump.
 */
export const RNNOISE_WORKLET_LATENCY = 992;

export type RnnoiseNode = AudioWorkletNode & { destroy(): void };

export async function createRnnoiseNode(ctx: AudioContext): Promise<RnnoiseNode> {
    const [lib, workletMod, wasmMod, wasmSimdMod] = await Promise.all([
        import('@sapphi-red/web-noise-suppressor'),
        import('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'),
        import('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'),
        import('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'),
    ]);
    const wasmBinary = await lib.loadRnnoise({ url: wasmMod.default, simdUrl: wasmSimdMod.default });
    await ctx.audioWorklet.addModule(workletMod.default);
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
    return worklet as RnnoiseNode;
}
