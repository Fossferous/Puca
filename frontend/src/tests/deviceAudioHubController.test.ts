/**
 * Audio Hub, CONTROLLER side (the owner's phone): the session it opens, the
 * request it sends, and how it reads — or refuses — what comes back.
 *
 * The host half (who may reach Audio Hub at all) is driven in
 * deviceSessionAuth.test.ts, "Audio Hub requests". These drive the real
 * controller handlers with a stand-in host that seals frames under the real
 * session key, the same rig as deviceArmedChallenge.test.ts.
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
vi.mock('../api/devices/deviceKeyRc', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/platform', () => ({
    isTauri: () => false,
    isMobile: () => false,
    getApiBaseUrl: () => 'http://localhost:3000',
    getWebSocketUrl: () => 'ws://localhost:3000',
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'agent',
        async capabilities() {
            return { capture: true, unattended: true, input: true, elevated: false, clipboard: false, files: true, monitors: [] };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        injectEvent: async () => {},
    }),
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl, openControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';
import type { AudioHubOutcome } from '../api/devices/audioHub';

class ControllerPc {
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
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(d: unknown) { this.localDescription = d; }
    async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
    async addIceCandidate() { /* accepted */ }
    addTrack() { return {}; }
    close() { /* nothing to release */ }
}
Object.defineProperty(window, 'RTCPeerConnection', { value: ControllerPc, configurable: true, writable: true });

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

let hostSeq = 0;

/** An active controller session to 'dev-host', and the key the HOST holds. */
async function activeController(opts?: { audioHub?: boolean; filesOnly?: boolean }): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions, activeSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    hostSeq = 0;
    const id = await connectToDevice('dev-host', opts);
    const controllerEph = sent.find(m => m.type === 'DeviceConnect')?.payload?.eph as string;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph)!;
    handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded } });
    await settle();
    expect(activeSessions().find(s => s.id === id)?.phase, 'premise: the controller is active').toBe('active');
    return { id, key };
}

async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: hostSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

/** Every signal the controller sealed, opened as the host would. */
async function controllerFrames(key: Uint8Array): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const m of sent) {
        if (m.type !== 'DeviceSignal') continue;
        const plain = await openControl(key, m.payload!.payload as string);
        if (plain) out.push(JSON.parse(plain) as Record<string, unknown>);
    }
    return out;
}

/** Track a promise's settlement without awaiting it. */
function track<T>(p: Promise<T>): { value: () => T | undefined } {
    let v: T | undefined;
    void p.then(x => { v = x; });
    return { value: () => v };
}

const STATUS_BODY = {
    name: 'PC',
    airpods: { on_pc: true, handed_to_phone: false, line: 'AirPods: L 64%' },
    xm6: { on_pc: false, available: true, line: 'XM6: on the phone' },
    devices: 'Out: Speakers',
};

beforeEach(() => {
    vi.useRealTimers();
});

describe('an Audio Hub session', () => {
    it('is files-only on the wire and asks for no file access', async () => {
        const { key } = await activeController({ audioHub: true });
        const frames = await controllerFrames(key);
        const offer = frames.find(f => f.kind === 'offer');
        expect(offer?.filesOnly, 'the host must answer without capturing').toBe(true);
        expect(frames.some(f => f.kind === 'file-access-request'), 'no file browsing was asked for').toBe(false);
    });

    it('POSITIVE CONTROL: a Files session still asks for file access straight away', async () => {
        const { key } = await activeController({ filesOnly: true });
        expect((await controllerFrames(key)).some(f => f.kind === 'file-access-request')).toBe(true);
    });

    it('is marked as Audio Hub, and is replaced when Control opens', async () => {
        const { activeSessions, connectToDevice } = await import('../api/devices/session');
        const { id } = await activeController({ audioHub: true });
        expect(activeSessions().find(s => s.id === id)).toMatchObject({ audioHub: true, filesOnly: true });
        // Opening CONTROL to the same PC must not be refused as "already in a
        // session" because of a panel's session: it replaces it. (Files would
        // have replaced it under the old same-kind rule too; Control would not.)
        await connectToDevice('dev-host');
        await settle();
        expect(sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === id)).toBe(true);
    });

    it('opening an Audio Hub session never ends a Files or Control session already open', async () => {
        const { connectToDevice } = await import('../api/devices/session');
        const { id } = await activeController({ filesOnly: true });
        await connectToDevice('dev-host', { audioHub: true });
        await settle();
        expect(sent.some(m => m.type === 'DeviceEnd' && m.payload?.session_id === id)).toBe(false);
    });
});

