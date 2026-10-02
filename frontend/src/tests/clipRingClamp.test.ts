/**
 * THE RING IS CLAMPED TO THE SERVER'S LONGEST CLIP. Arming needs a server
 * with clips on, and the composer can never seal more than that server's
 * clip_max_seconds (ClipControls passes it to seal(); the server 400s past
 * it). So a 5:00 buffer armed in a 2:00 server held three minutes of
 * footage — 130 MB of RAM at 1080p30 — that could never be posted. Both arm
 * paths (native auto-arm and the picker) now take the cap and size the ring
 * to it plus one keyframe interval (ringSecondsFor).
 *
 * jsdom has no worker or audio graph: stubs record the 'arm' message.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('../api/clips/nativeCapture', () => ({
    isNativeCaptureSupported: () => true,
    preferredLoopbackDeviceName: async () => null,
    startNativeVideo: async () => ({ target: { outputIndex: 0, width: 1920, height: 1080, reason: 'primary', bitrate: 6_000_000 }, stop: async () => { } }),
    startNativeSystemAudioTrack: async () => { throw new Error('no loopback in this test'); },
}));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('../api/captureBar', () => ({ hideCaptureBar: () => { }, releaseCaptureBar: () => { } }));
vi.mock('../api/webrtc', () => ({
    webrtcManager: { getLocalStreamSync: () => null, onMicTrackSwapped: () => () => { } },
}));

const posted: { t: string; cfg?: { ringMs: number } }[] = [];
class StubWorker {
    onmessage: unknown = null; onerror: unknown = null;
    constructor(_u: unknown, _o?: unknown) { }
    postMessage(m: { t: string; cfg?: { ringMs: number } }) { posted.push(m); }
    terminate() { }
}
class StubProcessor { readable = new ReadableStream(); constructor(_o: unknown) { } }
class StubAudioContext {
    state = 'running'; currentTime = 0;
    createMediaStreamDestination() { return { channelCount: 2, connect() { }, stream: { getAudioTracks: () => [{ kind: 'audio' }] } }; }
    createMediaStreamSource() { return { connect: (n: unknown) => n, disconnect() { } }; }
    createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n, disconnect() { } }; }
    createDelay() { return { delayTime: { value: 0, setValueAtTime() { }, linearRampToValueAtTime() { }, cancelScheduledValues() { } }, connect: (n: unknown) => n, disconnect() { } }; }
    async resume() { }
    async close() { }
}

beforeEach(() => {
    posted.length = 0;
    vi.stubGlobal('AudioContext', StubAudioContext);
    vi.stubGlobal('Worker', StubWorker);
    vi.stubGlobal('MediaStreamTrackProcessor', StubProcessor);
    vi.stubGlobal('VideoEncoder', function VideoEncoder() { });
    // The picker path: a granted screen with a 1080p video track.
    const video = { kind: 'video', readyState: 'live', getSettings: () => ({ width: 1920, height: 1080 }), addEventListener() { }, stop() { } };
    (navigator.mediaDevices.getDisplayMedia as unknown as { mockResolvedValue: (v: unknown) => void })
        .mockResolvedValue({ getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] });
    // The default settings: a 5:00 buffer (clipBufferSeconds 300).
});

const armCfg = () => posted.find(m => m.t === 'arm')?.cfg;

// Import once, outside any test's timeout: the module graph is large and a
// cold transform under load used to eat the first test's 5 s.
let rbMod: typeof import('../api/clips/replayBuffer');
beforeAll(async () => { rbMod = await import('../api/clips/replayBuffer'); }, 60_000);

async function pastWipeGrace<T>(f: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
        const done = f();
        await vi.advanceTimersByTimeAsync(1500);
        return await done;
    } finally {
        vi.useRealTimers();
    }
}

async function fresh() {
    const rb = rbMod;
    // disarm() always waits out its 1.5 s wipe grace: handleWorker drops the
    // worker's 'wiped' reply because disarm has already cleared `session`, so
    // answering the wipe from the stub would not help. Spend that grace on a
    // fake clock: in real time it made each test 1.5-3 s long, and one that
    // timed out under load raced the next test's arm ('already armed').
    await pastWipeGrace(() => rb.disarm('test'));
    rb.__resetReplayForTests();
    posted.length = 0;
    return rb;
}

describe('the clip ring never holds more than the server lets you post', () => {
    test('native auto-arm in a 2:00 server: ring is 2:02, not the 5:00 setting', async () => {
        const rb = await fresh();
        await rb.armNative({ maxSeconds: 120 });
        expect(armCfg()?.ringMs).toBe(122_000);
    });

    test('positive control: with no server cap the 5:00 setting stands', async () => {
        const rb = await fresh();
        await rb.armNative();
        expect(armCfg()?.ringMs).toBe(300_000);
    });

    test('the picker path is clamped the same way', async () => {
        const rb = await fresh();
        await rb.arm({ maxSeconds: 120 });
        expect(armCfg()?.ringMs).toBe(122_000);
    });

    test('a repick keeps the cap the session was armed with', async () => {
        const rb = await fresh();
        await rb.arm({ maxSeconds: 60 });
        expect(armCfg()?.ringMs).toBe(62_000);
        posted.length = 0;
        await pastWipeGrace(() => rb.arm({ repick: true })); // a repick disarms first
        expect(armCfg()?.ringMs).toBe(62_000);
    });
});
