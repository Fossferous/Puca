/**
 * Regression tests for the duplicate-answer glare bug (perfect-negotiation
 * serialization, 2026-07-27).
 *
 * Field failure (reproduced by e2e/perfect-negotiation-2peer.mjs): makeOffer
 * ran directly from onnegotiationneeded, unserialized with the incoming-
 * description handler. Its arg-less setLocalDescription could execute while a
 * remote offer was mid-application ('have-remote-offer') and mint an ANSWER,
 * which shipped in an OFFER envelope; the handler's own later
 * setLocalDescription then minted an unintended OFFER shipped in the ANSWER
 * envelope. The remote treated that as a fresh offer and answered AGAIN — a
 * duplicate answer that hit the first side's now-stable pc as an
 * InvalidStateError and triggered a forced rebuild of a healthy call.
 *
 * The fix: makeOffer is enqueued on the same per-peer signaling chain as
 * incoming descriptions, offers only ever start from 'stable', both send
 * paths verify the implicit description's TYPE before shipping it, and an
 * answer landing on a stable pc is dropped instead of applied.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));

// Minimal event-emitting stand-in for the singleton wsClient: lets tests
// inject incoming Offer/Answer messages and capture outgoing signaling.
vi.mock('../api/websocket', () => {
    type Handler = (msg: { type: string; payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const wsClient = {
        sentOffers: [] as { to: number; json: string }[],
        sentAnswers: [] as { to: number; json: string }[],
        on(type: string, h: Handler) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type)!.add(h);
        },
        off(type: string, h: Handler) { handlers.get(type)?.delete(h); },
        emit(type: string, payload: unknown) {
            handlers.get(type)?.forEach(h => h({ type, payload }));
        },
        sendOffer(to: number, json: string) { wsClient.sentOffers.push({ to, json }); },
        sendAnswer(to: number, json: string) { wsClient.sentAnswers.push({ to, json }); },
        sendIceCandidate() { /* not exercised */ },
        _reset() {
            handlers.clear();
            wsClient.sentOffers.length = 0;
            wsClient.sentAnswers.length = 0;
        },
    };
    return { wsClient };
});

import { WebRTCManager } from '../api/rtc/manager';
import { wsClient } from '../api/websocket';

const fakeWs = wsClient as unknown as {
    sentOffers: { to: number; json: string }[];
    sentAnswers: { to: number; json: string }[];
    emit(type: string, payload: unknown): void;
    _reset(): void;
};

/** RTCPeerConnection stub with real signaling-state semantics for the arg-less
 *  setLocalDescription: its product depends on the state AT EXECUTION — the
 *  exact property the bug abused. */
