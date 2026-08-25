/**
 * Regression tests for the leave/rejoin silent-audio bug (v0.5.90).
 *
 * A peer that rebuilds its RTCPeerConnection (leave/rejoin, ICE-failure
 * rebuild, stuck-pair recovery) offers from a FRESH pc. Applying that offer to
 * the stale pc the other side still holds throws the "m-lines order doesn't
 * match" InvalidAccessError and leaves the pc stable-but-deaf — the watchdog
 * saw 'stable', assumed recovery, and the pair stayed silent until a manual
 * rejoin. The fix mints a per-pc connId carried in every offer/answer:
 *  - an offer with a CHANGED connId ⇒ remote rebuilt ⇒ replace our pc too;
 *  - an answer whose answerTo isn't our current pc's connId ⇒ stale ⇒ drop;
 *  - descriptions without connIds (old clients) keep the legacy behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({
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

// The mock exposes helpers the real module doesn't; view it through that shape.
const fakeWs = wsClient as unknown as {
    sentOffers: { to: number; json: string }[];
    sentAnswers: { to: number; json: string }[];
    emit(type: string, payload: unknown): void;
    _reset(): void;
};

/** RTCPeerConnection stub with just enough signaling-state behavior for the
 *  perfect-negotiation handler: implicit setLocalDescription answers/offers
 *  and records every remote description applied. */
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
    // Transceivers: a listen-only client (no mic track) adds an explicit
    // recvonly audio transceiver so it still negotiates — model enough of the
    // real API for that path.
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
        // NOTE: a real pc fires negotiationneeded ASYNCHRONOUSLY here. These
        // tests drive offers explicitly, so the fake stays passive — firing it
        // synchronously would inject an extra offer and reorder the exchange.
        return t;
    }
    async setRemoteDescription(desc: { type?: string; sdp?: string }) {
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

function offerFrom(user: number, extra: Record<string, unknown> = {}) {
    fakeWs.emit('Offer', {
        from_user: user,
        sdp: JSON.stringify({ type: 'offer', sdp: 'v=0\r\nremote-offer', ...extra }),
    });
}

beforeEach(() => {
    FakePC.instances = [];
    fakeWs._reset();
    vi.stubGlobal('RTCPeerConnection', FakePC);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('WebRTCManager rejoin/rebuild detection (connId protocol)', () => {
    it('reuses the pc for renegotiation offers with the SAME connId', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        offerFrom(10, { connId: 'A' });
        await flush();
        offerFrom(10, { connId: 'A' });
        await flush();

        expect(FakePC.instances).toHaveLength(1);
        expect(FakePC.instances[0].appliedRemote).toHaveLength(2);
        // Both answers echo the offering pc's id.
        expect(fakeWs.sentAnswers).toHaveLength(2);
        for (const a of fakeWs.sentAnswers) {
            expect(JSON.parse(a.json).answerTo).toBe('A');
        }
        mgr.closeAll();
    });

    it('replaces the stale pc when an offer arrives with a NEW connId', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        offerFrom(10, { connId: 'A' });
        await flush();
        // The peer rebuilt (left + rejoined): fresh pc, fresh connId.
        offerFrom(10, { connId: 'B' });
        await flush();

        expect(FakePC.instances).toHaveLength(2);
        expect(FakePC.instances[0].closed).toBe(true);   // stale pc torn down
        expect(FakePC.instances[1].closed).toBe(false);
        // The rejoin offer was applied to the FRESH pc, never the stale one.
        expect(FakePC.instances[0].appliedRemote).toHaveLength(1);
        expect(FakePC.instances[1].appliedRemote).toHaveLength(1);
        const last = fakeWs.sentAnswers.at(-1)!;
        expect(JSON.parse(last.json).answerTo).toBe('B');

        // Follow-up renegotiation on the new connId must NOT rebuild again.
        offerFrom(10, { connId: 'B' });
        await flush();
        expect(FakePC.instances).toHaveLength(2);
        mgr.closeAll();
    });

    it('keeps legacy behavior for offers without a connId (old clients)', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        offerFrom(10);
        await flush();
        offerFrom(10);
        await flush();

        expect(FakePC.instances).toHaveLength(1);
        expect(FakePC.instances[0].appliedRemote).toHaveLength(2);
        mgr.closeAll();
    });

    it('drops a stale answer aimed at a replaced pc, accepts legacy and current ones', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        await mgr.callUser(10);
        const pc = FakePC.instances[0];
        // No local tracks in this harness, so negotiationneeded doesn't fire on
        // its own — trigger the manager's glare-safe offer path directly.
        pc.onnegotiationneeded!();
        await flush();
        expect(fakeWs.sentOffers).toHaveLength(1);
        const ourConnId = JSON.parse(fakeWs.sentOffers[0].json).connId as string;
        expect(ourConnId).toBeTruthy();

        // Stale answer for a pc we no longer have → dropped.
        fakeWs.emit('Answer', {
            from_user: 10,
            sdp: JSON.stringify({ type: 'answer', sdp: 'v=0\r\nstale', answerTo: 'dead-pc' }),
        });
        await flush();
        expect(pc.appliedRemote).toHaveLength(0);

        // Answer that names our current pc → applied.
        fakeWs.emit('Answer', {
            from_user: 10,
            sdp: JSON.stringify({ type: 'answer', sdp: 'v=0\r\ngood', answerTo: ourConnId, connId: 'J1' }),
        });
        await flush();
        expect(pc.appliedRemote).toHaveLength(1);
        expect(pc.appliedRemote[0].type).toBe('answer');

        // Legacy answer without answerTo (old client) is still accepted.
        pc.onnegotiationneeded!();
        await flush();
        fakeWs.emit('Answer', {
            from_user: 10,
            sdp: JSON.stringify({ type: 'answer', sdp: 'v=0\r\nlegacy' }),
        });
        await flush();
        expect(pc.appliedRemote).toHaveLength(2);
        mgr.closeAll();
    });

    it('outgoing offers always carry our per-pc connId', async () => {
        const mgr = new WebRTCManager();
        mgr.setLocalUserId(1);

        await mgr.callUser(10);
        FakePC.instances[0].onnegotiationneeded!();
        await flush();

        expect(fakeWs.sentOffers).toHaveLength(1);
        const envelope = JSON.parse(fakeWs.sentOffers[0].json);
        expect(envelope.type).toBe('offer');
        expect(typeof envelope.connId).toBe('string');
        expect(envelope.connId.length).toBeGreaterThan(8);
        mgr.closeAll();
    });

    it('rebuilds AND ANSWERS when an offer fails on a STABLE pc (old-client m-line mismatch)', async () => {
        vi.useFakeTimers();
        try {
            const mgr = new WebRTCManager();
            mgr.setLocalUserId(1);

            // Established legacy session (no connIds anywhere).
            offerFrom(10);
            await vi.runAllTimersAsync();
            const stale = FakePC.instances[0];
            expect(stale.appliedRemote).toHaveLength(1);
            expect(stale.signalingState).toBe('stable');
            const answersBefore = fakeWs.sentAnswers.length;

            // The remote rebuilt (old client, no connId): its fresh offer now
            // throws the m-line InvalidAccessError while our pc sits 'stable'.
            stale.setRemoteDescription = async () => {
                throw new DOMException('m-lines order mismatch', 'InvalidAccessError');
            };
            offerFrom(10);
            await vi.runAllTimersAsync();

            // The peer must be rebuilt in place (stale closed, fresh alive)...
            expect(stale.closed).toBe(true);
            expect(FakePC.instances.length).toBeGreaterThanOrEqual(2);
            const fresh = FakePC.instances.at(-1)!;
            expect(fresh.closed).toBe(false);
            // ...and crucially the SAME offer must be applied to the fresh pc
            // and ANSWERED — a counter-offer instead would deadlock an old
            // impolite remote sitting in have-local-offer.
            expect(fresh.appliedRemote).toHaveLength(1);
            expect(fresh.appliedRemote[0].type).toBe('offer');
            expect(fakeWs.sentAnswers.length).toBe(answersBefore + 1);
            mgr.closeAll();
        } finally {
            vi.useRealTimers();
        }
    });

    it('rebuilds an offer that never receives an answer (offerer-side watchdog)', async () => {
        vi.useFakeTimers();
        try {
            const mgr = new WebRTCManager();
            mgr.setLocalUserId(1);

            await mgr.callUser(10);
            const pc = FakePC.instances[0];
            pc.onnegotiationneeded!(); // offer goes out; no answer will ever come
            await vi.runAllTimersAsync();

            // The watchdog must have torn down the answer-less pc (stuck in
            // have-local-offer, ICE never starting) and built a fresh one.
            expect(fakeWs.sentOffers.length).toBeGreaterThanOrEqual(1);
            expect(pc.closed).toBe(true);
            expect(FakePC.instances.length).toBeGreaterThanOrEqual(2);
            mgr.closeAll();
        } finally {
            vi.useRealTimers();
        }
    });
});
