/**
 * CURSOR OWNERSHIP — exactly one pointer, on every host version.
 *
 * The host composites its own cursor into the video, so what the viewer sees
 * trails their finger by a round trip; a camera that follows the finger is
 * therefore always ahead of the visible pointer. The fix used here:
 * ask the host to stop drawing, and draw the pointer locally from the same
 * coordinates that move the camera, so the two are inseparable.
 *
 * The whole design rests on ONE safety property: `cursorOwned` is only ever
 * true because a host said so. An older host does not understand the request,
 * never acks, and keeps drawing — and this end must therefore keep NOT
 * drawing. Get that wrong in either direction and the user sees two cursors
 * or none.
 *
 * Every "must not happen" here has a positive-control sibling proving the rig
 * can see the good case happen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); },
    },
}));

vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyDh: async () => new Uint8Array(32).fill(3),
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'dev-me',
}));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return {
                capture: true, unattended: false, input: true, elevated: false,
                clipboard: false, files: false, monitors: [],
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        injectEvent: async () => {},
    }),
}));

/** jsdom has no RTCPeerConnection, and the controller builds a real one. */
class ControllerPc {
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    oniceconnectionstatechange: unknown = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel() {
        return { onopen: null, onclose: null, onmessage: null, readyState: 'connecting', close() {} };
    }
    addTransceiver() { return { receiver: { track: { onunmute: null, kind: 'video', stop() {} } } }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    addTrack() { return {}; }
    close() {}
}
Object.defineProperty(window, 'RTCPeerConnection', {
    value: ControllerPc, configurable: true, writable: true,
});

import { sealControl, openControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

/** Drive a controller session to 'active', returning the key the HOST holds. */
async function activeController(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const id = await connectToDevice('dev-host');
    const connect = sent.find(m => m.type === 'DeviceConnect');
    const controllerEph = connect?.payload?.eph as string;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph);
    expect(key, 'the rig must agree a key').not.toBeNull();

    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle();
    return { id, key: key! };
}

/** Deliver one sealed signal frame as the host would. */
let peerSeq = 0;
async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: peerSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

function sessionById(list: Array<{ id: string }>, id: string) {
    return list.find(s => s.id === id);
}

beforeEach(() => { peerSeq = 0; });

describe('cursor ownership is granted only by the host', () => {
    it('POSITIVE CONTROL: an ack hands the cursor over', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await settle();
        expect(
            sent.some(m => m.type === 'DeviceSignal'),
            'the request must actually reach the wire',
        ).toBe(true);

        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'the host said it stopped drawing, so this end draws',
        ).toBe(true);
    });

    it('a host that never acks leaves us NOT drawing (the old-host case)', async () => {
        const { id } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await settle();

        // An old host does not know this signal kind; it falls through the
        // handler chain and nothing comes back. Silence is the answer.
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'drawing on hope would put a second cursor over the host\'s own',
        ).toBe(false);
    });

    it('a malformed ack changes nothing', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: 'yes' });
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'a truthy non-boolean must not coerce its way into ownership',
        ).toBe(false);

        await hostSignal(id, key, { kind: 'cursor-owner-active' });
        expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(false);
    });

    it('an explicit refusal leaves ownership false and does NOT fail the session', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-failed', reason: 'this host cannot hide its pointer' });

        const s = sessionById(activeSessions(), id);
        expect(s?.cursorOwned, 'refused means the host kept drawing').toBe(false);
        expect(s?.error, 'an optional nicety being refused is not a session failure').toBeFalsy();
        expect(s?.phase, 'and certainly must not end the session').toBe('active');
    });

    it('handing the cursor BACK is acked too, so the host is never left pointerless', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(true);

        setCursorOwned(id, false);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: false });
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'the host draws again, so this end must stop',
        ).toBe(false);
    });

    it('ownership does not survive the session that negotiated it', async () => {
        const { id, key } = await activeController();
        const { activeSessions, endSession, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(true);

        // A fresh capture is born drawing its own cursor, so a stale `true`
        // carried into the next session would show two.
        endSession(id, 'you disconnected');
        await settle();
        expect(sessionById(activeSessions(), id), 'the session is gone entirely').toBeUndefined();
    });

    it('THE RACE: a request made while still connecting is replayed on activation', async () => {
        // The stage mounts and asks for the cursor as soon as it has a session
        // id — which is BEFORE the handshake completes. The first version
        // dropped that request on the floor (phase !== 'active'), so on real
        // hardware the host kept compositing and this end kept not drawing,
        // while every isolated test stayed green. Shipped as 0.8.51 and found
        // only in the field.
        const { installDeviceSessions, connectToDevice, endAllSessions, setCursorOwned, activeSessions } =
            await import('../api/devices/session');
        installDeviceSessions();
        endAllSessions('test reset');
        sent.length = 0;

        const id = await connectToDevice('dev-host');
        const connect = sent.find(m => m.type === 'DeviceConnect');
        const controllerEph = connect?.payload?.eph as string;
        const hostEph = generateControlEphemeral();
        const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph)!;

        expect(
            activeSessions().find(s => s.id === id)?.phase,
            'the premise: the stage asks while the session is still connecting',
        ).toBe('connecting');

        setCursorOwned(id, true);          // too early to send
        await settle();

        handlers.get('DeviceConnectAnswered')!({
            payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
        });
        await settle();

        // DECRYPT what actually went out. Counting DeviceSignal frames would
        // pass against the broken code too — going active always sends the
        // SDP offer on the same channel, so the count rises either way. Only
        // the frame's kind distinguishes a replayed request from an offer.
        const kinds: string[] = [];
        for (const m of sent.filter(x => x.type === 'DeviceSignal')) {
            const blob = (m.payload as { payload?: string } | undefined)?.payload;
            if (!blob) continue;
            const opened = await openControl(key, blob);
            if (opened) kinds.push(String(JSON.parse(opened).kind));
        }
        expect(kinds, 'the premise: the offer goes out on this channel too').toContain('offer');
        expect(
            kinds,
            'going active must REPLAY the held request, not forget it',
        ).toContain('set-cursor-owner');

        // And it is still only the ACK that grants ownership.
        expect(activeSessions().find(s => s.id === id)?.cursorOwned).toBe(false);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(activeSessions().find(s => s.id === id)?.cursorOwned).toBe(true);
    });
});
