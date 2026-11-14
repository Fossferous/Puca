// @vitest-environment jsdom
/**
 * The device card's Power off, CONTROLLER side: the session it opens, when the
 * forced power-off goes out, and how every answer — and every silence — is
 * recorded for the card to say (api/devices/powerOff.ts words it).
 *
 * The host half (who may, and in what order it acks, calls Windows and ends)
 * is driven in deviceSessionAuth.test.ts, "the forced power-off". These drive
 * the REAL controller handlers with a stand-in host that seals frames under
 * the real session key — the rig of deviceAudioHubController.test.ts.
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
const requestUnattendedPassphrase = vi.fn(async (): Promise<string | null> => null);
vi.mock('../api/devices/unattendedPrompt', () => ({
    requestUnattendedPassphrase: () => requestUnattendedPassphrase(),
}));
const confirmUaSeed = vi.fn();
const forgetUaSeed = vi.fn();
// The passphrase stretch (argon2id: ~0.4 s on a desktop, longer on a phone),
// replaceable so a test can make time pass inside it.
const deriveUaSeed = vi.fn((): Uint8Array => new Uint8Array(32));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => deriveUaSeed(),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: (...a: unknown[]) => confirmUaSeed(...a),
    forgetUaSeed: (...a: unknown[]) => forgetUaSeed(...a),
}));
// The follow to a PC's desktop after somebody signs in at it (wakeSession).
const followToDesktop = vi.fn();
const followToSignIn = vi.fn();
vi.mock('../api/devices/wakeSession', () => ({
    followToDesktop: (...a: unknown[]) => followToDesktop(...a),
    followToSignIn: (...a: unknown[]) => followToSignIn(...a),
}));
vi.mock('../api/devices/index', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/devices/index')>()),
    currentUserId: () => 42,
}));
vi.mock('../api/platform', () => ({
    isTauri: () => false,
    isMobile: () => false,
    getApiBaseUrl: () => 'http://localhost:3000',
    getWebSocketUrl: () => 'ws://localhost:3000',
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/devices/shares', () => ({
    verifiedSharePeerDevice: async () => ({ device_pub: 'x25519:' + btoa('k') }),
}));
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
import type { DeviceControlSession } from '../api/devices/session';

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

/** Wait for what a step produces, bounded in REAL time (WebCrypto runs on
 *  libuv's pool, so a fixed number of turns can lose the race on a busy
 *  machine). setImmediate is never faked here. */
async function spinUntil(what: string, done: () => boolean | Promise<boolean>): Promise<void> {
    const end = performance.now() + 4000;
    while (!(await done())) {
        if (performance.now() > end) throw new Error(`${what} never happened`);
        await new Promise(r => setImmediate(r));
    }
}

let hostSeq = 0;
/** Every snapshot of every session, by id: the ENDED one is emitted once and
 *  then deleted, and it is the one these tests read. */
const seen = new Map<string, DeviceControlSession>();

type ShareOpt = { inviteId: number; ownerUser: number; ownerUsername: string; capabilities: string[] };

async function startController(opts: { powerOff?: boolean; filesOnly?: boolean; share?: ShareOpt }): Promise<string> {
    const { installDeviceSessions, connectToDevice, endAllSessions, subscribeSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    hostSeq = 0;
    seen.clear();
    subscribeSessions(all => { for (const s of all) seen.set(s.id, s); });
    return connectToDevice('dev-host', { ...opts, peerName: 'Slim-Jim' });
}

/** An active controller session to 'dev-host', and the key the HOST holds. */
async function activeController(opts: { powerOff?: boolean; filesOnly?: boolean; share?: ShareOpt } = { powerOff: true }): Promise<{ id: string; key: Uint8Array }> {
    const id = await startController(opts);
    const controllerEph = sent.find(m => m.type === 'DeviceConnect')?.payload?.eph as string;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph)!;
    handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded } });
    // Past 'connecting' (a refusal on the spot can take it straight to 'ended').
    await spinUntil('the session going active', () => !!seen.get(id) && seen.get(id)?.phase !== 'connecting');
    return { id, key };
}

