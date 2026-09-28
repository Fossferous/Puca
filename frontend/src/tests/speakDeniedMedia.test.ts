/**
 * MediaManager with SPEAK denied: the microphone is never opened.
 *
 * A member without SPEAK joins a voice channel listen-only. The rule is not
 * "open the mic and don't send it" — a permission prompt for a microphone
 * they may not use is itself the bug, and a hot capture nobody publishes can
 * still reach the clip buffer. Every path that can open a mic ends in
 * MediaManager: the join (getLocalStream), and every re-acquire (noise-mode
 * change, device watchdog, settings) through reacquireAudioTrack. These pin
 * that none of them calls getUserMedia for audio while denied, including the
 * race where the deny lands while a re-acquire is already awaiting a device.
 *
 * getUserMedia is a stub; the default noise mode ('standard', gain 1) makes
 * processAudioStream a pass-through, as in micDeviceWatch.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaManager } from '../api/rtc/media';

class FakeTrack extends EventTarget {
    enabled = true;
    muted = false;
    readyState: 'live' | 'ended' = 'live';
    kind: 'audio' | 'video';
    id: string;
    constructor(kind: 'audio' | 'video', id: string) { super(); this.kind = kind; this.id = id; }
    getSettings() { return {}; }
    stop() { this.readyState = 'ended'; } // scripted stop: no 'ended' event (spec)
}

class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* not needed here */ }
    removeEventListener() { /* not needed here */ }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let lostEvents: number;
const onLost = () => { lostEvents++; };

/** The constraints of every getUserMedia call that asked for AUDIO. */
const audioAsks = () => getUserMedia.mock.calls
    .map(c => c[0] as MediaStreamConstraints)
    .filter(c => !!c && c.audio !== false && c.audio !== undefined);

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

beforeEach(() => {
    getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    localStorage.clear();
    lostEvents = 0;
    window.addEventListener('sovereign:mic-device-lost', onLost);
});

