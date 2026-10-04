/**
 * applyDeepFilter's PAUSE wiring on the main thread: setPaused -> the
 * worklet's 'pause' / 'resume' messages, and the guards around them. The
 * audio-thread half (what a pause does to the samples) is dfCore.test.ts;
 * the decision is dfPauseDecision.test.ts / dfPause.test.ts.
 *
 * The guard that matters: a pause hands the mic to the RNNoise bridge, so it
 * may only ever start on a bridge PROVEN to work, must end the moment the
 * bridge stops working, and must never be mistaken for an overload (a dead
 * bridge while paused is not a dead DeepFilter).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const bridgeState = { fail: false, last: null as null | FakeBridge };
class FakeBridge {
    connect = vi.fn();
    disconnect = vi.fn();
    destroy = vi.fn();
    onprocessorerror: null | (() => void) = null;
    constructor() { bridgeState.last = this; }
}
vi.mock('../api/rnnoiseNode', () => ({
    RNNOISE_WORKLET_LATENCY: 992,
    createRnnoiseNode: async () => {
        if (bridgeState.fail) throw new Error('rnnoise wasm failed');
        return new FakeBridge();
    },
}));
vi.mock('../api/dfWorklet.js?url', () => ({ default: 'df-worklet.js' }));

class FakeNode { connect = vi.fn(); disconnect = vi.fn(); channelCount = 2; channelCountMode = 'max'; }
class FakeWorkletNode extends FakeNode {
    static last: FakeWorkletNode | null = null;
    port = { postMessage: vi.fn(), onmessage: null as null | ((e: { data: unknown }) => void) };
    onprocessorerror: null | (() => void) = null;
    constructor() { super(); FakeWorkletNode.last = this; }
}
class FakeWorker {
    static last: FakeWorker | null = null;
    onmessage: null | ((e: { data: unknown }) => void) = null;
    onerror: null | ((e: unknown) => void) = null;
    terminate = vi.fn();
    constructor() { FakeWorker.last = this; }
    postMessage(msg: { type?: string }) {
        if (msg?.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', hop: 480, delayHops: 3 } }));
    }
}
const fakeCtx = () => ({
    state: 'running',
    sampleRate: 48000,
    audioWorklet: { addModule: vi.fn(async () => { }) },
    createMediaStreamSource: () => new FakeNode(),
    createGain: () => Object.assign(new FakeNode(), { gain: { value: 1 } }),
    createMediaStreamDestination: () => Object.assign(new FakeNode(), { stream: {} }),
    resume: async () => { },
}) as unknown as AudioContext;

import { applyDeepFilter, deepFilterDiagnostics, type DeepFilterPauseDiag } from '../api/deepFilter';
import { SUSTAINED_MS } from '../api/dfOverloadPolicy';

const events: { type: string; detail: unknown }[] = [];
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
const fromWorklet = (data: unknown) => FakeWorkletNode.last!.port.onmessage!({ data });
const LIVE = { bridgeLive: true, inputLive: true };
/** The worklet's ~2 s report: what proves (or disproves) the bridge. */
const report = (stats: Record<string, unknown> = LIVE) => fromWorklet({ type: 'stats', stats });
/** Only the pause traffic, in order. */
const pauseMsgs = () => FakeWorkletNode.last!.port.postMessage.mock.calls
    .map((c) => (c[0] as { type?: string }).type)
    .filter((t) => t === 'pause' || t === 'resume');
const diag = () => deepFilterDiagnostics().pause as DeepFilterPauseDiag;

