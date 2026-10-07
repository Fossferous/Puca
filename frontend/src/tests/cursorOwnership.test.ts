/**
 * CURSOR OWNERSHIP — exactly one pointer, on every host version.
 *
 * The host composites its own cursor into the video, so what the viewer sees
 * trails their finger by a round trip; a camera that follows the finger is
 * therefore always ahead of the visible pointer. The fix used here:
 * ask the host to stop drawing, and draw the pointer locally from the same
 * coordinates that move the camera, so the two are inseparable.
 *
 * The whole design rests on ONE safety property: `cursorOwned` is only ever
 * true because a host said so. An older host does not understand the request,
 * never acks, and keeps drawing — and this end must therefore keep NOT
 * drawing. Get that wrong in either direction and the user sees two cursors
 * or none.
 *
 * Every "must not happen" here has a positive-control sibling proving the rig
 * can see the good case happen.
 */
import { describe, it, expect, vi, afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
/** What the socket reports as unsent — the input coalescer's motion gate
 *  reads it. 0 is an idle socket; a test raises it to congest the relay. */
let wsBuffered = 0;
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); },
        // The input coalescer's motion gate reads it (see wsBuffered).
        bufferedAmount: () => wsBuffered,
    },
}));

vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyDh: async () => new Uint8Array(32).fill(3),
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'dev-me',
}));
/** What the person types at the unattended prompt; null = they cancel. */
let passphraseAnswer: string | null = null;
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => passphraseAnswer }));
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

import { sealControl, openControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';

/** WebCrypto calls still running. Seal and open are REAL here (sealControl,
 *  openControl), and crypto.subtle completes on Node's threadpool: no
 *  microtask flush, and no fake clock, can wait for one. So they are counted
 *  on the way out and waited for by name. */
const subtleOut = new Set<Promise<unknown>>();
const subtle = crypto.subtle as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
// Every async method, not just the three this flow uses today: a digest or a
// deriveBits added to it later would otherwise be a wait that settle() skips.
const SUBTLE_CALLS = [
    'encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey',
    'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey',
].filter(m => typeof subtle[m] === 'function');
const subtleReal = Object.fromEntries(SUBTLE_CALLS.map(m => [m, subtle[m]]));
for (const m of SUBTLE_CALLS) {
    subtle[m] = (...a) => {
        const p = subtleReal[m].apply(crypto.subtle, a);
        const drop = () => { subtleOut.delete(p); };
        subtleOut.add(p);
        p.then(drop, drop);
        return p;
    };
}
afterAll(() => { for (const m of SUBTLE_CALLS) subtle[m] = subtleReal[m]; });

/** Let the session's async work run out: every WebCrypto call it started has
 *  landed, then `quiet` turns of the event loop pass without it starting
 *  another (the microtask queue drains before each turn).
 *
 *  It used to be 12 × setTimeout(0), which waited for wall time rather than
 *  for the work. Node clamps that to 1 ms, and on Windows each one typically
 *  waits for the next timer tick (15.6 ms by default): ~190 ms a settle, two
 *  or three settles a test. setImmediate is a turn with no timer behind it. */
async function settle(quiet = 12): Promise<void> {
    for (let n = 0; n < quiet;) {
        if (subtleOut.size > 0) {
            await Promise.allSettled([...subtleOut]);
            n = 0;
        } else {
            await new Promise(r => setImmediate(r));
            n++;
        }
    }
}

/** Put the rest of this test on a fake clock. deviceDiagnosticsWindow sleeps
 *  its window out on setTimeout and stamps both ends with Date.now(), and the
 *  input coalescer spaces moves with the same two, so the window can be
 *  driven rather than slept through: it was a real 1.5 s per test, and the
 *  sends inside it had to land before it closed, however loaded the machine.
 *  setImmediate stays real, because settle() turns on it. */
function fakeClock(): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
}
afterEach(() => { vi.useRealTimers(); });

// Load the session module, and the graph under it, before any test's clock
// starts, so the first test does not pay for the transform (~0.6 s alone,
// seconds under a full parallel run). Every later import is a cache hit.
beforeAll(async () => {
    await import('../api/devices/session');
});

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

function sessionById<S extends { id: string }>(list: S[], id: string): S | undefined {
    return list.find(s => s.id === id);
}

