/**
 * P2P INPUT — WHICH PIPE CARRIES A FRAME (W5/R2, W6/R3).
 *
 * The relay is the permanent fallback and the only path that always exists,
 * so its continued use has to be PROVABLE, not assumed: this drives a real
 * viewer session through remoteControl and watches where the bytes go.
 *
 *   no capability     → WebSocket ControlInput   (today's behaviour, intact)
 *   mesh hello seen   → the data channel, and NOTHING on the socket
 *   channel dies      → straight back to the socket, mid-session
 *   SFU sender armed  → the room's data path
 *
 * The sequence NAMESPACES are checked here too: the relay's counter must not
 * advance while frames ride P2P, or a later relay frame would be refused by
 * the host as a replay.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); },
        bufferedAmount: () => 0,
    },
}));
vi.mock('../api/platform', () => ({ isTauri: () => false, isMobile: () => false }));
vi.mock('../components/voiceState', () => ({
    getCurrentStreamingUserId: () => null,
    getStreamData: () => null,
    selectStream: () => {},
}));
vi.mock('../api/rtc/receiverLatency', () => ({
    clearAllScreenLatency: () => {},
    setScreenLatencyMinimised: () => {},
}));

const HOST = 42;
let hostIdentityPub = '';
vi.mock('../api/dms', () => ({ getCachedPublicKey: async () => hostIdentityPub }));

import {
    CTL_HIGH_WATER_BYTES, FRAME_HELLO, FRAME_SEALED_INPUT, decodeFrame, registerControlChannel,
    resetControlChannels, setSfuControlSender,
} from '../api/rtc/controlDc';
import {
    makeIdentity, generateControlEphemeral, deriveControlSessionKey, openControlBytes,
    openControl, sealControlBytes,
} from '../api/e2ee';

/** jsdom has no RTCDataChannel. */
function fakeDc() {
    const frames: Uint8Array[] = [];
    const dc = {
        label: 'sov-ctl-s',
        readyState: 'open' as RTCDataChannelState,
        binaryType: 'blob',
        bufferedAmount: 0,
        onopen: null as (() => void) | null,
        onmessage: null as ((ev: MessageEvent) => void) | null,
        onclose: null as (() => void) | null,
        send: (b: ArrayBuffer) => { frames.push(new Uint8Array(b)); },
        close: () => { dc.readyState = 'closed'; dc.onclose?.(); },
    };
    return { dc: dc as unknown as RTCDataChannel, frames, raw: dc };
}

const settle = async (rounds = 8) => {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
};

/** Drive a VIEWER session to active; returns the key the host would hold. */
async function activeViewer(): Promise<Uint8Array> {
    const rc = await import('../api/remoteControl');
    const { setActiveIdentity } = await import('../api/e2ee');
    // Deterministic seeds — no KDF cost, and the pair is stable per run.
    const me = makeIdentity(new Uint8Array(32).fill(1));
    const host = makeIdentity(new Uint8Array(32).fill(2));
    setActiveIdentity(me);
    hostIdentityPub = host.publicKeyEncoded;

    rc.initRemoteControl();
    sent.length = 0;
    rc.requestControl(HOST, 'host');
    await settle();
    const req = sent.find(m => m.type === 'ControlRequest');
    const viewerEph = req?.payload?.eph as string;
    expect(viewerEph, 'the request carries the viewer ephemeral').toBeTruthy();

    // The host's half of the handshake.
    const hostEph = generateControlEphemeral();
    handlers.get('ControlResponse')!({
        payload: { from_user: HOST, granted: true, eph: hostEph.pubEncoded, cap_w: 1920, cap_h: 1080 },
    });
    await settle();
    const key = deriveControlSessionKey(host.privateKey, me.publicKeyEncoded, hostEph.priv, viewerEph);
    expect(key, 'both ends agree a session key').not.toBeNull();
    sent.length = 0;
    return key!;
}

