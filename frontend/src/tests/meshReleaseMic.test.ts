/**
 * WebRTCManager.releaseMic — SPEAK withdrawn mid-call on a mesh call.
 *
 * The member's own client closes its microphone and stops sending it to every
 * peer with replaceTrack(null), which keeps each transceiver (so they still
 * RECEIVE) with no renegotiation. The senders must be found by TRACK
 * IDENTITY, never by kind: a member who is sharing their screen has a second
 * audio sender carrying the share's audio, and SPEAK does not govern that
 * (Stream does). Clearing every audio sender would silence the share too.
 *
 * FakePc pattern from meshExtraAudioHeld.test.ts; the senders are installed
 * by hand so each one's track is known.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';

class FakeTrack {
    enabled = true;
    readyState: 'live' | 'ended' = 'live';
    kind: 'audio' | 'video';
    id: string;
    constructor(kind: 'audio' | 'video', id: string) { this.kind = kind; this.id = id; }
    getSettings() { return {}; }
    stop() { this.readyState = 'ended'; }
}

class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}

class FakeSender {
    replaced: Array<FakeTrack | null> = [];
    track: FakeTrack | null;
    private fail: boolean;
    constructor(track: FakeTrack | null, fail = false) { this.track = track; this.fail = fail; }
    async replaceTrack(t: FakeTrack | null) {
        this.replaced.push(t);
        if (this.fail) throw new Error('peer gone');
        this.track = t;
    }
}

class FakePc {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    senders: FakeSender[] = [];
    createDataChannel() { return { close() { /* fake */ } } as unknown as RTCDataChannel; }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    addTransceiver() { return {}; }
    close() { /* no-op */ }
}

let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.stubGlobal('RTCPeerConnection', FakePc);
    getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    localStorage.clear();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** In a mesh call with peers 2 (and optionally 3), our mic open. */
async function setup(peerIds: number[] = [2]) {
    const mic = new FakeTrack('audio', 'mic');
    getUserMedia.mockResolvedValue(new FakeStream([mic]));
    const mgr = new WebRTCManager();
    mgr.setLocalUserId(1);
    for (const id of peerIds) await mgr.callUser(id);
    await mgr.getLocalStream(true, false);
    const peers = (mgr as unknown as { peers: Map<number, { connection: FakePc }> }).peers;
    const pcOf = (id: number) => {
        const pc = peers.get(id)?.connection;
        expect(pc, `peer ${id} was built`).toBeTruthy();
        return pc!;
    };
    return { mgr, mic, pcOf };
}

describe('WebRTCManager.releaseMic', () => {
    it('clears ONLY the mic sender; the screen-share audio sender keeps its track', async () => {
        const { mgr, mic, pcOf } = await setup();
        const shareAudio = new FakeTrack('audio', 'share-audio'); // same KIND as the mic
        const shareVideo = new FakeTrack('video', 'share-video');
        const micSender = new FakeSender(mic);
        const shareAudioSender = new FakeSender(shareAudio);
        const shareVideoSender = new FakeSender(shareVideo);
        pcOf(2).senders = [shareAudioSender, micSender, shareVideoSender];

        await mgr.releaseMic();

        // POSITIVE CONTROL: the mic sender really was cleared.
        expect(micSender.replaced).toEqual([null]);
        expect(micSender.track).toBeNull();
        expect(mic.readyState, 'the capture itself is closed').toBe('ended');
        // The share is Stream's business, not Speak's.
        expect(shareAudioSender.replaced, 'share audio must keep flowing').toEqual([]);
        expect(shareAudioSender.track).toBe(shareAudio);
        expect(shareAudio.readyState).toBe('live');
        expect(shareVideoSender.replaced).toEqual([]);
        expect(mgr.getLocalStreamSync()?.getAudioTracks()).toHaveLength(0);
    });

    it('clears the mic sender on EVERY peer, and one failing peer does not stop the rest', async () => {
        const { mgr, mic, pcOf } = await setup([2, 3]);
        const gone = new FakeSender(mic, true); // replaceTrack rejects: peer went away
        const live = new FakeSender(mic);
        pcOf(2).senders = [gone];
        pcOf(3).senders = [live];

        await expect(mgr.releaseMic()).resolves.toBeUndefined();

        expect(gone.replaced).toEqual([null]);
        expect(live.replaced).toEqual([null]);
    });

    it('touches no sender when there is no mic to release', async () => {
        const { mgr, pcOf } = await setup();
        const shareAudioSender = new FakeSender(new FakeTrack('audio', 'share-audio'));
        pcOf(2).senders = [shareAudioSender];
        await mgr.releaseMic(); // releases the mic (no sender carried it)
        await mgr.releaseMic(); // nothing left to release

        expect(shareAudioSender.replaced).toEqual([]);
    });
});
