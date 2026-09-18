/**
 * THE CONTROLLER'S MUTE ON A 'stream-died' THAT DESCRIBES THE STREAM A RESTART
 * ALREADY REPLACED.
 *
 * The host now reports 'stream-died' from its 1 Hz status poll as well as from
 * a failing inject, and every controller-initiated restart closes the old
 * peer connection BEFORE its restart-offer reaches the host — so the agent can
 * end the old stream, and the host's next poll report it, while the NEW stream
 * is coming up. Acting on that report inside RESTART_COOLDOWN_MS would end a
 * session whose picture had just come back. RESTART_STREAM_DIED_MUTE_MS is
 * what absorbs it; this pins that it does, and the control pins that a report
 * just outside the mute is still acted on (so the silence is the mute, not a
 * rig that cannot deliver the signal).
 *
 * Time moves through Date.now only.
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
vi.mock('../api/devices/deviceKeyRc', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
// async: restartMedia awaits closeTunnels and calls .catch on the result.
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: async () => {} }));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'dev-me' }));
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

/** The receive tracks the controller's pcs were built with, newest last — the
 *  handle the test uses to say "the restarted stream's first frame arrived". */
const recvTracks: Array<{ onunmute: (() => void) | null }> = [];

/** jsdom has no RTCPeerConnection, and the controller builds a real one. */
class ControllerPc {
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    oniceconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel(label: string) {
        return {
            label, readyState: 'connecting', onopen: null, onclose: null, onmessage: null,
            send() {}, close() {},
        };
    }
    addTransceiver() {
        const track = { onunmute: null as (() => void) | null, kind: 'video', stop() {} };
        recvTracks.push(track);
        return { receiver: { track } };
    }
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

async function activeController(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions, activeSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    recvTracks.length = 0;

    const id = await connectToDevice('dev-host');
    const connect = sent.find(m => m.type === 'DeviceConnect');
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, connect?.payload?.eph as string);
    expect(key, 'the rig must agree a key').not.toBeNull();
    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle();
    expect(activeSessions().find(s => s.id === id)?.phase, 'the premise: an ACTIVE controller').toBe('active');
    return { id, key: key! };
}

let peerSeq = 0;
async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: peerSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

/** How many restart-offers the controller has sent. */
async function restartOffers(key: Uint8Array): Promise<number> {
    let n = 0;
    for (const m of sent) {
        if (m.type !== 'DeviceSignal') continue;
        const blob = m.payload?.payload;
        if (typeof blob !== 'string') continue;
        const plain = await openControl(key, blob);
        if (plain && (JSON.parse(plain) as { kind?: string }).kind === 'restart-offer') n++;
    }
    return n;
}

async function phaseOf(id: string): Promise<string | undefined> {
    const { activeSessions } = await import('../api/devices/session');
    return activeSessions().find(s => s.id === id)?.phase;
}

let now = 0;
let dateSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
    peerSeq = 0;
    now = 1_900_000_000_000;
    dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => {
    dateSpy?.mockRestore();
    dateSpy = null;
});

/** Restart once on a host report, and let the new stream's first frame land —
 *  so `mediaRestarting` is clear and the MUTE is the only thing left between
 *  a second report and the cooldown teardown. */
async function restartedAndRecovered(): Promise<{ id: string; key: Uint8Array }> {
    const { id, key } = await activeController();
    await hostSignal(id, key, { kind: 'stream-died' });
    expect(await restartOffers(key), 'the premise: the first report restarted the media').toBe(1);
    const fresh = recvTracks.at(-1);
    expect(fresh?.onunmute, 'the restart built a new receive track').toBeTypeOf('function');
    fresh!.onunmute!();
    await settle();
    return { id, key };
}

describe('a stream-died right after a restart', () => {
    it('inside RESTART_STREAM_DIED_MUTE_MS sends no second restart-offer and keeps the session', async () => {
        const { id, key } = await restartedAndRecovered();

        now += 5_000;
        await hostSignal(id, key, { kind: 'stream-died' });

        expect(await restartOffers(key), 'the late report describes the replaced stream').toBe(1);
        expect(await phaseOf(id), 'and must not end the session whose picture just came back').toBe('active');
    });

    it('POSITIVE CONTROL: just outside the mute, the same report is acted on (inside the cooldown, it ends honestly)', async () => {
        const { id, key } = await restartedAndRecovered();

        now += 16_000;
        await hostSignal(id, key, { kind: 'stream-died' });

        expect(await restartOffers(key), 'the cooldown does not restart twice').toBe(1);
        expect(await phaseOf(id), 'a second death inside the cooldown ends the session').not.toBe('active');
    });
});
