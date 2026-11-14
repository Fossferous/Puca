// @vitest-environment jsdom
/**
 * A mesh call: the camera turned OFF and ON again. The other side's tile
 * stayed frozen or black (e2e/android-camera-flip-live.mjs OFF_ON=1, 6 runs
 * in 7 on the emulator; the camera-rear hand-over).
 *
 * THE BUG. Turned off, the camera's track was stopped and left on its sender.
 * Turned on, publishCameraTrack addTrack()ed the new camera: a SECOND video
 * transceiver in the same stream (the voice stream, one msid), so the other
 * side's stream held two video tracks, the dead one first, and the <video>
 * a tile binds plays the first.
 *
 * THE FIX, both halves: the camera goes back on the sender it rode before
 * (turned off, that sender carries no track and its transceiver stops
 * sending; turned on, it sends again, which renegotiates, so the other side
 * is told of the track again), and a camera is delivered to the tiles as its
 * own track alone, so a peer on an older version, which still adds a second
 * one, is shown its live camera.
 *
 * The peer connection here follows the spec's rules where they matter:
 * addTrack makes a new transceiver unless one was never used to send, and
 * removeTrack / a direction leave the transceiver in place.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/websocket', () => ({ wsClient: { on: () => {}, off: () => {}, sendOffer: () => {}, sendAnswer: () => {}, sendIceCandidate: () => {} } }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));

import { WebRTCManager } from '../api/rtc/manager';

let ids = 0;
class FakeTrack {
    readonly id = `t${++ids}`;
    readyState: 'live' | 'ended' = 'live';
    enabled = true;
    muted = false;
    readonly kind: 'audio' | 'video';
    readonly label: string;
    constructor(kind: 'audio' | 'video', label: string = kind) { this.kind = kind; this.label = label; }
    stop() { this.readyState = 'ended'; }
    clone() { return new FakeTrack(this.kind, this.label); }
    getSettings() { return {}; }
    addEventListener() { /* nothing fires here */ }
    removeEventListener() { /* nothing */ }
}

class FakeStream {
    readonly id: string;
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = [], id = `s${++ids}`) { this.tracks = [...tracks]; this.id = id; }
    getTracks() { return [...this.tracks]; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    addTrack(t: FakeTrack) { if (!this.tracks.includes(t)) this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* nothing fires here */ }
    removeEventListener() { /* nothing */ }
}

class FakeSender {
    track: FakeTrack | null;
    constructor(track: FakeTrack | null) { this.track = track; }
    replaceTrack(t: FakeTrack | null) { this.track = t; return Promise.resolve(); }
    getParameters() { return { encodings: [{}] }; }
    setParameters() { return Promise.resolve(); }
}

type Direction = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
class FakeTransceiver {
    readonly sender: FakeSender;
    readonly receiver: { track: FakeTrack };
    currentDirection: Direction | 'stopped' | null = null;
    /** The stream ids its sender was added with (the msid the other side sees). */
    streams: string[];
    /** Has it ever carried our media? (spec: addTrack reuses only one that never has) */
    usedToSend: boolean;
    private dir: Direction;
    readonly kind: 'audio' | 'video';
    private pc: FakePeerConnection;
    constructor(kind: 'audio' | 'video', sender: FakeSender, dir: Direction, streams: string[], pc: FakePeerConnection) {
        this.kind = kind;
        this.pc = pc;
        this.sender = sender;
        this.receiver = { track: new FakeTrack(kind) };
        this.dir = dir;
        this.streams = streams;
        this.usedToSend = !!sender.track;
    }
    get direction(): Direction { return this.dir; }
    set direction(d: Direction) {
        if (d === this.dir) return;
        this.dir = d;
        this.pc.negotiations++;
    }
}

