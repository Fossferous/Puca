/**
 * P2P INPUT (W5/R2) — the transport's own rules, tested without a browser
 * peer connection: framing, lane assignment, the registry's one-channel-per-
 * lane claim, the capability gate that is NOT readyState, and the raw
 * seal/open pair's equivalence with the base64 one the relay uses.
 *
 * The ordering property this exists to protect (a fast DC move must never
 * invalidate a WS click still in flight) lives in the SEQUENCE NAMESPACES,
 * which the sender picks by transport — pinned here through laneFor + the
 * gate, and end-to-end in remoteControl's own suite.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    CTL_HIGH_WATER_BYTES, CTL_STATE_LABEL, FRAME_HELLO, FRAME_SEALED_INPUT,
    controlChannels, controlDcCongested, controlDcReady, decodeFrame, disarmControlChannels, encodeFrame, forgetControlChannels,
    markHelloSeen, markSfuHelloSeen, registerControlChannel, resetControlChannels,
    deliverSfuControlFrame, forgetSfuControl, sendControlFrame, sendSfuControlFrame,
    setControlFrameHandler, setSfuControlSender, sfuControlReady,
} from '../api/rtc/controlDc';
import { sealControl, openControl, sealControlBytes, openControlBytes } from '../api/e2ee';

/** A data channel stand-in: jsdom has no RTCDataChannel. */
function fakeDc(label: string, readyState: RTCDataChannelState = 'open') {
    const sent: ArrayBuffer[] = [];
    const dc = {
        label,
        readyState,
        binaryType: 'blob',
        bufferedAmount: 0,
        onmessage: null as ((ev: MessageEvent) => void) | null,
        onopen: null as (() => void) | null,
        onclose: null as (() => void) | null,
        send: (b: ArrayBuffer) => { sent.push(b); },
        close: () => { (dc as { readyState: RTCDataChannelState }).readyState = 'closed'; dc.onclose?.(); },
    };
    return { dc: dc as unknown as RTCDataChannel, sent, raw: dc };
}

beforeEach(() => resetControlChannels());

describe('framing', () => {
    it('round-trips kind + payload, and refuses an empty buffer', () => {
        const payload = new Uint8Array([9, 8, 7]);
        const frame = encodeFrame(FRAME_SEALED_INPUT, payload);
        expect(frame[0]).toBe(FRAME_SEALED_INPUT);
        const back = decodeFrame(frame)!;
        expect(back.kind).toBe(FRAME_SEALED_INPUT);
        expect([...back.payload]).toEqual([9, 8, 7]);
        expect(decodeFrame(new Uint8Array([]))).toBeNull();
    });
});

describe('one lane, deliberately', () => {
    it('there is no unreliable lane to put a positioning move on', () => {
        // Two SCTP streams have no relative ordering, and the unreliable one
        // could drop the move that positions a click for good — the exact
        // click-teleport `sendControlEvent`'s flush-before-click block
        // exists to prevent. The label list is the contract: one channel.
        expect(CTL_STATE_LABEL).toBe('sov-ctl-s');
        // The registry holds ONE channel slot per peer. A second lane would
        // have to widen this shape, and widening it means revisiting the
        // ordering argument in the module header — which is the point.
        const { dc } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        markHelloSeen(7, 'viewer');
        expect(Object.keys(controlChannels(7)!).sort()).toEqual(['helloSeen', 'state']);
    });
});