afterEach(() => {
    window.removeEventListener('sovereign:mic-device-lost', onLost);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('MediaManager: POSITIVE CONTROL (SPEAK allowed)', () => {
    it('opens the mic through getUserMedia and returns its track', async () => {
        const mic = new FakeTrack('audio', 'mic');
        getUserMedia.mockResolvedValue(new FakeStream([mic]));
        const media = new MediaManager();

        const stream = await media.getLocalStream(true, false);

        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(audioAsks()).toHaveLength(1);
        expect(stream.getAudioTracks()).toEqual([mic]);
        expect(media.isListenOnly()).toBe(false);
        expect(media.isSpeakDenied()).toBe(false);
    });

    it('re-acquires a fresh mic track when allowed', async () => {
        const first = new FakeTrack('audio', 'first');
        const second = new FakeTrack('audio', 'second');
        getUserMedia
            .mockResolvedValueOnce(new FakeStream([first]))
            .mockResolvedValueOnce(new FakeStream([second]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);

        const res = await media.reacquireAudioTrack();

        expect(res?.newTrack).toBe(second as unknown as MediaStreamTrack);
        expect(getUserMedia).toHaveBeenCalledTimes(2);
    });
});

describe('MediaManager: SPEAK denied', () => {
    it('getLocalStream(audio) returns an EMPTY stream and never calls getUserMedia', async () => {
        const media = new MediaManager();
        media.setSpeakDenied(true);

        const stream = await media.getLocalStream(true, false);

        expect(stream, 'a valid handle, so the call can still be joined').toBeTruthy();
        expect(stream.getTracks()).toHaveLength(0);
        expect(getUserMedia, 'a denied member must never see a mic prompt').not.toHaveBeenCalled();
        expect(media.isListenOnly()).toBe(true);
    });

    it('getLocalStream(audio, video) asks for the CAMERA only', async () => {
        const cam = new FakeTrack('video', 'cam');
        getUserMedia.mockResolvedValue(new FakeStream([cam]));
        const media = new MediaManager();
        media.setSpeakDenied(true);

        const stream = await media.getLocalStream(true, true);

        expect(getUserMedia).toHaveBeenCalledTimes(1);
        const asked = getUserMedia.mock.calls[0][0] as MediaStreamConstraints;
        expect(asked.audio).toBe(false);
        expect(asked.video).toBeTruthy();
        expect(stream.getVideoTracks()).toEqual([cam]);
        expect(stream.getAudioTracks()).toHaveLength(0);
    });

    it('reacquireAudioTrack resolves null without calling getUserMedia (denied at join)', async () => {
        const media = new MediaManager();
        media.setSpeakDenied(true);
        await media.getLocalStream(true, false);

        await expect(media.reacquireAudioTrack()).resolves.toBeNull();
        expect(getUserMedia).not.toHaveBeenCalled();
    });

    it('reacquireAudioTrack resolves null without calling getUserMedia (denied after the mic opened)', async () => {
        getUserMedia.mockResolvedValue(new FakeStream([new FakeTrack('audio', 'mic')]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        expect(getUserMedia).toHaveBeenCalledTimes(1);

        media.setSpeakDenied(true);

        await expect(media.reacquireAudioTrack()).resolves.toBeNull();
        expect(getUserMedia, 'no second capture').toHaveBeenCalledTimes(1);
    });

    it('a deny that lands WHILE a re-acquire awaits the device: resolves null and stops the new capture', async () => {
        const old = new FakeTrack('audio', 'old');
        const fresh = new FakeTrack('audio', 'fresh');
        const pending = deferred<FakeStream>();
        getUserMedia
            .mockResolvedValueOnce(new FakeStream([old]))
            .mockReturnValueOnce(pending.promise);
        const media = new MediaManager();
        const local = await media.getLocalStream(true, false);

        const inFlight = media.reacquireAudioTrack(); // passes the entry check: still allowed
        await Promise.resolve();
        expect(getUserMedia).toHaveBeenCalledTimes(2); // the device is being opened
        media.setSpeakDenied(true);                  // ...and SPEAK is withdrawn now
        pending.resolve(new FakeStream([fresh]));

        await expect(inFlight).resolves.toBeNull();
        expect(fresh.readyState, 'the capture opened for nothing is closed').toBe('ended');
        expect(local.getAudioTracks(), 'never installed into the local stream').not.toContain(fresh);
    });

    it('releaseMic stops and removes every audio track, returns them, and leaves the camera alone', async () => {
        const mic = new FakeTrack('audio', 'mic');
        const cam = new FakeTrack('video', 'cam');
        getUserMedia.mockResolvedValue(new FakeStream([mic, cam]));
        const media = new MediaManager();
        const local = await media.getLocalStream(true, true);
        const swapped = vi.fn();
        media.onMicTrackSwapped(swapped);

        const removed = media.releaseMic();

        expect(removed).toEqual([mic]);
        expect(mic.readyState).toBe('ended');
        expect(local.getAudioTracks()).toHaveLength(0);
        expect(local.getVideoTracks()).toEqual([cam]);
        expect(cam.readyState).toBe('live');
        expect(swapped, 'VAD and the clip mic tap re-read the stream').toHaveBeenCalled();
    });

    it('releaseMic disarms the device watch, so the closed mic is not "recovered"', async () => {
        const mic = new FakeTrack('audio', 'mic');
        getUserMedia.mockResolvedValue(new FakeStream([mic]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        expect(media.rawMicState()).not.toBeNull();

        media.releaseMic();
        mic.dispatchEvent(new Event('ended'));

        expect(media.rawMicState()).toBeNull();
        expect(lostEvents, 'a deliberate close is not a device loss').toBe(0);
    });

    it('releaseMic with no local stream returns nothing', () => {
        expect(new MediaManager().releaseMic()).toEqual([]);
    });

    it('isListenOnly follows the deny', () => {
        const media = new MediaManager();
        expect(media.isListenOnly()).toBe(false);
        media.setSpeakDenied(true);
        expect(media.isListenOnly()).toBe(true);
        expect(media.isSpeakDenied()).toBe(true);
        media.setSpeakDenied(false);
        expect(media.isListenOnly()).toBe(false);
    });

    it('stopLocalStream resets the deny, so the next join decides SPEAK afresh', async () => {
        const media = new MediaManager();
        media.setSpeakDenied(true);
        await media.getLocalStream(true, false);

        media.stopLocalStream();

        expect(media.isSpeakDenied()).toBe(false);
        expect(media.isListenOnly()).toBe(false);
        getUserMedia.mockResolvedValue(new FakeStream([new FakeTrack('audio', 'mic')]));
        await media.getLocalStream(true, false);
        expect(audioAsks(), 'an allowed rejoin opens the mic again').toHaveLength(1);
    });
});