const pcs: FakePeerConnection[] = [];
class FakePeerConnection {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    oniceconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    signalingState = 'stable';
    iceConnectionState = 'new';
    transceivers: FakeTransceiver[] = [];
    negotiations = 0;
    constructor() { pcs.push(this); }
    getSenders() { return this.transceivers.map(t => t.sender); }
    getReceivers() { return this.transceivers.map(t => t.receiver); }
    getTransceivers() { return this.transceivers; }
    addTrack(track: FakeTrack, ...streams: FakeStream[]) {
        const reuse = this.transceivers.find(t => t.kind === track.kind && !t.sender.track && !t.usedToSend);
        this.negotiations++;
        if (reuse) {
            reuse.sender.track = track;
            reuse.usedToSend = true;
            reuse.streams = streams.map(s => s.id);
            reuse.direction = reuse.direction === 'recvonly' ? 'sendrecv' : 'sendonly';
            return reuse.sender;
        }
        const t = new FakeTransceiver(track.kind, new FakeSender(track), 'sendrecv', streams.map(s => s.id), this);
        this.transceivers.push(t);
        return t.sender;
    }
    addTransceiver(kind: 'audio' | 'video', init?: { direction?: Direction }) {
        const t = new FakeTransceiver(kind, new FakeSender(null), init?.direction ?? 'sendrecv', [], this);
        this.transceivers.push(t);
        return t;
    }
    removeTrack(sender: FakeSender) {
        const t = this.transceivers.find(x => x.sender === sender)!;
        sender.track = null;
        t.direction = t.direction === 'sendrecv' ? 'recvonly' : t.direction === 'sendonly' ? 'inactive' : t.direction;
    }
    createDataChannel() { return { close: () => {}, addEventListener: () => {} }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    async getStats() { return new Map(); }
    getConfiguration() { return {}; }
    close() { /* no-op */ }

    /** Our video transceivers: what the other side has an m-line (and a remote track) for. */
    video() { return this.transceivers.filter(t => t.kind === 'video'); }
}

/** A manager in a call with peer 2, its media a stand-in: a microphone, a
 *  camera opened by toggleVideo(true) (as MediaManager does: added to the
 *  local stream) and stopped and taken out by toggleVideo(false), a share. */
async function inCall(opts: { cameraAtJoin?: boolean } = {}) {
    const mgr = new WebRTCManager();
    mgr.setLocalUserId(1);
    mgr.setRequireMediaE2ee(false);
    const local = new FakeStream([new FakeTrack('audio', 'mic')], 'voice');
    let screen: FakeStream | null = null;
    const cameras: FakeTrack[] = [];
    const openCamera = () => {
        const cam = new FakeTrack('video', `camera ${cameras.length + 1}`);
        cameras.push(cam);
        local.addTrack(cam);
        return cam;
    };
    if (opts.cameraAtJoin) openCamera();
    const media = mgr.media as unknown as Record<string, unknown>;
    media.getLocalStreamSync = () => local;
    media.getScreenShareStreamSync = () => screen;
    media.toggleVideo = async (on: boolean) => {
        const v = local.getVideoTracks();
        if (on && v.length === 0) return openCamera();
        if (!on) v.forEach(t => { t.stop(); local.removeTrack(t); });
        return null;
    };
    media.flipCamera = async () => {
        local.getVideoTracks().forEach(t => { t.stop(); local.removeTrack(t); });
        return { ok: true, track: openCamera() };
    };
    media.cameraSwitchInProgress = () => false;
    media.stopScreenShare = () => { const was = !!screen; screen?.getTracks().forEach(t => t.stop()); screen = null; return was; };
    await mgr.callUser(2);
    const pc = pcs.at(-1)!;
    /** The panel's camera button: on acquires, then (once the server has
     *  echoed the announcement) publishes; off goes through toggleVideo. */
    const cameraOn = async () => {
        const cam = await mgr.acquireCamera();
        mgr.publishCameraTrack(cam!);
        await settle();
        return cam as unknown as FakeTrack;
    };
    const cameraOff = () => mgr.toggleVideo(false);
    const startShare = async () => {
        screen = new FakeStream([new FakeTrack('video', 'screen')], 'screen');
        await mgr.addScreenShareToPeers();
        return screen;
    };
    return { mgr, pc, local, cameras, cameraOn, cameraOff, startShare, stopShare: () => mgr.stopScreenShare() };
}

async function settle() {
    for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0));
}

