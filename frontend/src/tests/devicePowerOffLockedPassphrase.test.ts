// @vitest-environment jsdom
/**
 * Power off of a LOCKED PC asking for the passphrase again (the owner's
 * report, 2026-11-20): from the phone, a signed-in PC powered off without a
 * prompt, a locked one, one at its sign-in screen, and one just restarted or
 * woken, asked for the unattended passphrase.
 *
 * ONE WINDOWS PC IS TWO HOSTS (api/devices/machines.ts): the desktop app's
 * device row, which answers while somebody is signed in, and the lock-screen
 * service's row, which answers while the PC is locked, at its sign-in screen,
 * or freshly booted. Each checks its OWN passphrase record (Devices, This
 * device: "Unattended access" and "Passphrase for the sign-in screen"), each
 * with its own random salt, so what the phone remembers is per row: the seed
 * stretched from that row's salt. Before this fix each row's remembered seed
 * also lived on its own 7-day clock, renewed only by a session to THAT row;
 * the sign-in row is reached only when the PC is locked or off, which on the
 * owner's PC happened 4 to 26 days apart (the agent's own start lines in its
 * log), so its seed had lapsed by the next one even though the desktop row's
 * stayed fresh with everyday use.
 *
 * These drive the REAL session layer, the REAL card (powerOffDevice) and the
 * REAL remembered-seed store (unattended.ts, on a phone: isMobile) against two
 * stand-in hosts that verify every proof with Ed25519 against their own
 * record, exactly as crates/puca-ua does: a seed is only ever accepted by the
 * host whose record it was stretched for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';

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
/** Which host asked, every time the phone asked for a passphrase. */
const prompts: string[] = [];
/** Everything each of those asks handed the dialog (the REAL bridge's
 *  PassphraseRequest, which is all UnattendedPassphrasePrompt reads). */
