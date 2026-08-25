/**
 * Noise-suppression mode plumbing behind the Settings → Voice picker and the
 * pipeline mic test.
 *
 * Two pickers (Settings, voice panel), one source of truth (noiseFilter):
 *  - changeNoiseModeLive() persists and fires NOISE_MODE_EVENT with apply=true
 *    (the voice panel then swaps the live mic);
 *  - setNoiseSuppressionMode() — the automatic-downgrade path — fires
 *    apply=false so nothing re-acquires off a sync event.
 *
 * buildMicTestGraph() must be PRIVATE (never touch the call's graph state),
 * must cascade deepfilter → rnnoise → plain when a tier cannot be built and
 * SAY so, and must report a suppressor dying mid-test to its owner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- Web Audio fake rich enough for the graph builders --------------------
class FakeNode {
    connect = vi.fn();
    disconnect = vi.fn();
    channelCount = 2;
    channelCountMode = 'max';
}
class FakeGain extends FakeNode { gain = { value: 1 }; }
class FakeDest extends FakeNode { stream = new (window.MediaStream as unknown as new () => MediaStream)(); }
class FakeAnalyser extends FakeNode { fftSize = 2048; smoothingTimeConstant = 0.8; frequencyBinCount = 1024; getByteFrequencyData() { } }
class FakeCtx {
    static instances: FakeCtx[] = [];
    state: 'running' | 'suspended' | 'closed' = 'running';
    sampleRate = 48000;
    closed = false;
    audioWorklet = { addModule: vi.fn(async () => { }) };
    constructor() { FakeCtx.instances.push(this); }
    createMediaStreamSource() { return new FakeNode(); }
    createGain() { return new FakeGain(); }
    createMediaStreamDestination() { return new FakeDest(); }
    createAnalyser() { return new FakeAnalyser(); }
    async resume() { this.state = 'running'; }
    async close() { this.closed = true; this.state = 'closed'; }
}

// ---- Suppressor libraries, mocked so no wasm loads ------------------------
const rnnoiseState = { loadShouldFail: false, lastNode: null as null | { onprocessorerror: null | (() => void) } };
vi.mock('@sapphi-red/web-noise-suppressor', () => ({
    loadRnnoise: async () => { if (rnnoiseState.loadShouldFail) throw new Error('rnnoise wasm failed'); return new ArrayBuffer(8); },
    RnnoiseWorkletNode: class extends FakeNode {
        onprocessorerror: null | (() => void) = null;
        destroy = vi.fn();
        constructor() { super(); rnnoiseState.lastNode = this; }
    },
}));
vi.mock('@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url', () => ({ default: 'rnnoise-worklet.js' }));
vi.mock('@sapphi-red/web-noise-suppressor/rnnoise.wasm?url', () => ({ default: 'rnnoise.wasm' }));
vi.mock('@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url', () => ({ default: 'rnnoise_simd.wasm' }));

const dfState = { shouldFail: false, lastOpts: null as null | Record<string, unknown> };
vi.mock('../api/deepFilter', () => ({
    isDeepFilterAvailable: async () => true,
    deepFilterDiagnostics: () => ({}),
    captureDeepFilter: async () => null,
    encodeWav16: () => new Blob(),
    applyDeepFilter: async (ctx: FakeCtx, _input: MediaStream, initialGain: number, opts?: Record<string, unknown>) => {
        dfState.lastOpts = opts ?? null;
        if (dfState.shouldFail) throw new Error('DeepFilter worker init failed');
        const gain = ctx.createGain(); gain.gain.value = initialGain;
        return { source: ctx.createMediaStreamSource(), worklet: Object.assign(new FakeNode(), { destroy: vi.fn() }), gain, destination: ctx.createMediaStreamDestination() };
    },
}));

import {
    NOISE_MODE_EVENT, type NoiseModeChange, changeNoiseModeLive, setNoiseSuppressionMode,
    getNoiseSuppressionMode, buildMicTestGraph, noiseDiagnostics, hasLiveGainStage,
} from '../api/noiseFilter';

const events: NoiseModeChange[] = [];
const onEvent = (e: Event) => events.push((e as CustomEvent<NoiseModeChange>).detail);

beforeEach(() => {
    events.length = 0;
    FakeCtx.instances.length = 0;
    rnnoiseState.loadShouldFail = false;
    rnnoiseState.lastNode = null;
    dfState.shouldFail = false;
    dfState.lastOpts = null;
    vi.stubGlobal('AudioContext', FakeCtx);
    (window as unknown as { AudioWorkletNode: unknown }).AudioWorkletNode = class { };
    (window as unknown as { Worker: unknown }).Worker = class { };
    localStorage.clear();
    window.addEventListener(NOISE_MODE_EVENT, onEvent);
});
afterEach(() => {
    window.removeEventListener(NOISE_MODE_EVENT, onEvent);
    vi.unstubAllGlobals();
});

describe('noise mode: two pickers, one truth', () => {
    // setup.ts installs a vi.fn localStorage (no storage behind it): assert on
    // the writes, which is what persistence IS here.
    const saved = () => vi.mocked(localStorage.setItem).mock.calls
        .filter(c => c[0] === 'noiseSuppressionMode').map(c => c[1]);

    it('changeNoiseModeLive persists the choice and asks the call owner to apply it', () => {
        vi.mocked(localStorage.setItem).mockClear();
        changeNoiseModeLive('rnnoise');
        expect(getNoiseSuppressionMode()).toBe('rnnoise');
        expect(saved()).toEqual(['rnnoise']);
        expect(events).toEqual([{ mode: 'rnnoise', apply: true }]);
    });

    it('an automatic downgrade syncs the pickers but never triggers a second re-acquire', () => {
        changeNoiseModeLive('deepfilter');
        events.length = 0;
        vi.mocked(localStorage.setItem).mockClear();
        setNoiseSuppressionMode('rnnoise', false); // what a graph-dead handler does
        expect(getNoiseSuppressionMode()).toBe('rnnoise');
        expect(events).toEqual([{ mode: 'rnnoise', apply: false }]);
        // Session-only: the saved preference is untouched, next launch retries it.
        expect(saved()).toEqual([]);
    });
});

describe('buildMicTestGraph', () => {
    const stream = () => new (window.MediaStream as unknown as new () => MediaStream)();
    const hooks = () => ({ onDead: vi.fn(), onFallback: vi.fn() });

    it('is PRIVATE: builds on its own context and leaves the call graph state untouched', async () => {
        const h = hooks();
        const input = stream();
        const g = await buildMicTestGraph(input, 'standard', h);
        expect(g.mode).toBe('standard');
        // Every module slot the LIVE call graph would fill stays empty: the
        // context, the worklet, the gain stage (hasLiveGainStage), the diag.
        const diag = noiseDiagnostics();
        expect(diag.graphLive).toBe(false);
        expect(diag.workletConnected).toBe(false);
        expect(diag.contextState).toBeNull();
        expect(hasLiveGainStage()).toBe(false);
        expect(FakeCtx.instances.length).toBe(1);
        // The gain stage is live-adjustable, and the output is the PROCESSED
        // destination stream — not the raw mic stream handed in.
        g.setGain(1.5);
        expect((g.meterNode as unknown as FakeGain).gain.value).toBe(1.5);
        expect(g.output).toBeTruthy();
        expect(g.output).not.toBe(input);
        g.destroy();
        expect(FakeCtx.instances[0].closed).toBe(true);
        g.destroy(); // idempotent
        expect(h.onFallback).not.toHaveBeenCalled();
    });

    it('runs the requested ML tier when it builds — DeepFilter as a private graph, RNNoise via the shared builder', async () => {
        const h = hooks();
        const df = await buildMicTestGraph(stream(), 'deepfilter', h);
        expect(df.mode).toBe('deepfilter');
        // The private-graph contract: applyDeepFilter got `local` (its death
        // goes to the test's owner, and it never becomes the capture worker).
        expect(dfState.lastOpts?.local).toBeTruthy();
        expect(h.onFallback).not.toHaveBeenCalled();
        df.destroy();

        const rn = await buildMicTestGraph(stream(), 'rnnoise', h);
        expect(rn.mode).toBe('rnnoise');
        expect(rnnoiseState.lastNode).toBeTruthy();
        rn.destroy();
    });

    it('cascades deepfilter → rnnoise → plain when a tier cannot be built, and says so each time', async () => {
        dfState.shouldFail = true;
        const h = hooks();
        const g1 = await buildMicTestGraph(stream(), 'deepfilter', h);
        expect(g1.mode).toBe('rnnoise');
        expect(h.onFallback).toHaveBeenCalledTimes(1);
        expect(h.onFallback.mock.calls[0].slice(0, 2)).toEqual(['deepfilter', 'rnnoise']);
        g1.destroy();

        rnnoiseState.loadShouldFail = true;
        const h2 = hooks();
        const g2 = await buildMicTestGraph(stream(), 'deepfilter', h2);
        expect(g2.mode).toBe('standard');
        expect(h2.onFallback.mock.calls.map(c => c.slice(0, 2))).toEqual([['deepfilter', 'rnnoise'], ['rnnoise', 'standard']]);
        // Even the last resort still hands back a working gain stage.
        g2.setGain(0.5);
        expect((g2.meterNode as unknown as FakeGain).gain.value).toBe(0.5);
        g2.destroy();
    });

    it('reports a suppressor dying mid-test to its owner, not to the live call', async () => {
        const deadEvents: Event[] = [];
        const onGraphDead = (e: Event) => deadEvents.push(e);
        window.addEventListener('sovereign:noise-graph-dead', onGraphDead);
        try {
            const h = hooks();
            const g = await buildMicTestGraph(stream(), 'rnnoise', h);
            rnnoiseState.lastNode!.onprocessorerror!();
            expect(h.onDead).toHaveBeenCalledTimes(1);
            expect(deadEvents.length).toBe(0); // the call's fallback machinery stays quiet
            g.destroy();
        } finally {
            window.removeEventListener('sovereign:noise-graph-dead', onGraphDead);
        }
    });
});