async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: hostSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
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
const powerFrames = async (key: Uint8Array) => (await controllerFrames(key)).filter(f => f.kind === 'power');

/** The host answering an offer (a Files or Control session's). */
async function answerOffer(id: string, key: Uint8Array): Promise<void> {
    await hostSignal(id, key, { kind: 'answer', sdp: 'v=0\r\n', dataOnly: true });
}

/** A power-off session, connected: the request is out. */
async function sentPowerOff(): Promise<{ id: string; key: Uint8Array }> {
    const { id, key } = await activeController({ powerOff: true });
    await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
    return { id, key };
}

const CHALLENGE = { kind: 'ua-challenge', nonce: btoa('n'.repeat(32)), salt: btoa('s'.repeat(16)) };

const deviceEnds = (id: string) => sent.filter(m => m.type === 'DeviceEnd' && m.payload?.session_id === id);

beforeEach(() => {
    vi.useRealTimers();
    requestUnattendedPassphrase.mockReset();
    requestUnattendedPassphrase.mockResolvedValue(null);
});
afterEach(() => {
    vi.useRealTimers();
});

describe('a power-off session', () => {
    it('sends NO offer and asks for no files — and the power-off goes the moment it is connected', async () => {
        const { FORCE_POWER_OFF_ACTION } = await import('../api/devices/session');
        const { id, key } = await sentPowerOff();
        await settle();
        const frames = await controllerFrames(key);
        // The sign-in-screen agent (the way into a LOCKED PC) ends a
        // files-only offer outright, so an offer would make Power off
        // impossible exactly where it is needed.
        expect(frames.some(f => f.kind === 'offer'), 'no offer at all').toBe(false);
        expect(frames.some(f => f.kind === 'file-access-request'), 'no file browsing was asked for').toBe(false);
        const power = await powerFrames(key);
        expect(power).toHaveLength(1);
        expect(power[0].action).toBe(FORCE_POWER_OFF_ACTION);
        expect(FORCE_POWER_OFF_ACTION, 'the wire spelling both Rust hosts parse').toBe('force_power_off');
        expect(seen.get(id)).toMatchObject({ powerOffOnly: true, filesOnly: true, audioHub: false, phase: 'active' });
        expect(seen.get(id)?.powerOff?.state).toBe('sent');
    });

    it('POSITIVE CONTROL: a Files session still sends its offer and asks for file access, and no power-off', async () => {
        const { id, key } = await activeController({ filesOnly: true });
        await answerOffer(id, key);
        await settle();
        const frames = await controllerFrames(key);
        expect(frames.some(f => f.kind === 'offer')).toBe(true);
        expect(frames.some(f => f.kind === 'file-access-request')).toBe(true);
        expect(frames.some(f => f.kind === 'power')).toBe(false);
        expect(seen.get(id)?.powerOff).toBeNull();
    });

    it('opening one never ends a Files session already open to that PC', async () => {
        const { connectToDevice } = await import('../api/devices/session');
        const { id } = await activeController({ filesOnly: true });
        await connectToDevice('dev-host', { powerOff: true });
        await settle();
        expect(deviceEnds(id), 'Power off must not silently end somebody\'s Files session').toEqual([]);
    });

    it('…and Control replaces one, like an Audio Hub session', async () => {
        const { connectToDevice } = await import('../api/devices/session');
        const { id } = await activeController({ powerOff: true });
        await connectToDevice('dev-host');
        await settle();
        expect(deviceEnds(id)).toHaveLength(1);
    });

    it('its own end tells the server nothing of what it was for', async () => {
        const { id, key } = await sentPowerOff();
        await hostSignal(id, key, { kind: 'power-failed', action: 'force_power_off', reason: 'Windows refused: the account Púca runs as there may not shut it down' });
        await spinUntil('the end', () => seen.get(id)?.phase === 'ended');
        const ends = deviceEnds(id);
        expect(ends).toHaveLength(1);
        // Server-visible: the plain hang-up, never the sealed answer's words.
        expect(ends[0].payload?.reason).toBe('the session ended');
    });
});