const asked: Array<{ peerDevice: string; peerName: string | null; signIn: boolean }> = [];
/** What the person types for each host (null: Cancel). */
let typed: Record<string, string | null> = {};
vi.mock('../api/devices/wakeSession', () => ({ followToDesktop: () => {}, followToSignIn: () => {} }));
vi.mock('../api/devices/index', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/devices/index')>()),
    currentUserId: () => 42,
}));
// THE PHONE: the remembered-seed store is written only inside a native shell.
vi.mock('../api/platform', () => ({
    isTauri: () => false,
    isMobile: () => true,
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
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl, openControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';
import { buildUaRecord, challengeMessage, type UaRecord } from '../api/devices/unattended';
import type { PowerOffOutcome } from '../api/devices/powerOff';
import { setUnattendedPassphraseHandler, resetUnattendedPassphraseHandler } from '../api/devices/unattendedPrompt';

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

/** Bounded in REAL time: argon2id and WebCrypto take what they take. */
async function spinUntil(what: string, done: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
    const end = performance.now() + ms;
    while (!(await done())) {
        if (performance.now() > end) throw new Error(`${what} never happened`);
        await new Promise(r => setImmediate(r));
    }
}

const b64 = (bytes: Uint8Array): string => {
    let s = '';
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** A stand-in host: a device row with its own passphrase record. It verifies
 *  a proof the way puca-ua does — the signature over the framed session id and
 *  ITS nonce, under ITS verifying key — and carries the power-off out only on
 *  a good one, answering the way the real host of that kind does. */
interface StandIn {
    id: string;
    record: UaRecord;
    /** 'app': the attended host (power-ack, then the end with the reason).
     *  'signin': the sign-in-screen agent (no ack; the end with the reason). */
    kind: 'app' | 'signin';
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1, 22, 0, 0);
const APP = 'dev-pc-app';
const SIGNIN = 'dev-pc-signin';
const OTHER = 'dev-laptop-app';
const PC_ROWS = [APP, SIGNIN];

let app: StandIn;
let signIn: StandIn;
let other: StandIn;

/** Every proof the stand-ins checked, and what they made of it. */
const verdicts: Array<{ host: string; ok: boolean }> = [];

/**
 * How the host's answer to the proof can fail to reach the phone, as the
 * server and the service really behave:
 *  - 'socket': the PHONE's socket drops just as the PC answers. The server
 *    relays the end to a connection that is no longer there (send_to_conn
 *    drops it), and once the phone is back and has attested, its reattach
 *    claim is answered the way src/ws.rs answers one for a session that has
 *    ended: "that session did not survive the disconnect".
 *  - 'service': the PC's side goes before its answer leaves (Windows taking
 *    the service down with it): the server holds the session for it
 *    (DevicePeerReconnecting), then its reaper ends it with "the other device
 *    did not come back".
 *  - 'zombie': nothing says the link is gone. The phone's socket reads OPEN
 *    with its transport dead (websocket.ts calls that the usual outcome of a
 *    mobile network change, and closes one only after 45 to 75 s with no
 *    pong), or the PC's service went without a FIN and the server's
 *    DevicePeerReconnecting is more than 8 s behind. The phone's own answer
 *    deadline (POWER_OFF_ANSWER_TIMEOUT_MS from the proof) is what ends it,
 *    and calls the PC too old.
 * Either way the answer (the shutdown, or the refusal) never arrives. The
 * attended host's power-ack goes FIRST, before Windows, so a 'service' loss
 * still delivers it; a 'socket' or 'zombie' loss takes it with the end.
 */
type Loss = 'socket' | 'service' | 'zombie';

/**
 * Press Power off on a card, and play the host that answers. Resolves with
 * the card's outcome. `machineRows` is what the card knows of the PC: every
 * row the device list grouped into it. `lose`: the host's answer to the
 * proof never reaches the phone (see Loss).
 */
async function pressPowerOff(host: StandIn, machineRows: string[] | undefined, lose?: Loss): Promise<PowerOffOutcome> {
    const { powerOffDevice } = await import('../api/devices/powerOff');
    const { SHUTDOWN_REASON, POWER_OFF_ANSWER_TIMEOUT_MS } = await import('../api/devices/session');
    const before = sent.length;
    // The answer deadline has to fall due: the session's timers are faked for
    // this one press (setImmediate, which spinUntil turns on, never is).
    if (lose === 'zombie') {
        const now = Date.now();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(now);
    }
    const run = powerOffDevice({
        hostDevice: host.id,
        name: 'Desk-PC',
        signIn: host.kind === 'signin',
        ...(machineRows ? { machineRows } : {}),
    });
    await spinUntil('the connect', () => sent.slice(before).some(m => m.type === 'DeviceConnect'));
    const connect = sent.slice(before).find(m => m.type === 'DeviceConnect')!;
    const id = connect.payload!.session_id as string;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, connect.payload!.eph as string)!;
    handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded } });
    let n = 0;
    const signal = async (obj: Record<string, unknown>) => {
        const sealed = await sealControl(key, JSON.stringify({ sid: id, n: n++, ...obj }));
        handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    };
    const frames = async (): Promise<Record<string, unknown>[]> => {
        const out: Record<string, unknown>[] = [];
        for (const m of sent) {
            if (m.type !== 'DeviceSignal' || m.payload?.session_id !== id) continue;
            const plain = await openControl(key, m.payload!.payload as string);
            if (plain) out.push(JSON.parse(plain) as Record<string, unknown>);
        }
        return out;
    };
    // The request goes the moment the session is up, and the host holds it.
    await spinUntil('the power-off request', async () => (await frames()).some(f => f.kind === 'power'));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    await signal({ kind: 'ua-challenge', nonce: b64(nonce), salt: b64(Uint8Array.from(host.record.salt)) });
    const ended = () => sent.slice(before).some(m => m.type === 'DeviceEnd' && m.payload?.session_id === id);
    await spinUntil('a proof, or the session given up', async () =>
        ended() || (await frames()).some(f => f.kind === 'ua-response'));
    const proof = (await frames()).find(f => f.kind === 'ua-response');
    if (proof) {
        const ok = ed25519.verify(
            unb64(proof.sig as string),
            challengeMessage(id, nonce),
            Uint8Array.from(host.record.verifying_key),
        );
        verdicts.push({ host: host.id, ok });
        if (lose === 'socket') {
            window.dispatchEvent(new CustomEvent('wsClosed', { detail: {} }));
            window.dispatchEvent(new Event('deviceAttested'));
            await spinUntil('the reattach claim', () => sent.slice(before).some(m =>
                m.type === 'DeviceReattach' && m.payload?.session_id === id));
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'that session did not survive the disconnect' } });
        } else if (lose === 'service') {
            if (ok && host.kind === 'app') {
                await signal({ kind: 'power-ack', action: 'force_power_off' });
                // The reaper's end comes seconds later: the ack has been
                // opened and taken by then.
                const { subscribeSessions } = await import('../api/devices/session');
                let acked = false;
                const off = subscribeSessions(all => {
                    acked ||= all.some(x => x.id === id && x.powerOff?.state === 'accepted');
                });
                try { await spinUntil('the power-ack taken', () => acked); } finally { off(); }
            }
            handlers.get('DevicePeerReconnecting')!({ payload: { session_id: id } });
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the other device did not come back' } });
        } else if (lose === 'zombie') {
            // Whatever the PC sends goes nowhere, and nothing else happens:
            // only the phone's own deadline is left to end it.
            await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS + 100);
        } else if (!ok) {
            // A wrong proof: the host ends the session with that, and never
            // carries anything out.
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'unattended access was refused' } });
        } else {
            if (host.kind === 'app') await signal({ kind: 'power-ack', action: 'force_power_off' });
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: SHUTDOWN_REASON } });
        }
    }
    try {
        return await run;
    } finally {
        if (lose === 'zombie') {
            const now = Date.now();
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(now);
        }
    }
}

