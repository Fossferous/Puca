// @vitest-environment jsdom
/**
 * The client half of the stream-only bundle (docs/STREAM_ONLY.md), off the
 * wire and in the media layer:
 *
 *  - the restricting permission bits read through isRestricted (never hasPerm,
 *    which an ADMINISTRATOR passes for every bit);
 *  - VoiceSpeakState's `receives`, parsed from the SAME fixtures the server's
 *    protocol tests compare against;
 *  - NO RECEIVE on the mesh: a flagged peer is sent no track, at creation and
 *    mid-call, and a member flagged itself plays nothing it is sent;
 *  - NO RECEIVE on the SFU: the grant's canSubscribe;
 *  - "Join without a microphone": no getUserMedia for audio, listen-only, and
 *    no re-acquire path can open one.
 *
 * Every positive assertion has its negative control beside it (an unflagged
 * peer, a member with a microphone), so none passes for the wrong reason.
 * FakePc pattern from meshReleaseMic.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';
import { MediaManager } from '../api/rtc/media';
import { parseVoiceSpeakState } from '../api/rtc/speakGate';
import { subscribeAllowed } from '../api/rtc/sfuManager';
import { PERM, PERMISSIONS, hasPerm, isRestricted } from '../api/permissionBits';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

class FakeTrack {
    enabled = true;
    muted = false;
    readyState: 'live' | 'ended' = 'live';
    kind: 'audio' | 'video';
    id: string;
    constructor(kind: 'audio' | 'video', id: string) { this.kind = kind; this.id = id; }
    getSettings() { return {}; }
    stop() { this.readyState = 'ended'; }
    addEventListener() { /* not needed */ }
    removeEventListener() { /* not needed */ }
}

