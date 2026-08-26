import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MediaManager } from '../api/rtc/media';

/**
 * A Bluetooth headset walking out of range used to kill a call's audio with
 * no way back short of leaving and rejoining: the raw capture track died
 * inside the noise graph while the PUBLISHED Web Audio track kept emitting
 * silence, so nothing above the media layer ever noticed. These pin the
 * detection half of the fix — the raw track's death must surface as a
 * 'sovereign:mic-device-lost' event, and rawMicState() must expose
 * device-level truth for the devicechange evaluation.
 *
 * The default noise mode is 'standard' at gain 1, so processAudioStream is a
 * pass-through here and the "raw" track is also the published one — the
 * arming code path is the same one the ML modes run.
 */

class FakeTrack extends EventTarget {
    kind = 'audio';
    enabled = true;
    muted = false;
    readyState: 'live' | 'ended' = 'live';
    private settings: MediaTrackSettings;
    constructor(settings: MediaTrackSettings = {}) {
        super();
        this.settings = settings;
    }
    getSettings() { return this.settings; }
    stop() { this.readyState = 'ended'; } // scripted stop: NO 'ended' event (spec)
}

class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* not needed here */ }
    removeEventListener() { /* not needed here */ }
}

let getUserMedia: ReturnType<typeof vi.fn>;
let lostEvents: Array<{ kind?: string }>;
const onLost = (e: Event) => { lostEvents.push((e as CustomEvent<{ kind?: string }>).detail ?? {}); };

function domError(name: string): DOMException {
    try { return new DOMException('test', name); }
    catch { const e = new Error('test'); e.name = name; return e as unknown as DOMException; }
}

beforeEach(() => {
    getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    lostEvents = [];
    window.addEventListener('sovereign:mic-device-lost', onLost);
});

afterEach(() => {
    window.removeEventListener('sovereign:mic-device-lost', onLost);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('mic device-loss detection', () => {
    it('dispatches mic-device-lost when the raw capture track ends', async () => {
        const track = new FakeTrack();
        getUserMedia.mockResolvedValue(new FakeStream([track]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);

        track.readyState = 'ended';
        track.dispatchEvent(new Event('ended'));

        expect(lostEvents).toEqual([{ kind: 'ended' }]);
    });

    it('dispatches after a mute that persists 3 s', async () => {
        vi.useFakeTimers();
        const track = new FakeTrack();
        getUserMedia.mockResolvedValue(new FakeStream([track]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);

        track.muted = true;
        track.dispatchEvent(new Event('mute'));
        await vi.advanceTimersByTimeAsync(3000);

        expect(lostEvents).toEqual([{ kind: 'muted' }]);
    });

    it('does NOT dispatch when the mute clears within 3 s', async () => {
        vi.useFakeTimers();
        const track = new FakeTrack();
        getUserMedia.mockResolvedValue(new FakeStream([track]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);

        track.muted = true;
        track.dispatchEvent(new Event('mute'));
        await vi.advanceTimersByTimeAsync(1500);
        track.muted = false;
        track.dispatchEvent(new Event('unmute'));
        await vi.advanceTimersByTimeAsync(10000);

        expect(lostEvents).toEqual([]);
    });

    it('ignores a late ended from a capture torn down on purpose', async () => {
        const track = new FakeTrack();
        getUserMedia.mockResolvedValue(new FakeStream([track]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);

        media.stopLocalStream();
        // Some engines fire a late 'ended' for a track the OS reclaims after
        // we stopped it — that is not a device loss.
        track.dispatchEvent(new Event('ended'));

        expect(lostEvents).toEqual([]);
    });

    it('moves the watch to the fresh track on reacquire', async () => {
        const first = new FakeTrack();
        const second = new FakeTrack();
        getUserMedia
            .mockResolvedValueOnce(new FakeStream([first]))
            .mockResolvedValueOnce(new FakeStream([second]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        const res = await media.reacquireAudioTrack();
        expect(res?.newTrack).toBe(second as unknown as MediaStreamTrack);

        // The superseded capture's death is stale news...
        first.dispatchEvent(new Event('ended'));
        expect(lostEvents).toEqual([]);
        // ...the live one's is not (positive control for the line above).
        second.dispatchEvent(new Event('ended'));
        expect(lostEvents).toEqual([{ kind: 'ended' }]);
    });
});

describe('rawMicState', () => {
    it('exposes the raw track device identity and liveness', async () => {
        const track = new FakeTrack({ deviceId: 'bt-headset', groupId: 'grp-1' });
        getUserMedia.mockResolvedValue(new FakeStream([track]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);

        expect(media.rawMicState()).toEqual({
            ended: false, muted: false, deviceId: 'bt-headset', groupId: 'grp-1',
        });

        track.muted = true;
        track.readyState = 'ended';
        expect(media.rawMicState()).toMatchObject({ ended: true, muted: true });
    });

    it('is null with no capture open (listen-only join, teardown)', async () => {
        getUserMedia.mockRejectedValue(domError('NotFoundError'));
        const media = new MediaManager();
        await media.getLocalStream(true, false); // degrades listen-only
        expect(media.rawMicState()).toBeNull();

        getUserMedia.mockResolvedValue(new FakeStream([new FakeTrack()]));
        const media2 = new MediaManager();
        await media2.getLocalStream(true, false);
        expect(media2.rawMicState()).not.toBeNull();
        media2.stopLocalStream();
        expect(media2.rawMicState()).toBeNull();
    });
});
