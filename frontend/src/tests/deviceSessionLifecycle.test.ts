/**
 * The lifecycle wedge these pin: an UNGRACEFUL end used to strand three kinds
 * of state — a 'connecting' session no answer would ever end, a server-side
 * session no DeviceEnd ever released, and a stage-shadowing local zombie —
 * and the only cure was force-killing the Android app so the socket died and
 * the server's detach path cleaned up. Reported as "when the connection
 * doesn't close gracefully I have to hard close the app before connecting
 * works again".
 *
 * The four repairs under test:
 *  - connectToDevice fails FAST when the socket is down, and otherwise arms a
 *    connect deadline so a silently-dropped DeviceConnect becomes a named
 *    failure instead of an eternal 'connecting';
 *  - a new connect to the same host first ENDS any lingering local session OF
 *    THE SAME KIND to it (DeviceEnd before DeviceConnect on the same in-order
 *    socket), which is what frees the server's one-session-per-host slot on a
 *    plain retry — but never a session of the OTHER kind (Files vs Control),
 *    and never anything at all when the socket is down and the new connect
 *    cannot be sent (an old session in its transport grace must survive);
 *  - a DeviceReattached ack for a session this device no longer holds answers
 *    with DeviceEnd, so the reattach-vs-thawed-grace race cannot strand a
 *    rebound session server-side; and grace expiry itself now tells the peer
 *    (a no-op when the socket is down — the socket's death detaches the
 *    session server-side, where the supersede path frees the slot).
 *
 * Where a "must not happen" is asserted, a sibling control proves the rig CAN
 * see it happen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();
/** The mock socket's state; tests flip it to take the transport down. The
 *  send() gate mirrors the real client, which silently drops below OPEN —
 *  that silent drop is the exact behaviour half these tests exist to survive. */
let wsUp = true;

