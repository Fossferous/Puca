/**
 * Regression tests for the ICE-failure recovery LADDER (mesh path).
 *
 * A pc can reach connectionState 'failed' with media still flowing: ICE
 * stuck in 'checking' because the only workable candidate pair never
 * validated (observed live behind a VPN whose egress hairpins STUN requests
 * but eats the responses). The old recovery tore down the whole pc on the
 * FIRST failure — destroying working tracks and forcing every remote to
 * rebuild to match (the camera-tile churn the 2-peer e2e kept tripping on).
 *
 * The ladder: failure #1 → restartIce() on the SAME pc (same connId — the
 * remote sees a plain renegotiation); if the pc is still 'failed' at the
 * rung-1 deadline (edge-triggered connectionstatechange never re-fires for
 * a failure ICE cannot cure, e.g. a terminal DTLS transport) → the full
 * rebuild; 'connected' resets the ladder AND cancels any armed timer.
 *
 * Event semantics are modeled honestly: state changes only fire the handler
 * on a TRANSITION, and restartIce() drives onnegotiationneeded (async), as
 * real Chromium does.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));

// Event-emitting stand-in for the singleton wsClient (same shape as
// rtcRejoinRebuild.test.ts): capture outgoing signaling, inject answers.
vi.mock('../api/websocket', () => {
    type Handler = (msg: { type: string; payload: unknown }) => void;
    const handlers = new Map<string, Set<Handler>>();
    const wsClient = {
        sentOffers: [] as { to: number; json: string }[],
        on(type: string, h: Handler) {
            if (!handlers.has(type)) handlers.set(type, new Set());
            handlers.get(type)!.add(h);
        },
        off(type: string, h: Handler) { handlers.get(type)?.delete(h); },
        emit(type: string, payload: unknown) {
            handlers.get(type)?.forEach(h => h({ type, payload }));
        },
        sendOffer(to: number, json: string) { wsClient.sentOffers.push({ to, json }); },
        sendAnswer() { /* not exercised */ },
        sendIceCandidate() { /* not exercised */ },
        _reset() { handlers.clear(); wsClient.sentOffers.length = 0; },
    };
    return { wsClient };
});

import { WebRTCManager } from '../api/rtc/manager';
import { wsClient } from '../api/websocket';

const fakeWs = wsClient as unknown as {
    sentOffers: { to: number; json: string }[];
    emit(type: string, payload: unknown): void;
    _reset(): void;
};