describe('the registry', () => {
    it('keeps ONE channel per lane; a second IN-BAND claim is closed (the residual case)', () => {
        // Two in-band channels can only meet when neither end negotiates —
        // two OLD clients — and there this rule is the annihilation described
        // in CTL_STREAM_ID's comment. Between current clients the holder is
        // negotiated and the branch below never runs; see the next test.
        const mine = fakeDc(CTL_STATE_LABEL);
        const theirs = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, mine.dc);
        registerControlChannel(7, theirs.dc);
        expect(theirs.raw.readyState, 'the second claim is closed, not stored').toBe('closed');
        markHelloSeen(7, 'viewer');
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(true);
        expect(mine.sent).toHaveLength(1);
    });

    it('a NEGOTIATED holder adopts an older peer\'s in-band channel and closes only its own', () => {
        const ours = fakeDc(CTL_STATE_LABEL);
        (ours.raw as unknown as { negotiated: boolean }).negotiated = true;
        const theirs = fakeDc(CTL_STATE_LABEL);
        (theirs.raw as unknown as { negotiated: boolean }).negotiated = false;
        registerControlChannel(7, ours.dc);
        registerControlChannel(7, theirs.dc);
        expect(ours.raw.readyState, 'our negotiated half, which the peer never held').toBe('closed');
        expect(theirs.raw.readyState, 'the channel BOTH ends hold stays open').toBe('open');
        expect(controlChannels(7)!.state).toBe(theirs.dc);
        markHelloSeen(7, 'viewer');
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(true);
        expect(theirs.sent).toHaveLength(1);
        expect(ours.sent).toHaveLength(0);
    });

    it('capability is per (peer, ROLE): ending the host session leaves the viewer session armed', () => {
        // One user can host a peer while viewing another — or host and view
        // the SAME peer at once. Those are separate sessions with separate
        // keys; the first cut kept one flag per peer and ending either
        // session disarmed the other for the rest of the call.
        const { dc } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        markHelloSeen(7, 'host');   // their hello opened under my host session's key
        markHelloSeen(7, 'viewer'); // and one under my viewer session's key
        expect(controlDcReady(7, 'viewer')).toBe(true);
        disarmControlChannels(7, 'host');
        expect(controlDcReady(7, 'host'), 'the session that ended').toBe(false);
        expect(controlDcReady(7, 'viewer'), 'the one that did not').toBe(true);
        setSfuControlSender(() => true);
        markSfuHelloSeen(7, 'host');
        markSfuHelloSeen(7, 'viewer');
        forgetSfuControl(7, 'host');
        expect(sfuControlReady(7, 'host')).toBe(false);
        expect(sfuControlReady(7, 'viewer')).toBe(true);
    });

    it('a session ending DISARMS the lane and keeps the pipe; only the pc going away closes it', () => {
        const { dc, raw } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        markHelloSeen(7, 'viewer');
        expect(controlDcReady(7, 'viewer')).toBe(true);
        disarmControlChannels(7, 'viewer');
        expect(raw.readyState, 'the channel belongs to the peer connection').toBe('open');
        expect(controlDcReady(7, 'viewer'), 'capability is per session').toBe(false);
        markHelloSeen(7, 'viewer'); // the next session\'s hello
        expect(controlDcReady(7, 'viewer'), 'and the next session can arm the same pipe').toBe(true);
        forgetControlChannels(7);
        expect(raw.readyState).toBe('closed');
        expect(controlDcReady(7, 'viewer')).toBe(false);
    });

    it('an OPEN channel is not a capability: the hello is', () => {
        const { dc } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        expect(controlDcReady(7, 'viewer'), 'open but unproved — the relay keeps it').toBe(false);
        markHelloSeen(7, 'viewer');
        expect(controlDcReady(7, 'viewer')).toBe(true);
    });

    it('losing the state lane drops the peer back to the relay', () => {
        const state = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, state.dc);
        markHelloSeen(7, 'viewer');
        expect(controlDcReady(7, 'viewer')).toBe(true);
        state.raw.close();
        expect(controlDcReady(7, 'viewer'), 'a dead lane must not read as capable').toBe(false);
        // And a send over it answers false so the caller falls back.
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
    });

    it('a throwing send answers false instead of exploding an input path', () => {
        const { dc } = fakeDc(CTL_STATE_LABEL);
        (dc as unknown as { send: () => void }).send = () => { throw new Error('closing'); };
        registerControlChannel(7, dc);
        markHelloSeen(7, 'viewer');
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
    });

    it('forgetting a peer closes its channel and disarms the capability', () => {
        const state = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, state.dc);
        markHelloSeen(7, 'viewer');
        forgetControlChannels(7);
        expect(state.raw.readyState).toBe('closed');
        expect(controlDcReady(7, 'viewer')).toBe(false);
    });

    it('inbound frames reach the handler with their peer; text is ignored', () => {
        const seen: Array<{ peer: number; kind: number }> = [];
        setControlFrameHandler((peer, frame) => seen.push({ peer, kind: frame.kind }));
        const { dc, raw } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        expect(raw.binaryType, 'binary channel').toBe('arraybuffer');
        const frame = encodeFrame(FRAME_HELLO, new Uint8Array([1]));
        raw.onmessage!({ data: frame.buffer.slice(0) } as MessageEvent);
        raw.onmessage!({ data: 'not binary' } as unknown as MessageEvent);
        expect(seen).toEqual([{ peer: 7, kind: FRAME_HELLO }]);
    });

    it('a CONGESTED channel stays the transport — the SENDER holds motion, it does not reroute', () => {
        const { dc, raw, sent } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        markHelloSeen(7, 'viewer');
        expect(controlDcReady(7, 'viewer')).toBe(true);
        expect(controlDcCongested(7)).toBe(false);
        raw.bufferedAmount = CTL_HIGH_WATER_BYTES + 1;
        // The first cut answered "not ready" here and the caller took the
        // relay: a `down` on the slow pipe and its `up` on the fast one have
        // no relative order, which is a button held down on someone else's
        // desktop. Congestion is reported separately and the sender HOLDS
        // motion behind it (remoteControl's valve); state events still go
        // down this ordered pipe, behind whatever is queued on it.
        expect(controlDcReady(7, 'viewer'), 'rerouting mid-session is the ordering hazard').toBe(true);
        expect(controlDcCongested(7)).toBe(true);
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(true);
        expect(sent).toHaveLength(1);
        // POSITIVE CONTROL: back under the mark the flag clears.
        raw.bufferedAmount = 0;
        expect(controlDcCongested(7)).toBe(false);
    });

    it('the high-water mark is sized in TIME — a few hundred ms of motion, not seconds', () => {
        // A sealed control frame is ~100-120 bytes; sustained motion emits
        // 60 (absolute) to 125 (relative) of them a second. 64 KiB — the
        // first cut — banked five to ten seconds of stale pointer to replay.
        const FRAME_BYTES = 110;
        expect(CTL_HIGH_WATER_BYTES / FRAME_BYTES / 125, 'at 125 Hz').toBeLessThan(0.4);
        expect(CTL_HIGH_WATER_BYTES / FRAME_BYTES / 60, 'at 60 Hz').toBeLessThan(0.8);
        expect(CTL_HIGH_WATER_BYTES / FRAME_BYTES, 'still holds a real burst').toBeGreaterThan(20);
    });

    it('a REBUILT channel starts unproved — a hello belongs to its connection', () => {
        const first = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, first.dc);
        markHelloSeen(7, 'viewer');
        expect(controlDcReady(7, 'viewer')).toBe(true);
        first.raw.close();
        const rebuilt = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, rebuilt.dc);
        expect(
            controlDcReady(7, 'viewer'),
            'the new connection\'s far end has not answered on it',
        ).toBe(false);
    });
});