const promptsFor = (host: string) => prompts.filter(p => p === host).length;

/**
 * A REAL localStorage: setup.ts installs bare vi.fn()s that store nothing, so
 * against them every press would ask and nothing here would mean anything
 * (unattended.test.ts does the same, for the same reason).
 */
const store = new Map<string, string>();

beforeEach(async () => {
    store.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k) => store.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => { store.set(k, v); });
    vi.mocked(localStorage.removeItem).mockImplementation((k) => { store.delete(k); });
    prompts.length = 0;
    asked.length = 0;
    verdicts.length = 0;
    sent.length = 0;
    // The REAL bridge, answered as the dialog would: what reaches the handler
    // is all UnattendedPassphrasePrompt has to say which passphrase it wants.
    setUnattendedPassphraseHandler(req => {
        prompts.push(req.peerDevice);
        asked.push({ peerDevice: req.peerDevice, peerName: req.peerName, signIn: req.signIn });
        req.resolve(typed[req.peerDevice] ?? null);
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const { installDeviceSessions, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    // The two records are set separately on the PC, each with its own salt
    // (buildUaRecord picks a random one): even the same words make two
    // different keys.
    app ??= { id: APP, record: buildUaRecord('desk passphrase'), kind: 'app' };
    signIn ??= { id: SIGNIN, record: buildUaRecord('desk passphrase'), kind: 'signin' };
    other ??= { id: OTHER, record: buildUaRecord('laptop passphrase'), kind: 'app' };
    typed = { [APP]: 'desk passphrase', [SIGNIN]: 'desk passphrase', [OTHER]: 'laptop passphrase' };
});
afterEach(() => {
    resetUnattendedPassphraseHandler();
    vi.useRealTimers();
    vi.mocked(localStorage.getItem).mockReset();
    vi.mocked(localStorage.setItem).mockReset();
    vi.mocked(localStorage.removeItem).mockReset();
});

// Real argon2id for every typed passphrase and real WebCrypto for every frame:
// up to a dozen presses a test, so a busy machine needs more than the default.
describe('Power off of a locked PC, with the passphrase remembered on this phone', { timeout: 60_000 }, () => {
    it('THE REPORT: a PC used every day does not ask again at its lock screen a week later', async () => {
        // Night 0: the PC is locked, so its sign-in row answers. First time:
        // it asks, once, for the sign-in screen's passphrase.
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN), 'premise: the first time asks').toBe(1);
        // Nine days of everyday use while somebody is signed in: the desktop
        // row answers, it asks once, and never again.
        for (let day = 1; day <= 9; day++) {
            vi.setSystemTime(T0 + day * DAY);
            expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        }
        expect(promptsFor(APP), 'premise: the signed-in PC asked once, then never').toBe(1);
        // Day 10, locked again: nothing has changed about the passphrase, and
        // the phone has the sign-in screen's own proved seed.
        vi.setSystemTime(T0 + 10 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN), 'asked again at the lock screen').toBe(1);
        // And the host verified what was offered: the gate ran, and passed.
        expect(verdicts.filter(v => v.host === SIGNIN)).toEqual([{ host: SIGNIN, ok: true }, { host: SIGNIN, ok: true }]);
    });

    it('…and the same the other way: a PC reached only at its lock screen keeps its desktop passphrase', async () => {
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        for (let day = 1; day <= 9; day++) {
            vi.setSystemTime(T0 + day * DAY);
            expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        }
        vi.setSystemTime(T0 + 10 * DAY);
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(APP)).toBe(1);
        expect(promptsFor(SIGNIN)).toBe(1);
    });

    it('CONTROL (abandoned): nothing to either row for over a week, and both ask again', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        vi.setSystemTime(T0 + 8 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(2);
        expect(promptsFor(APP)).toBe(2);
    });

    it('CONTROL (another PC): everyday use of a DIFFERENT PC keeps nothing of this one', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        for (let day = 1; day <= 9; day++) {
            vi.setSystemTime(T0 + day * DAY);
            expect((await pressPowerOff(other, [OTHER])).kind).toBe('going');
        }
        vi.setSystemTime(T0 + 10 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN), 'this PC\'s lock-screen passphrase lapsed on its own week').toBe(2);
    });

    it('THE GATE: what was remembered for one row is never offered to the other — each still asks its first time', async () => {
        // The desktop's passphrase is remembered; the sign-in screen's record
        // is a different key (its own salt), and the phone has nothing proved
        // for it, so it asks rather than offer the desktop's seed.
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(APP)).toBe(1);
        expect(promptsFor(SIGNIN)).toBe(1);
        expect(verdicts.every(v => v.ok), 'no proof the host refused was ever sent').toBe(true);
    });

    it('THE GATE: a wrong passphrase is refused by the host, not carried out, and the next press asks again', async () => {
        typed[SIGNIN] = 'not it';
        const first = await pressPowerOff(signIn, PC_ROWS);
        expect(first.kind).toBe('refused');
        // And says WHICH passphrase it refused: the sign-in screen's, not the
        // unattended one (the review of this branch, 2026-11-20).
        expect(first.text).toMatch(/did not accept the passphrase for its sign-in screen/);
        expect(first.text).toMatch(/not its unattended-access passphrase/);
        expect(verdicts).toEqual([{ host: SIGNIN, ok: false }]);
        // Everyday use of the desktop row meanwhile renews nothing it refused.
        vi.setSystemTime(T0 + 1 * DAY);
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        typed[SIGNIN] = 'desk passphrase';
        vi.setSystemTime(T0 + 2 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN), 'the refused one was forgotten').toBe(2);
    });

    it('THE GATE: a lapsed seed is not brought back by the other row\'s use', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        // Eight days with nothing at all: the sign-in row's seed is dead.
        vi.setSystemTime(T0 + 8 * DAY);
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        vi.setSystemTime(T0 + 9 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(2);
    });
});