class FakeStream {
    id = 'stream-' + Math.random().toString(36).slice(2);
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[]) { this.tracks = [...tracks]; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    addTrack(t: FakeTrack) { this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
    addEventListener() { /* not needed */ }
    removeEventListener() { /* not needed */ }
}

class FakeSender {
    replaced: Array<FakeTrack | null> = [];
    track: FakeTrack | null;
    constructor(track: FakeTrack | null) { this.track = track; }
    async replaceTrack(t: FakeTrack | null) { this.replaced.push(t); this.track = t; }
    getParameters() { return { encodings: [{}] }; }
    async setParameters() { /* fake */ }
}

class FakePc {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    senders: FakeSender[] = [];
    added: FakeTrack[] = [];
    transceivers: string[] = [];
    createDataChannel() { return { close() { /* fake */ } } as unknown as RTCDataChannel; }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    addTransceiver(kind: string, init?: { direction?: string }) { this.transceivers.push(`${kind}:${init?.direction}`); return {}; }
    addTrack(track: FakeTrack) {
        this.added.push(track);
        const s = new FakeSender(track);
        this.senders.push(s);
        return s;
    }
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

const audioAsks = () => getUserMedia.mock.calls
    .map(c => c[0] as MediaStreamConstraints)
    .filter(c => !!c && c.audio !== false && c.audio !== undefined);

describe('the restricting bits', () => {
    it('are bits 29 and 30, in both maps (permissions.rs pins the same text)', () => {
        expect(PERM.STREAM_ONLY).toBe(2 ** 29);
        expect(PERM.NO_RECEIVE).toBe(2 ** 30);
        expect(PERMISSIONS.STREAM_ONLY).toBe(PERM.STREAM_ONLY);
        expect(PERMISSIONS.NO_RECEIVE).toBe(PERM.NO_RECEIVE);
        expect(PERM.NO_RECEIVE).toBeGreaterThan(0); // not the sign bit
    });
    it('are read with isRestricted: an ADMINISTRATOR is never restricted', () => {
        const so = PERM.VIEW_CHANNEL | PERM.CONNECT | PERM.STREAM | PERM.STREAM_ONLY;
        expect(isRestricted(so, PERM.STREAM_ONLY)).toBe(true);
        expect(isRestricted(so | PERM.ADMINISTRATOR, PERM.STREAM_ONLY)).toBe(false);
        expect(isRestricted(PERM.VIEW_CHANNEL, PERM.STREAM_ONLY)).toBe(false);
        expect(isRestricted(undefined, PERM.STREAM_ONLY), 'an older server sends no bits').toBe(false);
        // Why not hasPerm: it says an administrator HAS the restriction.
        expect(hasPerm(PERM.ADMINISTRATOR, PERM.STREAM_ONLY)).toBe(true);
    });
});

describe('VoiceSpeakState.receives', () => {
    it('is false only when the server says so (the fixtures src/protocol.rs pins)', () => {
        const plain = parseVoiceSpeakState(fixture('voiceSpeakState.json'));
        const noReceive = parseVoiceSpeakState(fixture('voiceSpeakStateNoReceive.json'));
        const streamOnly = parseVoiceSpeakState(fixture('voiceSpeakStateStreamOnly.json'));
        expect(plain).toEqual({ room_id: 'voice_42', user_id: 7, can_speak: false, receives: true, stream_only: false });
        expect(noReceive).toEqual({ room_id: 'voice_42', user_id: 7, can_speak: false, receives: false, stream_only: false });
        expect(streamOnly).toEqual({ room_id: 'voice_42', user_id: 7, can_speak: false, receives: false, stream_only: true });
    });
    it('refuses a receives or stream_only that is not a boolean rather than guessing', () => {
        const junk = { type: 'VoiceSpeakState', payload: { room_id: 'voice_1', user_id: 1, can_speak: true, receives: 'no' } };
        expect(parseVoiceSpeakState(junk)).toBeNull();
        const junk2 = { type: 'VoiceSpeakState', payload: { room_id: 'voice_1', user_id: 1, can_speak: true, stream_only: 1 } };
        expect(parseVoiceSpeakState(junk2)).toBeNull();
    });
});

describe('NO RECEIVE on the SFU', () => {
    it('follows the grant canSubscribe; absent reads as allowed, like LiveKit', () => {
        expect(subscribeAllowed({ canSubscribe: false })).toBe(false);
        expect(subscribeAllowed({ canSubscribe: true })).toBe(true);
        expect(subscribeAllowed(undefined)).toBe(true);
        expect(subscribeAllowed({})).toBe(true);
    });
});

/** A mesh call with our microphone open; peers built after `before` ran. */
async function meshCall(peerIds: number[], before?: (mgr: WebRTCManager) => void) {
    const mic = new FakeTrack('audio', 'mic');
    getUserMedia.mockResolvedValue(new FakeStream([mic]));
    const mgr = new WebRTCManager();
    mgr.setLocalUserId(1);
    await mgr.getLocalStream(true, false);
    before?.(mgr);
    for (const id of peerIds) await mgr.callUser(id);
    const peers = (mgr as unknown as { peers: Map<number, { connection: FakePc }> }).peers;
    const pcOf = (id: number) => {
        const pc = peers.get(id)?.connection;
        expect(pc, `peer ${id} was built`).toBeTruthy();
        return pc!;
    };
    return { mgr, mic, pcOf };
}

describe('NO RECEIVE on the mesh', () => {
    it('a flagged peer is built with no track of ours; an unflagged one gets the mic', async () => {
        const { mic, pcOf } = await meshCall([2, 3], (mgr) => mgr.setPeerReceives(2, false));
        expect(pcOf(2).added, 'nothing of ours goes to a no-receive peer').toEqual([]);
        expect(pcOf(2).transceivers, 'but we still negotiate to RECEIVE their stream').toEqual(['audio:recvonly']);
        expect(pcOf(3).added, 'negative control: everyone else hears us').toEqual([mic]);
    });

    it('mid-call: the flag takes our tracks off that peer only, and lifting it puts them back', async () => {
        const { mgr, mic, pcOf } = await meshCall([2, 3]);
        expect(pcOf(2).added).toEqual([mic]);
        const [toTwo] = pcOf(2).senders;
        const [toThree] = pcOf(3).senders;

        mgr.setPeerReceives(2, false);
        await Promise.resolve();
        expect(toTwo.replaced).toEqual([null]);
        expect(toThree.replaced, 'the other peer is untouched').toEqual([]);
        expect(mgr.sendsTo(2)).toBe(false);

        // A camera turned on now does not go to them either.
        const cam = new FakeTrack('video', 'cam');
        mgr.publishCameraTrack(cam as unknown as MediaStreamTrack);
        expect(pcOf(2).added).not.toContain(cam);
        expect(pcOf(3).added).toContain(cam);

        mgr.setPeerReceives(2, true);
        await new Promise(r => setTimeout(r, 0));
        expect(pcOf(2).added.filter(t => t === mic), 'the mic is sent again').toHaveLength(2);
        expect(mgr.sendsTo(2)).toBe(true);
    });

    it('a member flagged ITSELF plays nothing it is sent', async () => {
        const deliver = async (selfReceives: boolean) => {
            const { mgr, pcOf } = await meshCall([2]);
            mgr.setSelfReceives(selfReceives);
            const heard: number[] = [];
            mgr.setOnRemoteStream((uid) => { heard.push(uid); });
            const track = new FakeTrack('audio', 'their-mic');
            pcOf(2).ontrack?.({ track, streams: [new FakeStream([track])], receiver: {} });
            return heard;
        };
        expect(await deliver(false)).toEqual([]);
        expect(await deliver(true), 'negative control: a receiving member plays it').toEqual([2]);
    });
});

describe('Join without a microphone (MediaManager)', () => {
    it('never asks for the microphone, joins listen-only, and no re-acquire opens one', async () => {
        const media = new MediaManager();
        media.setMicOffByChoice(true);
        const stream = await media.getLocalStream(true, false);
        expect(stream.getTracks()).toHaveLength(0);
        expect(audioAsks(), 'no getUserMedia for audio: no prompt, no capture').toHaveLength(0);
        expect(media.isListenOnly()).toBe(true);
        expect(media.isSpeakDenied(), 'a choice, not a missing permission').toBe(false);
        expect(await media.reacquireAudioTrack()).toBeNull();
        expect(audioAsks()).toHaveLength(0);
        // Leaving re-reads the choice on the next join.
        media.stopLocalStream();
        expect(media.isMicOffByChoice()).toBe(false);
    });

    it('NEGATIVE CONTROL: without the choice the microphone is opened', async () => {
        getUserMedia.mockResolvedValue(new FakeStream([new FakeTrack('audio', 'mic')]));
        const media = new MediaManager();
        await media.getLocalStream(true, false);
        expect(audioAsks()).toHaveLength(1);
        expect(media.isListenOnly()).toBe(false);
    });
});
