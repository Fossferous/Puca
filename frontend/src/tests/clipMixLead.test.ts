/**
 * THE MIX GRAPH OF A NATIVE CLIP SESSION AND THE LEAD: replayBuffer.armNative
 * builds system audio -> gain -> dest and mic -> DELAY -> gain -> dest, and
 * every scheduling-lead report from nativeCapture (a) reaches the worker as an
 * `audioLead` message, segment flag and all, and (b) drives that delay, so
 * the whole mix is late by the lead the worker then subtracts. The review of
 * the first version found the mic pulled EARLY by 50-500 ms because it had no
 * delay; this pins the delay, its ramp (never a step), its ceiling, that a
 * consumer appearing late is told the CURRENT segment (its start, its lead so
 * far), and that a session with no system-audio leg gets no delay at all.
 *
 * jsdom has no audio graph or worker: minimal stubs record the wiring.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach } from 'vitest';

type Lead = (renderAtMs: number, leadMs: number, newSegment: boolean) => void;
let capturedOnLead: Lead | null = null;
let sysAvailable = true;
/** Reports the (mock) audio leg makes the moment it starts, before the mix graph or the worker exist. */
let leadsAtStart: [number, number, boolean][] = [];
vi.mock('../api/clips/nativeCapture', () => ({
    isNativeCaptureSupported: () => true,
    preferredLoopbackDeviceName: async () => null,
    startNativeVideo: async () => ({ target: { outputIndex: 0, width: 1280, height: 720, reason: 'primary', bitrate: 8_000_000 }, stop: async () => { } }),
    startNativeSystemAudioTrack: async (_onErr: unknown, _dev: unknown, onLead?: Lead) => {
        if (!sysAvailable) throw new Error('no loopback device');
        capturedOnLead = onLead ?? null;
        for (const [at, lead, seg] of leadsAtStart) onLead?.(at, lead, seg);
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
type Node = { kind: string; connections: Node[]; connect: (n: Node) => Node; disconnect: () => void; gain?: { value: number }; delayTime?: { value: number; ramps: { value: number; at: number }[]; setValueAtTime: (v: number, at: number) => void; linearRampToValueAtTime: (v: number, at: number) => void; cancelScheduledValues: (at: number) => void }; maxDelay?: number; stream?: unknown };
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
        const ramps: { value: number; at: number }[] = [];
        return node('delay', { maxDelay: max, delayTime: { value: 0, ramps, setValueAtTime() { }, linearRampToValueAtTime(v, at) { ramps.push({ value: v, at }); }, cancelScheduledValues() { } } });
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
    nodes.length = 0; posted.length = 0; capturedOnLead = null; sysAvailable = true; leadsAtStart = [];
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

        // A segment start: forwarded to the worker AND ramped into the delay.
        capturedOnLead!(1_700_000_000_000, 120, true);
        expect(posted).toContainEqual({ t: 'audioLead', renderAtMs: 1_700_000_000_000, leadMs: 120, newSegment: true });
        expect(delay.delayTime!.ramps.at(-1)).toMatchObject({ value: 0.12 });
        // A LINEAR ramp over the size of the change (from 0 here), never a step.
        expect(delay.delayTime!.ramps.at(-1)!.at).toBeCloseTo(7.25 + 0.12, 5);
        expect(delay.delayTime!.value, 'delayTime.value is never stepped directly').toBe(0);

        // Growth within the segment: nativeCapture only reports it at 5 ms
        // or more, so every report is forwarded — flag intact — and ramped.
        capturedOnLead!(1_700_000_000_010, 126, false);
        expect(posted).toContainEqual({ t: 'audioLead', renderAtMs: 1_700_000_000_010, leadMs: 126, newSegment: false });
        expect(delay.delayTime!.ramps.at(-1)!.value).toBeCloseTo(0.126, 6);
        // The ceiling holds.
        capturedOnLead!(1_700_000_000_020, 900, true);
        expect(delay.delayTime!.ramps.at(-1)!.value).toBe(0.9);
        capturedOnLead!(1_700_000_000_030, 5000, false);
        expect(delay.delayTime!.ramps.at(-1)!.value).toBe(1);
        await rb.disarm('test');
    });

    test('reports made before the mix graph and the worker exist reach both as the CURRENT segment', async () => {
        // nativeCapture reports from its first packet, which can land before
        // buildMixedAudio creates the delay and before the arm message (the
        // worker drops lead messages that come before it). What either
        // consumer must be told then is the segment in force: where it
        // started, and its lead as learnt so far — not the last growth
        // point, which would put the segment's start in the wrong place.
        leadsAtStart = [[1_700_000_000_000, 77, true], [1_700_000_000_040, 84, false]];
        const rb = await armed();
        const delay = nodes.find(n => n.kind === 'delay')!;
        expect(delay.delayTime!.ramps.at(-1), 'the delay started on the lead it missed').toMatchObject({ value: 0.084 });
        const arm = posted.findIndex(m => (m as { t: string }).t === 'arm');
        const leads = posted.map((m, i) => ((m as { t: string }).t === 'audioLead' ? i : -1)).filter(i => i >= 0);
        expect(arm).toBeGreaterThanOrEqual(0);
        expect(leads.some(i => i > arm), 'the worker got the lead AFTER its arm message').toBe(true);
        expect(posted[leads.at(-1)!]).toEqual({ t: 'audioLead', renderAtMs: 1_700_000_000_000, leadMs: 84, newSegment: true });
        // Later reports go straight through.
        const before = posted.length;
        capturedOnLead!(1_700_000_000_050, 90, false);
        expect(posted.length).toBe(before + 1);
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
