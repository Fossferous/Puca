/**
 * A CONTROLLER must not lose the unattended challenge that an armed host sends
 * the instant it accepts.
 *
 * THE BUG THIS PINS, and it is why armed unattended access never once worked.
 * The host issues `ua-challenge` immediately after its accept. The controller
 * only has a session key AFTER an async peer-key lookup (an HTTP round trip on
 * a cold cache) and a Diffie-Hellman over Tauri IPC — and the WebSocket does not
 * wait for any of that. So the challenge arrived while `s.key` was still null,
 * `openSignal` returned null for it, and the frame was discarded with no log, no
 * retry, and no way for either end to notice: the host never re-sends, and the
 * controller does not know it was owed anything.
 *
 * What the user saw: no passphrase prompt, ever. The stage sat on "Waiting for
 * the device's screen…" until the 30s media deadline killed it, and the reason
 * was written to a session object that had already been deleted, so nothing was
 * displayed at all. Meanwhile the host sat holding the offer, which is why its
 * agent.log ends at "[host] using the NATIVE AGENT for this session" with no
 * start_stream after it.
 *
 * Attended sessions were immune, which is what made this look like an
 * unattended-specific mystery: there the host's first frame is the ANSWER, and
 * an answer cannot precede the controller's own offer — by which time the key
 * exists.
 *
 * The tests below drive the real handlers and assert on whether the passphrase
 * was actually requested and answered, not on any internal flag.
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
 * The Diffie-Hellman the controller must finish before it has a key — held
 * open on purpose, because the whole bug lives in that window.
 */
let releaseDh: (() => void) | null = null;
let dhGate: Promise<void> = Promise.resolve();
function holdKeyAgreement(): void {
    dhGate = new Promise<void>(resolve => { releaseDh = resolve; });
}
vi.mock('../api/devices/deviceKey', () => ({
    deviceKeyDh: async () => {
        await dhGate;
        return new Uint8Array(32).fill(3);
    },
}));

/**
 * The passphrase the user types. Held open in the deadline test, because "how
 * long does someone take to type" is the whole question there.
 */
let answerPassphrase: ((v: string | null) => void) | null = null;
let passphraseIsSlow = false;
const requestUnattendedPassphrase = vi.fn(async () => {
    if (!passphraseIsSlow) return 'correct horse battery';
    return new Promise<string | null>(resolve => { answerPassphrase = resolve; });
});
vi.mock('../api/devices/unattendedPrompt', () => ({
    requestUnattendedPassphrase: () => requestUnattendedPassphrase(),
}));

/** The stretched seed a typed passphrase derives in this rig. */
const DERIVED = new Uint8Array(32).fill(9);
const deriveUaSeed = vi.fn((..._a: unknown[]) => DERIVED);
const signUaChallengeSeed = vi.fn((..._a: unknown[]) => new Uint8Array(64).fill(7));
/** What this device "remembers" for the host — null means a prompt is owed. */
let rememberedSeed: Uint8Array | null = null;
const rememberedUaSeed = vi.fn((..._a: unknown[]) => rememberedSeed);
const rememberUaSeed = vi.fn((..._a: unknown[]) => {});
const confirmUaSeed = vi.fn((..._a: unknown[]) => {});
const forgetUaSeed = vi.fn((..._a: unknown[]) => {});
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: (...a: unknown[]) => deriveUaSeed(...(a as [])),
    signUaChallengeSeed: (...a: unknown[]) => signUaChallengeSeed(...(a as [])),
    rememberedUaSeed: (...a: unknown[]) => rememberedUaSeed(...(a as [])),
    rememberUaSeed: (...a: unknown[]) => rememberUaSeed(...(a as [])),
    confirmUaSeed: (...a: unknown[]) => confirmUaSeed(...(a as [])),
    forgetUaSeed: (...a: unknown[]) => forgetUaSeed(...(a as [])),
}));

/** Whether this rig plays a NATIVE shell (Tauri/Capacitor). Remembering the
 *  seed is native-only — app-owned storage — so the web case must be testable
 *  too. Everything else platform.ts exports is irrelevant to this rig. */
let nativeShell = true;
vi.mock('../api/platform', () => ({
    isTauri: () => nativeShell,
    isMobile: () => false,
    getApiBaseUrl: () => 'http://localhost:3000',
    getWebSocketUrl: () => 'ws://localhost:3000',
}));

vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/index', () => ({ thisDeviceId: () => 'dev-me' }));
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
        injectEvent: async () => {},
    }),
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl, openControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';