beforeEach(() => { peerSeq = 0; wsBuffered = 0; });

describe('cursor ownership is granted only by the host', () => {
    it('POSITIVE CONTROL: an ack hands the cursor over', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await settle();
        expect(
            sent.some(m => m.type === 'DeviceSignal'),
            'the request must actually reach the wire',
        ).toBe(true);

        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'the host said it stopped drawing, so this end draws',
        ).toBe(true);
    });

    it('a host that never acks leaves us NOT drawing (the old-host case)', async () => {
        const { id } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await settle();

        // An old host does not know this signal kind; it falls through the
        // handler chain and nothing comes back. Silence is the answer.
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'drawing on hope would put a second cursor over the host\'s own',
        ).toBe(false);
    });

    it('a malformed ack changes nothing', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: 'yes' });
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'a truthy non-boolean must not coerce its way into ownership',
        ).toBe(false);

        await hostSignal(id, key, { kind: 'cursor-owner-active' });
        expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(false);
    });

    it('an explicit refusal leaves ownership false and does NOT fail the session', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-failed', reason: 'this host cannot hide its pointer' });

        const s = sessionById(activeSessions(), id);
        expect(s?.cursorOwned, 'refused means the host kept drawing').toBe(false);
        expect(s?.error, 'an optional nicety being refused is not a session failure').toBeFalsy();
        expect(s?.phase, 'and certainly must not end the session').toBe('active');
    });

    it('handing the cursor BACK is acked too, so the host is never left pointerless', async () => {
        const { id, key } = await activeController();
        const { activeSessions, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(true);

        setCursorOwned(id, false);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: false });
        expect(
            sessionById(activeSessions(), id)?.cursorOwned,
            'the host draws again, so this end must stop',
        ).toBe(false);
    });

    it('ownership does not survive the session that negotiated it', async () => {
        const { id, key } = await activeController();
        const { activeSessions, endSession, setCursorOwned } = await import('../api/devices/session');

        setCursorOwned(id, true);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(true);

        // A fresh capture is born drawing its own cursor, so a stale `true`
        // carried into the next session would show two.
        endSession(id, 'you disconnected');
        await settle();
        expect(sessionById(activeSessions(), id), 'the session is gone entirely').toBeUndefined();
    });

    it('THE RACE: a request made while still connecting is replayed on activation', async () => {
        // The stage mounts and asks for the cursor as soon as it has a session
        // id — which is BEFORE the handshake completes. The first version
        // dropped that request on the floor (phase !== 'active'), so on real
        // hardware the host kept compositing and this end kept not drawing,
        // while every isolated test stayed green. Shipped as 0.8.51 and found
        // only in the field.
        const { installDeviceSessions, connectToDevice, endAllSessions, setCursorOwned, activeSessions } =
            await import('../api/devices/session');
        installDeviceSessions();
        endAllSessions('test reset');
        sent.length = 0;

        const id = await connectToDevice('dev-host');
        const connect = sent.find(m => m.type === 'DeviceConnect');
        const controllerEph = connect?.payload?.eph as string;
        const hostEph = generateControlEphemeral();
        const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph)!;

        expect(
            activeSessions().find(s => s.id === id)?.phase,
            'the premise: the stage asks while the session is still connecting',
        ).toBe('connecting');

        setCursorOwned(id, true);          // too early to send
        await settle();

        handlers.get('DeviceConnectAnswered')!({
            payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
        });
        await settle();

        // DECRYPT what actually went out. Counting DeviceSignal frames would
        // pass against the broken code too — going active always sends the
        // SDP offer on the same channel, so the count rises either way. Only
        // the frame's kind distinguishes a replayed request from an offer.
        const kinds: string[] = [];
        for (const m of sent.filter(x => x.type === 'DeviceSignal')) {
            const blob = (m.payload as { payload?: string } | undefined)?.payload;
            if (!blob) continue;
            const opened = await openControl(key, blob);
            if (opened) kinds.push(String(JSON.parse(opened).kind));
        }
        expect(kinds, 'the premise: the offer goes out on this channel too').toContain('offer');
        expect(
            kinds,
            'going active must REPLAY the held request, not forget it',
        ).toContain('set-cursor-owner');

        // And it is still only the ACK that grants ownership.
        expect(activeSessions().find(s => s.id === id)?.cursorOwned).toBe(false);
        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        expect(activeSessions().find(s => s.id === id)?.cursorOwned).toBe(true);
    });
});

