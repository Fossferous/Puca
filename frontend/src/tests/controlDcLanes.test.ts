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
import { describe, it, expect, beforeEach } from 'vitest';
import {
    CTL_HIGH_WATER_BYTES, CTL_STATE_LABEL, FRAME_HELLO, FRAME_SEALED_INPUT,
    controlChannels, controlDcReady, decodeFrame, encodeFrame, forgetControlChannels,
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
        markHelloSeen(7);
        expect(Object.keys(controlChannels(7)!).sort()).toEqual(['helloSeen', 'state']);
    });
});

describe('the registry', () => {
    it('keeps ONE channel per lane and closes the loser (both sides create)', () => {
        const mine = fakeDc(CTL_STATE_LABEL);
        const theirs = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, mine.dc);
        registerControlChannel(7, theirs.dc);
        expect(theirs.raw.readyState, 'the second claim is closed, not stored').toBe('closed');
        markHelloSeen(7);
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(true);
        expect(mine.sent).toHaveLength(1);
    });

    it('an OPEN channel is not a capability: the hello is', () => {
        const { dc } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        expect(controlDcReady(7), 'open but unproved — the relay keeps it').toBe(false);
        markHelloSeen(7);
        expect(controlDcReady(7)).toBe(true);
    });

    it('losing the state lane drops the peer back to the relay', () => {
        const state = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, state.dc);
        markHelloSeen(7);
        expect(controlDcReady(7)).toBe(true);
        state.raw.close();
        expect(controlDcReady(7), 'a dead lane must not read as capable').toBe(false);
        // And a send over it answers false so the caller falls back.
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
    });

    it('a throwing send answers false instead of exploding an input path', () => {
        const { dc } = fakeDc(CTL_STATE_LABEL);
        (dc as unknown as { send: () => void }).send = () => { throw new Error('closing'); };
        registerControlChannel(7, dc);
        markHelloSeen(7);
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
    });

    it('forgetting a peer closes its channel and disarms the capability', () => {
        const state = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, state.dc);
        markHelloSeen(7);
        forgetControlChannels(7);
        expect(state.raw.readyState).toBe('closed');
        expect(controlDcReady(7)).toBe(false);
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

    it('a CONGESTED channel is not ready — the relay has the valve', () => {
        const { dc, raw } = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, dc);
        markHelloSeen(7);
        expect(controlDcReady(7)).toBe(true);
        raw.bufferedAmount = CTL_HIGH_WATER_BYTES + 1;
        expect(
            controlDcReady(7),
            'queueing behind a stalled association grows until the send buffer throws',
        ).toBe(false);
        expect(sendControlFrame(7, FRAME_SEALED_INPUT, new Uint8Array([1]))).toBe(false);
        // POSITIVE CONTROL: back under the mark and it flows again.
        raw.bufferedAmount = 0;
        expect(controlDcReady(7)).toBe(true);
    });

    it('a REBUILT channel starts unproved — a hello belongs to its connection', () => {
        const first = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, first.dc);
        markHelloSeen(7);
        expect(controlDcReady(7)).toBe(true);
        first.raw.close();
        const rebuilt = fakeDc(CTL_STATE_LABEL);
        registerControlChannel(7, rebuilt.dc);
        expect(
            controlDcReady(7),
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
        expect(sfuControlReady(7), 'no room, no sender').toBe(false);
        setSfuControlSender(() => true);
        expect(sfuControlReady(7), 'a room is not a capability').toBe(false);
        markSfuHelloSeen(7);
        expect(sfuControlReady(7)).toBe(true);
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
        markSfuHelloSeen(7);
        expect(sfuControlReady(7)).toBe(true);
        setSfuControlSender(null);
        expect(sfuControlReady(7), 'no publisher, no P2P — back to the relay').toBe(false);
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
        markSfuHelloSeen(7);
        markSfuHelloSeen(8);
        forgetSfuControl(7);
        expect(sfuControlReady(7)).toBe(false);
        expect(sfuControlReady(8)).toBe(true);
    });
});