/**
 * The controller builds a real peer connection, and the shared stub in
 * setup.ts predates the data channel and the recvonly transceiver. Without
 * both, `DeviceConnectAnswered` throws and tears the session down — which would
 * make every assertion below pass or fail for the wrong reason.
 */
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
Object.defineProperty(window, 'RTCPeerConnection', {
    value: ControllerPc, configurable: true, writable: true,
});

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

const NONCE = btoa('nonce-abcdefgh');
const SALT = btoa('salt-abcdefgh');

/**
 * Drive a controller session up to the point where the host has accepted, with
 * the key agreement still in flight. Returns the key the HOST would hold, so
 * the test can seal frames exactly as a real host does.
 */
async function connectingController(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    holdKeyAgreement();
    const id = await connectToDevice('dev-host');

    const connect = sent.find(m => m.type === 'DeviceConnect');
    const controllerEph = connect?.payload?.eph as string;
    expect(controllerEph, 'the controller must publish its ephemeral').toBeTruthy();

    // Stand in for the host: its own ephemeral, and the same key both sides
    // derive from the pair.
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph);
    expect(key).not.toBeNull();

    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle(2);
    return { id, key: key! };
}

/** Seal and deliver one signal frame, as the host would. */
async function hostSignal(id: string, key: Uint8Array, n: number, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

/** The controller's answer to the challenge, opened as the host would open it. */
async function uaResponse(key: Uint8Array): Promise<Record<string, unknown> | null> {
    for (const m of sent) {
        if (m.type !== 'DeviceSignal') continue;
        const plain = await openControl(key, m.payload!.payload as string);
        if (!plain) continue;
        const obj = JSON.parse(plain) as Record<string, unknown>;
        if (obj.kind === 'ua-response') return obj;
    }
    return null;
}

beforeEach(() => {
    requestUnattendedPassphrase.mockClear();
    deriveUaSeed.mockClear();
    signUaChallengeSeed.mockClear();
    rememberedUaSeed.mockClear();
    rememberUaSeed.mockClear();
    confirmUaSeed.mockClear();
    forgetUaSeed.mockClear();
    rememberedSeed = null;
    nativeShell = true;
    releaseDh = null;
    answerPassphrase = null;
    passphraseIsSlow = false;
});

describe('controller: an unattended challenge that arrives before the key', () => {
    it('is held and answered once the key is agreed', async () => {
        const { id, key } = await connectingController();

        // THE RACE. The host has accepted and challenged; this controller is
        // still deriving. Before the fix this frame was dropped on the floor.
        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        expect(
            requestUnattendedPassphrase,
            'nothing can be asked before there is a key to answer with',
        ).not.toHaveBeenCalled();

        // Key agreement completes.
        releaseDh!();
        await settle();

        expect(
            requestUnattendedPassphrase,
            'the held challenge must be replayed once the key exists',
        ).toHaveBeenCalledTimes(1);

        const reply = await uaResponse(key);
        expect(reply, 'the controller must send a ua-response the host can open').toBeTruthy();
        expect(reply!.nonce, 'it must answer the nonce it was challenged with').toBe(NONCE);

        // The signature is over the SALT AND NONCE the host chose, not
        // defaults: the salt reaches the derivation, the nonce the signing.
        const [, salt] = deriveUaSeed.mock.calls[0] as unknown as [string, Uint8Array];
        expect(Array.from(salt)).toEqual(Array.from(Uint8Array.from(atob(SALT), c => c.charCodeAt(0))));
        const [, , nonce] = signUaChallengeSeed.mock.calls[0] as unknown as [Uint8Array, string, Uint8Array];
        expect(Array.from(nonce)).toEqual(Array.from(Uint8Array.from(atob(NONCE), c => c.charCodeAt(0))));
    });

    /**
     * POSITIVE CONTROL. Everything above is about a frame arriving EARLY, and
     * an assertion that something did not happen is worthless without proof the
     * rig can see it happen at all. Same challenge, delivered after the key is
     * in place, must prompt — if this fails, the test above proves nothing.
     */
    it('is answered normally when it arrives after the key', async () => {
        const { id, key } = await connectingController();
        releaseDh!();
        await settle();

        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        expect(requestUnattendedPassphrase).toHaveBeenCalledTimes(1);
        expect((await uaResponse(key))?.nonce).toBe(NONCE);
    });

    /**
     * The challenge is also a FACT about the session: only an armed host sends
     * one, and "nobody at that machine was asked anything" is what lets the
     * stage ask an older host for every screen without ever overriding a
     * screen someone picked in the consent prompt. Read through the PUBLIC
     * snapshot, which is what the stage sees — the field is projected in
     * emit(), and a field set on the internal object alone would be invisible.
     */
    it('marks the session unattended once a challenge has arrived — and not before', async () => {
        const { subscribeSessions } = await import('../api/devices/session');
        let latest: Array<{ id: string; unattended: boolean }> = [];
        const unsub = subscribeSessions(next => { latest = next; });
        try {
            const { id, key } = await connectingController();
            releaseDh!();
            await settle();
            expect(latest.find(s => s.id === id)?.unattended,
                'an attended connect (no challenge) is not unattended').toBe(false);

            await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });
            expect(requestUnattendedPassphrase).toHaveBeenCalledTimes(1);
            expect(latest.find(s => s.id === id)?.unattended,
                'the challenge makes it unattended, and the snapshot says so').toBe(true);
        } finally {
            unsub();
        }
    });

    it('replays held frames in the order they arrived', async () => {
        const { id, key } = await connectingController();

        // Two frames while the key is still being agreed. `openSignal` demands
        // a strictly increasing counter, so replaying these out of order would
        // silently discard the second — the challenge would be answered, or
        // dropped, depending purely on which one won.
        await hostSignal(id, key, 0, { kind: 'monitors', monitors: [{ id: 0, label: 'Main display' }], active: 0 });
        await hostSignal(id, key, 1, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        releaseDh!();
        await settle();

        const { activeSessions } = await import('../api/devices/session');
        const s = activeSessions().find(x => x.id === id);
        expect(s?.monitors.map(m => m.label), 'the earlier frame must survive too').toEqual(['Main display']);
        expect(requestUnattendedPassphrase, 'and the later one must still be processed').toHaveBeenCalledTimes(1);
    });

    /**
     * THE REGRESSION THE REPLAY ITSELF CREATES, and the reason a fix must be
     * reviewed as new code.
     *
     * The challenge handler clears the controller's 30s media deadline before
     * prompting, so the session does not die while someone types. That clear
     * only works if the timer is already armed — and a REPLAYED challenge runs
     * the moment the key lands, which is BEFORE `DeviceConnectAnswered` finishes
     * and arms it. The clear then hit nothing, the timer was armed a moment
     * later, and a user taking longer than thirty seconds lost the session with
     * a message about "an older version of Puca".
     */
    it('does not time out while the passphrase dialog is still open', async () => {
        passphraseIsSlow = true;
        // shouldAdvanceTime keeps the settle() helper's real setTimeout(0)
        // working while letting the 30s deadline be jumped deliberately.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { id, key } = await connectingController();

            await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });
            releaseDh!();
            await settle();

            expect(requestUnattendedPassphrase, 'the prompt must be open').toHaveBeenCalledTimes(1);
            expect(answerPassphrase, 'and still waiting for an answer').toBeTruthy();

            // Longer than the 30s media deadline, well inside the host's 120s.
            await vi.advanceTimersByTimeAsync(45_000);
            await settle();

            const { activeSessions } = await import('../api/devices/session');
            const alive = activeSessions().find(x => x.id === id);
            expect(alive, 'the session must survive a slow typist').toBeTruthy();
            expect(alive!.phase).not.toBe('ended');

            // Answering still works, and the response goes out.
            answerPassphrase!('correct horse battery');
            await settle();
            expect((await uaResponse(key))?.nonce).toBe(NONCE);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the head of a flood and drops the overflow', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { id, key } = await connectingController();

            // The RELAY decides how many frames arrive before the key exists,
            // so the buffer needs a ceiling. The challenge goes FIRST, because
            // the head is what a real handshake puts there and what the cap
            // must therefore protect.
            await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

            // Then a flood past the cap. The last one is observable on its own:
            // if the cap were not enforced it would take effect.
            for (let n = 1; n <= 40; n++) {
                const last = n === 40;
                const sealed = await sealControl(key, JSON.stringify(last
                    ? { sid: id, n, kind: 'monitors', monitors: [{ id: 9, label: 'PAST-THE-CAP' }], active: 9 }
                    : { sid: id, n, kind: 'ice', candidate: { candidate: `candidate:${n}`, sdpMid: '0' } }));
                handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
            }

            releaseDh!();
            await settle(20);

            // The head survived: the handshake still completes under a flood.
            expect(
                requestUnattendedPassphrase,
                'the challenge at the head of the buffer must not be evicted',
            ).toHaveBeenCalledTimes(1);

            // The overflow did not: the frame past the cap had no effect.
            const { activeSessions } = await import('../api/devices/session');
            const s = activeSessions().find(x => x.id === id);
            expect(s, 'the session must not be destroyed').toBeTruthy();
            expect(
                s!.monitors.map(m => m.label),
                'a frame beyond the cap must be dropped, not applied',
            ).not.toContain('PAST-THE-CAP');

            // And the drop is reported rather than silent.
            expect(warn.mock.calls.some(c => String(c[0]).includes('too many signals'))).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });
});