describe('how it ends', () => {
    it('the attended host: ack ("going"), then the end WITH the shutdown reason, is done — and leaves no banner', async () => {
        const { SHUTDOWN_REASON } = await import('../api/devices/session');
        const { id, key } = await sentPowerOff();
        await hostSignal(id, key, { kind: 'power-ack', action: 'force_power_off' });
        await spinUntil('the ack', () => seen.get(id)?.powerOff?.state === 'accepted');
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: SHUTDOWN_REASON } });
        await settle();
        const end = seen.get(id)!;
        expect(end.phase).toBe('ended');
        expect(end.powerOff).toEqual({ state: 'done', reason: SHUTDOWN_REASON });
        // The stage puts its failure banner over ANY ended controller session
        // with an error; the card says this one.
        expect(end.error).toBeNull();
    });

    it('the sign-in-screen agent: no ack, the end with the reason is done', async () => {
        const { SHUTDOWN_REASON } = await import('../api/devices/session');
        const { id } = await sentPowerOff();
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: SHUTDOWN_REASON } });
        await settle();
        expect(seen.get(id)?.powerOff?.state).toBe('done');
    });

    it('acked, then the connection simply went (the PC died first): done', async () => {
        const { id, key } = await sentPowerOff();
        await hostSignal(id, key, { kind: 'power-ack', action: 'force_power_off' });
        await spinUntil('the ack', () => seen.get(id)?.powerOff?.state === 'accepted');
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the other device disconnected' } });
        await settle();
        expect(seen.get(id)?.powerOff?.state).toBe('done');
    });

    it('sent, then the connection went with NO answer either way: unknown, never called success', async () => {
        const { id } = await sentPowerOff();
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the other device disconnected' } });
        await settle();
        expect(seen.get(id)?.powerOff).toEqual({ state: 'unknown', reason: 'the other device disconnected' });
    });

    it('Windows refusing after the ack is a failure with the host\'s words, and the session is ended quietly', async () => {
        const { id, key } = await sentPowerOff();
        await hostSignal(id, key, { kind: 'power-ack', action: 'force_power_off' });
        await spinUntil('the ack', () => seen.get(id)?.powerOff?.state === 'accepted');
        await hostSignal(id, key, { kind: 'power-failed', action: 'force_power_off', reason: 'Windows refused: the account Púca runs as there may not shut it down' });
        await spinUntil('the failure', () => seen.get(id)?.phase === 'ended');
        const end = seen.get(id)!;
        expect(end.powerOff).toEqual({ state: 'failed', reason: 'Windows refused: the account Púca runs as there may not shut it down' });
        expect(end.error, 'no stage banner: the card says it').toBeNull();
        expect(deviceEnds(id), 'the session it opened is closed, not left on the PC').toHaveLength(1);
    });

    it('an OLDER sign-in-screen agent ("not one this agent knows") is a failure the card words as too old', async () => {
        const { id, key } = await sentPowerOff();
        await hostSignal(id, key, { kind: 'power-failed', action: 'force_power_off', reason: 'that power action is not one this agent knows' });
        await spinUntil('the failure', () => seen.get(id)?.powerOff?.state === 'failed');
        expect(seen.get(id)?.powerOff?.reason).toBe('that power action is not one this agent knows');
    });

    it('an OLDER host drops it on the floor: POWER_OFF_ANSWER_TIMEOUT_MS later it is "too old", and only then', async () => {
        const { POWER_OFF_ANSWER_TIMEOUT_MS, POWER_OFF_TOO_OLD_REASON } = await import('../api/devices/session');
        // Fake ONLY the deadline clock, from before the request is armed.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { id, key } = await activeController({ powerOff: true });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS - 100);
        expect(seen.get(id)?.powerOff?.state, 'not before the deadline').toBe('sent');
        await vi.advanceTimersByTimeAsync(200);
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: POWER_OFF_TOO_OLD_REASON });
        expect(seen.get(id)?.phase).toBe('ended');
    });

    it('an ack moves it off the short deadline (a current host is never called too old)', async () => {
        const { POWER_OFF_ANSWER_TIMEOUT_MS, POWER_OFF_GOING_TIMEOUT_MS, POWER_OFF_STOPPED_WAITING_REASON } = await import('../api/devices/session');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { id, key } = await activeController({ powerOff: true });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        await hostSignal(id, key, { kind: 'power-ack', action: 'force_power_off' });
        await spinUntil('the ack', () => seen.get(id)?.powerOff?.state === 'accepted');
        await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS + 1000);
        expect(seen.get(id)?.powerOff?.state).toBe('accepted');
        // It said it is going; past the long wait this side stops waiting and
        // takes it at its word.
        await vi.advanceTimersByTimeAsync(POWER_OFF_GOING_TIMEOUT_MS);
        expect(seen.get(id)?.powerOff).toEqual({ state: 'done', reason: POWER_OFF_STOPPED_WAITING_REASON });
    });

    it('the other end reconnecting is no verdict: the deadline waits, and the server\'s end decides', async () => {
        const { POWER_OFF_ANSWER_TIMEOUT_MS } = await import('../api/devices/session');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { id, key } = await activeController({ powerOff: true });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        handlers.get('DevicePeerReconnecting')!({ payload: { session_id: id } });
        await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS * 3);
        expect(seen.get(id)?.powerOff?.state, 'not "too old" over a dropped link').toBe('sent');
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the other device disconnected' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(seen.get(id)?.powerOff?.state).toBe('unknown');
    });

    it('refused before it ever got in (nobody let it in) is a failure with that reason', async () => {
        const id = await startController({ powerOff: true });
        handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: false, reason: 'the person at that device declined' } });
        await settle();
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: 'the person at that device declined' });
        expect(seen.get(id)?.error, 'no stage banner for it').toBeNull();
    });

    it('the server saying it is offline is a failure with that reason', async () => {
        const id = await startController({ powerOff: true });
        handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: false, reason: "that device isn't online" } });
        await settle();
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: "that device isn't online" });
    });
});

