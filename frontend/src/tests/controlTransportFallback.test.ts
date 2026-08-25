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
    FRAME_HELLO, FRAME_SEALED_INPUT, decodeFrame, registerControlChannel,
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
        registerControlChannel(HOST, 'state', dc);
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
        registerControlChannel(HOST, 'state', dc);
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
        registerControlChannel(HOST, 'state', dc);
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
