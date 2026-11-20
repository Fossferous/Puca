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
/** What the person types for each host (null: Cancel). */
let typed: Record<string, string | null> = {};
vi.mock('../api/devices/unattendedPrompt', () => ({
    requestUnattendedPassphrase: async (peer: string) => {
        prompts.push(peer);
        return typed[peer] ?? null;
    },
}));
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
 * Press Power off on a card, and play the host that answers. Resolves with
 * the card's outcome. `machineRows` is what the card knows of the PC: every
 * row the device list grouped into it.
 */
async function pressPowerOff(host: StandIn, machineRows: string[] | undefined): Promise<PowerOffOutcome> {
    const { powerOffDevice } = await import('../api/devices/powerOff');
    const { SHUTDOWN_REASON } = await import('../api/devices/session');
    const before = sent.length;
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
        if (!ok) {
            // A wrong proof: the host ends the session with that, and never
            // carries anything out.
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'unattended access was refused' } });
        } else {
            if (host.kind === 'app') await signal({ kind: 'power-ack', action: 'force_power_off' });
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: SHUTDOWN_REASON } });
        }
    }
    return run;
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
    verdicts.length = 0;
    sent.length = 0;
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
        expect(first.text).toMatch(/did not accept the unattended-access passphrase/);
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
