/**
 * A mesh peer's EXTRA audio stream — neither their voice stream nor an
 * announced screen share — is held until the server announces a share.
 *
 * Why it matters for SPEAK: receivers refuse a denied member's VOICE stream
 * (speakGate.ts), but the manager used to hand any second audio stream to the
 * screen-share path unconditionally. A client that ignores the rule could send
 * its mic as that second stream and be played as "share audio". The STREAM
 * bit is enforced on the ScreenShareStarted announcement, so audio with no
 * announcement behind it gets the same treatment as unannounced video (B7).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';

class FakePc {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    createDataChannel() { return { close() { /* fake */ } } as unknown as RTCDataChannel; }
    getSenders() { return []; }
    getTransceivers() { return []; }
    addTransceiver() { return {}; }
    close() { /* no-op */ }
}

beforeEach(() => { vi.stubGlobal('RTCPeerConnection', FakePc); });
afterEach(() => vi.unstubAllGlobals());

const audioArrival = (streamId: string) => ({ track: { kind: 'audio', id: `t-${streamId}` }, streams: [{ id: streamId }] });

async function setup() {
    const mgr = new WebRTCManager();
    const voice: string[] = [];
    const share: string[] = [];
    mgr.setLocalUserId(1);
    mgr.setOnRemoteStream((_uid, s) => { voice.push(s.id); });
    mgr.setOnScreenShareStream((_uid, s) => { share.push(s.id); });
    await mgr.callUser(2);
    const pc = (mgr as unknown as { peers: Map<number, { connection: FakePc }> }).peers.get(2)!.connection;
    return { mgr, pc, voice, share };
}

describe('extra mesh audio needs a share announcement', () => {
    it('POSITIVE CONTROL: the first audio stream is the voice stream and is delivered', async () => {
        const { pc, voice, share } = await setup();
        pc.ontrack!(audioArrival('voice'));
        expect(voice).toEqual(['voice']);
        expect(share).toEqual([]);
    });

    it('holds a second audio stream when no share is announced', async () => {
        const { pc, voice, share } = await setup();
        pc.ontrack!(audioArrival('voice'));
        pc.ontrack!(audioArrival('smuggled'));
        expect(share, 'not played as share audio').toEqual([]);
        expect(voice).toEqual(['voice']);
    });

    it('releases the held stream when the share is announced', async () => {
        const { mgr, pc, share } = await setup();
        pc.ontrack!(audioArrival('voice'));
        pc.ontrack!(audioArrival('share-audio'));
        mgr.setPeerSharing(2, true, null);
        expect(share).toEqual(['share-audio']);
    });

    it('delivers share audio immediately when the share was announced first', async () => {
        const { mgr, pc, share } = await setup();
        mgr.setPeerSharing(2, true, null);
        pc.ontrack!(audioArrival('voice'));
        pc.ontrack!(audioArrival('share-audio'));
        expect(share).toEqual(['share-audio']);
    });

    it('a share STOP drops the held stream instead of playing it', async () => {
        const { mgr, pc, share } = await setup();
        pc.ontrack!(audioArrival('voice'));
        pc.ontrack!(audioArrival('smuggled'));
        mgr.setPeerSharing(2, false);
        mgr.setPeerSharing(2, true, null);
        expect(share).toEqual([]);
    });
});
