// @vitest-environment jsdom
/**
 * SECURITY POSITIVE CONTROL, second half: "Require encryption for calls" must
 * fail CLOSED for the CAMERA and the SCREEN SHARE too, not only for the
 * microphone (audit 2026-10, docs/AUDIT_2026-10.md).
 *
 * THE BUG. mediaE2eeEnforcement.test.ts pins the guard in addLocalMediaToPeer,
 * which covers the tracks present when a peer is BUILT. A camera turned on or
 * a share started mid-call reaches the peers through publishCameraTrack /
 * toggleVideo / switchCamera / addScreenShareToPeers, which added the track and
 * called wireSender — a no-op without the Encoded Transform API. So on
 * Safari, iOS, Firefox and the WebKit shells the setting blocked the mic at
 * join and then let the camera and the screen go out as plain DTLS-SRTP, while
 * the panel said media was blocked. docs/SECURITY_MODEL.md §4 describes the
 * H-3 fix as "making both directions fail closed"; this is the part it missed.
 *
 * These tests FAIL against the pre-fix manager: remove the
 * publishBlockedByEnforcement call from any of the four paths and the matching
 * case goes red. The paired cases are the other half of the control: a manager
 * that refused to publish video for EVERYONE would satisfy the security
 * assertions on its own, and must not be able to pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));

import { WebRTCManager } from '../api/rtc/manager';

const addedTracks: string[] = [];

class FakeRTCPeerConnection {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    connectionState = 'new';
    getSenders() { return []; }
    getTransceivers() { return []; }
    addTrack(track: { kind: string }) {
        addedTracks.push(track.kind);
        return { track, replaceTrack: () => Promise.resolve() };
    }
    addTransceiver() { return {}; }
    close() { /* no-op */ }
}

/** Swap the capability probe `isMediaE2eeSupported()` reads. */
function setEncodedTransformSupport(supported: boolean) {
    class FakeSender {}
    if (supported) {
        (FakeSender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
    }
    vi.stubGlobal('RTCRtpSender', FakeSender);
}

type MediaStub = {
    getLocalStreamSync: () => unknown;
    getScreenShareStreamSync: () => unknown;
    toggleVideo: (on: boolean) => Promise<unknown>;
    switchCamera: (mode: string) => Promise<unknown>;
};

const cameraTrack = { kind: 'video', id: 'v1', enabled: true, readyState: 'live', stop: () => {} };
const screenTrack = { kind: 'video', id: 'sv1', enabled: true, readyState: 'live', stop: () => {}, addEventListener: () => {} };

/** A manager whose MediaManager hands out a mic stream, a camera on request
 *  and a screen share, without touching any real device. */
function rig(opts: { supported: boolean; required: boolean }) {
    setEncodedTransformSupport(opts.supported);
    const mgr = new WebRTCManager();
    mgr.setLocalUserId(1);
    mgr.setRequireMediaE2ee(opts.required);
    const mic = { kind: 'audio', id: 'a1', enabled: true, stop: () => {} };
    const stream = { id: 's1', getTracks: () => [mic], getAudioTracks: () => [mic], getVideoTracks: () => [] as unknown[] };
    const screen = { id: 'scr', getTracks: () => [screenTrack], getAudioTracks: () => [], getVideoTracks: () => [screenTrack] };
    const media = (mgr as unknown as { media: MediaStub }).media;
    media.getLocalStreamSync = () => stream;
    media.getScreenShareStreamSync = () => screen;
    media.toggleVideo = async () => cameraTrack;
    media.switchCamera = async () => cameraTrack;
    return mgr;
}

/** Join with the mic only, then forget the mic's addTrack so each assertion
 *  is about the camera or the share alone. */
async function joined(opts: { supported: boolean; required: boolean }) {
    const mgr = rig(opts);
    await mgr.callUser(2);
    addedTracks.length = 0;
    return mgr;
}

beforeEach(() => {
    addedTracks.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('camera and screen share fail closed without Encoded Transform', () => {
    it('SECURITY: toggleVideo publishes NO camera track when encryption is required and unsupported', async () => {
        const mgr = await joined({ supported: false, required: true });
        await mgr.toggleVideo(true);
        expect(addedTracks, 'a plaintext camera must never reach the wire while enforcement is on').toEqual([]);
    });

    it('SECURITY: publishCameraTrack publishes nothing when encryption is required and unsupported', async () => {
        const mgr = await joined({ supported: false, required: true });
        mgr.publishCameraTrack(cameraTrack as unknown as MediaStreamTrack);
        expect(addedTracks).toEqual([]);
    });

    it('SECURITY: switchCamera publishes nothing when encryption is required and unsupported', async () => {
        const mgr = await joined({ supported: false, required: true });
        await mgr.switchCamera('user');
        expect(addedTracks).toEqual([]);
    });

    it('SECURITY: addScreenShareToPeers publishes NO share when encryption is required and unsupported', async () => {
        const mgr = await joined({ supported: false, required: true });
        await mgr.addScreenShareToPeers();
        expect(addedTracks, 'a plaintext screen share must never reach the wire while enforcement is on').toEqual([]);
    });

    it('SECURITY: the refusal is reported as local-unsupported on the peer', async () => {
        const mgr = await joined({ supported: false, required: true });
        await mgr.addScreenShareToPeers();
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'local-unsupported', enforced: true, encrypted: false });
    });

    it('CONTROL: the camera and the share publish when the API IS available (not a blanket refusal)', async () => {
        const mgr = await joined({ supported: true, required: true });
        await mgr.toggleVideo(true);
        await mgr.addScreenShareToPeers();
        expect(addedTracks, 'a supported browser must still publish, or the guard refuses everyone').toEqual(['video', 'video']);
    });

    it('CONTROL: the camera and the share publish when enforcement is OFF, even unsupported (documented downgrade)', async () => {
        const mgr = await joined({ supported: false, required: false });
        mgr.publishCameraTrack(cameraTrack as unknown as MediaStreamTrack);
        await mgr.addScreenShareToPeers();
        expect(addedTracks).toEqual(['video', 'video']);
    });
});
