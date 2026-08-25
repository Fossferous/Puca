/**
 * Controller-side stream-quality routing: what happens to the UI when the host
 * answers badly, or does not answer at all.
 *
 * Salvaged from an abandoned worktree that was 75 commits behind main. The
 * shipped code had two real gaps this pins:
 *
 *  - An inbound `stream-quality-ack` was read with bare `as number` casts, so
 *    an ack with a missing or non-numeric field wrote `undefined`/`NaN` into
 *    the store AND cleared the pending state — the UI showed a quality nobody
 *    was running, with no error, and the timeout that would have reported the
 *    real failure had just been cancelled.
 *  - Only the UPDATE path had a deadline. A host that went silent after a
 *    `query_stream_quality` left the controller waiting forever with nothing
 *    on screen, which a user cannot tell apart from "that IS the quality".
 *
 * Every "must not happen" test here has a positive-control sibling proving the
 * rig can see the good case happen — an assertion that cannot fail is worse
 * than no assertion.
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

function failures(): string[] {
    return failureLog.slice();
}
let failureLog: string[] = [];
const onFailure = (e: Event) => {
    failureLog.push(String((e as CustomEvent<{ code?: string }>).detail?.code));
};

beforeEach(async () => {
    peerSeq = 0;
    failureLog = [];
    window.addEventListener('stream-quality-failed', onFailure);
    const { useStreamStore } = await import('../stores/streamStore');
    useStreamStore.getState().clearAllStreams();
});

afterEach(() => {
    window.removeEventListener('stream-quality-failed', onFailure);
});

describe('an inbound stream-quality ack is validated before it is believed', () => {
    it('POSITIVE CONTROL: a well-formed ack updates the stored quality', async () => {
        const { id, key } = await activeController();
        const { useStreamStore } = await import('../stores/streamStore');

        await hostSignal(id, key, { kind: 'stream-quality-ack', fps: 30, bitrate_kbps: 4000 });

        expect(useStreamStore.getState().qualities[id]).toEqual({ fps: 30, bitrate: 4000 });
    });

    it.each([
        ['a missing field', { kind: 'stream-quality-ack', fps: 30 }],
        ['a string field', { kind: 'stream-quality-ack', fps: '30', bitrate_kbps: 4000 }],
        ['a null field', { kind: 'stream-quality-ack', fps: 30, bitrate_kbps: null }],
    ])('ignores an ack with %s rather than storing NaN', async (_label, frame) => {
        const { id, key } = await activeController();
        const { useStreamStore } = await import('../stores/streamStore');
        // Something is in flight, as it would be after a real update request.
        useStreamStore.getState().setPendingQuality(id, { fps: 60, bitrate: 8000 });

        await hostSignal(id, key, frame as Record<string, unknown>);

        const store = useStreamStore.getState();
        expect(store.qualities[id], 'a malformed ack must not become a displayed quality')
            .toBeUndefined();
        expect(store.pendingQualities[id], 'and must not cancel the request it failed to answer')
            .toEqual({ fps: 60, bitrate: 8000 });
    });
});

describe('a query that is never answered fails instead of hanging', () => {
    it('reports query_failed once the deadline passes', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { id } = await activeController();
            const { queryStreamQuality } = await import('../api/devices/session');

            queryStreamQuality(id);
            await settle();
            expect(failures(), 'nothing is reported while the host still has time').toEqual([]);

            await vi.advanceTimersByTimeAsync(5100);
            await settle();
            expect(failures()).toContain('query_failed');
        } finally {
            vi.useRealTimers();
        }
    });

    it('POSITIVE CONTROL: an answered query reports nothing', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { id, key } = await activeController();
            const { queryStreamQuality } = await import('../api/devices/session');

            queryStreamQuality(id);
            await settle();
            await hostSignal(id, key, { kind: 'stream-quality-ack', fps: 30, bitrate_kbps: 4000 });

            await vi.advanceTimersByTimeAsync(5100);
            await settle();
            expect(failures(), 'a host that answered must not be reported as failed').toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