/** The kinds of every signal this end sealed after index `from`. */
async function sentKinds(key: Uint8Array, from: number): Promise<string[]> {
    const kinds: string[] = [];
    for (const m of sent.slice(from).filter(x => x.type === 'DeviceSignal')) {
        const blob = (m.payload as { payload?: string } | undefined)?.payload;
        if (!blob) continue;
        const opened = await openControl(key, blob);
        if (opened) kinds.push(String(JSON.parse(opened).kind));
    }
    return kinds;
}

describe('an ARMED host drops a cursor request made before the passphrase (the "no mouse" report)', () => {
    // An armed host ignores everything but the passphrase from a peer that
    // has not proved it, and the request goes out the moment the session is
    // active — while the person is still typing. Hosts up to 0.9.835 dropped
    // it and nothing asked again; this end must re-assert it once the host's
    // ANSWER proves the passphrase was accepted, or a newer phone against an
    // older PC still shows no pointer.
    it('re-asserts the request once the host answers, when nothing acked it yet', async () => {
        passphraseAnswer = 'correct horse';
        try {
            const { id, key } = await activeController();
            const { activeSessions, setCursorOwned } = await import('../api/devices/session');
            setCursorOwned(id, true);
            await settle();
            await hostSignal(id, key, { kind: 'ua-challenge', nonce: btoa('nonce'), salt: btoa('salt') });
            const proved = await sentKinds(key, 0);
            expect(proved, 'the premise: the proof went out').toContain('ua-response');

            const before = sent.length;
            await hostSignal(id, key, { kind: 'answer', sdp: 'v=0\r\n' });
            expect(
                await sentKinds(key, before),
                'the host has proved it is listening now: ask again',
            ).toEqual(['set-cursor-owner']);

            // Still only the ACK grants it.
            expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(false);
            await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
            expect(sessionById(activeSessions(), id)?.cursorOwned).toBe(true);
        } finally {
            passphraseAnswer = null;
        }
    });

    it('re-asserts it ONCE: a media restart\'s later answer does not repeat it', async () => {
        passphraseAnswer = 'correct horse';
        try {
            const { id, key } = await activeController();
            const { setCursorOwned } = await import('../api/devices/session');
            setCursorOwned(id, true);
            await hostSignal(id, key, { kind: 'ua-challenge', nonce: btoa('nonce'), salt: btoa('salt') });
            await hostSignal(id, key, { kind: 'answer', sdp: 'v=0\r\n' });
            const before = sent.length;
            await hostSignal(id, key, { kind: 'answer', sdp: 'v=0\r\n' });
            expect(await sentKinds(key, before)).not.toContain('set-cursor-owner');
        } finally {
            passphraseAnswer = null;
        }
    });

    it('NEGATIVE CONTROL: an unarmed host is not asked twice', async () => {
        const { id, key } = await activeController();
        const { setCursorOwned } = await import('../api/devices/session');
        setCursorOwned(id, true);
        await settle();
        const before = sent.length;
        await hostSignal(id, key, { kind: 'answer', sdp: 'v=0\r\n' });
        expect(await sentKinds(key, before)).not.toContain('set-cursor-owner');
    });

    it('nothing is re-asserted when the stage never asked for the pointer', async () => {
        passphraseAnswer = 'correct horse';
        try {
            const { id, key } = await activeController();
            await hostSignal(id, key, { kind: 'ua-challenge', nonce: btoa('nonce'), salt: btoa('salt') });
            const before = sent.length;
            await hostSignal(id, key, { kind: 'answer', sdp: 'v=0\r\n' });
            expect(await sentKinds(key, before)).not.toContain('set-cursor-owner');
        } finally {
            passphraseAnswer = null;
        }
    });
});