describe('an armed PC (the passphrase)', () => {
    it('the passphrase not entered: a FAILURE, never "unknown" — the host holds the request until the proof', async () => {
        const { id, key } = await sentPowerOff();
        requestUnattendedPassphrase.mockResolvedValueOnce(null);
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the end', () => seen.get(id)?.phase === 'ended');
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: 'unattended passphrase not entered' });
        expect((await controllerFrames(key)).some(f => f.kind === 'ua-response'), 'no proof went').toBe(false);
    });

    it('the link dropping while the passphrase is being typed: a failure too, never "unknown" (no proof went)', async () => {
        const { id, key } = await sentPowerOff();
        requestUnattendedPassphrase.mockImplementationOnce(() => new Promise<string | null>(() => {}));
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the prompt', () => requestUnattendedPassphrase.mock.calls.length === 1);
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the other device disconnected' } });
        await settle();
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: 'the other device disconnected' });
    });

    it('the passphrase refused by the PC: a failure', async () => {
        const { id, key } = await sentPowerOff();
        requestUnattendedPassphrase.mockResolvedValueOnce('wrong horse');
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the proof', async () => (await controllerFrames(key)).some(f => f.kind === 'ua-response'));
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'unattended access was refused' } });
        await settle();
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: 'unattended access was refused' });
    });

    it('typing the passphrase does not count: the deadline waits, and starts afresh when the proof is sent', async () => {
        const { POWER_OFF_ANSWER_TIMEOUT_MS, POWER_OFF_TOO_OLD_REASON } = await import('../api/devices/session');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { id, key } = await activeController({ powerOff: true });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        let type: (p: string | null) => void = () => {};
        requestUnattendedPassphrase.mockImplementationOnce(() => new Promise<string | null>(r => { type = r; }));
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the prompt', () => requestUnattendedPassphrase.mock.calls.length === 1);
        // A slow typist: far past the deadline, and still no verdict. OFF the
        // deadline's own grid (4.6 of them), so an old clock still running
        // would fire before a fresh one could.
        await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS * 4 + POWER_OFF_ANSWER_TIMEOUT_MS * 0.6);
        expect(seen.get(id)?.powerOff?.state).toBe('sent');
        type('correct horse');
        await spinUntil('the proof', async () => (await controllerFrames(key)).some(f => f.kind === 'ua-response'));
        // The host has its full answer time from the proof.
        await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS - 100);
        expect(seen.get(id)?.powerOff?.state, 'a full deadline from the proof').toBe('sent');
        await vi.advanceTimersByTimeAsync(200);
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: POWER_OFF_TOO_OLD_REASON });
    });

    it('a power-off the PC answered keeps the remembered passphrase (it was right)', async () => {
        const { SHUTDOWN_REASON } = await import('../api/devices/session');
        confirmUaSeed.mockClear();
        forgetUaSeed.mockClear();
        const { id, key } = await sentPowerOff();
        requestUnattendedPassphrase.mockResolvedValueOnce('correct horse');
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the proof', async () => (await controllerFrames(key)).some(f => f.kind === 'ua-response'));
        await hostSignal(id, key, { kind: 'power-ack', action: 'force_power_off' });
        await spinUntil('the ack', () => seen.get(id)?.powerOff?.state === 'accepted');
        // The PC died before it could say goodbye: the ACK alone vouches.
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the other device disconnected' } });
        await settle();
        expect(seen.get(id)?.powerOff?.state, 'premise').toBe('done');
        expect(SHUTDOWN_REASON, 'premise: not the end that also vouches').not.toBe('the other device disconnected');
        expect(confirmUaSeed, 'the host answered only past the proof').toHaveBeenCalledWith('dev-host');
        expect(forgetUaSeed, 'and teardown must not forget it as unconfirmed').not.toHaveBeenCalled();
    });

    it('…and so does the sign-in agent\'s end with the reason (it sends no ack)', async () => {
        const { SHUTDOWN_REASON } = await import('../api/devices/session');
        confirmUaSeed.mockClear();
        forgetUaSeed.mockClear();
        const { id, key } = await sentPowerOff();
        requestUnattendedPassphrase.mockResolvedValueOnce('correct horse');
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the proof', async () => (await controllerFrames(key)).some(f => f.kind === 'ua-response'));
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: SHUTDOWN_REASON } });
        await settle();
        expect(confirmUaSeed).toHaveBeenCalledWith('dev-host');
        expect(forgetUaSeed).not.toHaveBeenCalled();
    });

    it('somebody signing in at the locked PC first: not done, and NOT followed into a Control session', async () => {
        const { HANDOVER_REASON, POWER_OFF_UNLOCKED_REASON } = await import('../api/devices/session');
        followToDesktop.mockClear();
        const { id } = await sentPowerOff();
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: HANDOVER_REASON } });
        await settle();
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: POWER_OFF_UNLOCKED_REASON });
        expect(followToDesktop, 'a Control session nobody asked for').not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a Files session IS followed to the desktop on the same hand-over', async () => {
        const { HANDOVER_REASON } = await import('../api/devices/session');
        followToDesktop.mockClear();
        const { id } = await activeController({ filesOnly: true });
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: HANDOVER_REASON } });
        await settle();
        expect(followToDesktop).toHaveBeenCalled();
    });

    it('the deadline falling due while the passphrase is being STRETCHED is no verdict: the proof still goes, and the clock starts from it', async () => {
        // The prompt has closed (awaitingUaPassphrase is false again), but the
        // proof has not left: argon2id, then signing and sealing, take real
        // time. A verdict there would end the session before the proof it was
        // waiting for, and tell the user to update a PC that is fine.
        const { POWER_OFF_ANSWER_TIMEOUT_MS, POWER_OFF_TOO_OLD_REASON } = await import('../api/devices/session');
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const { id, key } = await activeController({ powerOff: true });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        requestUnattendedPassphrase.mockResolvedValueOnce('correct horse');
        // The stretch outlasts the whole deadline, so it falls due INSIDE it.
        deriveUaSeed.mockImplementationOnce(() => {
            vi.advanceTimersByTime(POWER_OFF_ANSWER_TIMEOUT_MS + 500);
            return new Uint8Array(32);
        });
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the proof', async () => (await controllerFrames(key)).some(f => f.kind === 'ua-response'));
        expect(deriveUaSeed, 'premise: the stretch ran').toHaveBeenCalled();
        expect(seen.get(id)?.phase, 'not ended before its proof left').toBe('active');
        expect(seen.get(id)?.powerOff?.state).toBe('sent');
        // From the proof, the host's full answer time — and then the verdict.
        await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS - 100);
        expect(seen.get(id)?.powerOff?.state, 'a full deadline from the proof').toBe('sent');
        await vi.advanceTimersByTimeAsync(200);
        expect(seen.get(id)?.powerOff).toEqual({ state: 'failed', reason: POWER_OFF_TOO_OLD_REASON });
    });

    it('a LOCK at the PC first (the host hands a session over at a lock): not done, and NOT followed to its lock screen', async () => {
        const { LOCK_HANDOVER_REASON, POWER_OFF_LOCKED_REASON } = await import('../api/devices/session');
        followToSignIn.mockClear();
        const { id } = await sentPowerOff();
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: LOCK_HANDOVER_REASON } });
        await settle();
        expect(seen.get(id)?.powerOff, 'never "unknown": the host drops what it held at the lock')
            .toEqual({ state: 'failed', reason: POWER_OFF_LOCKED_REASON });
        expect(followToSignIn, 'a Control session nobody asked for').not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a Files session IS followed to the lock screen on the same hand-over', async () => {
        const { LOCK_HANDOVER_REASON } = await import('../api/devices/session');
        followToSignIn.mockClear();
        const { id } = await activeController({ filesOnly: true });
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: LOCK_HANDOVER_REASON } });
        await settle();
        expect(followToSignIn).toHaveBeenCalled();
    });

    it('a friend\'s PC locking first: not done either (the share\'s own wording for that end)', async () => {
        const { LOCK_HANDOVER_REASON } = await import('../api/devices/session');
        followToSignIn.mockClear();
        const { id, key } = await activeController({
            powerOff: true,
            share: { inviteId: 7, ownerUser: 9, ownerUsername: 'friend', capabilities: ['control'] },
        });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: LOCK_HANDOVER_REASON } });
        await settle();
        expect(seen.get(id)?.powerOff?.state).toBe('failed');
        expect(seen.get(id)?.powerOff?.reason).toMatch(/machine is now locked/);
        expect(followToSignIn).not.toHaveBeenCalled();
    });

    it('proved: the held request is the host\'s to carry out, and its ack is taken', async () => {
        const { id, key } = await sentPowerOff();
        requestUnattendedPassphrase.mockResolvedValueOnce('correct horse');
        await hostSignal(id, key, CHALLENGE);
        await spinUntil('the proof', async () => (await controllerFrames(key)).some(f => f.kind === 'ua-response'));
        expect(await powerFrames(key), 'sent once, never again').toHaveLength(1);
        await hostSignal(id, key, { kind: 'power-ack', action: 'force_power_off' });
        await spinUntil('the ack', () => seen.get(id)?.powerOff?.state === 'accepted');
    });
});