beforeEach(() => {
    pcs.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
    // A MediaStream that keeps the tracks it is made with (setup.ts's drops them).
    vi.stubGlobal('MediaStream', FakeStream);
    // No Encoded Transform API, encryption not required: this is about which
    // sender a camera rides (the transform rides the sender: see Flip's tests).
    vi.stubGlobal('RTCRtpSender', class {});
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the camera turned off and on again (mesh), the sending side', () => {
    it('THE BUG: it goes back on the camera sender it rode, never a second video transceiver', async () => {
        const c = await inCall();
        const cam1 = await c.cameraOn();
        expect(c.pc.video()).toHaveLength(1);
        const [t] = c.pc.video();
        expect(t.sender.track).toBe(cam1);
        expect(t.streams, 'the camera rides the voice stream (the other side files it as the camera by that)').toEqual(['voice']);

        await c.cameraOff();
        expect(cam1.readyState).toBe('ended');
        expect(t.sender.track, 'the stopped camera is not left on the sender').toBeNull();
        expect(t.direction, 'no longer sending, still receiving (the other side\'s camera may ride it)').toBe('recvonly');

        const cam2 = await c.cameraOn();
        expect(c.pc.video(), 'one video transceiver: the other side has one camera track, the live one').toHaveLength(1);
        expect(c.pc.video()[0]).toBe(t);
        expect(t.sender.track).toBe(cam2);
        expect(t.direction, 'sending again: renegotiated, so the other side is told of the track again').toBe('sendrecv');
    });

    it('the same with the camera on when the peer was built (addLocalMediaToPeer), and over several turns', async () => {
        const c = await inCall({ cameraAtJoin: true });
        const [t] = c.pc.video();
        expect(t.sender.track).toBe(c.cameras[0]);
        for (let i = 0; i < 3; i++) {
            await c.cameraOff();
            expect(t.direction).toBe('recvonly');
            const cam = await c.cameraOn();
            expect(c.pc.video()).toHaveLength(1);
            expect(t.sender.track).toBe(cam);
            expect(t.direction).toBe('sendrecv');
        }
    });

    it('each turn renegotiates once (off: the other side drops the track; on: it is told of it again)', async () => {
        const c = await inCall();
        await c.cameraOn();
        const before = c.pc.negotiations;
        await c.cameraOff();
        expect(c.pc.negotiations - before).toBe(1);
        await c.cameraOn();
        expect(c.pc.negotiations - before).toBe(2);
    });

    it('Flip after the camera was turned off and on rides that same sender', async () => {
        const c = await inCall();
        await c.cameraOn();
        await c.cameraOff();
        await c.cameraOn();
        const [t] = c.pc.video();
        const before = c.pc.negotiations;
        const r = await c.mgr.flipCamera();
        expect(r.ok).toBe(true);
        expect(c.pc.video()).toHaveLength(1);
        expect(t.sender.track).toBe(c.cameras.at(-1));
        expect(c.pc.negotiations, 'a switch is a replaceTrack: no renegotiation').toBe(before);
    });

    it('a share\'s sender, its share over (no track, not sending, like a camera turned off), is never taken for the camera', async () => {
        const c = await inCall();
        await c.startShare();
        c.stopShare();
        const share = c.pc.video()[0];
        expect(share.sender.track).toBeNull();
        expect(share.direction).toBe('recvonly');
        const cam = await c.cameraOn();
        expect(share.sender.track, 'the camera on the share\'s m-line would be filed as a screen by the other side').toBeNull();
        const camT = c.pc.video().find(t => t.sender.track === cam)!;
        expect(camT).toBeTruthy();
        expect(camT.streams).toEqual(['voice']);
    });

    it('turned off while sharing: the share goes on, untouched', async () => {
        const c = await inCall();
        await c.cameraOn();
        const screen = await c.startShare();
        await c.cameraOff();
        const shareT = c.pc.video().find(t => t.streams.includes('screen'))!;
        expect(shareT.sender.track).toBe(screen.getVideoTracks()[0]);
        expect(shareT.direction).toBe('sendrecv');
        const cam = await c.cameraOn();
        expect(shareT.sender.track, 'the camera did not go on the share').toBe(screen.getVideoTracks()[0]);
        expect(c.pc.video().filter(t => t.streams.includes('voice'))).toHaveLength(1);
        expect(c.pc.video().find(t => t.streams.includes('voice'))!.sender.track).toBe(cam);
    });

    it('CONTROL: the microphone is left alone by the camera going off and on', async () => {
        const c = await inCall();
        const mic = c.local.getAudioTracks()[0];
        await c.cameraOn();
        await c.cameraOff();
        await c.cameraOn();
        const audio = c.pc.transceivers.filter(t => t.kind === 'audio');
        expect(audio).toHaveLength(1);
        expect(audio[0].sender.track).toBe(mic);
        expect(audio[0].direction).toBe('sendrecv');
    });
});

