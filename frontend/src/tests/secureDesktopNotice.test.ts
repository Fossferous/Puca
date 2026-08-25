/**
 * THE SECURE-DESKTOP NOTICE — saying why the picture froze.
 *
 * A UAC prompt (or the lock screen) takes the host's display away from its
 * capture, and the host holds the last frame. Without a notice the viewer sees
 * a picture that simply stops, which is indistinguishable from a crash — and
 * the liveness ladder, seeing no frames while the user jabs at the screen,
 * would climb to a full media renegotiation that cannot possibly help, because
 * the host is not sending anything until the prompt closes.
 *
 * The safety property mirrors cursorOwnership's: `secureDesktop` is only ever
 * true because a HOST said so. The controller cannot tell a security prompt
 * from any other reason frames stopped, so it must never guess — and a
 * malformed frame must not be able to paste a banner over a working session.
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

vi.mock('../api/devices/deviceKey', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/index', () => ({ thisDeviceId: () => 'dev-me' }));
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
        // NOTE: no sessionStatus — a webview host cannot tell, which is also
        // the shape the host-side poll must tolerate without throwing.
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

import { sealControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';

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

describe('the controller is told a security screen took the display', () => {
    it('POSITIVE CONTROL: a host notice raises the flag, and clearing it lowers it', async () => {
        const { id, key } = await activeController();
        const { activeSessions } = await import('../api/devices/session');

        expect(
            sessionById(activeSessions(), id)?.secureDesktop,
            'a fresh session is not blocked',
        ).toBe(false);

        await hostSignal(id, key, { kind: 'secure-desktop', up: true });
        expect(
            sessionById(activeSessions(), id)?.secureDesktop,
            'the host said a security screen owns its display',
        ).toBe(true);

        // THE DOWN TRANSITION IS THE CONTROL. Without it, a flag wired to a
        // constant true would pass the assertion above and leave the banner
        // stuck over a session that recovered minutes ago.
        await hostSignal(id, key, { kind: 'secure-desktop', up: false });
        expect(
            sessionById(activeSessions(), id)?.secureDesktop,
            'the prompt closed, so the banner must go',
        ).toBe(false);
    });

    it('a malformed notice changes nothing', async () => {
        const { id, key } = await activeController();
        const { activeSessions } = await import('../api/devices/session');

        await hostSignal(id, key, { kind: 'secure-desktop', up: 'yes' });
        expect(
            sessionById(activeSessions(), id)?.secureDesktop,
            'a banner asserting the machine is unreachable must need a real boolean',
        ).toBe(false);
    });

    it('an old host that never sends the notice leaves the flag alone', async () => {
        const { id } = await activeController();
        const { activeSessions } = await import('../api/devices/session');

        // A host predating this feature simply never sends the kind. Silence
        // must read as "no security screen", which is exactly the behaviour
        // every build had before the notice existed.
        await settle();
        expect(
            sessionById(activeSessions(), id)?.secureDesktop,
            'silence is not evidence of a prompt',
        ).toBe(false);
    });
});

describe('the controller is told a cursor clip took the pointer', () => {
    // The same safety property as the secure-desktop notice, for the same
    // reason: `cursorClipped` is only ever true because a HOST said so, and a
    // malformed frame must not paste a "your clicks aren't landing" banner
    // over a working session.
    it('POSITIVE CONTROL: the host notice raises the flag, and clearing it lowers it', async () => {
        const { id, key } = await activeController();
        const { activeSessions } = await import('../api/devices/session');

        expect(
            sessionById(activeSessions(), id)?.cursorClipped,
            'a fresh session is not clip-blocked',
        ).toBe(false);

        await hostSignal(id, key, { kind: 'cursor-clipped', clipped: true });
        expect(
            sessionById(activeSessions(), id)?.cursorClipped,
            'the host said a clip holds the pointer off the streamed screen',
        ).toBe(true);

        // The down transition is the control — a flag wired to a constant
        // would leave the banner stuck after the game released the clip.
        await hostSignal(id, key, { kind: 'cursor-clipped', clipped: false });
        expect(
            sessionById(activeSessions(), id)?.cursorClipped,
            'the clip released, so the banner must go',
        ).toBe(false);
    });

    it('a malformed notice changes nothing', async () => {
        const { id, key } = await activeController();
        const { activeSessions } = await import('../api/devices/session');

        await hostSignal(id, key, { kind: 'cursor-clipped', clipped: 'yes' });
        expect(
            sessionById(activeSessions(), id)?.cursorClipped,
            'the banner must need a real boolean behind it',
        ).toBe(false);
    });
});
