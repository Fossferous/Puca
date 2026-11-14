// @vitest-environment jsdom
/**
 * ONE CAPTURE OF A SURFACE, NOT TWO (replayBuffer.ts followShareCapture,
 * docs/CLIPS.md "Sharing while armed"). A picker-armed clip buffer and a
 * screen share of the SAME surface used to capture it twice. Now the ring
 * moves onto a clone of the share's track and stops its own capture — and
 * only when that costs the clip nothing:
 *
 *  - same surface (the picker's deviceId) and the same frame rate, or the
 *    ring keeps its own capture;
 *  - the worker must take the clone (its frames are the encoder's size);
 *    refused, the clone is stopped and the ring's own capture kept;
 *  - followed, the ring's own VIDEO track stops and its system-audio track
 *    does not; the clone is watched for 'ended' instead, and outlives the
 *    share (stopping the share's track leaves it alone);
 *  - teardown stops the clone; a native arm is never followed;
 *  - rtc/media.ts tells every listener about each new share capture.
 * jsdom has no media: tracks, the worker and the track processor are
 * stand-ins that record what was done to them.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/clips/nativeCapture', () => ({
    isNativeCaptureSupported: () => true,
    preferredLoopbackDeviceName: async () => null,
    startNativeVideo: async () => ({ target: { outputIndex: 0, width: 1920, height: 1080, reason: 'primary', bitrate: 6_000_000 }, stop: async () => { } }),
    startNativeSystemAudioTrack: async () => { throw new Error('no loopback in this test'); },
}));
vi.mock('../api/platform', async (orig) => ({ ...(await orig<typeof import('../api/platform')>()), isTauri: () => true, isMobile: () => false, isAndroidApp: () => false }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => null }));
vi.mock('../api/captureBar', () => ({ hideCaptureBar: () => { }, releaseCaptureBar: () => { } }));

/** The share half: what rtc/media.ts offers the ring. */
const hub = vi.hoisted(() => {
    const listeners = new Set<(t: unknown) => void>();
    return {
        listeners,
        live: null as unknown,
        onShareCapture(cb: (t: unknown) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; },
        getScreenShareStreamSync() { return hub.live ? { getVideoTracks: () => [hub.live] } : null; },
    };
});
vi.mock('../api/webrtc', () => ({
    webrtcManager: { getLocalStreamSync: () => null, onMicTrackSwapped: () => () => { }, media: hub },
}));

type Listener = () => void;
class Track {
    readyState: 'live' | 'ended' = 'live';
    stopped = false;
    clones: Track[] = [];
    constraints: unknown[] = [];
    private ended = new Set<Listener>();
    kind: string; settings: Record<string, unknown>; label: string;
    constructor(kind: string, settings: Record<string, unknown>, label = 'rig') { this.kind = kind; this.settings = settings; this.label = label; }
    getSettings() { return { ...this.settings }; }
    addEventListener(t: string, l: Listener) { if (t === 'ended') this.ended.add(l); }
    removeEventListener(t: string, l: Listener) { if (t === 'ended') this.ended.delete(l); }
    stop() { this.stopped = true; this.readyState = 'ended'; }
    /** The SOURCE ended (the shared window closed): every track of it. */
    endSource() { for (const t of [this, ...this.clones]) { t.readyState = 'ended'; for (const l of t.ended) l(); } }
    clone() { const c = new Track(this.kind, this.settings, this.label); this.clones.push(c); return c; }
    async applyConstraints(c: unknown) { this.constraints.push(c); }
}

/** The worker: records messages; answers rebindVideo as told. */
let answer: 'ok' | 'size' | 'never' = 'ok';
const posted: { t: string;[k: string]: unknown }[] = [];
const workers: StubWorker[] = [];
/** The worker the session made last. */
const worker = () => workers[workers.length - 1];
class StubWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null; onerror: unknown = null;
    constructor(_u: unknown, _o?: unknown) { workers.push(this); }
    postMessage(m: { t: string; seq?: number }) {
        posted.push(m);
        if (m.t === 'rebindVideo' && answer !== 'never') {
            const reply = answer === 'ok' ? { t: 'videoRebound', seq: m.seq, ok: true, width: 1920, height: 1080 } : { t: 'videoRebound', seq: m.seq, ok: false, reason: 'size', width: 1280, height: 720 };
            queueMicrotask(() => this.onmessage?.({ data: reply }));
        }
        if (m.t === 'wipe') queueMicrotask(() => this.onmessage?.({ data: { t: 'wiped' } }));
    }
    terminate() { }
}
const processed: Track[] = [];
class StubProcessor { readable = new ReadableStream(); constructor(o: { track: Track }) { processed.push(o.track); } }

let ownVideo: Track, ownAudio: Track;
const SCREEN = { deviceId: 'screen:2:0', displaySurface: 'monitor', frameRate: 30, width: 1920, height: 1080 };