describe('the camera turned off and on again (mesh), the receiving side', () => {
    /** Peer 2's voice stream arriving, then its camera (announced first, B7). */
    async function viewer() {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(false);
        const media = mgr.media as unknown as Record<string, unknown>;
        media.getLocalStreamSync = () => new FakeStream([new FakeTrack('audio', 'mic')], 'mine');
        media.getScreenShareStreamSync = () => null;
        const shown: MediaStream[] = [];
        mgr.setOnCameraStream((_uid, s) => { shown.push(s); });
        mgr.setOnRemoteStream(() => {});
        await mgr.callUser(2);
        const pc = pcs.at(-1)!;
        const voice = new FakeStream([new FakeTrack('audio', 'their mic')], 'their-voice');
        pc.ontrack!({ track: voice.getAudioTracks()[0], receiver: { track: voice.getAudioTracks()[0] }, streams: [voice] });
        mgr.setPeerCamera(2, true);
        return { mgr, pc, voice, shown };
    }

    it('a peer that ADDED its camera again (0.9.862 and older): the tile is given the live camera, not the dead first track of the stream', async () => {
        const v = await viewer();
        const dead = new FakeTrack('video', 'their camera, turned off');
        dead.muted = true;
        const live = new FakeTrack('video', 'their camera, on again');
        v.voice.addTrack(dead);
        v.voice.addTrack(live);
        v.pc.ontrack!({ track: live, receiver: { track: live }, streams: [v.voice] });
        expect(v.shown).toHaveLength(1);
        expect(v.voice.getVideoTracks()[0], 'CONTROL: the stream it came in leads with the dead track').toBe(dead);
        expect(v.shown[0].getVideoTracks(), 'what a <video> plays: the first video track').toEqual([live]);
    });

    it('a camera held until announced is given alone too, when released', async () => {
        const v = await viewer();
        v.mgr.setPeerCamera(2, false);
        const dead = new FakeTrack('video', 'old');
        const live = new FakeTrack('video', 'new');
        v.voice.addTrack(dead);
        v.voice.addTrack(live);
        v.pc.ontrack!({ track: live, receiver: { track: live }, streams: [v.voice] });
        expect(v.shown, 'not announced: held').toHaveLength(0);
        v.mgr.setPeerCamera(2, true);
        expect(v.shown).toHaveLength(1);
        expect(v.shown[0].getVideoTracks()).toEqual([live]);
    });
});