describe('who may', () => {
    it('a share WITHOUT control never sends it: refused here as not allowed', async () => {
        const { POWER_OFF_NOT_ALLOWED_REASON } = await import('../api/devices/session');
        const { id, key } = await activeController({
            powerOff: true,
            share: { inviteId: 7, ownerUser: 9, ownerUsername: 'friend', capabilities: ['view_only', 'files'] },
        });
        await spinUntil('the refusal', () => seen.get(id)?.powerOff?.state === 'failed');
        expect(seen.get(id)?.powerOff?.reason).toBe(POWER_OFF_NOT_ALLOWED_REASON);
        expect(await powerFrames(key)).toEqual([]);
    });

    it('POSITIVE CONTROL: a share WITH control sends it', async () => {
        const { key } = await activeController({
            powerOff: true,
            share: { inviteId: 7, ownerUser: 9, ownerUsername: 'friend', capabilities: ['control'] },
        });
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
    });

    it('the host refusing OUT LOUD (not allowed, or somebody there let it in) is recorded with its code', async () => {
        const { POWER_OFF_NOT_ALLOWED_REASON, POWER_OFF_ATTENDED_REASON } = await import('../api/devices/session');
        for (const code of [POWER_OFF_NOT_ALLOWED_REASON, POWER_OFF_ATTENDED_REASON]) {
            const { id, key } = await sentPowerOff();
            await hostSignal(id, key, { kind: 'power-failed', action: 'force_power_off', reason: code });
            await spinUntil('the failure', () => seen.get(id)?.powerOff?.state === 'failed');
            expect(seen.get(id)?.powerOff?.reason).toBe(code);
        }
    });
});