beforeEach(async () => {
    // NO vi.resetModules(): remoteControl dynamically imports controlDc, and
    // a module reset would hand it a DIFFERENT registry instance from the one
    // this file drives — the transport would look permanently unproved and
    // every assertion below would pass for the wrong reason.
    const rc = await import('../api/remoteControl');
    rc.resetRemoteControl();
    resetControlChannels();
    sent.length = 0;
});

describe('the transport the viewer actually uses', () => {
    it('WITHOUT a proved data channel every frame rides the WebSocket relay', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        const inputs = sent.filter(m => m.type === 'ControlInput');
        expect(inputs, 'the relay is the path when nothing else is proved').toHaveLength(1);
        // And it is genuinely sealed under the session key, seq 1.
        const plain = await openControl(key, inputs[0].payload!.event as string);
        expect(JSON.parse(plain!)).toMatchObject({ s: 1, e: { t: 'down', button: 0 } });
    });

    it('an OPEN channel alone changes nothing — only a sealed hello moves the traffic', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const { dc, frames } = fakeDc();
        registerControlChannel(HOST, dc);
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'still the relay').toHaveLength(1);
        // The only DC traffic is our own hello (sent when the key appeared).
        for (const f of frames) expect(decodeFrame(f)!.kind).toBe(FRAME_HELLO);
        void key;
    });

    it('once the peer HELLOs, input rides the channel and the socket stays quiet', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const { dc, frames, raw } = fakeDc();
        registerControlChannel(HOST, dc);
        // The host's sealed hello arrives on the channel.
        const hello = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        const wire = new Uint8Array(hello.length + 1);
        wire[0] = FRAME_HELLO;
        wire.set(hello, 1);
        raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
        await settle();
        frames.length = 0;
        sent.length = 0;

        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'the relay must go quiet').toHaveLength(0);
        const inputFrames = frames.filter(f => decodeFrame(f)!.kind === FRAME_SEALED_INPUT);
        expect(inputFrames).toHaveLength(1);
        const plain = await openControlBytes(key, decodeFrame(inputFrames[0])!.payload);
        // The DC's OWN sequence namespace starts at 1 — the relay's counter
        // is untouched, which the next test proves matters.
        expect(JSON.parse(plain!)).toMatchObject({ s: 1, e: { t: 'down', button: 0 } });
    });

    it('a channel that DIES mid-session falls straight back, with the relay sequence intact', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const { dc, raw } = fakeDc();
        registerControlChannel(HOST, dc);
        const hello = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        const wire = new Uint8Array(hello.length + 1);
        wire[0] = FRAME_HELLO;
        wire.set(hello, 1);
        raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
        await settle();

        rc.sendControlEvent({ t: 'down', button: 0 });   // over the DC
        await settle();
        raw.close();                                      // the peer goes away
        rc.sendControlEvent({ t: 'up', button: 0 });      // must reach the host
        await settle();

        const inputs = sent.filter(m => m.type === 'ControlInput');
        expect(inputs, 'the click release cannot be lost with the channel').toHaveLength(1);
        const plain = await openControl(key, inputs[0].payload!.event as string);
        // seq 1 on the RELAY: its namespace never advanced while the DC
        // carried traffic, so the host (which tracks the two separately)
        // accepts this as the first relay frame rather than a replay.
        expect(JSON.parse(plain!)).toMatchObject({ s: 1, e: { t: 'up', button: 0 } });
    });

    it('an SFU room carries the frames when there is no mesh channel', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const published: Array<{ user: number; frame: Uint8Array }> = [];
        setSfuControlSender((user, frame) => { published.push({ user, frame }); return true; });
        // The host's hello arrives through the room's data path.
        const hello = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        const wire = new Uint8Array(hello.length + 1);
        wire[0] = FRAME_HELLO;
        wire.set(hello, 1);
        const { deliverSfuControlFrame } = await import('../api/rtc/controlDc');
        deliverSfuControlFrame(HOST, wire);
        await settle();
        published.length = 0;
        sent.length = 0;

        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'not the relay').toHaveLength(0);
        const inputs = published.filter(p => decodeFrame(p.frame)!.kind === FRAME_SEALED_INPUT);
        expect(inputs).toHaveLength(1);
        expect(inputs[0].user).toBe(HOST);
    });
});