describe('"Copy diagnostics" carries the pointer story (the lock-screen mouse report)', () => {
    it('counts sent input BY KIND and names the lane, so "no moves left the phone" is readable', async () => {
        const { id } = await activeController();
        const { activeSessions, sendInput, deviceDiagnostics } = await import('../api/devices/session');
        expect(sessionById(activeSessions(), id)?.phase, 'precondition: an active controller').toBe('active');

        const before = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(before.inputSentTotal).toBe(0);
        expect(before.inputSentByKind).toEqual({});
        expect(before.inputLane).toBeNull();

        expect(sendInput(id, { t: 'move', x: 0.25, y: 0.5 })).toBe(true);
        // A key force-flushes held motion ahead of itself, so both go out.
        expect(sendInput(id, { t: 'key', code: 'KeyA', down: true })).toBe(true);
        await settle();

        // POSITIVE CONTROL for the rig: the frames really left.
        expect(sent.filter(m => m.type === 'DeviceInput')).toHaveLength(2);
        const row = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(row.inputSentTotal).toBe(2);
        expect(row.inputSentByKind).toEqual({ move: 1, key: 1 });
        expect(row.inputLane, 'no proved input channel in this rig: the relay carried it').toBe('relay');
    });

    it('reports whether this end owns (and must draw) the pointer, from the host ack only', async () => {
        const { id, key } = await activeController();
        const { deviceDiagnostics, setCursorOwned } = await import('../api/devices/session');
        const row0 = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(row0.cursorOwned).toBe(false);

        expect(row0.cursorOwnerPending, 'nothing asked, nothing held').toBeNull();

        setCursorOwned(id, true);
        await settle();
        const asked = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(asked.cursorOwned, 'asking is not owning').toBe(false);
        // An ACTIVE session sends the request at once: nothing is held.
        // `cursorOwnerPending` is the request HELD for a session not yet
        // able to send (see the next test), not "awaiting the ack".
        expect(asked.cursorOwnerPending, 'sent, so not held').toBeNull();

        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        const owned = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(owned.cursorOwned).toBe(true);
        expect(owned.cursorOwnerPending).toBeNull();
    });

    it('reports a request HELD while connecting as pending, and clears it once going active sends it', async () => {
        const { installDeviceSessions, connectToDevice, endAllSessions, setCursorOwned, deviceDiagnostics } =
            await import('../api/devices/session');
        installDeviceSessions();
        endAllSessions('test reset');
        sent.length = 0;
        const id = await connectToDevice('dev-host');
        const connect = sent.find(m => m.type === 'DeviceConnect');
        const hostEph = generateControlEphemeral();
        const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, connect?.payload?.eph as string)!;

        setCursorOwned(id, true);          // too early to send: held
        await settle();
        const held = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(held.phase, 'the premise: still connecting').toBe('connecting');
        expect(held.cursorOwnerPending, 'the held request is reported').toBe(true);
        expect(held.cursorOwned).toBe(false);

        handlers.get('DeviceConnectAnswered')!({
            payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
        });
        await settle();
        const replayed = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(replayed.cursorOwnerPending, 'going active sent it').toBeNull();
        expect(replayed.cursorOwned, 'and only the ack grants it').toBe(false);

        await hostSignal(id, key, { kind: 'cursor-owner-active', owned: true });
        const owned = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(owned.cursorOwned).toBe(true);
        expect(owned.cursorOwnerPending).toBeNull();
    });

    it('the window reports input per second and per kind across the time the user kept driving', async () => {
        const { inputWindow } = await import('../api/devices/session');
        const w = inputWindow(
            { total: 10, byKind: { key: 10 }, at: 1_000 },
            { total: 35, byKind: { key: 12, move: 20, down: 1, up: 1, wheel: 1 }, at: 6_000 },
        );
        expect(w.windowInputPerSecond).toBe(5);
        expect(w.windowInputByKind).toEqual({ key: 2, move: 20, down: 1, up: 1, wheel: 1 });
        // The shape of the report's own case: keys still going, no motion at all.
        const keysOnly = inputWindow(
            { total: 0, byKind: {}, at: 0 },
            { total: 4, byKind: { key: 4 }, at: 5_000 },
        );
        expect(keysOnly.windowInputByKind).toEqual({ key: 4 });
        expect(keysOnly.windowInputByKind.move).toBeUndefined();
    });
});

/** Let `ms` pass on the fake clock (see fakeClock), settling the async seal
 *  queue as it goes. */
async function wait(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    await settle();
}

