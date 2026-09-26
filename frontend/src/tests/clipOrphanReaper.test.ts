/**
 * THE ORPHAN NATIVE-CAPTURE REAPER: replayBuffer.reapOrphanNativeCapture stops
 * a native clip capture (DXGI + hardware encode, WASAPI loopback) that runs
 * while the page owns no clip session — the one state nothing on screen admits
 * to — and never one that a session owns, is arming, or is still tearing down.
 *
 * The contract pinned here: it acts only on the SECOND consecutive sighting of
 * the SAME generations (disarm() drops the session before its native stop
 * lands, so one sighting may be a teardown in flight); it stops by exactly the
 * generations it saw; it logs what it did to puca.log; an armed session — or
 * one armed while the status call was in flight — is never touched; and
 * wireSystemSuspendHook runs it once a minute.
 *
 * jsdom has no audio graph or worker: clipMixLead.test.ts's stubs arm a session.
 */
// @vitest-environment jsdom
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

type Status = { video: number | null; audio: number | null };
let status: Status = { video: null, audio: null };
/** When set, clip_capture_status waits on this before answering. */
let statusGate: Promise<void> | null = null;
const calls: [string, unknown][] = [];
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: unknown) => {
        calls.push([cmd, args]);
        if (cmd === 'clip_capture_status') { if (statusGate) await statusGate; return status; }
        return null;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => { } }));
vi.mock('../api/clips/nativeCapture', () => ({
    isNativeCaptureSupported: () => true,
    preferredLoopbackDeviceName: async () => null,
    startNativeVideo: async () => ({ target: { outputIndex: 0, width: 1280, height: 720, reason: 'primary', bitrate: 8_000_000 }, stop: async () => { } }),
    startNativeSystemAudioTrack: async () => { throw new Error('no loopback device'); },
}));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('../api/captureBar', () => ({ hideCaptureBar: () => { }, releaseCaptureBar: () => { } }));
vi.mock('../api/webrtc', () => ({
    webrtcManager: { getLocalStreamSync: () => null, onMicTrackSwapped: () => () => { } },
}));

class StubAudioContext {
    state = 'running'; currentTime = 0;
    constructor(_o?: unknown) { }
    createMediaStreamDestination() { return { connect() { }, disconnect() { }, stream: { getAudioTracks: () => [{ kind: 'audio' }] } }; }
    createMediaStreamSource() { return { connect() { }, disconnect() { } }; }
    createGain() { return { connect() { }, disconnect() { }, gain: { value: 1 } }; }
    async resume() { }
    async close() { }
}
class StubWorker {
    onmessage: unknown = null; onerror: unknown = null;
    constructor(_u: unknown, _o?: unknown) { }
    postMessage() { }
    terminate() { }
}
class StubProcessor { readable = new ReadableStream(); constructor(_o: unknown) { } }

const stops = () => calls.filter(([c]) => c.startsWith('stop_clip_'));
const logged = () => calls.filter(([c]) => c === 'log_stream_diag').map(([, a]) => (a as { line: string }).line);

async function rb() {
    const m = await import('../api/clips/replayBuffer');
    return m;
}

beforeEach(async () => {
    calls.length = 0; status = { video: null, audio: null }; statusGate = null;
    vi.stubGlobal('AudioContext', StubAudioContext);
    vi.stubGlobal('Worker', StubWorker);
    vi.stubGlobal('MediaStreamTrackProcessor', StubProcessor);
    const m = await rb();
    m.__resetReplayForTests();
    m.__stopOrphanReaperForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => { });
});
afterEach(async () => {
    vi.useRealTimers();
    (await rb()).__stopOrphanReaperForTests();
    vi.restoreAllMocks();
});