describe('the in-flight fallback — the branch a clean close never reaches', () => {
    /** A channel that ACCEPTS the hello, then throws on the next send: the
     *  race where readyState still said "open" and the SCTP association was
     *  already gone. The clean-close test above never reaches this branch,
     *  which is how it shipped with the bug below. */
    function dyingDc() {
        const h = fakeDc();
        let armed = false;
        (h.raw as unknown as { send: (b: ArrayBuffer) => void }).send = (b: ArrayBuffer) => {
            if (armed) throw new Error('closing');
            h.frames.push(new Uint8Array(b));
        };
        return { ...h, arm: () => { armed = true; } };
    }

    async function provedDying(key: Uint8Array) {
        const dying = dyingDc();
        registerControlChannel(HOST, dying.dc);
        const hello = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        const wire = new Uint8Array(hello.length + 1);
        wire[0] = FRAME_HELLO;
        wire.set(hello, 1);
        dying.raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
        await settle();
        return dying;
    }

    it('re-seals for the relay with the RELAY sequence, not the channel’s', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const dying = await provedDying(key);

        // Two frames over the channel first, so its counter runs ahead of the
        // relay's — the condition that made this bug fatal rather than cosmetic.
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        rc.sendControlEvent({ t: 'up', button: 0 });
        await settle();
        sent.length = 0;
        dying.arm();

        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        const inputs = sent.filter(m => m.type === 'ControlInput');
        expect(inputs, 'the event must reach the host, not be dropped').toHaveLength(1);
        const plain = await openControl(key, inputs[0].payload!.event as string);
        // s: 1 — the RELAY's first frame. Before the fix this carried the
        // CHANNEL's number (3): the host set its relay counter to 3, and every
        // later relay frame — numbered from 1 — was refused as a replay. A
        // dead pointer, over a session still showing as active.
        expect(JSON.parse(plain!)).toMatchObject({ s: 1, e: { t: 'down', button: 0 } });
    });

    it('LATCHES to the relay afterwards — two transports must not interleave', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const dying = await provedDying(key);
        dying.arm();

        rc.sendControlEvent({ t: 'down', button: 0 });   // fails over
        await settle();
        sent.length = 0;
        rc.sendControlEvent({ t: 'up', button: 0 });     // must NOT retry the channel
        await settle();
        const inputs = sent.filter(m => m.type === 'ControlInput');
        expect(inputs, 'a down on the slow path and an up on the fast one can invert — '
            + 'and an inverted pair leaves a button held down on someone else’s desktop')
            .toHaveLength(1);
        const plain = await openControl(key, inputs[0].payload!.event as string);
        expect(JSON.parse(plain!)).toMatchObject({ s: 2, e: { t: 'up', button: 0 } });
    });

    it('an SFU room that RECONNECTS announces again instead of latching to the relay', async () => {
        const key = await activeViewer();
        const published: Array<{ user: number; frame: Uint8Array }> = [];
        // The room comes up AFTER the session key exists — the ordering that
        // used to leave the capability unannounced forever, because the only
        // announce iterated a set the same function had just emptied.
        setSfuControlSender((user, frame) => { published.push({ user, frame }); return true; });
        await settle();
        const hellos = published.filter(p => decodeFrame(p.frame)!.kind === FRAME_HELLO);
        expect(hellos, 'the room must be told this client speaks control frames').toHaveLength(1);
        expect(hellos[0].user).toBe(HOST);
        // And it is a real sealed hello, not a bare marker byte.
        expect(await openControlBytes(key, decodeFrame(hellos[0].frame)!.payload)).toBe('{"hello":1}');
    });
});