/**
 * Remembering a proved passphrase on this device: a remembered seed answers the
 * challenge with no prompt, a typed one is remembered for next time, the first
 * post-proof frame from the host confirms it, and a session the host tears
 * down before any such frame FORGETS it — the host's only reaction to a bad
 * signature is that teardown, so "still unconfirmed at teardown" is the
 * rejection observable, and keeping the seed would replay the same refusal
 * promptless forever.
 */
describe('controller: remembering a proved passphrase', () => {
    it('answers from the remembered seed with NO prompt', async () => {
        rememberedSeed = new Uint8Array(32).fill(5);
        const { id, key } = await connectingController();
        releaseDh!();
        await settle();

        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        expect(requestUnattendedPassphrase, 'a remembered seed must not prompt').not.toHaveBeenCalled();
        expect((await uaResponse(key))?.nonce, 'and must still answer the challenge').toBe(NONCE);
        const [seed] = signUaChallengeSeed.mock.calls[0] as unknown as [Uint8Array];
        expect(Array.from(seed), 'signed with the REMEMBERED seed, not a derived one')
            .toEqual(Array.from(new Uint8Array(32).fill(5)));
        expect(deriveUaSeed, 'no Argon2 stretch either — that is the 0.4s the cache saves')
            .not.toHaveBeenCalled();
    });

    it('remembers the seed a typed passphrase derives, under the host\'s salt', async () => {
        const { id, key } = await connectingController();
        releaseDh!();
        await settle();

        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        expect(requestUnattendedPassphrase).toHaveBeenCalledTimes(1);
        const [dev, saltB64, seed] = rememberUaSeed.mock.calls[0] as unknown as [string, string, Uint8Array];
        expect(dev).toBe('dev-host');
        expect(saltB64, 'keyed under the salt so a re-armed host misses instead of failing').toBe(SALT);
        expect(Array.from(seed)).toEqual(Array.from(DERIVED));
    });

    it('does NOT remember on the plain web, where storage is not the app\'s own', async () => {
        nativeShell = false;
        const { id, key } = await connectingController();
        releaseDh!();
        await settle();

        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        expect(requestUnattendedPassphrase, 'the prompt still runs').toHaveBeenCalledTimes(1);
        expect((await uaResponse(key))?.nonce, 'and the challenge is still answered').toBe(NONCE);
        expect(rememberUaSeed, 'but a shared browser profile keeps no seed')
            .not.toHaveBeenCalled();
    });

    it('confirms the seed on the first frame only a verified controller receives', async () => {
        rememberedSeed = new Uint8Array(32).fill(5);
        const { id, key } = await connectingController();
        releaseDh!();
        await settle();
        // The reset inside connectingController tears down the previous test's
        // session, which may legitimately forget ITS seed — this test's counts
        // start after that.
        forgetUaSeed.mockClear();

        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });
        expect(confirmUaSeed, 'no confirmation before the host has shown acceptance')
            .not.toHaveBeenCalled();

        await hostSignal(id, key, 1, { kind: 'monitors', monitors: [{ id: 0, label: 'Main' }], active: 0 });

        expect(confirmUaSeed).toHaveBeenCalledWith('dev-host');

        // And a teardown AFTER confirmation keeps it: only an unproven seed
        // is dropped.
        const { endAllSessions } = await import('../api/devices/session');
        endAllSessions('test end');
        await settle();
        expect(forgetUaSeed, 'a confirmed seed survives the session ending').not.toHaveBeenCalled();
    });

    it('forgets a seed the host never accepted', async () => {
        rememberedSeed = new Uint8Array(32).fill(5);
        const { id, key } = await connectingController();
        releaseDh!();
        await settle();
        forgetUaSeed.mockClear();

        await hostSignal(id, key, 0, { kind: 'ua-challenge', nonce: NONCE, salt: SALT });

        // The host's only reaction to a signature it rejects is tearing the
        // session down; no post-proof frame ever arrives.
        const { endAllSessions } = await import('../api/devices/session');
        endAllSessions('host rejected the signature');
        await settle();

        expect(forgetUaSeed).toHaveBeenCalledWith('dev-host');
    });
});