/**
 * WHICH passphrase the phone asks for (the review of this branch,
 * 2026-11-20). The two records may hold different words — the docs say each
 * is set on its own — and a locked PC checks the sign-in screen's. The dialog
 * asked every row for "the unattended passphrase", so a person who typed what
 * it asked for was refused at every locked PC, the refused seed was
 * forgotten, and the next Power off asked again: the remembering this branch
 * adds could never start, because no sign-in seed was ever proved.
 */
describe('Power off of a locked PC whose two passphrases differ', { timeout: 60_000 }, () => {
    /** The same PC's lock-screen service, its passphrase set with OTHER words. */
    let lockScreen: StandIn | null = null;

    it('THE FINDING: a locked PC asks for its sign-in screen\'s passphrase, naming the PC, and typing what it asks for powers it off', async () => {
        lockScreen ??= { id: SIGNIN, record: buildUaRecord('lock-screen words'), kind: 'signin' };
        // The person types what the dialog asks for, and nothing else.
        setUnattendedPassphraseHandler(req => {
            prompts.push(req.peerDevice);
            asked.push({ peerDevice: req.peerDevice, peerName: req.peerName, signIn: req.signIn });
            req.resolve(req.signIn === true ? 'lock-screen words' : 'desk passphrase');
        });
        const locked = await pressPowerOff(lockScreen, PC_ROWS);
        // Before the fix: the dialog said "Unattended passphrase", the person
        // typed that, and the lock screen refused it.
        expect(verdicts, 'the lock screen accepted what was typed').toEqual([{ host: SIGNIN, ok: true }]);
        expect(locked.kind).toBe('going');
        expect(asked).toEqual([{ peerDevice: SIGNIN, peerName: 'Desk-PC', signIn: true }]);
        // Proved, so remembered: the next one at the lock screen does not ask.
        vi.setSystemTime(T0 + 1 * DAY);
        expect((await pressPowerOff(lockScreen, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(1);
        // CONTROL: the same PC signed in asks for the unattended passphrase,
        // and that one powers it off.
        const signedIn = await pressPowerOff(app, PC_ROWS);
        expect(asked[1]).toEqual({ peerDevice: APP, peerName: 'Desk-PC', signIn: false });
        expect(signedIn.kind).toBe('going');
    });
});

/**
 * The PC's answer to the proof LOST on the way to the phone (the review of
 * this branch, round 2). The sign-in-screen agent sends nothing between the
 * proof and the shutdown: on a good proof it calls Windows and its only answer
 * is the end, "the device is shutting down" (crates/puca-agent session.rs, the
 * `ua-response` arm into power_now), so that one relayed frame was the only
 * thing that could confirm the seed. A phone whose socket was down for it (the
 * server drops a frame for a connection that is gone), or a service Windows
 * took down before it left, ended the session with no answer either way: the
 * card says so ('unknown'), and teardown forgot the seed as if the PC had
 * refused it, so the next Power off of the locked PC asked again.
 *
 * Both hosts refuse a proof OUT LOUD (the agent: "unattended access was
 * refused", or its lockout; the desktop app: "unattended passphrase
 * rejected"), and that still forgets the seed. Silence is no refusal.
 */
describe('Power off of a locked PC whose answer never reached the phone', { timeout: 60_000 }, () => {
    for (const lose of ['socket', 'service'] as const) {
        it(`THE FINDING (${lose}): a remembered sign-in passphrase is not forgotten when the PC's answer is lost`, async () => {
            expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
            vi.setSystemTime(T0 + 1 * DAY);
            const lost = await pressPowerOff(signIn, PC_ROWS, lose);
            expect(lost.kind, 'premise: the card cannot say whether it went').toBe('unknown');
            expect(verdicts, 'premise: the PC accepted what was offered').toEqual([
                { host: SIGNIN, ok: true }, { host: SIGNIN, ok: true },
            ]);
            vi.setSystemTime(T0 + 2 * DAY);
            expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
            expect(promptsFor(SIGNIN), 'asked again after an answer that never arrived').toBe(1);
        });
    }

    it('THE FINDING (just typed): the first time at the lock screen, its answer lost, is still the only time it asks', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS, 'socket')).kind).toBe('unknown');
        vi.setSystemTime(T0 + 1 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(1);
        expect(verdicts).toEqual([{ host: SIGNIN, ok: true }, { host: SIGNIN, ok: true }]);
    });

    it('THE REPORT, with the first answer lost: a week of everyday use after it, and the lock screen still does not ask', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS, 'socket')).kind).toBe('unknown');
        for (let day = 1; day <= 9; day++) {
            vi.setSystemTime(T0 + day * DAY);
            expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        }
        vi.setSystemTime(T0 + 10 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(1);
        expect(promptsFor(APP)).toBe(1);
    });

    it('…and the desktop row the same, when the phone\'s socket takes its power-ack with the end', async () => {
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        vi.setSystemTime(T0 + 1 * DAY);
        expect((await pressPowerOff(app, PC_ROWS, 'socket')).kind).toBe('unknown');
        vi.setSystemTime(T0 + 2 * DAY);
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(APP)).toBe(1);
    });

    it('CONTROL: the desktop row\'s power-ack, sent before Windows, confirms it even when the end is lost', async () => {
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        vi.setSystemTime(T0 + 1 * DAY);
        expect((await pressPowerOff(app, PC_ROWS, 'service')).kind).toBe('going');
        vi.setSystemTime(T0 + 2 * DAY);
        expect((await pressPowerOff(app, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(APP)).toBe(1);
    });

    it('THE GATE: a WRONG passphrase whose refusal was lost is offered once more, refused out loud, forgotten, and then asked for', async () => {
        typed[SIGNIN] = 'not it';
        expect((await pressPowerOff(signIn, PC_ROWS, 'socket')).kind).toBe('unknown');
        vi.setSystemTime(T0 + 1 * DAY);
        // Not asked: the phone still holds what was typed, and the PC says no.
        const refused = await pressPowerOff(signIn, PC_ROWS);
        expect(refused.kind).toBe('refused');
        expect(refused.text).toMatch(/did not accept the passphrase for its sign-in screen/);
        expect(promptsFor(SIGNIN)).toBe(1);
        // That refusal was heard, so it is forgotten: the next press asks.
        typed[SIGNIN] = 'desk passphrase';
        vi.setSystemTime(T0 + 2 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(2);
        expect(verdicts).toEqual([
            { host: SIGNIN, ok: false }, { host: SIGNIN, ok: false }, { host: SIGNIN, ok: true },
        ]);
    });

    // No end arrives at all, and the link reads open: the phone's own answer
    // deadline ends it and calls the PC too old (it cannot tell that from a
    // Púca that never answers). Neither host refuses a proof in silence, so
    // that says nothing about the passphrase (review of this branch, round 3).
    it('THE FINDING (zombie): the answer deadline after the proof does not forget a remembered sign-in passphrase', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        vi.setSystemTime(T0 + 1 * DAY);
        const lost = await pressPowerOff(signIn, PC_ROWS, 'zombie');
        expect(lost.kind, 'premise: the deadline called it').toBe('refused');
        expect(lost.text, 'premise: as too old').toMatch(/too old/);
        expect(verdicts, 'premise: the PC accepted what was offered').toEqual([
            { host: SIGNIN, ok: true }, { host: SIGNIN, ok: true },
        ]);
        vi.setSystemTime(T0 + 2 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN), 'asked again after an answer that never arrived').toBe(1);
    });

    it('THE FINDING (zombie, just typed): the first time at the lock screen, its answer never arriving, is still the only time it asks', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS, 'zombie')).kind).toBe('refused');
        vi.setSystemTime(T0 + 1 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(1);
        expect(verdicts).toEqual([{ host: SIGNIN, ok: true }, { host: SIGNIN, ok: true }]);
    });

    it('THE GATE (zombie): a WRONG passphrase whose refusal never arrived is offered once more, refused out loud, forgotten, and then asked for', async () => {
        typed[SIGNIN] = 'not it';
        expect((await pressPowerOff(signIn, PC_ROWS, 'zombie')).kind).toBe('refused');
        vi.setSystemTime(T0 + 1 * DAY);
        const refused = await pressPowerOff(signIn, PC_ROWS);
        expect(refused.kind).toBe('refused');
        expect(refused.text).toMatch(/did not accept the passphrase for its sign-in screen/);
        expect(promptsFor(SIGNIN)).toBe(1);
        typed[SIGNIN] = 'desk passphrase';
        vi.setSystemTime(T0 + 2 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(2);
        expect(verdicts).toEqual([
            { host: SIGNIN, ok: false }, { host: SIGNIN, ok: false }, { host: SIGNIN, ok: true },
        ]);
    });

    it('CONTROL: a lost answer renews nothing: what it kept lapses on its own week', async () => {
        expect((await pressPowerOff(signIn, PC_ROWS, 'socket')).kind).toBe('unknown');
        vi.setSystemTime(T0 + 8 * DAY);
        expect((await pressPowerOff(signIn, PC_ROWS)).kind).toBe('going');
        expect(promptsFor(SIGNIN)).toBe(2);
    });
});

