/**
 * The mesh control lane is ONE NEGOTIATED channel per peer connection.
 *
 * The first cut created it in-band on both ends and let the registry close
 * the duplicate that arrived. An arrived channel is the peer's own channel,
 * so each end closed the other's — measured 2026-09-06 with two live
 * Chromium peers: both locals CLOSED within a second of opening, and every
 * remote-control session rode the WebSocket relay (client → Cloudflare →
 * server → Cloudflare → client, per mouse move) while the code believed it
 * had a P2P path. Nothing in the suite could see it: every test registered
 * ONE fake channel per peer.
 *
 * This pins the shape that makes the lane exist: `negotiated: true` with the
 * shared stream id, created at pc construction, registered for the peer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';
import { CTL_STATE_LABEL, CTL_STREAM_ID, controlChannels, resetControlChannels } from '../api/rtc/controlDc';

class FakeDc {
    readyState: RTCDataChannelState = 'connecting';
    binaryType = 'blob';
    bufferedAmount = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    negotiated: boolean;
    id: number | null;
    constructor(public label: string, init?: RTCDataChannelInit) {
        this.negotiated = !!init?.negotiated;
        this.id = init?.id ?? null;
    }
    send() { /* no-op */ }
    close() { this.readyState = 'closed'; this.onclose?.(); }
}

const created: Array<{ label: string; init: RTCDataChannelInit | undefined; dc: FakeDc }> = [];

class FakePc {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    ondatachannel: ((ev: { channel: RTCDataChannel }) => void) | null = null;
    connectionState = 'new';
    createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
        const dc = new FakeDc(label, init);
        created.push({ label, init, dc });
        return dc as unknown as RTCDataChannel;
    }
    getSenders() { return []; }
    getTransceivers() { return []; }
    addTransceiver() { return {}; }
    close() { /* no-op */ }
}

beforeEach(() => {
    created.length = 0;
    resetControlChannels();
    vi.stubGlobal('RTCPeerConnection', FakePc);
});
afterEach(() => vi.unstubAllGlobals());

describe('the mesh control lane', () => {
    it('is created NEGOTIATED on the shared stream id, ordered, at pc construction', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        await mgr.callUser(2);

        expect(created, 'exactly one lane per peer connection').toHaveLength(1);
        expect(created[0].label).toBe(CTL_STATE_LABEL);
        expect(created[0].init).toMatchObject({ ordered: true, negotiated: true, id: CTL_STREAM_ID });
    });

    it('is registered for the peer, so a hello can arm it', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        await mgr.callUser(2);
        expect(controlChannels(2)?.state).toBe(created[0].dc as unknown as RTCDataChannel);
        expect(controlChannels(2)?.helloSeen, 'open is not a capability').toEqual({ host: false, viewer: false });
    });

    it('uses a stream id in-band allocation never hands out (0/1 by DTLS role)', () => {
        expect(CTL_STREAM_ID).toBeGreaterThan(1);
    });

    it('still adopts an OLDER peer\'s announced channel — that peer holds no other', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);
        await mgr.callUser(2);
        const ours = created[0].dc;
        ours.readyState = 'open';
        // The peer's in-band channel arrives. It is the only channel that
        // peer will ever read, so it becomes the lane; ours closes.
        const theirs = new FakeDc(CTL_STATE_LABEL, { ordered: true });
        theirs.readyState = 'open';
        const pcs = (mgr as unknown as { peers: Map<number, { connection: FakePc }> }).peers;
        pcs.get(2)!.connection.ondatachannel!({ channel: theirs as unknown as RTCDataChannel });
        expect(controlChannels(2)?.state).toBe(theirs as unknown as RTCDataChannel);
        expect(ours.readyState, 'only OUR half is closed').toBe('closed');
        expect(theirs.readyState).toBe('open');
    });
});