describe('the lane outlives a control session', () => {
    async function helloOn(raw: ReturnType<typeof fakeDc>['raw'], key: Uint8Array) {
        const hello = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        const wire = new Uint8Array(hello.length + 1);
        wire[0] = FRAME_HELLO;
        wire.set(hello, 1);
        raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
        await settle();
    }

    it('the SECOND session of a call still rides the channel — ending one disarms, it does not close', async () => {
        const key1 = await activeViewer();
        const rc = await import('../api/remoteControl');
        const { dc, frames, raw } = fakeDc();
        (raw as unknown as { negotiated: boolean }).negotiated = true;
        registerControlChannel(HOST, dc);
        await helloOn(raw, key1);
        frames.length = 0;
        sent.length = 0;
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'session 1: the channel').toHaveLength(0);
        expect(frames.filter(f => decodeFrame(f)!.kind === FRAME_SEALED_INPUT)).toHaveLength(1);

        rc.stopControlling();
        await settle();
        // The first cut CLOSED the channel here. A closed SCTP stream never
        // reopens and nothing re-creates it until the pc is rebuilt, so every
        // later session of the call silently rode the relay.
        expect(raw.readyState, 'the pipe belongs to the peer connection, not the session').toBe('open');

        const key2 = await activeViewer();
        frames.length = 0;
        sent.length = 0;
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'before the new hello: the relay (capability is per session)').toHaveLength(1);

        await helloOn(raw, key2);
        frames.length = 0;
        sent.length = 0;
        rc.sendControlEvent({ t: 'up', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'after it: the channel again').toHaveLength(0);
        const inputs = frames.filter(f => decodeFrame(f)!.kind === FRAME_SEALED_INPUT);
        expect(inputs).toHaveLength(1);
        const plain = await openControlBytes(key2, decodeFrame(inputs[0])!.payload);
        // A fresh session, a fresh channel namespace.
        expect(JSON.parse(plain!)).toMatchObject({ s: 1, e: { t: 'up', button: 0 } });
    });
});

describe('the valve on the lane', () => {
    async function helloOn(raw: ReturnType<typeof fakeDc>['raw'], key: Uint8Array) {
        const hello = await sealControlBytes(key, JSON.stringify({ hello: 1 }));
        const wire = new Uint8Array(hello.length + 1);
        wire[0] = FRAME_HELLO;
        wire.set(hello, 1);
        raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
        await settle();
    }
    const kinds = (frames: Uint8Array[]) => frames.map(f => decodeFrame(f)!.kind);
    const inputsOf = async (frames: Uint8Array[], key: Uint8Array) => {
        const out: unknown[] = [];
        for (const f of frames) {
            const d = decodeFrame(f)!;
            if (d.kind !== FRAME_SEALED_INPUT) continue;
            out.push(JSON.parse((await openControlBytes(key, d.payload))!).e);
        }
        return out;
    };

    it('a congested channel HOLDS motion at the sender; a click flushes it ahead, on the SAME pipe', async () => {
        const key = await activeViewer();
        const rc = await import('../api/remoteControl');
        const { dc, frames, raw } = fakeDc();
        registerControlChannel(HOST, dc);
        await helloOn(raw, key);
        frames.length = 0;
        sent.length = 0;

        raw.bufferedAmount = CTL_HIGH_WATER_BYTES + 1;
        rc.sendControlEvent({ t: 'move', x: 0.25, y: 0.75 });
        await settle();
        expect(kinds(frames).filter(k => k === FRAME_SEALED_INPUT), 'motion is held').toHaveLength(0);
        expect(sent.filter(m => m.type === 'ControlInput'), 'and never rerouted to the relay').toHaveLength(0);

        // The click lands where the pointer was last seen: the held
        // position goes first, then the click, both on the channel.
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput')).toHaveLength(0);
        expect(await inputsOf(frames, key)).toEqual([
            { t: 'move', x: 0.25, y: 0.75 },
            { t: 'down', button: 0 },
        ]);

        // Drained: motion flows again.
        raw.bufferedAmount = 0;
        frames.length = 0;
        // Past the 16 ms absolute-move window so the leading edge is clear.
        await new Promise(r => setTimeout(r, 20));
        rc.sendControlEvent({ t: 'move', x: 0.5, y: 0.5 });
        await settle();
        expect(await inputsOf(frames, key)).toEqual([{ t: 'move', x: 0.5, y: 0.5 }]);
    });
});
