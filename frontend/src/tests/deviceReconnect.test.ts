/**
 * A dropped WebSocket must HOLD an active device session for the reconnect,
 * not end it.
 *
 * Phones drop their socket the moment the app backgrounds, and the previous
 * behaviour — teardown-all on the first `wsClosed` — made every brief app
 * switch fatal: the WS layer's own reconnect came back seconds later to
 * nothing. These tests drive the real window events and the real handlers and
 * assert the lifecycle: survive the drop, release held input at once, claim
 * the session back with DeviceReattach, and still END the session when the
 * grace runs out or the handshake had not finished.
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

const releaseInput = vi.fn(async () => {});
const stopSession = vi.fn(async () => {});
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return {
                capture: true, unattended: true, input: true, elevated: false,
                clipboard: true, files: true, monitors: [],
            };
        },
        // 'agent-pc', a REAL transport kind: the rig used to say 'webview',
        // which only worked while session.ts had a catch-all else branch.
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: (...a: unknown[]) => stopSession(...(a as [])),
        listMonitors: async () => [],
        setMonitor: async () => {},
        setFileAccess: async () => {},
        injectEvent: async () => {},
        releaseInput: () => releaseInput(),
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

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

/** Drive an UNARMED host session to 'active' through the real handshake. */
async function activeHostSession(): Promise<string> {
    const { installDeviceSessions, activeSessions, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectRequested')!({
        payload: { session_id: 'ds-test', from_device: 'dev-peer', eph: eph.pubEncoded },
    });
    await settle();

    const s = activeSessions().find(x => x.id === 'ds-test');
    expect(s?.phase, 'harness must reach an ACTIVE host session').toBe('active');
    return 'ds-test';
}

beforeEach(() => {
    releaseInput.mockClear();
    stopSession.mockClear();
});

describe('a device session across a WebSocket drop', () => {
    it('survives wsClosed, flags itself, and releases held input at once', async () => {
        const id = await activeHostSession();

        window.dispatchEvent(new CustomEvent('wsClosed'));
        await settle();

        const { activeSessions } = await import('../api/devices/session');
        const s = activeSessions().find(x => x.id === id);
        expect(s, 'the session must be HELD, not ended').toBeTruthy();
        expect(s!.phase).toBe('active');
        expect(s!.reconnecting, 'and say so').toBe(true);
        expect(releaseInput, 'no relay means no key-up is coming — release now')
            .toHaveBeenCalled();
        expect(stopSession, 'but the capture must keep running for the comeback')
            .not.toHaveBeenCalled();
    });

    it('claims the session back on ATTESTATION, not on the bare socket open', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const id = await activeHostSession();
            window.dispatchEvent(new CustomEvent('wsClosed'));
            await settle();
            sent.length = 0;

            // `wsConnected` fires from onopen, BEFORE the socket has attested
            // as a device — a claim sent here loses the race and the server
            // refuses it, which made the entire grace feature inert while a
            // test that keyed on wsConnected stayed green.
            window.dispatchEvent(new CustomEvent('wsConnected'));
            await settle();
            expect(
                sent.some(m => m.type === 'DeviceReattach'),
                'an unattested socket must not claim yet',
            ).toBe(false);

            window.dispatchEvent(new CustomEvent('deviceAttested'));
            await settle();
            expect(
                sent.some(m => m.type === 'DeviceReattach' && m.payload?.session_id === id),
                'the attested socket claims the held session',
            ).toBe(true);

            // Still counting down until the server confirms; DeviceReattached
            // is what stands the session fully back up.
            handlers.get('DeviceReattached')!({ payload: { session_id: id, peer_connected: true } });
            await settle();
            const { activeSessions } = await import('../api/devices/session');
            expect(activeSessions().find(x => x.id === id)?.reconnecting).toBe(false);

            // And it DISARMED the grace countdown — the single line that makes
            // a recovered session survive. Without this advance, deleting the
            // clearTimeout in the DeviceReattached handler turns nothing red.
            await vi.advanceTimersByTimeAsync(61_000);
            await settle();
            expect(
                activeSessions().find(x => x.id === id),
                'a reattached session outlives the grace deadline',
            ).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the banner up when the server says the PEER is still gone', async () => {
        const id = await activeHostSession();
        window.dispatchEvent(new CustomEvent('wsClosed'));
        await settle();

        // Both sides dropped together: the DevicePeerReconnecting notice went
        // to OUR dead conn, so this ack is the first word about the peer.
        handlers.get('DeviceReattached')!({ payload: { session_id: id, peer_connected: false } });
        await settle();
        const { activeSessions } = await import('../api/devices/session');
        expect(
            activeSessions().find(x => x.id === id)?.reconnecting,
            'our half being back is not the session being back',
        ).toBe(true);

        handlers.get('DevicePeerReconnected')!({ payload: { session_id: id } });
        await settle();
        expect(activeSessions().find(x => x.id === id)?.reconnecting).toBe(false);
    });

    it('a DELIBERATE close (sign-out) still ends everything immediately', async () => {
        const id = await activeHostSession();

        window.dispatchEvent(new CustomEvent('wsClosed', { detail: { deliberate: true } }));
        await settle();

        const { activeSessions } = await import('../api/devices/session');
        expect(
            activeSessions().find(x => x.id === id),
            'sign-out must not leave a host capturing through the grace window',
        ).toBeUndefined();
        expect(stopSession, 'the capture is stopped, not graced').toHaveBeenCalled();
    });

    it('ENDS the session when the grace expires with no reattach', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const id = await activeHostSession();
            window.dispatchEvent(new CustomEvent('wsClosed'));
            await settle();

            await vi.advanceTimersByTimeAsync(61_000);
            await settle();

            const { activeSessions } = await import('../api/devices/session');
            expect(
                activeSessions().find(x => x.id === id),
                'the grace is a window, not immortality',
            ).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows the PEER as reconnecting on the server\'s word, and recovers', async () => {
        const id = await activeHostSession();

        handlers.get('DevicePeerReconnecting')!({ payload: { session_id: id } });
        await settle();
        const { activeSessions } = await import('../api/devices/session');
        expect(activeSessions().find(x => x.id === id)?.reconnecting).toBe(true);

        handlers.get('DevicePeerReconnected')!({ payload: { session_id: id } });
        await settle();
        expect(activeSessions().find(x => x.id === id)?.reconnecting).toBe(false);
    });

    /** POSITIVE CONTROL for the survival tests above: the rig CAN see a
     *  session end on wsClosed — a handshake that never finished still dies
     *  with the socket, exactly as the server treats it. */
    it('still ends a session whose handshake had not finished', async () => {
        const { installDeviceSessions, activeSessions, endAllSessions, connectToDevice } =
            await import('../api/devices/session');
        installDeviceSessions();
        endAllSessions('test reset');
        sent.length = 0;

        // A controller session sits in 'connecting' until the host answers.
        const id = await connectToDevice('dev-host');
        expect(activeSessions().find(x => x.id === id)?.phase).toBe('connecting');

        window.dispatchEvent(new CustomEvent('wsClosed'));
        await settle();

        expect(
            activeSessions().find(x => x.id === id),
            'mid-handshake sessions die with the socket',
        ).toBeUndefined();
    });
});