const gdm = () => navigator.mediaDevices.getDisplayMedia as unknown as { mockResolvedValue: (v: unknown) => void };
let rb: typeof import('../api/clips/replayBuffer');
beforeEach(async () => {
    vi.resetModules();
    posted.length = 0; processed.length = 0; workers.length = 0; answer = 'ok';
    hub.listeners.clear(); hub.live = null;
    vi.stubGlobal('Worker', StubWorker);
    vi.stubGlobal('MediaStreamTrackProcessor', StubProcessor);
    vi.stubGlobal('VideoEncoder', function VideoEncoder() { });
    vi.stubGlobal('AudioContext', class {
        state = 'running'; currentTime = 0;
        createMediaStreamDestination() { return { channelCount: 2, connect() { }, stream: { getAudioTracks: () => [{ kind: 'audio' }] } }; }
        createMediaStreamSource() { return { connect: (n: unknown) => n, disconnect() { } }; }
        createGain() { return { gain: { value: 1 }, connect: (n: unknown) => n, disconnect() { } }; }
        async resume() { } async close() { }
    });
    ownVideo = new Track('video', SCREEN);
    ownAudio = new Track('audio', {});
    // setup.ts defines navigator.mediaDevices for good; its mocks take values.
    gdm().mockResolvedValue({ getVideoTracks: () => [ownVideo], getAudioTracks: () => [ownAudio], getTracks: () => [ownVideo, ownAudio] });
    rb = await import('../api/clips/replayBuffer');
});
afterEach(async () => {
    vi.useRealTimers();
    await rb?.disarm('test').catch(() => { });
});

const share = (over: Record<string, unknown> = {}) => new Track('video', { ...SCREEN, ...over });
/** The worker's ring is running: what it posts once its arm() is done. */
const workerArmed = () => worker().onmessage!({ data: { t: 'armed', videoCodec: 'avc1.640028', audioCodec: null, width: 1920, height: 1080 } });
async function armByHand() { await rb.arm({ maxSeconds: 120 }); workerArmed(); }
const rebinds = () => posted.filter(m => m.t === 'rebindVideo');