describe('the orphan native-capture reaper', () => {
    test('an unowned capture is stopped on the SECOND sighting, by exactly the generations seen, and logged', async () => {
        const m = await rb();
        status = { video: 7, audio: 3 };
        expect(await m.reapOrphanNativeCapture(), 'one sighting may be a teardown in flight').toBeNull();
        expect(stops()).toEqual([]);
        expect(await m.reapOrphanNativeCapture()).toEqual({ video: 7, audio: 3 });
        expect(stops()).toEqual([
            ['stop_clip_video_capture', { generation: 7 }],
            ['stop_clip_desktop_audio', { generation: 3 }],
        ]);
        expect(logged()).toEqual(['clips: stopped a native capture no clip session owned (video generation 7, audio generation 3)']);
    });

    test('a video-only orphan stops only the video', async () => {
        const m = await rb();
        status = { video: 12, audio: null };
        await m.reapOrphanNativeCapture();
        expect(await m.reapOrphanNativeCapture()).toEqual({ video: 12, audio: null });
        expect(stops()).toEqual([['stop_clip_video_capture', { generation: 12 }]]);
    });

    test('different generations on the two checks are two teardowns, not an orphan', async () => {
        const m = await rb();
        status = { video: 7, audio: 3 };
        await m.reapOrphanNativeCapture();
        status = { video: 8, audio: 3 };
        expect(await m.reapOrphanNativeCapture()).toBeNull();
        expect(stops()).toEqual([]);
        // ...but the new generation is now the sighting, and a third check reaps it
        expect(await m.reapOrphanNativeCapture()).toEqual({ video: 8, audio: 3 });
        expect(stops()[0]).toEqual(['stop_clip_video_capture', { generation: 8 }]);
    });

    test('a clean check in between resets the sighting', async () => {
        const m = await rb();
        status = { video: 7, audio: null };
        await m.reapOrphanNativeCapture();
        status = { video: null, audio: null };
        expect(await m.reapOrphanNativeCapture()).toBeNull();
        status = { video: 7, audio: null };
        expect(await m.reapOrphanNativeCapture()).toBeNull();
        expect(stops()).toEqual([]);
    });

    test('nothing running: nothing stopped, nothing logged', async () => {
        const m = await rb();
        expect(await m.reapOrphanNativeCapture()).toBeNull();
        expect(await m.reapOrphanNativeCapture()).toBeNull();
        expect(stops()).toEqual([]);
        expect(logged()).toEqual([]);
    });

    test('an ARMED session\'s capture is never touched, however many checks', async () => {
        const m = await rb();
        await m.armNative();
        expect(m.getReplayState().phase).toBe('armed');
        status = { video: 1, audio: null };
        for (let i = 0; i < 3; i++) expect(await m.reapOrphanNativeCapture()).toBeNull();
        expect(stops()).toEqual([]);
        expect(calls.some(([c]) => c === 'clip_capture_status'), 'it does not even ask while a session exists').toBe(false);
    });

    test('a session armed WHILE the status call is in flight is never touched', async () => {
        const m = await rb();
        status = { video: 1, audio: null };
        await m.reapOrphanNativeCapture(); // first sighting (e.g. a teardown in flight)
        let open!: () => void;
        statusGate = new Promise<void>(r => { open = r; });
        const pending = m.reapOrphanNativeCapture(); // would be the confirming sighting...
        await m.armNative(); // ...but the user arms before the shell answers
        open();
        expect(await pending).toBeNull();
        expect(stops()).toEqual([]);
    });

    test('wireSystemSuspendHook runs it once a minute, and only once however often it is wired', async () => {
        vi.useFakeTimers();
        const m = await rb();
        await m.wireSystemSuspendHook();
        await m.wireSystemSuspendHook(); // App remounts must not stack a second timer
        status = { video: 5, audio: 2 };
        await vi.advanceTimersByTimeAsync(m.ORPHAN_REAP_MS - 1);
        expect(calls.filter(([c]) => c === 'clip_capture_status')).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls.filter(([c]) => c === 'clip_capture_status')).toHaveLength(1);
        expect(stops()).toEqual([]);
        await vi.advanceTimersByTimeAsync(m.ORPHAN_REAP_MS);
        expect(calls.filter(([c]) => c === 'clip_capture_status')).toHaveLength(2);
        expect(stops()).toEqual([
            ['stop_clip_video_capture', { generation: 5 }],
            ['stop_clip_desktop_audio', { generation: 2 }],
        ]);
    });
});