class MockPc {
    static instances: MockPc[] = [];
    onicecandidate: unknown = null;
    onnegotiationneeded: (() => void) | null = null;
    ontrack: unknown = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    signalingState = 'stable';
    localDescription: { type: string; sdp: string } | null = null;
    remoteDescription: { type?: string; sdp?: string } | null = null;
    restartIceCalls = 0;
    closed = false;
    /** Models a failure an ICE restart cannot cure (terminal DTLS transport):
     *  signaling keeps working but connectionState stays pinned at 'failed'. */
    pinnedFailed = false;
    constructor() { MockPc.instances.push(this); }
    getSenders() { return []; }
    getTransceivers() { return []; }
    addTransceiver() { return { direction: 'recvonly', sender: { track: null }, receiver: { track: null }, mid: null }; }
    restartIce() {
        this.restartIceCalls++;
        // Real semantics: restartIce marks the next negotiation for an ICE
        // restart and queues negotiationneeded. It does NOT itself move
        // connectionState.
        queueMicrotask(() => this.onnegotiationneeded?.());
    }
    async setRemoteDescription(desc: { type?: string; sdp?: string }) {
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
    async getStats() { return { forEach() { /* empty */ } }; }
    close() { this.closed = true; this.signalingState = 'closed'; this.connectionState = 'closed'; }

    /** Edge-triggered transition — refuses a no-op "transition" so a test can
     *  never accidentally rely on an event real Chromium would not emit. */
    transition(state: string) {
        if (this.connectionState === state) {
            throw new Error(`test bug: transition to current state '${state}' would not fire in a real pc`);
        }
        this.connectionState = state;
        this.onconnectionstatechange?.();
    }
}

/** Drain microtasks + zero-delay timers under fake timers. */
async function flush(times = 8) {
    for (let i = 0; i < times; i++) {
        await vi.advanceTimersByTimeAsync(0);
    }
}

/** The peer's connId, parsed from the latest offer we sent them. */
function lastOfferConnId(): string | undefined {
    const last = fakeWs.sentOffers[fakeWs.sentOffers.length - 1];
    return last ? (JSON.parse(last.json) as { connId?: string }).connId : undefined;
}

/** Answer the latest offer so the pc returns to 'stable' (models the remote
 *  accepting the restart renegotiation while the transport stays broken). */
function answerLatestOffer(from: number) {
    const connId = lastOfferConnId();
    fakeWs.emit('Answer', {
        from_user: from,
        sdp: JSON.stringify({ type: 'answer', sdp: 'v=0\r\nremote-answer', connId: 'their-pc', answerTo: connId }),
    });
}

beforeEach(() => {
    MockPc.instances = [];
    fakeWs._reset();
    vi.stubGlobal('RTCPeerConnection', MockPc);
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('WebRTCManager ICE-failure recovery ladder', () => {
    async function establish(mgr: WebRTCManager): Promise<MockPc> {
        mgr.setLocalUserId(1);
        await mgr.callUser(2);
        const pc = MockPc.instances[0];
        // Initial negotiation (the mock's addTransceiver stays passive, so
        // drive it like the pc would) and connect.
        pc.onnegotiationneeded?.();
        await flush();
        pc.transition('connected');
        return pc;
    }

    it('first failure restarts ICE on the SAME pc — same connId renegotiation, no rebuild', async () => {
        const mgr = new WebRTCManager();
        const pc = await establish(mgr);
        const initialConnId = lastOfferConnId();
        expect(initialConnId).toBeTruthy();

        pc.transition('failed');
        await flush();

        expect(pc.restartIceCalls).toBe(1);
        expect(pc.closed).toBe(false);
        expect(MockPc.instances.length).toBe(1); // no rebuild
        // The restart-triggered offer went out from the SAME pc: same connId.
        expect(lastOfferConnId()).toBe(initialConnId);
    });

    it("pinned 'failed' (DTLS-terminal model): the rung-1 deadline escalates to a rebuild", async () => {
        const mgr = new WebRTCManager();
        const pc = await establish(mgr);

        pc.pinnedFailed = true;
        pc.transition('failed');
        await flush();
        expect(pc.restartIceCalls).toBe(1);
        // The remote ANSWERS the restart offer (signaling healthy) so the 3s
        // soft stuck-watchdog bails on 'stable' — exactly the uncovered case:
        // clean signaling, transport dead, no second 'failed' event ever.
        answerLatestOffer(2);
        await flush();
        expect(pc.signalingState).toBe('stable');

        await vi.advanceTimersByTimeAsync(10_000); // rung-1 deadline
        await vi.advanceTimersByTimeAsync(2_000);  // attempts=2 backoff rebuild
        await flush();

        expect(pc.closed).toBe(true);
        expect(MockPc.instances.length).toBe(2); // fresh pc built
    });

    it("reaching 'connected' cancels an armed rebuild timer — a recovered pc is never demolished", async () => {
        const mgr = new WebRTCManager();
        const pc = await establish(mgr);

        pc.pinnedFailed = true;
        pc.transition('failed');
        await flush();
        answerLatestOffer(2);
        await flush();
        await vi.advanceTimersByTimeAsync(10_000); // deadline → attempts=2 → 2s rebuild armed
        // The restart belatedly succeeds (remote's ladder fixed the path)
        // BEFORE the rebuild fires.
        pc.transition('connected');
        await vi.advanceTimersByTimeAsync(30_000);
        await flush();

        expect(pc.closed).toBe(false);
        expect(MockPc.instances.length).toBe(1); // the armed rebuild never fired
    });

    it("'connected' resets the ladder — the NEXT failure gets the gentle rung again", async () => {
        const mgr = new WebRTCManager();
        const pc = await establish(mgr);

        pc.transition('failed');
        await flush();
        expect(pc.restartIceCalls).toBe(1);
        pc.transition('connected'); // restart worked; ladder resets

        pc.transition('failed');
        await flush();
        expect(pc.restartIceCalls).toBe(2); // gentle rung again, not a rebuild
        expect(pc.closed).toBe(false);
        expect(MockPc.instances.length).toBe(1);
    });
});
