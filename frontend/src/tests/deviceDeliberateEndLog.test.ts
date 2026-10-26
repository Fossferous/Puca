// @vitest-environment jsdom
/**
 * The controller's `[rc-connect]` log (api/devices/connectLog.ts) records
 * DELIBERATE ends too, not only failures.
 *
 * 2026-10-26: the laptop timeline ("mouse cursor doesnt move after
 * reconnect") had to be rebuilt from the other computer's `+N.Ns` offsets,
 * because a Disconnect, a connect over a live session and the other
 * computer's own stop left no line on this side. Each now leaves one, marked
 * "by choice", with how long the session was up — in the style the failure
 * lines already had: the code's own words, no names, no ids (Send diagnostics
 * carries these lines to a server owner).
 *
 * CONTROL: a failure still logs exactly as before, without "by choice".
 *
 * Rig: deviceSessionLifecycle.test.ts's, the real session layer over a mock
 * socket and a minimal peer connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recentRcConnectLines } from '../api/devices/connectLog';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        get isConnected() { return true; },
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); },
    },
}));
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return { capture: true, unattended: true, input: true, elevated: false, clipboard: true, files: true, monitors: [] };
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
vi.mock('../api/devices/fileAccessConsent', () => ({ requestFileAccessConsent: async () => null }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKeyRc', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

async function boot() {
    const mod = await import('../api/devices/session');
    mod.installDeviceSessions();
    mod.endAllSessions('test reset');
    await settle();
    sent.length = 0;
    return mod;
}

/** The lines logged from here on (after the last one there now — the log
 *  keeps 40, so a count would stop working once it is full). */
function linesSince(): () => string[] {
    const marker = recentRcConnectLines().at(-1) ?? null;
    return () => {
        const all = recentRcConnectLines();
        const from = marker === null ? 0 : all.lastIndexOf(marker) + 1;
        return all.slice(from).map(l => l.replace(/^\[rc-connect\] \S+ /, ''));
    };
}

/** Just enough peer connection for the controller to build its offer. */
class SetupPc {
    connectionState = 'new';
    onicecandidate: unknown = null;
    onconnectionstatechange: unknown = null;
    ontrack: unknown = null;
    ondatachannel: unknown = null;
    createDataChannel(label: string) {
        return { label, readyState: 'connecting', onopen: null, onclose: null, onmessage: null, close: () => {}, send: () => {} };
    }
    addTransceiver() { return { receiver: { track: { kind: 'video', onunmute: null, stop: () => {} } } }; }
    async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close(): void { this.connectionState = 'closed'; }
}

beforeEach(() => { sent.length = 0; });

describe('a deliberate end leaves a line on the controller', () => {
    it('Disconnect', async () => {
        const { connectToDevice, endSession } = await boot();
        const lines = linesSince();
        const id = await connectToDevice('dev-host');
        await settle();
        endSession(id, 'you disconnected');
        await settle();
        expect(lines()).toEqual(['control ended by choice while connecting: you disconnected (socket up)']);
    });

    it('connecting again over a live attempt (the "reconnect")', async () => {
        const { connectToDevice } = await boot();
        const lines = linesSince();
        await connectToDevice('dev-host');
        await settle();
        await connectToDevice('dev-host');
        await settle();
        expect(lines()).toContain('control ended by choice while connecting: replaced by a new connection to that device (socket up)');
    });

    it('the other computer\'s own stop', async () => {
        const { connectToDevice } = await boot();
        const lines = linesSince();
        const id = await connectToDevice('dev-host');
        await settle();
        handlers.get('DeviceEnded')!({ payload: { session_id: id } });
        await settle();
        expect(lines()).toEqual(['control ended by choice while connecting: the session ended (socket up)']);
    });

    it('a sign-out', async () => {
        const { connectToDevice, endAllSessions } = await boot();
        const lines = linesSince();
        await connectToDevice('dev-host');
        await settle();
        endAllSessions('signed out');
        await settle();
        expect(lines()).toEqual(['control ended by choice while connecting: signed out (socket up)']);
    });

    it('a session that was up says for how long — which is when it started', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        vi.stubGlobal('RTCPeerConnection', SetupPc);
        try {
            const { connectToDevice, endSession, activeSessions } = await boot();
            const lines = linesSince();
            const id = await connectToDevice('dev-host');
            await settle();
            const eph = (await import('../api/e2ee')).generateControlEphemeral();
            handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: eph.pubEncoded } });
            for (let i = 0; i < 50 && activeSessions().find(x => x.id === id)?.phase !== 'active'; i++) await settle();
            expect(activeSessions().find(x => x.id === id)?.phase, 'the rig reaches active').toBe('active');
            await vi.advanceTimersByTimeAsync(12_000);
            endSession(id, 'you disconnected');
            await settle();
            const ended = lines().filter(l => l.startsWith('control ended'));
            expect(ended).toHaveLength(1);
            expect(ended[0]).toMatch(/^control ended by choice while active: you disconnected \(socket up, up 1[23] s\)$/);
        } finally {
            vi.useRealTimers();
            vi.unstubAllGlobals();
        }
    });

    it('no line names the computer or the session', async () => {
        const { connectToDevice, endSession } = await boot();
        const lines = linesSince();
        const id = await connectToDevice('dev-host', { peerName: 'Study PC' });
        await settle();
        endSession(id, 'you disconnected');
        await settle();
        expect(lines(), 'there is a line to look at (not vacuous)').toHaveLength(1);
        expect(lines().join('\n')).not.toMatch(/dev-host|Study PC|ds[0-9a-f]{6}/);
    });
});

describe('CONTROL: a failure logs as it always did', () => {
    it('a connect nobody answered: no "by choice"', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { connectToDevice } = await boot();
            const lines = linesSince();
            await connectToDevice('dev-host');
            await settle();
            await vi.advanceTimersByTimeAsync(21_000);
            await settle();
            const ended = lines().filter(l => l.startsWith('control ended'));
            expect(ended).toHaveLength(1);
            expect(ended[0]).toMatch(/^control ended while connecting: no answer from that device/);
        } finally {
            vi.useRealTimers();
        }
    });
});