describe('a request and its answer', () => {
    it('sends only the op and an id, and resolves with the host\'s status', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { id, key } = await activeController({ audioHub: true });
        const result = track(sendAudioHubRequest(id, 'status'));
        await settle();
        const req = (await controllerFrames(key)).find(f => f.kind === 'audio-hub')!;
        expect(Object.keys(req).sort()).toEqual(['kind', 'n', 'op', 'rid', 'sid']);
        expect(req.op).toBe('status');

        await hostSignal(id, key, { kind: 'audio-hub-ack', rid: req.rid });
        await hostSignal(id, key, { kind: 'audio-hub-result', rid: req.rid, op: 'status', running: true, status: 200, body: STATUS_BODY });
        expect(result.value()).toMatchObject({ kind: 'status', status: { airpods: { line: 'AirPods: L 64%' }, xm6: { onPc: false } } });
    });

    it('an answer to an id it never asked about resolves nothing', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { id, key } = await activeController({ audioHub: true });
        const result = track(sendAudioHubRequest(id, 'airpods-phone'));
        await settle();
        await hostSignal(id, key, { kind: 'audio-hub-result', rid: 'someone-elses-id', op: 'airpods-phone', running: true, status: 200, body: { ok: true } });
        expect(result.value()).toBeUndefined();
    });

    it('reads the answer as the op IT asked for, whatever op the frame claims', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { id, key } = await activeController({ audioHub: true });
        const result = track(sendAudioHubRequest(id, 'airpods-phone'));
        await settle();
        const req = (await controllerFrames(key)).find(f => f.kind === 'audio-hub')!;
        await hostSignal(id, key, {
            kind: 'audio-hub-result', rid: req.rid, op: 'status', running: true, status: 200,
            body: { ok: true, message: 'let go' },
        });
        expect(result.value()).toEqual({ kind: 'action', ok: true, message: 'let go', error: null, httpStatus: 200 });
    });

    it('a forged answer (not sealed under the session key) is ignored', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { id, key } = await activeController({ audioHub: true });
        const result = track(sendAudioHubRequest(id, 'status'));
        await settle();
        const req = (await controllerFrames(key)).find(f => f.kind === 'audio-hub')!;
        const forged = await sealControl(new Uint8Array(32).fill(0x42), JSON.stringify({
            sid: id, n: 50, kind: 'audio-hub-result', rid: req.rid, op: 'status', running: false,
        }));
        handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: forged } });
        await settle();
        expect(result.value()).toBeUndefined();
    });

    it('a request that is not on the allow-list is never sent', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { id, key } = await activeController({ audioHub: true });
        const o = await sendAudioHubRequest(id, '/api/pair' as never);
        expect(o.kind).toBe('error');
        expect((await controllerFrames(key)).some(f => f.kind === 'audio-hub')).toBe(false);
    });

    it('ending the session answers every waiting request', async () => {
        const { sendAudioHubRequest, endSession } = await import('../api/devices/session');
        const { id } = await activeController({ audioHub: true });
        const result = track(sendAudioHubRequest(id, 'status'));
        await settle();
        endSession(id, 'closed');
        await settle();
        expect(result.value()?.kind).toBe('error');
    });

    it('a host that never acknowledges (an older Púca) is reported as needing an update', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { AUDIO_HUB_ACK_TIMEOUT_MS, NEEDS_UPDATE_MESSAGE } = await import('../api/devices/audioHub');
        const { id } = await activeController({ audioHub: true });
        vi.useFakeTimers();
        let outcome: AudioHubOutcome | undefined;
        void sendAudioHubRequest(id, 'status').then(o => { outcome = o; });
        await vi.advanceTimersByTimeAsync(AUDIO_HUB_ACK_TIMEOUT_MS - 100);
        expect(outcome, 'not before the deadline').toBeUndefined();
        await vi.advanceTimersByTimeAsync(200);
        expect(outcome).toEqual({ kind: 'unsupported', message: NEEDS_UPDATE_MESSAGE });
        vi.useRealTimers();
    });

    it('a host that DID acknowledge gets the long deadline, not the short one', async () => {
        const { sendAudioHubRequest } = await import('../api/devices/session');
        const { AUDIO_HUB_ACK_TIMEOUT_MS, AUDIO_HUB_RESULT_TIMEOUT_MS } = await import('../api/devices/audioHub');
        const { id, key } = await activeController({ audioHub: true });
        // Fake ONLY the deadline clock, from BEFORE the request, so the short
        // deadline is one this test controls; the crypto still needs real
        // turns of the event loop, which setImmediate gives it.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const spin = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
        try {
            let outcome: AudioHubOutcome | undefined;
            void sendAudioHubRequest(id, 'airpods-pc').then(o => { outcome = o; });
            await spin();
            const req = (await controllerFrames(key)).find(f => f.kind === 'audio-hub')!;
            const sealed = await sealControl(key, JSON.stringify({ sid: id, n: hostSeq++, kind: 'audio-hub-ack', rid: req.rid }));
            handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
            await spin();
            await vi.advanceTimersByTimeAsync(AUDIO_HUB_ACK_TIMEOUT_MS + 1000);
            expect(outcome, 'an acknowledged request is still being worked on').toBeUndefined();
            // POSITIVE CONTROL: the long deadline does end it.
            await vi.advanceTimersByTimeAsync(AUDIO_HUB_RESULT_TIMEOUT_MS);
            expect(outcome?.kind).toBe('error');
        } finally {
            vi.useRealTimers();
        }
    });

    it('the panel is offered only an own, active session to THAT device', async () => {
        const { sendAudioHubRequest, audioHubSessionFor } = await import('../api/devices/session');
        // (A friend's share is refused by the HOST, deviceSessionAuth.test.ts,
        // and skipped by this lookup's `!s.share`.)
        const { id } = await activeController({ audioHub: true });
        expect(audioHubSessionFor('dev-host')).toBe(id);
        expect(audioHubSessionFor('some-other-device')).toBeNull();
        const o = await sendAudioHubRequest('no-such-session', 'status');
        expect(o.kind).toBe('error');
    });
});
