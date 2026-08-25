/**
 * Input events must reach the host in the order they were made.
 *
 * THE BUG THIS PINS. `sendInput` read and incremented the sequence counter
 * synchronously and then sealed asynchronously, so two overlapping calls took
 * s=0 and s=1 and raced through WebCrypto. If s=1 finished sealing first it
 * went out first — and the receiver, which requires a strictly increasing
 * sequence, DROPPED the perfectly legitimate s=0 that followed as a replay.
 *
 * At pointer-event rates overlapping seals are not a corner case, they are the
 * steady state, so input was being silently discarded. It reads to the user as
 * stutter and a cursor that skips, which is indistinguishable from lag and is
 * why it was reported as lag.
 *
 * This is the same failure the SIGNALLING path had and fixed with a SerialQueue,
 * where the comment ends: "a guard that leaves its mirror image open is not a
 * guard". Both mirrors are tested here — the send side and the receive side.
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

/**
 * Seal/open with CONTROLLABLE latency, so "the second one finishes first" is a
 * fact of the test rather than a race it hopes to win.
 *
 * The payload is passed through as plain text; these tests are about ordering,
 * and the crypto has its own tests.
 */
let sealDelays: number[] = [];
let openDelays: number[] = [];
let sealCall = 0;
let openCall = 0;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

vi.mock('../api/e2ee', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/e2ee')>();
    return {
        ...real,
        sealControl: async (_key: Uint8Array, plain: string) => {
            await wait(sealDelays[sealCall++] ?? 0);
            return `sealed:${plain}`;
        },
        openControl: async (_key: Uint8Array, blob: string) => {
            await wait(openDelays[openCall++] ?? 0);
            return blob.startsWith('sealed:') ? blob.slice('sealed:'.length) : null;
        },
    };
});

const injectEvent = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'agent',
        async capabilities() {
            return {
                capture: true, unattended: true, input: true, elevated: false,
                clipboard: false, files: false, monitors: [],
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        injectEvent: (...a: unknown[]) => injectEvent(...a),
    }),
}));
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKey', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/devices/index', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));
vi.mock('../api/devices/clipboard', () => ({
    buildClipboardEvent: (text: string) => ({ t: 'clip', data: text }),
    isClipboardEvent: (e: unknown) => (e as { t?: string })?.t === 'clip',
    readLocalClipboard: async () => 'clipboard text',
    readLocalClipboardDetailed: async () => ({ ok: true, text: 'clipboard text' }),
    MAX_CLIPBOARD_BYTES: 6000,
    writeLocalClipboard: async () => {},
}));

/** Enough of a peer connection for the controller handshake. */
class StubPc {
    localDescription: unknown = null;
    remoteDescription: unknown = null;
    onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel() {
        return { onopen: null, onclose: null, onmessage: null, readyState: 'connecting', close() {} };
    }
    addTransceiver() {
        return { receiver: { track: { onunmute: null, kind: 'video', stop() {} } } };
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(d: unknown) { this.localDescription = d; }
    async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
    async addIceCandidate() {}
    addTrack() { return {}; }
    close() {}
}
Object.defineProperty(window, 'RTCPeerConnection', {
    value: StubPc, configurable: true, writable: true,
});

async function settle(rounds = 30): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

/** A live CONTROLLER session, built through the real handshake. */
async function controllerSession(): Promise<string> {
    const { installDeviceSessions, connectToDevice, endAllSessions, activeSessions } =
        await import('../api/devices/session');
    const { generateControlEphemeral } = await import('../api/e2ee');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const sid = await connectToDevice('dev-host');
    const hostEph = generateControlEphemeral();
    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: sid, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle();
    expect(activeSessions().find(x => x.id === sid)?.phase, 'the controller session must reach active').toBe('active');
    sent.length = 0;
    // RESET THE DELAY CURSOR. The handshake seals its own frames (the offer,
    // at least), so a delay list set up before this point is consumed by the
    // handshake and every input then gets 0ms — which is how this test first
    // passed against the very bug it exists to catch.
    sealCall = 0;
    openCall = 0;
    return sid;
}

/** A live HOST session, built through the real handshake. */
async function hostSession(id: string): Promise<void> {
    const { installDeviceSessions, endAllSessions, activeSessions } =
        await import('../api/devices/session');
    const { generateControlEphemeral } = await import('../api/e2ee');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const eph = generateControlEphemeral();
    handlers.get('DeviceConnectRequested')!({
        payload: { session_id: id, from_device: 'dev-peer', eph: eph.pubEncoded },
    });
    await settle();
    expect(activeSessions().find(x => x.id === id)?.phase, 'the host session must reach active').toBe('active');
    sealCall = 0;
    openCall = 0;
}

/** The sequence numbers that actually went out, in wire order. */
function sentSequences(): number[] {
    return sent
        .filter(m => m.type === 'DeviceInput')
        .map(m => JSON.parse(String(m.payload!.event).slice('sealed:'.length)).s as number);
}

beforeEach(() => {
    sent.length = 0;
    sealDelays = [];
    openDelays = [];
    sealCall = 0;
    openCall = 0;
    injectEvent.mockClear();
});

describe('controller: sealing input', () => {
    it('puts events on the wire in sequence order even when the seals finish out of order', async () => {
        const { sendInput } = await import('../api/devices/session');
        const id = await controllerSession();

        // The FIRST seal is slow. Without a queue its frame is overtaken, and
        // the receiver then discards it as a replay — the event is simply lost.
        // These are all state events, so the coalescer forwards each at once
        // and what is being measured is purely the sealing order.
        sealDelays = [30, 0, 0];
        sendInput(id, { t: 'down', button: 0 });
        sendInput(id, { t: 'up', button: 0 });
        sendInput(id, { t: 'key', code: 'KeyA', down: true });
        await settle();

        expect(sentSequences()).toEqual([0, 1, 2]);
    });

    it('gives the clipboard a sequence number in line with input', async () => {
        const { sendInput, sendClipboard } = await import('../api/devices/session');
        const id = await controllerSession();

        sealDelays = [25, 0];
        const clip = sendClipboard(id);
        sendInput(id, { t: 'down', button: 0 });
        await clip;
        await settle();

        // The clipboard shares `sendSeq` with input, so sealing it off the
        // queue would burn a number out of order — and the receiver drops both
        // gaps and duplicates.
        expect(sentSequences()).toEqual([0, 1]);
    });
});

describe('host: opening input', () => {
    it('injects every event when the decrypts finish out of order', async () => {
        await hostSession('ds-recv');

        // The first frame decrypts SLOWLY. Unserialised, the second retires the
        // counter to 1 and the first is then dropped as a replay.
        openDelays = [30, 0];
        const deliver = (n: number) => handlers.get('DeviceInputted')!({
            payload: {
                session_id: 'ds-recv',
                event: `sealed:${JSON.stringify({ s: n, e: { t: 'key', code: `Key${n}`, down: true } })}`,
            },
        });
        deliver(0);
        deliver(1);
        await settle();

        const injected = injectEvent.mock.calls.map(c => JSON.parse(String(c[1])).code);
        expect(injected).toEqual(['Key0', 'Key1']);
    });
});
