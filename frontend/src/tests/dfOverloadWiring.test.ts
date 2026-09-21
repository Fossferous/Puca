/**
 * applyDeepFilter's overload wiring, end to end on the main thread: the
 * worklet's episode reports -> DfOverloadPolicy -> standby + Worker gone +
 * 'sovereign:df-settled', or the old full fallback when there is no bridge.
 * Web Audio, the Worker and the RNNoise node are fakes; the audio thread's
 * half is pinned in dfCore.test.ts.
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
    constructor(public ctx: unknown, public name: string, public opts: Record<string, unknown>) {
        super();
        FakeWorkletNode.last = this;
    }
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
    audioWorklet: { addModule: vi.fn(async () => { }) },
    createMediaStreamSource: () => new FakeNode(),
    createGain: () => Object.assign(new FakeNode(), { gain: { value: 1 } }),
    createMediaStreamDestination: () => Object.assign(new FakeNode(), { stream: {} }),
    resume: async () => { },
}) as unknown as AudioContext;

import { applyDeepFilter, deepFilterDiagnostics } from '../api/deepFilter';
import { SUSTAINED_MS, REPEAT_EPISODES } from '../api/dfOverloadPolicy';

const events: { type: string; detail: unknown }[] = [];
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });
const fromWorklet = (data: unknown) => FakeWorkletNode.last!.port.onmessage!({ data });
// What the worklet's reports carry about the bridge: a live one, and a mic
// with sound going in. Settling rests on this; without it there is no bridge.
const LIVE = { bridgeLive: true, inputLive: true };
const overloaded = (episode: number, stats: Record<string, unknown> = LIVE) =>
    fromWorklet({ type: 'overloaded', episode, stats });
const posted = () => FakeWorkletNode.last!.port.postMessage.mock.calls.map((c) => (c[0] as { type?: string }).type);

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

describe('applyDeepFilter overload wiring', () => {
    it('builds the bridge into input 1 and tells the worklet its delay', async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        const node = FakeWorkletNode.last!;
        expect(node.opts.numberOfInputs).toBe(2);
        expect(bridgeState.last!.connect).toHaveBeenCalledWith(node, 0, 1);
        const init = node.port.postMessage.mock.calls[0][0] as { type: string; bridgeDelay: unknown };
        expect(init.type).toBe('init');
        expect(init.bridgeDelay).toBe(992);
    });

    it('a spike that ends keeps DeepFilter: no standby, no event, Worker alive', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS / 2);
        fromWorklet({ type: 'recovered', episode: 1 });
        vi.advanceTimersByTime(SUSTAINED_MS * 2);
        expect(posted()).not.toContain('standby');
        expect(FakeWorker.last!.terminate).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    it('a sustained episode settles on the bridge: standby, Worker gone, df-settled', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS - 1);
        expect(events).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(posted()).toContain('standby');
        expect(FakeWorker.last!.terminate).toHaveBeenCalled();
        expect(events).toEqual([{ type: 'sovereign:df-settled', detail: { reason: 'sustained' } }]);
    });

    it('repeated episodes settle as repeated', async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        for (let k = 1; k <= REPEAT_EPISODES; k++) {
            overloaded(k);
            if (k < REPEAT_EPISODES) fromWorklet({ type: 'recovered', episode: k });
        }
        expect(events).toEqual([{ type: 'sovereign:df-settled', detail: { reason: 'repeated' } }]);
    });

    it('with no bridge, the FIRST episode falls back the old way, marked as an overload', async () => {
        bridgeState.fail = true;
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        expect(FakeWorkletNode.last!.port.postMessage.mock.calls[0][0]).toMatchObject({ bridgeDelay: null });
        overloaded(1, { bridgeLive: null, inputLive: true });
        // At once: waiting out the policy would leave the raw mic on air.
        expect(posted()).not.toContain('standby');
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'overload' } }]);
    });

    it('a bridge that never produced anything is no bridge: first episode falls back', async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1, { bridgeLive: false, inputLive: true }); // wasm never loaded: zeros, no error
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'overload' } }]);
    });

    it('positive control: a silent bridge over a SILENT mic is not a broken one', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1, { bridgeLive: false, inputLive: false }); // OS-muted mic: zeros in, zeros out
        expect(events).toEqual([]);
        fromWorklet({ type: 'recovered', episode: 1, stats: LIVE });
        expect(events).toEqual([]);
    });

    it('a bridge that crashed before settling makes the next episode fall back', async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        bridgeState.last!.onprocessorerror!();
        expect(events).toEqual([]); // still DeepFilter; nothing to do yet
        overloaded(1);
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'overload' } }]);
    });

    it('a bridge that crashes DURING an episode falls back at once (the raw mic is on air)', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        expect(events).toEqual([]);
        bridgeState.last!.onprocessorerror!();
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'overload' } }]);
    });

    it('bridge-failed during an episode (it went quiet, no error) falls back as an overload', async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        fromWorklet({ type: 'bridge-failed', stats: { bridgeLive: false, inputLive: true } });
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'overload' } }]);
    });

    it('a bridge that crashes AFTER settling falls back for real, as a crash', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS);
        events.length = 0; // the df-settled
        bridgeState.last!.onprocessorerror!();
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'crash' } }]);
    });

    it('a settled graph whose bridge goes quiet (worklet says bridge-failed) falls back', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS);
        events.length = 0;
        fromWorklet({ type: 'bridge-failed', stats: { bridgeLive: false, inputLive: true } });
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'crash' } }]);
    });

    it('a sustain timer that wakes before the wall clock agrees re-arms instead of giving up', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS - 1);
        // The timer fires next tick, but Date.now() says 20 ms short of 15 s.
        vi.setSystemTime(Date.now() - 20);
        vi.advanceTimersByTime(1);
        expect(events).toEqual([]);
        vi.advanceTimersByTime(250);
        expect(events).toEqual([{ type: 'sovereign:df-settled', detail: { reason: 'sustained' } }]);
    });

    it('the mic test is told when its DeepFilter settles, and what is playing', async () => {
        vi.useFakeTimers();
        const onDead = vi.fn();
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { local: { onDead } });
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS);
        expect(posted()).toContain('standby');
        expect(onDead).toHaveBeenCalledTimes(1);
        expect(onDead.mock.calls[0][0]).toMatch(/RNNoise is playing instead/);
        expect(events).toEqual([]); // a private graph never touches the call
    });

    it('the mic test hears about a settle through onSettled when it has one', async () => {
        vi.useFakeTimers();
        const onDead = vi.fn();
        const onSettled = vi.fn();
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { local: { onDead, onSettled } });
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS);
        expect(onSettled).toHaveBeenCalledTimes(1);
        expect(onDead).not.toHaveBeenCalled();
    });

    it("a replaced graph does not write the call's diagnostics", async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { stillCurrent: () => false });
        overloaded(1);
        expect(deepFilterDiagnostics().overloadEpisodes).toEqual([]);
        // POSITIVE CONTROL: the current graph does write it.
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { stillCurrent: () => true });
        overloaded(1);
        expect(deepFilterDiagnostics().overloadEpisodes).toHaveLength(1);
    });

    it('a replaced graph settles silently', async () => {
        vi.useFakeTimers();
        await applyDeepFilter(fakeCtx(), {} as MediaStream, 1, { stillCurrent: () => false });
        overloaded(1);
        vi.advanceTimersByTime(SUSTAINED_MS);
        expect(posted()).toContain('standby');
        expect(events).toEqual([]);
    });

    it('a torn-down graph cannot settle from a timer armed while it was live', async () => {
        vi.useFakeTimers();
        const { worklet } = await applyDeepFilter(fakeCtx(), {} as MediaStream);
        overloaded(1);
        worklet.destroy!();
        vi.advanceTimersByTime(SUSTAINED_MS * 2);
        expect(events).toEqual([]);
        expect(bridgeState.last!.destroy).toHaveBeenCalled();
    });

    it('a crash is still a crash: the worker error reports kind crash', async () => {
        await applyDeepFilter(fakeCtx(), {} as MediaStream);
        FakeWorker.last!.onerror!({ message: 'boom' });
        expect(events).toEqual([{ type: 'sovereign:noise-graph-dead', detail: { kind: 'crash' } }]);
    });
});