/**
 * A Control session to a stand-in host, opened the way the card's Control
 * opens one (connectToDevice with the PC's name and rows). The host checks
 * each proof against `record()` (read at the check, so a test can change
 * what it accepts), and answers the offer once one is good: the answer is
 * what lets the card's Power off ride the session.
 */
async function openControlSession(host: StandIn, machineRows: string[], record: () => UaRecord = () => host.record) {
    const { connectToDevice } = await import('../api/devices/session');
    const before = sent.length;
    const id = await connectToDevice(host.id, { peerName: 'Desk-PC', machineRows });
    const connect = sent.slice(before).find(m => m.type === 'DeviceConnect')!;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, connect.payload!.eph as string)!;
    handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded } });
    let n = 0;
    const signal = async (obj: Record<string, unknown>) => {
        const sealed = await sealControl(key, JSON.stringify({ sid: id, n: n++, ...obj }));
        handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    };
    /** Every frame this session's controller sealed, opened as the host would. */
    const frames = async (): Promise<Record<string, unknown>[]> => {
        const out: Record<string, unknown>[] = [];
        for (const m of sent) {
            if (m.type !== 'DeviceSignal' || m.payload?.session_id !== id) continue;
            const plain = await openControl(key, m.payload!.payload as string);
            if (plain) out.push(JSON.parse(plain) as Record<string, unknown>);
        }
        return out;
    };
    const proofs = async () => (await frames()).filter(f => f.kind === 'ua-response');
    const ended = () => sent.slice(before).some(m => m.type === 'DeviceEnd' && m.payload?.session_id === id);
    /** Ask for the proof and check it: true accepted (and the offer
     *  answered), false refused out loud (the session ended with the
     *  refusal), null: no proof came. */
    const challenge = async (): Promise<boolean | null> => {
        const had = (await proofs()).length;
        const nonce = crypto.getRandomValues(new Uint8Array(32));
        await signal({ kind: 'ua-challenge', nonce: b64(nonce), salt: b64(Uint8Array.from(record().salt)) });
        await spinUntil('a proof, or the session given up', async () => ended() || (await proofs()).length > had);
        const proof = (await proofs())[had];
        if (!proof) return null;
        const ok = ed25519.verify(unb64(proof.sig as string), challengeMessage(id, nonce), Uint8Array.from(record().verifying_key));
        verdicts.push({ host: host.id, ok });
        if (ok) await signal({ kind: 'answer', sdp: 'v=0\r\n' });
        else handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'unattended access was refused' } });
        return ok;
    };
    return { id, challenge, frames };
}

