/**
 * THE MIX GRAPH OF A NATIVE CLIP SESSION AND THE LEAD: replayBuffer.armNative
 * builds system audio -> gain -> dest and mic -> DELAY -> gain -> dest, and
 * every scheduling-lead report from nativeCapture (a) reaches the worker as an
 * `audioLead` message and (b) drives that delay, so the whole mix is late by
 * the lead the worker then subtracts. The review of the first version found
 * the mic pulled EARLY by 50-500 ms because it had no delay; this pins the
 * delay, its ramp (never a step), its ceiling, and that a session with no
 * system-audio leg gets no delay at all.
 *
 * jsdom has no audio graph or worker: minimal stubs record the wiring.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';

type Lead = (renderAtMs: number, leadMs: number) => void;
let capturedOnLead: Lead | null = null;
let sysAvailable = true;
vi.mock('../api/clips/nativeCapture', () => ({
    isNativeCaptureSupported: () => true,
    preferredLoopbackDeviceName: async () => null,
    startNativeVideo: async () => ({ target: { outputIndex: 0, width: 1280, height: 720, reason: 'primary', bitrate: 8_000_000 }, stop: async () => { } }),
    startNativeSystemAudioTrack: async (_onErr: unknown, _dev: unknown, onLead?: Lead) => {
        if (!sysAvailable) throw new Error('no loopback device');
        capturedOnLead = onLead ?? null;
        return { track: { kind: 'audio', readyState: 'live' }, deviceName: 'Speakers', stop: async () => { } };
    },
}));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('../api/captureBar', () => ({ hideCaptureBar: () => { }, releaseCaptureBar: () => { } }));
const micTrack = { kind: 'audio', readyState: 'live', enabled: true };
vi.mock('../api/webrtc', () => ({
    webrtcManager: { getLocalStreamSync: () => ({ getAudioTracks: () => [micTrack] }), onMicTrackSwapped: () => () => { } },
}));

/** Recorded audio nodes. */
type Node = { kind: string; connections: Node[]; connect: (n: Node) => Node; disconnect: () => void; gain?: { value: number }; delayTime?: { value: number; targets: { value: number; at: number; tc: number }[]; setTargetAtTime: (v: number, at: number, tc: number) => void }; maxDelay?: number; stream?: unknown };
const nodes: Node[] = [];
function node(kind: string, extra: Partial<Node> = {}): Node {
    const n: Node = { kind, connections: [], connect(m) { n.connections.push(m); return m; }, disconnect() { n.connections.length = 0; }, ...extra };
    nodes.push(n);
    return n;
}
class StubAudioContext {
    state = 'running';
    currentTime = 7.25;
    constructor(_o?: unknown) { }
    createMediaStreamDestination() { return node('dest', { stream: { getAudioTracks: () => [{ kind: 'audio' }] } }); }
    createMediaStreamSource(s: unknown) { return node('source', { stream: s }); }
    createGain() { return node('gain', { gain: { value: 1 } }); }
    createDelay(max: number) {
        const targets: { value: number; at: number; tc: number }[] = [];
        return node('delay', { maxDelay: max, delayTime: { value: 0, targets, setTargetAtTime(v, at, tc) { targets.push({ value: v, at, tc }); } } });
    }
    async resume() { }
    async close() { }
}
const posted: unknown[] = [];
class StubWorker {
    onmessage: unknown = null; onerror: unknown = null;
    constructor(_u: unknown, _o?: unknown) { }
    postMessage(m: unknown) { posted.push(m); }
    terminate() { }
}
class StubProcessor { readable = new ReadableStream(); constructor(_o: unknown) { } }

beforeEach(() => {
    nodes.length = 0; posted.length = 0; capturedOnLead = null; sysAvailable = true;
    vi.stubGlobal('AudioContext', StubAudioContext);
    vi.stubGlobal('Worker', StubWorker);
    vi.stubGlobal('MediaStreamTrackProcessor', StubProcessor);
    // MediaStream comes from setup.ts's MockMediaStream (non-configurable on window).
});

async function armed() {
    const rb = await import('../api/clips/replayBuffer');
    rb.__resetReplayForTests();
    await rb.armNative();
    return rb;
}
const path = (from: Node, to: Node): boolean => from === to || from.connections.some(n => path(n, to));

describe('the native mix graph and the scheduling lead', () => {
    test('the mic leg runs through a delay that follows every lead report the worker gets', async () => {
        const rb = await armed();
        expect(rb.getReplayState().hasMic).toBe(true);
        expect(capturedOnLead, 'nativeCapture was given the lead callback').not.toBeNull();
        const dest = nodes.find(n => n.kind === 'dest')!;
        const delay = nodes.find(n => n.kind === 'delay')!;
        const sources = nodes.filter(n => n.kind === 'source');
        // buildMixedAudio creates the system source first, buildMicSource the mic's.
        expect(sources.length).toBe(2);
        const [sysSrc, micSrc] = sources;
        expect(delay, 'a DelayNode exists').toBeTruthy();
        expect(path(micSrc, delay) && path(delay, dest), 'mic -> delay -> ... -> dest').toBe(true);
        expect(path(sysSrc, dest) && !path(sysSrc, delay), 'system audio reaches dest WITHOUT the delay').toBe(true);
        expect(delay.maxDelay).toBeGreaterThanOrEqual(0.5); // MAX_BACKLOG_S must fit

        // A lead report: forwarded to the worker AND ramped into the delay.
        capturedOnLead!(1_700_000_000_000, 120);
        expect(posted.some(m => (m as { t: string }).t === 'audioLead' && (m as { leadMs: number }).leadMs === 120)).toBe(true);
        expect(delay.delayTime!.targets.at(-1)).toMatchObject({ value: 0.12, at: 7.25 });
        expect(delay.delayTime!.targets.at(-1)!.tc).toBeGreaterThan(0); // a ramp, never a step
        expect(delay.delayTime!.value, 'delayTime.value is never stepped directly').toBe(0);

        // A repeat within 2 ms is throttled (no new message, no new ramp)...
        const before = posted.length, ramps = delay.delayTime!.targets.length;
        capturedOnLead!(1_700_000_000_010, 121);
        expect(posted.length).toBe(before);
        expect(delay.delayTime!.targets.length).toBe(ramps);
        // ...a real change is not, and the ceiling holds.
        capturedOnLead!(1_700_000_000_020, 900);
        expect(delay.delayTime!.targets.at(-1)!.value).toBe(0.9);
        capturedOnLead!(1_700_000_000_030, 5000);
        expect(delay.delayTime!.targets.at(-1)!.value).toBe(1);
        await rb.disarm('test');
    });

    test('with no system-audio leg the mic is not delayed at all', async () => {
        sysAvailable = false;
        const rb = await armed();
        expect(rb.getReplayState().hasMic).toBe(true);
        expect(rb.getReplayState().hasSystemAudio).toBe(false);
        expect(nodes.find(n => n.kind === 'delay'), 'no DelayNode: nothing to subtract, nothing to delay').toBeUndefined();
        const dest = nodes.find(n => n.kind === 'dest')!;
        const micSrc = nodes.find(n => n.kind === 'source')!;
        expect(path(micSrc, dest)).toBe(true);
        await rb.disarm('test');
    });
});