vi.mock('../api/websocket', () => ({
    wsClient: {
        get isConnected() { return wsUp; },
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => {
            if (wsUp) sent.push(m);
        },
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

async function boot() {
    const mod = await import('../api/devices/session');
    mod.installDeviceSessions();
    mod.endAllSessions('test reset');
    await settle();
    sent.length = 0;
    return mod;
}

/** Drive an UNARMED host session to 'active' through the real handshake. */
async function activeHostSession(): Promise<string> {
    const { activeSessions } = await import('../api/devices/session');
    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectRequested')!({
        payload: { session_id: 'ds-life', from_device: 'dev-peer', eph: eph.pubEncoded },
    });
    await settle();
    const s = activeSessions().find(x => x.id === 'ds-life');
    expect(s?.phase, 'harness must reach an ACTIVE host session').toBe('active');
    return 'ds-life';
}

beforeEach(() => {
    wsUp = true;
    releaseInput.mockClear();
    stopSession.mockClear();
});

describe('a connect attempt is bounded, not eternal', () => {
    it('fails fast and NAMED when the socket is down, sending nothing', async () => {
        const { connectToDevice, activeSessions, subscribeSessions } = await boot();
        const seen: Array<{ phase: string; error: string | null }> = [];
        wsUp = false;
        const unsub = subscribeSessions(list => {
            for (const s of list) seen.push({ phase: s.phase, error: s.error });
        });
        const id = await connectToDevice('dev-host');
        await settle();
        unsub();
        expect(
            sent.some(m => m.type === 'DeviceConnect'),
            'nothing must be queued into a socket that would silently drop it',
        ).toBe(false);
        expect(activeSessions().find(x => x.id === id), 'no eternal connecting zombie').toBeUndefined();
        expect(
            seen.some(s => s.phase === 'ended' && (s.error ?? '').includes('not connected to the server')),
            'the user is told WHY, through the normal failure surface',
        ).toBe(true);
    });

    it('control: with the socket up the DeviceConnect goes out and the session lives', async () => {
        const { connectToDevice, activeSessions } = await boot();
        const id = await connectToDevice('dev-host');
        await settle();
        expect(sent.some(m => m.type === 'DeviceConnect' && m.payload?.session_id === id)).toBe(true);
        expect(activeSessions().find(x => x.id === id)?.phase).toBe('connecting');
    });

    it('ends a never-answered connect at the deadline and frees the server slot', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { connectToDevice, activeSessions } = await boot();
            const id = await connectToDevice('dev-host');
            await settle();
            expect(sent.some(m => m.type === 'DeviceConnect')).toBe(true);
            await vi.advanceTimersByTimeAsync(21_000);
            await settle();
            expect(
                activeSessions().find(x => x.id === id),
                'a silently-dropped DeviceConnect must not live forever',
            ).toBeUndefined();
            expect(
                sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === id),
                'the deadline tells the server, in case IT created the session',
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('control: an answer before the deadline ends it with the ANSWER’s words', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { connectToDevice, activeSessions, subscribeSessions } = await boot();
            const seen: Array<string | null> = [];
            const unsub = subscribeSessions(list => {
                for (const s of list) if (s.phase === 'ended') seen.push(s.error);
            });
            const id = await connectToDevice('dev-host');
            await settle();
            handlers.get('DeviceConnectAnswered')!({
                payload: { session_id: id, accepted: false, reason: 'the device refused' },
            });
            await settle();
            await vi.advanceTimersByTimeAsync(25_000);
            await settle();
            unsub();
            expect(activeSessions().find(x => x.id === id)).toBeUndefined();
            expect(seen).toContain('the device refused');
            expect(
                seen.some(e => (e ?? '').includes('no answer from that device')),
                'the deadline must not also fire over the refusal',
            ).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a plain retry supersedes its own wreckage', () => {
    it('a new connect to the same host ends the lingering session FIRST, telling the server', async () => {
        const { connectToDevice, activeSessions } = await boot();
        const a = await connectToDevice('dev-host');
        await settle();
        const b = await connectToDevice('dev-host');
        await settle();
        expect(activeSessions().find(x => x.id === a), 'the old attempt is gone').toBeUndefined();
        expect(activeSessions().find(x => x.id === b)?.phase).toBe('connecting');
        const endIdx = sent.findIndex(m => m.type === 'DeviceEnd' && m.payload?.session_id === a);
        const conIdx = sent.findIndex(m => m.type === 'DeviceConnect' && m.payload?.session_id === b);
        expect(endIdx, 'the server was told about the old session').toBeGreaterThanOrEqual(0);
        expect(
            conIdx,
            'DeviceEnd precedes DeviceConnect on the same in-order socket, so the one-per-host slot is free in time',
        ).toBeGreaterThan(endIdx);
    });

    it('control: a connect to a DIFFERENT host ends nothing', async () => {
        const { connectToDevice, activeSessions } = await boot();
        const a = await connectToDevice('dev-host');
        await settle();
        await connectToDevice('dev-other');
        await settle();
        expect(activeSessions().find(x => x.id === a)?.phase).toBe('connecting');
        expect(sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === a)).toBe(false);
    });
});

describe('an offline tap must not destroy what it cannot replace', () => {
    it('keeps a prior session to the host when the socket is down', async () => {
        const { connectToDevice, activeSessions } = await boot();
        const a = await connectToDevice('dev-host');
        await settle();
        wsUp = false;
        // Impatient retry while the socket is down: the NEW attempt fails
        // fast — the OLD session (in real life one sitting in its transport
        // grace, seconds from reattaching) must survive it.
        const b = await connectToDevice('dev-host');
        await settle();
        expect(
            activeSessions().find(x => x.id === a)?.phase,
            'the prior session survives the failed tap',
        ).toBe('connecting');
        expect(activeSessions().find(x => x.id === b), 'only the unsendable attempt dies').toBeUndefined();
    });

    it('kinds do not supersede each other: Files must not kill a live Control session', async () => {
        const { connectToDevice, activeSessions } = await boot();
        const a = await connectToDevice('dev-host');
        await settle();
        const b = await connectToDevice('dev-host', { filesOnly: true });
        await settle();
        expect(
            activeSessions().find(x => x.id === a)?.phase,
            'Control survives a Files press',
        ).toBe('connecting');
        expect(
            sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === a),
            'no DeviceEnd for the control session',
        ).toBe(false);
        expect(
            activeSessions().find(x => x.id === b)?.phase,
            'the files attempt proceeds — the SERVER will refuse it with a reason the stage shows',
        ).toBe('connecting');
    });
});

describe('the reattach-vs-thawed-grace race cannot strand a server session', () => {
    it('answers an ack for a session it no longer holds with DeviceEnd', async () => {
        await boot();
        handlers.get('DeviceReattached')!({ payload: { session_id: 'ghost-1', peer_connected: true } });
        await settle();
        expect(
            sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === 'ghost-1'),
            'an orphaned rebound session is ended by the device it is bound to',
        ).toBe(true);
    });

    it('control: an ack for a session it DOES hold ends nothing', async () => {
        const { connectToDevice } = await boot();
        const a = await connectToDevice('dev-host');
        await settle();
        sent.length = 0;
        handlers.get('DeviceReattached')!({ payload: { session_id: a, peer_connected: true } });
        await settle();
        expect(sent.some(m => m.type === 'DeviceEnd')).toBe(false);
    });

    it('grace expiry TELLS the peer when the socket is back — a rebound session cannot squat the slot', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            await boot();
            const id = await activeHostSession();
            wsUp = false;
            window.dispatchEvent(new CustomEvent('wsClosed'));
            await settle();
            // The socket returns BEFORE the thawed timer fires — the race in
            // which the server may already have rebound this session to the
            // current conn. The expiry's DeviceEnd is then from a party conn
            // and actually ends it server-side.
            wsUp = true;
            await vi.advanceTimersByTimeAsync(61_000);
            await settle();
            const { activeSessions } = await import('../api/devices/session');
            expect(activeSessions().find(x => x.id === id), 'the grace is a window, not immortality').toBeUndefined();
            expect(
                sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === id),
                'the expiry names the session to the server',
            ).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
