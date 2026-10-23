// @vitest-environment jsdom
/**
 * SECURITY POSITIVE CONTROL, third half: "Require encryption for calls"
 * switched on IN THE MIDDLE OF A CALL, on an engine with no WebRTC Encoded
 * Transform API (Firefox, Safari, iOS, the WebKit desktop shells).
 *
 * THE BUG. On those engines nothing enforces the setting per frame: there is
 * no transform to read `requireE2ee`. What each peer is sent and shown is
 * settled when the peer is BUILT (addLocalMediaToPeer, ontrack) and when each
 * track is published (publishBlockedByEnforcement). setRequireMediaE2ee only
 * flipped the flag. So a member who joined with the setting off and then
 * turned it on, or whose server owner turned the server's policy on, kept
 * sending the mic, camera and share already on those connections as plain
 * DTLS-SRTP, and kept hearing everyone, while the panel switched to "media is
 * blocked both ways here".
 *
 * These tests FAIL against a manager whose setRequireMediaE2ee only flips the
 * flag: nothing is closed, and the connection that carried the mic stays up.
 * The controls are the other half: turning it back off must bring the media
 * back (or the member has to rejoin), and an engine that CAN encrypt must not
 * be rebuilt, because there the transforms already enforce it on every frame.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));

import { WebRTCManager } from '../api/rtc/manager';

/** Every connection the manager built, in order, with what was put on it. */
const pcs: FakeRTCPeerConnection[] = [];

class FakeRTCPeerConnection {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    connectionState = 'new';
    signalingState = 'stable';
    added: string[] = [];
    closed = false;
    constructor() { pcs.push(this); }
    getSenders() { return []; }
    getTransceivers() { return []; }
    addTrack(track: { kind: string; id: string }) {
        this.added.push(track.id);
        return { track, replaceTrack: () => Promise.resolve() };
    }
    addTransceiver() { return {}; }
    createDataChannel() { return { close: () => {} }; }
    close() { this.closed = true; }
}

/** Swap the capability probe `isMediaE2eeSupported()` reads. */
function setEncodedTransformSupport(supported: boolean) {
    class FakeSender {}
    if (supported) {
        (FakeSender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
    }
    vi.stubGlobal('RTCRtpSender', FakeSender);
}

/** WebCrypto and the ICE-config fetch resolve on macrotasks: drain those. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const mic = { kind: 'audio', id: 'mic', enabled: true, readyState: 'live', stop: () => {} };
const camera = { kind: 'video', id: 'camera', enabled: true, readyState: 'live', stop: () => {} };
const screen = { kind: 'video', id: 'screen', enabled: true, readyState: 'live', stop: () => {}, addEventListener: () => {} };

/** In a call with peer 2, sending a mic, a camera and a screen share. */
async function inCall(opts: { supported: boolean; required: boolean }) {
    setEncodedTransformSupport(opts.supported);
    const mgr = new WebRTCManager();
    mgr.setLocalUserId(1);
    mgr.setRequireMediaE2ee(opts.required);
    const local = { id: 'local', getTracks: () => [mic, camera], getAudioTracks: () => [mic], getVideoTracks: () => [camera] };
    const share = { id: 'share', getTracks: () => [screen], getAudioTracks: () => [], getVideoTracks: () => [screen] };
    const media = (mgr as unknown as { media: { getLocalStreamSync: () => unknown; getScreenShareStreamSync: () => unknown } }).media;
    media.getLocalStreamSync = () => local;
    media.getScreenShareStreamSync = () => share;
    await mgr.callUser(2);
    await settle();
    return mgr;
}

beforeEach(() => {
    pcs.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('"Require encryption for calls" changed mid-call on an engine that cannot encrypt', () => {
    it('SECURITY: turned ON, the connection carrying the mic, camera and share is closed', async () => {
        const mgr = await inCall({ supported: false, required: false });
        expect(pcs, 'precondition: one connection, carrying all three tracks').toHaveLength(1);
        expect(pcs[0].added).toEqual(['mic', 'camera', 'screen']);

        mgr.setRequireMediaE2ee(true);
        await settle();

        // Closing it is what stops both directions at once: no RTP leaves on
        // its senders, and every track it was receiving ends.
        expect(pcs[0].closed, 'plaintext media kept flowing on the old connection after enforcement went on').toBe(true);
    });

    it('SECURITY: turned ON, the replacement connection is sent nothing and shows nothing', async () => {
        const mgr = await inCall({ supported: false, required: false });
        let surfaced = false;
        mgr.setOnRemoteStream(() => { surfaced = true; });

        mgr.setRequireMediaE2ee(true);
        await settle();

        const fresh = pcs[pcs.length - 1];
        expect(pcs.length, 'the peer was rebuilt').toBe(2);
        expect(fresh.added, 'a plaintext track reached the rebuilt connection').toEqual([]);
        const track = { kind: 'audio', id: 'their-voice' };
        fresh.ontrack?.({ track, streams: [{ id: 'theirs', getTracks: () => [track] }], receiver: {} });
        expect(surfaced, 'their unencrypted voice played after enforcement went on').toBe(false);
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'local-unsupported', enforced: true, encrypted: false });
    });

    it('CONTROL: turned OFF again, the media comes back without a rejoin', async () => {
        const mgr = await inCall({ supported: false, required: true });
        expect(pcs[0].added, 'precondition: joined blocked').toEqual([]);

        mgr.setRequireMediaE2ee(false);
        await settle();

        expect(pcs[0].closed).toBe(true);
        expect(pcs[pcs.length - 1].added, 'turning the setting off left the call silent until a rejoin')
            .toEqual(['mic', 'camera', 'screen']);
    });

    it('CONTROL: an engine that CAN encrypt is not rebuilt (its transforms enforce every frame)', async () => {
        const mgr = await inCall({ supported: true, required: false });

        mgr.setRequireMediaE2ee(true);
        await settle();

        expect(pcs, 'a supported engine was rebuilt for nothing').toHaveLength(1);
        expect(pcs[0].closed).toBe(false);
        const peer = (mgr as unknown as { peers: Map<number, { mediaCrypto: { requireE2ee: boolean } }> }).peers.get(2)!;
        expect(peer.mediaCrypto.requireE2ee, 'the transforms read this flag on every frame').toBe(true);
    });

    it('CONTROL: an unchanged value rebuilds nothing (settingsChanged fires for every setting)', async () => {
        const mgr = await inCall({ supported: false, required: true });

        mgr.setRequireMediaE2ee(true);
        await settle();

        expect(pcs).toHaveLength(1);
        expect(pcs[0].closed).toBe(false);
    });
});