/**
 * A Power off that RODE a Control session (the card reuses one that is open:
 * powerOff.ts, requestForcePowerOff) keeps its outcome on that session after
 * it settles. Called too old by the answer deadline, that outcome used to
 * read as "a power-off whose answer never came" at the session's teardown,
 * however much later, and kept a seed the host had refused out loud in the
 * meantime (review of 0.9.867). The keep is meant for a POWER-OFF session,
 * which has no answer of its own to confirm the seed; a ridden one was
 * answered, past the proof, before it could carry the request. Today's hosts
 * ask for the proof once per session, before they answer, so the refused
 * proof here comes from a stand-in that asks again: the rule, not a path a
 * shipped host takes.
 */
describe('a Power off that rode a Control session', { timeout: 60_000 }, () => {
    it('HARDENING: called too old, it keeps no seed the host later refuses on that session', async () => {
        const { powerOffDevice } = await import('../api/devices/powerOff');
        const { powerOffSessionFor, POWER_OFF_ANSWER_TIMEOUT_MS } = await import('../api/devices/session');
        // The person's Control session: the passphrase typed, proved, answered.
        let accepts: UaRecord = app.record;
        const c = await openControlSession(app, PC_ROWS, () => accepts);
        expect(await c.challenge(), 'premise: the typed passphrase was proved').toBe(true);
        await spinUntil('the card may ride it', () => powerOffSessionFor(APP) === c.id);
        expect(promptsFor(APP)).toBe(1);
        // The card's Power off rides it, and this host never answers the
        // request: the deadline calls it too old, and the session goes on.
        const now = Date.now();
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(now);
        try {
            const run = powerOffDevice({ hostDevice: APP, name: 'Desk-PC', machineRows: PC_ROWS });
            await spinUntil('the power-off request on that session', async () => (await c.frames()).some(f => f.kind === 'power'));
            await vi.advanceTimersByTimeAsync(POWER_OFF_ANSWER_TIMEOUT_MS + 100);
            const out = await run;
            expect(out.kind, 'premise: called too old').toBe('refused');
            expect(out.text).toMatch(/too old/);
        } finally {
            const t = Date.now();
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(t);
        }
        expect(powerOffSessionFor(APP), 'premise: the Control session goes on').toBe(c.id);
        // The host asks again and refuses what this phone remembered, out loud.
        accepts = { ...app.record, verifying_key: Array.from(ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)))) };
        expect(await c.challenge(), 'premise: refused').toBe(false);
        expect(promptsFor(APP), 'premise: the remembered seed was offered, not asked for').toBe(1);
        // That refusal was heard: the next Control asks for the passphrase.
        accepts = app.record;
        const again = await openControlSession(app, PC_ROWS, () => accepts);
        expect(await again.challenge()).toBe(true);
        expect(promptsFor(APP), 'the refused seed was forgotten').toBe(2);
    });
});