describe('followShareCapture', () => {
    test('a share of the same surface: the ring reads its clone and stops its own video capture, not its audio', async () => {
        await armByHand();
        const s = share();
        for (const l of hub.listeners) l(s); // rtc/media.ts announcing the share
        await vi.waitFor(() => expect(rb.getReplayState().sharedCapture).toBe(true));
        expect(rebinds()).toHaveLength(1);
        expect(s.clones).toHaveLength(1);
        const clone = s.clones[0];
        expect(processed).toContain(clone);
        // Constrained the way the ring's own capture was: the clip preset.
        expect(clone.constraints[0]).toMatchObject({ width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } });
        expect(ownVideo.stopped).toBe(true);
        expect(ownAudio.stopped).toBe(false);
        expect(clone.stopped).toBe(false);
        expect(s.stopped).toBe(false); // the share's own track is the share's
    });

    test('the clone outlives the share, and its source ending disarms the ring', async () => {
        await armByHand();
        const s = share();
        expect(await rb.followShareCapture(s as unknown as MediaStreamTrack)).toBe('followed');
        s.stop(); // the share ends from the app: its tracks stop, the clone does not
        expect(s.clones[0].stopped).toBe(false);
        expect(rb.getReplayState().phase).not.toBe('idle');
        // The old track's end is no longer the ring's business...
        ownVideo.endSource();
        expect(rb.getReplayState().phase).not.toBe('idle');
        // ...the clone's source ending is.
        s.endSource();
        await vi.waitFor(() => expect(rb.getReplayState().phase).toBe('idle'), { timeout: 4000 });
        expect(rb.getReplayState().notice).toMatch(/Screen capture ended/);
    });

    test('teardown stops the clone', async () => {
        await armByHand();
        const s = share();
        expect(await rb.followShareCapture(s as unknown as MediaStreamTrack)).toBe('followed');
        await rb.disarm('user');
        expect(s.clones[0].stopped).toBe(true);
        expect(s.stopped).toBe(false);
        expect(hub.listeners.size).toBe(0);
    });

    test('another surface, or another frame rate: the ring keeps its own capture', async () => {
        await armByHand();
        const other = share({ deviceId: 'screen:3:0' });
        expect(await rb.followShareCapture(other as unknown as MediaStreamTrack)).toBe('other-surface');
        const win = share({ deviceId: 'window:123:0', displaySurface: 'window' });
        expect(await rb.followShareCapture(win as unknown as MediaStreamTrack)).toBe('other-surface');
        const fast = share({ frameRate: 60 });
        expect(await rb.followShareCapture(fast as unknown as MediaStreamTrack)).toBe('frame-rate');
        const slow = share({ frameRate: 15 });
        expect(await rb.followShareCapture(slow as unknown as MediaStreamTrack)).toBe('frame-rate');
        expect(rebinds()).toHaveLength(0);
        for (const t of [other, win, fast, slow]) expect(t.clones).toHaveLength(0);
        expect(ownVideo.stopped).toBe(false);
        expect(rb.getReplayState().sharedCapture).toBe(false);
    });

    test('the worker refusing (another size): the clone is stopped and the ring keeps its own capture', async () => {
        await armByHand();
        answer = 'size';
        const s = share();
        expect(await rb.followShareCapture(s as unknown as MediaStreamTrack)).toBe('size');
        expect(s.clones[0].stopped).toBe(true);
        expect(ownVideo.stopped).toBe(false);
        expect(rb.getReplayState().sharedCapture).toBe(false);
        // Its own capture is still the one watched.
        ownVideo.endSource();
        await vi.waitFor(() => expect(rb.getReplayState().phase).toBe('idle'), { timeout: 4000 });
    });

    test('a share already live when the ring is armed is followed once the worker has armed, not before', async () => {
        hub.live = share();
        await rb.arm({ maxSeconds: 120 });
        await new Promise(r => setTimeout(r, 20));
        // The worker is still inside its arm(): a rebind now would be refused.
        expect(rebinds()).toHaveLength(0);
        workerArmed();
        await vi.waitFor(() => expect(rb.getReplayState().sharedCapture).toBe(true));
        expect(ownVideo.stopped).toBe(true);
    });

    test('a share announced before the worker has armed waits for it', async () => {
        await rb.arm({ maxSeconds: 120 });
        const s = share();
        expect(await rb.followShareCapture(s as unknown as MediaStreamTrack)).toBe('busy');
        expect(rebinds()).toHaveLength(0);
        workerArmed();
        await vi.waitFor(() => expect(rb.getReplayState().sharedCapture).toBe(true));
    });

    test('a clone that never delivers a frame is stopped after the wait, and the ring keeps its own', async () => {
        await armByHand();
        vi.useFakeTimers();
        answer = 'never';
        const s = share();
        const out = rb.followShareCapture(s as unknown as MediaStreamTrack);
        await vi.advanceTimersByTimeAsync(rb.FOLLOW_FIRST_FRAME_MS + 1);
        expect(s.clones[0].stopped).toBe(true); // its stream ends; the worker then answers 'ended'
        const seq = rebinds()[0].seq as number;
        worker().onmessage!({ data: { t: 'videoRebound', seq, ok: false, reason: 'ended' } });
        expect(await out).toBe('refused');
        expect(ownVideo.stopped).toBe(false);
    });

    test('a share announced while another is being followed is tried after it, not dropped', async () => {
        await armByHand();
        const first = share({ deviceId: 'screen:2:0' });
        const second = share();
        const a = rb.followShareCapture(first as unknown as MediaStreamTrack);
        expect(await rb.followShareCapture(second as unknown as MediaStreamTrack)).toBe('busy');
        expect(await a).toBe('followed');
        // The second share (the newer one) is followed once the first is done.
        await vi.waitFor(() => expect(second.clones).toHaveLength(1));
        await vi.waitFor(() => expect(first.clones[0].stopped).toBe(true));
        expect(second.clones[0].stopped).toBe(false);
        expect(rebinds()).toHaveLength(2);
    });

    test('a follow that throws before the worker answers stops its clone', async () => {
        await armByHand();
        vi.stubGlobal('MediaStreamTrackProcessor', class { constructor() { throw new Error('no processor'); } });
        const s = share();
        expect(await rb.followShareCapture(s as unknown as MediaStreamTrack)).toBe('refused');
        expect(s.clones[0].stopped).toBe(true);
        expect(ownVideo.stopped).toBe(false);
        // And the next share can still be followed.
        vi.stubGlobal('MediaStreamTrackProcessor', StubProcessor);
        expect(await rb.followShareCapture(share() as unknown as MediaStreamTrack)).toBe('followed');
    });

    test('a native (auto) arm is never followed', async () => {
        await rb.armNative({ maxSeconds: 120 });
        expect(await rb.followShareCapture(share() as unknown as MediaStreamTrack)).toBe('native');
        expect(rebinds()).toHaveLength(0);
    });

    test('nothing armed: nothing to follow', async () => {
        expect(await rb.followShareCapture(share() as unknown as MediaStreamTrack)).toBe('no-session');
    });
});

describe('rtc/media.ts announces each share capture', () => {
    test('a listener hears the share\'s video track; one that throws does not break the share', async () => {
        const { MediaManager } = await import('../api/rtc/media');
        const m = new MediaManager();
        const video = { kind: 'video', contentHint: '', getSettings: () => ({}), stop() { } };
        const stream = { getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] };
        gdm().mockResolvedValue(stream);
        const heard: unknown[] = [];
        m.onShareCapture(() => { throw new Error('a broken listener'); });
        const off = m.onShareCapture((t) => heard.push(t));
        expect(await m.getScreenShareStream({ width: 1920, height: 1080, fps: 30 })).toBe(stream);
        expect(heard).toEqual([video]);
        off();
        await m.getScreenShareStream({ width: 1920, height: 1080, fps: 30 });
        expect(heard).toHaveLength(1);
    });
});