describe('riding a live session', () => {
    it('a Control session already open carries it, and a refusal leaves that session up', async () => {
        const { requestForcePowerOff, powerOffSessionFor } = await import('../api/devices/session');
        const { id, key } = await activeController({});
        expect(powerOffSessionFor('dev-host'), 'not before the host has answered').toBeNull();
        expect(requestForcePowerOff(id)).toBe(false);
        await answerOffer(id, key);
        await settle();
        expect(powerOffSessionFor('dev-host')).toBe(id);
        expect(requestForcePowerOff(id)).toBe(true);
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        await hostSignal(id, key, { kind: 'power-failed', action: 'force_power_off', reason: 'Windows refused to power it off (error 1190)' });
        await spinUntil('the failure', () => seen.get(id)?.powerOff?.state === 'failed');
        expect(seen.get(id)?.phase, 'somebody\'s Control session is not ended by a refused power-off').toBe('active');
        expect(deviceEnds(id)).toEqual([]);
    });

    it('not one whose other end is reconnecting (the server drops what is sent meanwhile)', async () => {
        const { requestForcePowerOff, powerOffSessionFor } = await import('../api/devices/session');
        const { id, key } = await activeController({});
        await answerOffer(id, key);
        await settle();
        handlers.get('DevicePeerReconnecting')!({ payload: { session_id: id } });
        await settle();
        expect(powerOffSessionFor('dev-host')).toBeNull();
        expect(requestForcePowerOff(id)).toBe(false);
    });

    it('a bare sendPowerAction with the forced action takes the same guarded path', async () => {
        const { sendPowerAction } = await import('../api/devices/session');
        const { id, key } = await activeController({});
        // Not answered yet: refused, nothing sent.
        expect(sendPowerAction(id, 'force_power_off')).toBe(false);
        await answerOffer(id, key);
        await settle();
        expect(sendPowerAction(id, 'force_power_off')).toBe(true);
        await spinUntil('the power-off frame', async () => (await powerFrames(key)).length === 1);
        expect(seen.get(id)?.powerOff?.state).toBe('sent');
    });
});