describe('raw vs base64 sealing — one construction, two encodings', () => {
    it('a frame sealed raw opens through the relay helper and vice versa', async () => {
        const key = new Uint8Array(32).fill(7);
        const bytes = await sealControlBytes(key, '{"s":1}');
        // Same AES-256-GCM nonce||ct: base64 it and the relay's opener reads it.
        const asB64 = btoa(String.fromCharCode(...bytes));
        expect(await openControl(key, asB64)).toBe('{"s":1}');
        // And the relay's sealer's output opens through the raw one.
        const sealed = await sealControl(key, '{"s":2}');
        const back = Uint8Array.from(atob(sealed), c => c.charCodeAt(0));
        expect(await openControlBytes(key, back)).toBe('{"s":2}');
    });

    it('a forged or truncated frame opens as null, never as content', async () => {
        const key = new Uint8Array(32).fill(7);
        const other = new Uint8Array(32).fill(8);
        const bytes = await sealControlBytes(key, '{"s":1}');
        expect(await openControlBytes(other, bytes), 'wrong key').toBeNull();
        expect(await openControlBytes(key, bytes.slice(0, 10)), 'truncated').toBeNull();
        const tampered = new Uint8Array(bytes);
        tampered[tampered.length - 1] ^= 0xff;
        expect(await openControlBytes(key, tampered), 'flipped tag').toBeNull();
    });
});

describe('the SFU transport (R3) — same frames, a different pipe', () => {
    it('is not ready until a sender exists AND a hello arrived', () => {
        expect(sfuControlReady(7, 'viewer'), 'no room, no sender').toBe(false);
        setSfuControlSender(() => true);
        expect(sfuControlReady(7, 'viewer'), 'a room is not a capability').toBe(false);
        markSfuHelloSeen(7, 'viewer');
        expect(sfuControlReady(7, 'viewer')).toBe(true);
    });

    it('publishes framed bytes to the right peer and reports a refusal', () => {
        const seen: Array<{ user: number; kind: number }> = [];
        setSfuControlSender((user, frame) => {
            seen.push({ user, kind: frame[0] });
            return user !== 99; // 99 = "no such participant"
        });
        expect(sendSfuControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1, 2]))).toBe(true);
        expect(sendSfuControlFrame(99, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
        expect(seen).toEqual([
            { user: 7, kind: FRAME_SEALED_INPUT },
            { user: 99, kind: FRAME_SEALED_INPUT },
        ]);
    });

    it('a throwing publisher answers false — the relay takes the frame', () => {
        setSfuControlSender(() => { throw new Error('room gone'); });
        expect(sendSfuControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
    });

    it('leaving the room disarms every SFU capability', () => {
        setSfuControlSender(() => true);
        markSfuHelloSeen(7, 'viewer');
        expect(sfuControlReady(7, 'viewer')).toBe(true);
        setSfuControlSender(null);
        expect(sfuControlReady(7, 'viewer'), 'no publisher, no P2P — back to the relay').toBe(false);
    });

    it('delivered frames reach the handler flagged as NOT mesh', () => {
        const seen: Array<{ peer: number; kind: number; viaMesh: boolean }> = [];
        setControlFrameHandler((peer, frame, viaMesh) => seen.push({ peer, kind: frame.kind, viaMesh }));
        deliverSfuControlFrame(7, encodeFrame(FRAME_HELLO, new Uint8Array([1])));
        // The flag is what makes a hello arm the pipe it ARRIVED on: a mesh
        // hello says nothing about an SFU room, and vice versa.
        expect(seen).toEqual([{ peer: 7, kind: FRAME_HELLO, viaMesh: false }]);
        // A malformed (empty) packet is dropped, not handed on.
        deliverSfuControlFrame(7, new Uint8Array([]));
        expect(seen).toHaveLength(1);
    });

    it('forgetSfuControl drops one peer without disturbing another', () => {
        setSfuControlSender(() => true);
        markSfuHelloSeen(7, 'viewer');
        markSfuHelloSeen(8, 'viewer');
        forgetSfuControl(7, 'viewer');
        expect(sfuControlReady(7, 'viewer')).toBe(false);
        expect(sfuControlReady(8, 'viewer')).toBe(true);
    });
});