beforeEach(() => {
    events.length = 0;
    bridgeState.fail = false;
    bridgeState.last = null;
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
    window.addEventListener('sovereign:df-settled', record);
    window.addEventListener('sovereign:noise-graph-dead', record);
});
afterEach(() => {
    window.removeEventListener('sovereign:df-settled', record);
    window.removeEventListener('sovereign:noise-graph-dead', record);
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('applyDeepFilter: pause wiring', () => {
    it('a pause waits for the first report proving the bridge live, then goes out once', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        worklet.setPaused!(true, 'alone');
        expect(pauseMsgs()).toEqual([]); // the bridge is unproven
        expect(diag()).toMatchObject({ paused: false, refused: 'no working bridge' });
        report();
        expect(pauseMsgs()).toEqual(['pause']);
        expect(diag()).toMatchObject({ paused: true, reason: 'alone', refused: null, pauses: 1 });
        report(); // further reports change nothing
        worklet.setPaused!(true, 'alone');
        expect(pauseMsgs()).toEqual(['pause']);
    });

    it('a resume goes out at once, in the same call', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'mic-closed');
        worklet.setPaused!(false, null);
        expect(pauseMsgs()).toEqual(['pause', 'resume']);
        expect(diag()).toMatchObject({ paused: false, reason: null, pauses: 1, resumes: 1 });
    });

    it('a new reason while paused is recorded without a resume', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'mic-closed');
        worklet.setPaused!(true, 'alone'); // unmuted while alone
        expect(pauseMsgs()).toEqual(['pause']);
        expect(diag().reason).toBe('alone');
    });

    it('a silent mic over a silent bridge is a working bridge: the pause goes out', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report({ bridgeLive: false, inputLive: false });
        worklet.setPaused!(true, 'alone');
        expect(pauseMsgs()).toEqual(['pause']);
    });

    it('no bridge at all: never pauses (the raw mic would carry it)', async () => {
        bridgeState.fail = true;
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        worklet.setPaused!(true, 'alone');
        report({ bridgeLive: null, inputLive: true });
        expect(pauseMsgs()).toEqual([]);
        expect(diag().refused).toBe('no working bridge');
    });

    it('a bridge that stops rendering while paused ends the pause at its next report', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'alone');
        report({ bridgeLive: false, inputLive: true, paused: true });
        expect(pauseMsgs()).toEqual(['pause', 'resume']);
        expect(events).toEqual([]);
    });

    it('a bridge that CRASHES while paused resumes DeepFilter at once, and is no graph death', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'mic-closed');
        bridgeState.last!.onprocessorerror!();
        expect(pauseMsgs()).toEqual(['pause', 'resume']);
        expect(events).toEqual([]);
        worklet.setPaused!(true, 'mic-closed'); // and it does not pause again
        report();
        expect(pauseMsgs()).toEqual(['pause', 'resume']);
    });

    it("the worklet's bridge-failed while paused (not overloaded) resumes DeepFilter and is no overload", async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'alone');
        fromWorklet({ type: 'bridge-failed', stats: { bridgeLive: false, inputLive: true, paused: true, overloaded: false } });
        expect(events).toEqual([]);
        expect(pauseMsgs()).toEqual(['pause', 'resume']);
        expect(diag().refused).toBe('no working bridge');
    });

    it('positive control: bridge-failed during an overload episode is still the overload fallback', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'alone');
        worklet.setPaused!(false, null);
        fromWorklet({ type: 'overloaded', episode: 1, stats: LIVE });
        fromWorklet({ type: 'bridge-failed', stats: { bridgeLive: false, inputLive: true, paused: false, overloaded: true } });
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'overload' } }]);
    });

    it('a settled graph refuses to pause: it has no Worker left', async () => {
        vi.useFakeTimers();
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        fromWorklet({ type: 'overloaded', episode: 1, stats: LIVE });
        vi.advanceTimersByTime(SUSTAINED_MS);
        worklet.setPaused!(true, 'alone');
        report();
        expect(pauseMsgs()).toEqual([]);
        expect(diag().refused).toBe('settled');
    });

    it('records how long the bridge carried the last resume, and the time spent paused', async () => {
        vi.useFakeTimers();
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.setPaused!(true, 'alone');
        vi.advanceTimersByTime(30_000);
        expect(diag().pausedMs).toBe(30_000); // the current pause counts while it lasts
        worklet.setPaused!(false, null);
        vi.advanceTimersByTime(5_000);
        fromWorklet({ type: 'resumed', coverSamples: 2400 });
        expect(diag()).toMatchObject({ pausedMs: 30_000, lastResumeCoverMs: 50 });
        fromWorklet({ type: 'resumed', coverSamples: -1 }); // paused again before it got there
        expect(diag().lastResumeCoverMs).toBe(null);
    });

    it('each call graph carries its own number, so a reader can tell a rebuild from the same graph later on', async () => {
        const first = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        const g1 = diag().graph;
        expect(diag().graph).toBe(g1); // the same graph reads the same number
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { local: { onDead: vi.fn() } });
        expect(diag().graph).toBe(g1); // the mic test is not a call graph
        first.worklet.destroy!();
        await applyDeepFilter(fakeCtx(), {} as MediaStream); // a rebuild
        expect(diag().graph).not.toBe(g1);
    });

    it('a torn-down graph sends nothing more, and leaves no pause diagnostics behind', async () => {
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        worklet.destroy!();
        worklet.setPaused!(true, 'alone');
        expect(pauseMsgs()).toEqual([]);
        expect(deepFilterDiagnostics().pause).toBe(null);
    });

    it('the mic test (a private graph) never writes the call\'s pause diagnostics', async () => {
        const call = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        report();
        call.worklet.setPaused!(true, 'alone');
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { local: { onDead: vi.fn() } });
        expect(diag()).toMatchObject({ paused: true, reason: 'alone' });
    });
});