class FakePC {
    static instances: FakePC[] = [];
    onicecandidate: ((e: unknown) => void) | null = null;
    onnegotiationneeded: (() => void) | null = null;
    ontrack: unknown = null;
    onconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    signalingState = 'stable';
    localDescription: { type: string; sdp: string } | null = null;
    remoteDescription: { type?: string; sdp?: string } | null = null;
    appliedRemote: { type?: string; sdp?: string }[] = [];
    closed = false;
    transceivers: { direction: string; sender: { track: unknown }; receiver: { track: unknown }; mid: string | null }[] = [];
    constructor() { FakePC.instances.push(this); }
    getSenders() { return []; }
    getTransceivers() { return this.transceivers; }
    addTransceiver(kind: string, init?: { direction?: string }) {
        const t = {
            direction: init?.direction ?? 'sendrecv',
            sender: { track: null as unknown },
            receiver: { track: { kind } as unknown },
            mid: null,
        };
        this.transceivers.push(t);
        return t;
    }
    async setRemoteDescription(desc: { type?: string; sdp?: string }) {
        // Mirror the real API's hard rule the duplicate-answer bug tripped:
        // an answer is only applicable while a local offer is outstanding.
        if (desc.type === 'answer' && this.signalingState !== 'have-local-offer') {
            throw new DOMException(
                `Failed to set remote answer sdp: Called in wrong state: ${this.signalingState}`,
                'InvalidStateError');
        }
        this.appliedRemote.push(desc);
        this.remoteDescription = desc;
        this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async setLocalDescription() {
        if (this.signalingState === 'have-remote-offer') {
            this.localDescription = { type: 'answer', sdp: 'v=0\r\nanswer' };
            this.signalingState = 'stable';
        } else {
            this.localDescription = { type: 'offer', sdp: 'v=0\r\noffer' };
            this.signalingState = 'have-local-offer';
        }
    }
    async addIceCandidate() { /* no-op */ }
    close() { this.closed = true; this.signalingState = 'closed'; }
}

/** Drain the per-peer signaling chains (real async gaps: ICE config fetch,
 *  description application). */
async function flush(times = 6) {
    for (let i = 0; i < times; i++) {
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}

beforeEach(() => {
    FakePC.instances = [];
    fakeWs._reset();
    vi.stubGlobal('RTCPeerConnection', FakePC);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('WebRTCManager negotiation serialization (duplicate-answer glare regression)', () => {
    it('a negotiationneeded racing an incoming offer yields ONE answer then ONE offer — right envelopes, right types', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1); // vs peer 10 → we are impolite (lower id), like peer A in the field failure

        await mgr.callUser(10);
        const pc = FakePC.instances[0];

        // The field interleaving: the remote's offer lands and, in the same
        // tick, track adds fire onnegotiationneeded. Unserialized, makeOffer's
        // arg-less setLocalDescription executed mid-offer-application and
        // minted an answer into the offer envelope.
        fakeWs.emit('Offer', {
            from_user: 10,
            sdp: JSON.stringify({ type: 'offer', sdp: 'v=0\r\nremote-offer', connId: 'R1' }),
        });
        pc.onnegotiationneeded!();
        await flush();

        // Exactly one answer, in the ANSWER envelope, answering the offer.
        expect(fakeWs.sentAnswers).toHaveLength(1);
        const answer = JSON.parse(fakeWs.sentAnswers[0].json);
        expect(answer.type).toBe('answer');
        expect(answer.answerTo).toBe('R1');
        // Exactly one offer, in the OFFER envelope — never an answer.
        expect(fakeWs.sentOffers).toHaveLength(1);
        expect(JSON.parse(fakeWs.sentOffers[0].json).type).toBe('offer');
        // The remote offer was applied to the pc exactly once.
        expect(pc.appliedRemote.filter(d => d.type === 'offer')).toHaveLength(1);
        mgr.closeAll();
    });

    it('drops a duplicate answer landing on a stable pc instead of applying it (no InvalidStateError)', async () => {
        const errSpy = vi.spyOn(console, 'error');
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        await mgr.callUser(10);
        const pc = FakePC.instances[0];
        pc.onnegotiationneeded!();
        await flush();
        expect(fakeWs.sentOffers).toHaveLength(1);
        const ourConnId = JSON.parse(fakeWs.sentOffers[0].json).connId as string;

        const answerJson = JSON.stringify({
            type: 'answer', sdp: 'v=0\r\nanswer', answerTo: ourConnId, connId: 'R1',
        });
        fakeWs.emit('Answer', { from_user: 10, sdp: answerJson });
        await flush();
        expect(pc.appliedRemote).toHaveLength(1);
        expect(pc.signalingState).toBe('stable');

        // The same answer again (old-client double-send / crossed a rollback):
        // must be DROPPED before setRemoteDescription — attempting to apply it
        // threw InvalidStateError into the console (the e2e suite's glare
        // assertion) and force-rebuilt the healthy call.
        fakeWs.emit('Answer', { from_user: 10, sdp: answerJson });
        await flush();
        expect(pc.appliedRemote).toHaveLength(1); // unchanged
        expect(pc.closed).toBe(false);
        expect(FakePC.instances).toHaveLength(1); // no rebuild
        const srdErrors = errSpy.mock.calls.filter(c => /setRemoteDescription/.test(String(c[0])));
        expect(srdErrors).toHaveLength(0);
        mgr.closeAll();
        errSpy.mockRestore();
    });

    it('does not double-offer while our own offer is outstanding', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        await mgr.callUser(10);
        const pc = FakePC.instances[0];
        // Two negotiationneeded events before any answer arrives (e.g. tracks
        // added across an await gap). The second must bail — re-offering from
        // 'have-local-offer' put a second offer on the wire, and its second
        // answer is what detonated on the stable pc.
        pc.onnegotiationneeded!();
        pc.onnegotiationneeded!();
        await flush();

        expect(fakeWs.sentOffers).toHaveLength(1);
        expect(JSON.parse(fakeWs.sentOffers[0].json).type).toBe('offer');
        mgr.closeAll();
    });
});