describe('why the lane is negotiated', () => {
    /** Two ends of ONE SCTP stream: closing either end closes both, and each
     *  end's onclose fires — what a real RTCDataChannel pair does, and what
     *  the single-channel fakes above cannot show. The FAR end closes on
     *  `flushCloses()`, not synchronously: a stream reset crosses the wire,
     *  and in the live measurement both ends had already closed each other's
     *  channel before either learned its own was gone. */
    const pendingFar: Array<() => void> = [];
    const flushCloses = () => { while (pendingFar.length) pendingFar.shift()!(); };
    function linkedPair(negotiated: boolean) {
        const mk = () => ({
            label: CTL_STATE_LABEL,
            readyState: 'open' as RTCDataChannelState,
            binaryType: 'blob',
            bufferedAmount: 0,
            negotiated,
            onmessage: null as ((ev: MessageEvent) => void) | null,
            onopen: null as (() => void) | null,
            onclose: null as (() => void) | null,
            send: () => { /* no-op */ },
            close: () => { /* replaced below */ },
        });
        const a = mk();
        const b = mk();
        const closeEnd = (end: typeof a) => {
            if (end.readyState === 'closed') return;
            end.readyState = 'closed';
            end.onclose?.();
        };
        a.close = () => { closeEnd(a); pendingFar.push(() => closeEnd(b)); };
        b.close = () => { closeEnd(b); pendingFar.push(() => closeEnd(a)); };
        return { a: a as unknown as RTCDataChannel, b: b as unknown as RTCDataChannel };
    }

    /** Two registries — one per peer — so both ends of a call are modelled. */
    async function twoPeers() {
        vi.resetModules();
        const A = await import('../api/rtc/controlDc');
        vi.resetModules();
        const B = await import('../api/rtc/controlDc');
        return { A, B };
    }

    it('in-band channels created on BOTH ends annihilate each other under "close the loser"', async () => {
        const { A, B } = await twoPeers();
        const fromA = linkedPair(false); // A created it: A holds .a, B receives .b
        const fromB = linkedPair(false);
        A.registerControlChannel(2, fromA.a);
        B.registerControlChannel(1, fromB.a);
        // ondatachannel on each end: the registry closes the "loser" — which
        // is the OTHER end's own channel. Then the resets cross the wire.
        A.registerControlChannel(2, fromB.b);
        B.registerControlChannel(1, fromA.b);
        flushCloses();
        expect(A.controlChannels(2)!.state, 'A lost its own channel').toBeNull();
        expect(B.controlChannels(1)!.state, 'B lost its own channel').toBeNull();
        expect(A.controlDcReady(2, 'viewer')).toBe(false);
        expect(B.controlDcReady(1, 'viewer')).toBe(false);
    });

    it('a negotiated channel is ONE pair both ends hold: nothing arrives, nothing is closed', async () => {
        const { A, B } = await twoPeers();
        const lane = linkedPair(true);
        A.registerControlChannel(2, lane.a);
        B.registerControlChannel(1, lane.b);
        A.markHelloSeen(2, 'viewer');
        B.markHelloSeen(1, 'viewer');
        expect(A.controlDcReady(2, 'viewer')).toBe(true);
        expect(B.controlDcReady(1, 'viewer')).toBe(true);
    });
});
