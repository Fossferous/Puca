/**
 * Backgrounding the ANDROID app must not kill an active controller session.
 *
 * Three separate paths used to end it the moment the OS froze the WebView,
 * each bypassing the transport grace that deviceReconnect.test.ts pins:
 *
 *  - `pc.connectionState === 'failed'` tore down instantly — but while our own
 *    transport is down, the media path failing is a consequence of the freeze,
 *    not a verdict. The grace owns the verdict now; a session that reattaches
 *    onto a genuinely dead pc is ended honestly at reattach time instead.
 *  - The 30s wait-for-video deadline kept counting while frozen, then fired on
 *    thaw and blamed the device for a screen that could not have arrived. It
 *    now waits out a fresh window when it finds the app hidden or the
 *    transport down.
 *
 * Same rig as deviceReconnect.test.ts, plus fakes for RTCPeerConnection and
 * MediaStream — the CONTROLLER path constructs both, which jsdom lacks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return {
                capture: true, unattended: true, input: true, elevated: false,
                clipboard: true, files: true, monitors: [],
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        setFileAccess: async () => {},
        injectEvent: async () => {},
        releaseInput: async () => {},
    }),
}));

vi.mock('../api/devices/fileAccessConsent', () => ({
    requestFileAccessConsent: async () => null,
}));
vi.mock('../api/devices/clipboard', () => ({
    writeLocalClipboard: async () => {},
    readLocalClipboard: async () => '',
    readLocalClipboardDetailed: async () => ({ ok: true, text: '' }),
    MAX_CLIPBOARD_BYTES: 6000,
    isClipboardEvent: () => false,
    buildClipboardEvent: (data: string) => ({ t: 'clip', data }),
}));
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKey', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/hostAgent', () => ({
    agentAnswerOffer: async () => 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n',
}));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/devices/index', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/hostConsent', () => ({
    requestHostConsent: async () => ({ monitor: 0 }),
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

class FakeTrack {
    kind = 'video';
    onunmute: (() => void) | null = null;
    stop(): void {}
}

class FakePc {
    static last: FakePc | null = null;
    connectionState = 'new';
    onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    ondatachannel: ((e: unknown) => void) | null = null;
    constructor() { FakePc.last = this; }
    createDataChannel(label: string) {
        return {
            label, readyState: 'connecting',
            onopen: null, onclose: null, onmessage: null,
            close: () => {}, send: () => {},
        };
    }
    addTransceiver() { return { receiver: { track: new FakeTrack() } }; }
    async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close(): void { this.connectionState = 'closed'; }
    /** Simulate ICE giving up, as it does when Android froze the process. */
    fail(): void { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
}

// MediaStream comes from setup.ts's MockMediaStream (non-configurable there);
// only the peer connection needs THIS file's richer fake, to drive
// connectionState transitions.
vi.stubGlobal('RTCPeerConnection', FakePc);

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

/** Drive a CONTROLLER session to 'active' through the real handshake. */
async function activeControllerSession(): Promise<string> {
    const { installDeviceSessions, activeSessions, endAllSessions, connectToDevice } =
        await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const id = await connectToDevice('dev-host');
    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: eph.pubEncoded },
    });
    await settle();

    const s = activeSessions().find(x => x.id === id);
    expect(s?.phase, 'harness must reach an ACTIVE controller session').toBe('active');
    return id;
}

let visibility: DocumentVisibilityState = 'visible';
beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
});
afterEach(() => {
    vi.useRealTimers();
});

describe('a controller session across an Android backgrounding', () => {
    it('outlives a pc failure while the transport is down, and dies honestly on reattach', async () => {
        const id = await activeControllerSession();
        const { activeSessions } = await import('../api/devices/session');

        window.dispatchEvent(new CustomEvent('wsClosed'));
        await settle();
        expect(activeSessions().find(x => x.id === id)?.reconnecting).toBe(true);

        // The freeze kills ICE consent; on thaw the pc reports failed. This
        // must NOT end the session — the transport grace owns the verdict.
        FakePc.last!.fail();
        await settle();
        expect(
            activeSessions().find(x => x.id === id),
            'a pc failure during the outage must not bypass the grace',
        ).toBeTruthy();

        // The relay comes back, but the media path is a corpse: WebRTC does
        // not return from failed by itself and the host reaped its stream.
        // The honest outcome is a told-to-the-user teardown, not a live
        // session showing a black screen.
        handlers.get('DeviceReattached')!({ payload: { session_id: id, peer_connected: true } });
        await settle();
        expect(
            activeSessions().find(x => x.id === id),
            'reattaching onto a dead pc must end the session',
        ).toBeUndefined();
    });

    /** POSITIVE CONTROL: with the transport UP, a pc failure still ends the
     *  session immediately — the guard is scoped to the outage, not a pardon. */
    it('still ends the session when the pc fails with the transport up', async () => {
        const id = await activeControllerSession();
        const { activeSessions } = await import('../api/devices/session');

        FakePc.last!.fail();
        await settle();
        expect(
            activeSessions().find(x => x.id === id),
            'a real media failure is still fatal',
        ).toBeUndefined();
    });

    it('survives a reattach when the pc is healthy', async () => {
        const id = await activeControllerSession();
        const { activeSessions } = await import('../api/devices/session');

        window.dispatchEvent(new CustomEvent('wsClosed'));
        await settle();
        handlers.get('DeviceReattached')!({ payload: { session_id: id, peer_connected: true } });
        await settle();
        const s = activeSessions().find(x => x.id === id);
        expect(s, 'a healthy pc reattaches and lives').toBeTruthy();
        expect(s!.reconnecting).toBe(false);
    });

    it('re-arms the wait-for-video deadline instead of firing while hidden', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const id = await activeControllerSession();
        const { activeSessions } = await import('../api/devices/session');

        // The deadline elapses entirely while the app is hidden — the frozen
        // WebView case. Firing here blamed the device for a screen that could
        // not possibly have arrived.
        visibility = 'hidden';
        await vi.advanceTimersByTimeAsync(31_000);
        await settle();
        expect(
            activeSessions().find(x => x.id === id),
            'a deadline that ran while hidden must wait out a fresh window',
        ).toBeTruthy();

        // Visible again with a working transport: the fresh window is real,
        // and a screen that still never arrives is still an error (positive
        // control — the re-arm is a reprieve, not a pardon).
        visibility = 'visible';
        await vi.advanceTimersByTimeAsync(31_000);
        await settle();
        expect(
            activeSessions().find(x => x.id === id),
            'no screen within a WATCHED window still ends the session',
        ).toBeUndefined();
    });
});