describe('the diagnostics WINDOW, end to end through sendInput', () => {
    it('counts the moves sent while it was open, per kind and per second', async () => {
        const { id } = await activeController();
        const { sendInput, deviceDiagnosticsWindow } = await import('../api/devices/session');
        fakeClock();
        // A move BEFORE the window is not counted in it.
        expect(sendInput(id, { t: 'move', x: 0.1, y: 0.1 })).toBe(true);
        await wait(30);

        const pending = deviceDiagnosticsWindow(1_500);
        // Spaced past the coalescer's 16 ms window, so each one goes out.
        for (let i = 0; i < 4; i++) {
            expect(sendInput(id, { t: 'move', x: 0.2 + i / 10, y: 0.5 })).toBe(true);
            await wait(30);
        }
        await wait(1_500);                  // the window closes
        const rows = await pending;
        const row = rows.find(r => r.id === id)!;
        expect(row, 'the window returns the session row').toBeTruthy();
        expect(row.windowInputByKind).toEqual({ move: 4 });
        expect(row.windowInputPerSecond as number).toBeGreaterThan(0);
        expect(row.windowMotionHeldByGate, 'an idle socket held nothing').toBe(0);
    });

    it('CONTROL: keys only in the window reports no move key at all', async () => {
        const { id } = await activeController();
        const { sendInput, deviceDiagnosticsWindow } = await import('../api/devices/session');
        fakeClock();
        const pending = deviceDiagnosticsWindow(1_500);
        expect(sendInput(id, { t: 'key', code: 'Digit1', down: true })).toBe(true);
        expect(sendInput(id, { t: 'key', code: 'Digit1', down: false })).toBe(true);
        await wait(30);
        await wait(1_500);                  // the window closes
        const row = (await pending).find(r => r.id === id)!;
        expect(row.windowInputByKind).toEqual({ key: 2 });
        expect((row.windowInputByKind as Record<string, number>).move).toBeUndefined();
        expect(row.windowInputPerSecond as number).toBeGreaterThan(0);
    });
});

describe('the motion gate is in the diagnostics (keys work, the mouse is held back)', () => {
    it('POSITIVE CONTROL: an idle socket reports the gate open and nothing held', async () => {
        const { id } = await activeController();
        const { sendInput, deviceDiagnostics } = await import('../api/devices/session');
        expect(sendInput(id, { t: 'move', x: 0.5, y: 0.5 })).toBe(true);
        await settle();
        const row = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(row.motionLane).toBe('relay');
        expect(row.motionLaneBufferedAmount).toBe(0);
        expect(row.motionGateOpen).toBe(true);
        expect(row.motionHeldByGate).toBe(0);
        expect(sent.filter(m => m.type === 'DeviceInput'), 'the move went out').toHaveLength(1);
    });

    it('a congested relay: the gate reads closed, moves are held and counted, keys still pass', async () => {
        const { id } = await activeController();
        const { sendInput, deviceDiagnostics, deviceDiagnosticsWindow } = await import('../api/devices/session');
        fakeClock();
        wsBuffered = 200_000;               // well past the 64 KiB high-water mark
        const pending = deviceDiagnosticsWindow(1_500);
        for (let i = 0; i < 3; i++) {
            expect(sendInput(id, { t: 'move', x: 0.1 * (i + 1), y: 0.5 })).toBe(true);
            await wait(20);
        }
        expect(sent.filter(m => m.type === 'DeviceInput'), 'held, not sent').toHaveLength(0);

        const row = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(row.motionLane).toBe('relay');
        expect(row.motionLaneBufferedAmount).toBe(200_000);
        expect(row.motionGateOpen).toBe(false);
        expect(row.motionHeldByGate).toBe(3);

        // The shape of the report: a key goes straight through the gate (and
        // forces the held move out ahead of itself).
        expect(sendInput(id, { t: 'key', code: 'KeyA', down: true })).toBe(true);
        await settle();
        const out = sent.filter(m => m.type === 'DeviceInput');
        expect(out, 'the key and the one move it forced out').toHaveLength(2);

        await wait(1_500);                  // the window closes
        const win = (await pending).find(r => r.id === id)!;
        expect(win.windowMotionHeldByGate, 'the window counts what the gate held in it').toBe(3);
        wsBuffered = 0;
    });
});
