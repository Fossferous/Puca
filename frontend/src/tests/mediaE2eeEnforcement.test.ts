/**
 * SECURITY POSITIVE CONTROL: "Require encryption for calls" must fail CLOSED on
 * a browser with no WebRTC Encoded Transform API.
 *
 * THE BUG (2026-08-20 pre-release audit). Enforcement lived entirely inside the
 * encrypt/decrypt transforms, and `wireSender` / `ontrack` decline to attach one
 * when `RTCRtpSender.prototype.createEncodedStreams` is absent — Safari/iOS,
 * Firefox, WKWebView. So on exactly those browsers the setting did nothing:
 * local tracks were added and went out as plain DTLS-SRTP, and inbound frames
 * were rendered unconditionally, while the UI told the user "Because encryption
 * is required for this call, media is blocked here"
 * (`mediaE2eeExplanation('local-unsupported', enforced=true)`).
 *
 * These tests FAIL against the pre-fix manager: revert either guard in
 * `addLocalMediaToPeer` / `ontrack` and the corresponding case goes red.
 *
 * The paired "supported" cases are the other half of the control: a manager that
 * simply refused to publish for EVERYONE would satisfy the security assertions
 * on its own, and must not be able to pass.
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

/** A local stream with one audio track, as a joined mic user would hold. */
function stubLocalStream(mgr: WebRTCManager) {
    const track = { kind: 'audio', id: 'a1', enabled: true, stop: () => {} };
    const stream = { id: 's1', getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
    (mgr as unknown as { media: { getLocalStreamSync: () => unknown } }).media.getLocalStreamSync = () => stream;
    return { track, stream };
}

beforeEach(() => {
    addedTracks.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('media-E2EE enforcement fails closed without Encoded Transform', () => {
    it('SECURITY: publishes NO local media when encryption is required and unsupported', async () => {
        setEncodedTransformSupport(false);
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        stubLocalStream(mgr);

        await mgr.callUser(2);

        expect(addedTracks, 'plaintext media must never reach the wire while enforcement is on').toEqual([]);
    });

    it('CONTROL: publishes local media when the API IS available (guard is not a blanket refusal)', async () => {
        setEncodedTransformSupport(true);
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        stubLocalStream(mgr);

        await mgr.callUser(2);

        expect(addedTracks, 'a supported browser must still publish, or the guard refuses everyone').toContain('audio');
    });

    it('CONTROL: publishes local media when enforcement is OFF, even unsupported (documented downgrade)', async () => {
        setEncodedTransformSupport(false);
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(false);
        stubLocalStream(mgr);

        await mgr.callUser(2);

        // Enforcement off is the DEFAULT and is a documented transport-only
        // downgrade, surfaced in the voice panel. It must keep working.
        expect(addedTracks).toContain('audio');
    });

    it('SECURITY: drops INBOUND tracks when encryption is required and unsupported', async () => {
        setEncodedTransformSupport(false);
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        stubLocalStream(mgr);

        let surfaced = false;
        mgr.onRemoteStream = () => { surfaced = true; };
        await mgr.callUser(2);

        const pc = (mgr as unknown as { peers: Map<number, { connection: FakeRTCPeerConnection }> })
            .peers.get(2)!.connection;
        const track = { kind: 'audio', id: 'r1' };
        pc.ontrack?.({ track, streams: [{ id: 'rs1', getTracks: () => [track] }], receiver: {} });

        expect(surfaced, 'unauthenticated inbound media must not be rendered while enforcement is on').toBe(false);
    });
});
