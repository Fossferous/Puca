/**
 * THE LOCKED-FOLLOW FALLBACK (pollLockedFollow): a controller session stuck on
 * a secure-desktop banner follows to the machine's sign-in row — but ONLY when
 * that row is online, which is the level signal that the secure desktop is a
 * LOCK and not a UAC prompt (the SYSTEM service keeps that row's socket open
 * only while the console is locked or logged off).
 *
 * WHY THIS EXISTS (field, 2026-08-20): a cold boot with Windows' ARSO
 * auto-sign-in-then-lock brings the DESKTOP row online at the lock screen, so
 * the phone's wake-connect lands there and the PIN cannot be typed. The
 * host-side handover (handleConsoleLock) is edge-triggered on the Windows lock
 * EVENT — which fired at boot, before any session existed — so nothing ever
 * followed. This poller is the level-triggered half.
 *
 * Same rig as deviceLockHandover.test.ts (real handshake to an ACTIVE
 * controller session), plus a sealed `secure-desktop` signal from the "host"
 * (the flag must arrive the way production sets it, not by poking internals)
 * and a controllable machines/index mock. Every "must NOT follow" case has the
 * "then it does" positive control in the same test, so a poller that never
 * fires cannot pass this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const follow = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../api/devices/wakeSession', () => ({
    followToSignIn: (...a: unknown[]) => follow(...a),
    followToDesktop: vi.fn(async () => {}),
}));
vi.mock('../api/devices/shares', () => ({
    verifiedSharePeerDevice: async () => ({ device_pub: 'x25519:' + btoa('k') }),
}));

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
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        setFileAccess: async () => {},
        injectEvent: async () => {},
        releaseInput: async () => {},
    }),
}));
vi.mock('../api/devices/fileAccessConsent', () => ({ requestFileAccessConsent: async () => null }));
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

/** The machine the poller sees. Tests mutate `signInRow` between calls. */
const h = vi.hoisted(() => ({
    signInRow: null as null | { id: string; online: boolean; verified: boolean },
    listDevicesCalls: 0,
}));
vi.mock('../api/devices/index', () => ({
    thisDeviceId: () => 'dev-me',
    currentUserId: () => 1,
    listDevices: async () => { h.listDevicesCalls++; return []; },
}));
vi.mock('../api/devices/machines', () => ({
    groupIntoMachines: async () => [],
    machineOf: (_machines: unknown[], deviceId: string) =>
        deviceId === 'dev-host'
            ? {
                primary: { id: 'dev-host', name: 'PC' },
                rows: [],
                signInRow: h.signInRow,
            }
            : null,
}));
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl } from '../api/e2ee';

class FakeTrack {
    kind = 'video';
    onunmute: (() => void) | null = null;
    stop(): void {}
}
class FakePc {
    connectionState = 'new';
    onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    ondatachannel: ((e: unknown) => void) | null = null;
    createDataChannel(label: string) {
        return {
            label, readyState: 'connecting',
            onopen: null, onclose: null, onmessage: null,
            close: () => {}, send: () => {},
        };
    }
    addTransceiver() { return { receiver: { track: new FakeTrack() } }; }
    async createOffer() { return { type: 'offer' as const, sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close(): void { this.connectionState = 'closed'; }
}
vi.stubGlobal('RTCPeerConnection', FakePc);

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

let peerSigSeq = 0;

/** Drive a CONTROLLER session to 'active' and keep the key the HOST would
 *  hold, so the secure-desktop flag arrives sealed, exactly as in production. */
async function activeControllerSession(share?: { capabilities: string[] }): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, activeSessions, endAllSessions, connectToDevice } =
        await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    peerSigSeq = 0;

    const id = await connectToDevice('dev-host', share
        ? { share: { inviteId: 9, ownerUser: 42, ownerUsername: 'owner', capabilities: share.capabilities } }
        : undefined);
    const connect = sent.find(m => m.type === 'DeviceConnect');
    const controllerEph = connect?.payload?.eph as string;
    expect(controllerEph, 'the controller must publish its ephemeral').toBeTruthy();

    const { generateControlEphemeral, deriveDeviceControlKey } = await import('../api/e2ee');
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph);
    expect(key).not.toBeNull();

    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle();
    const s = activeSessions().find(x => x.id === id);
    expect(s?.phase, 'harness must reach an ACTIVE controller session').toBe('active');
    return { id, key: key! };
}

async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: peerSigSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

function phaseOf(id: string) {
    return import('../api/devices/session').then(m =>
        m.activeSessions().find(x => x.id === id)?.phase ?? 'gone');
}

beforeEach(() => {
    follow.mockClear();
    h.signInRow = null;
    h.listDevicesCalls = 0;
    // shouldAdvanceTime keeps settle()'s real setTimeout(0) alive while the
    // 8s patience is jumped deliberately.
    vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('the locked-follow fallback', () => {
    it('follows once the banner has aged past the patience and the sign-in row is online', async () => {
        const { id, key } = await activeControllerSession();
        const { pollLockedFollow, LOCKED_FOLLOW_AFTER_MS } = await import('../api/devices/session');
        h.signInRow = { id: 'dev-signin', online: true, verified: true };

        await hostSignal(id, key, { kind: 'secure-desktop', up: true });

        // TOO SOON: the host-side lock-event handover gets its chance first.
        await pollLockedFollow();
        expect(follow, 'must wait out the patience window').not.toHaveBeenCalled();
        expect(await phaseOf(id)).toBe('active');

        // POSITIVE CONTROL, same session: past the patience it fires.
        vi.advanceTimersByTime(LOCKED_FOLLOW_AFTER_MS + 500);
        await pollLockedFollow();
        await settle();
        expect(follow).toHaveBeenCalledWith('dev-host', 1);
        expect(await phaseOf(id), 'the stuck session is handed over').toBe('gone');
        // The desktop app still holds its one-session slot; it must be told.
        expect(sent.some(m => m.type === 'DeviceEnd'), 'DeviceEnd must reach the host').toBe(true);
    });

    it('a machine with NO sign-in row keeps its frozen session — never ended on a guess', async () => {
        const { id, key } = await activeControllerSession();
        const { pollLockedFollow, LOCKED_FOLLOW_AFTER_MS } = await import('../api/devices/session');
        h.signInRow = null;

        await hostSignal(id, key, { kind: 'secure-desktop', up: true });
        vi.advanceTimersByTime(LOCKED_FOLLOW_AFTER_MS + 500);
        await pollLockedFollow();
        await settle();
        expect(follow).not.toHaveBeenCalled();
        expect(await phaseOf(id), 'freeze-and-resume must survive').toBe('active');

        // POSITIVE CONTROL: the row appearing later (today: minutes later,
        // while the service retried a server 500) is exactly the case.
        h.signInRow = { id: 'dev-signin', online: true, verified: true };
        await pollLockedFollow();
        await settle();
        expect(follow).toHaveBeenCalledWith('dev-host', 1);
    });

    it('an OFFLINE sign-in row is a UAC prompt for all this poller knows — no follow', async () => {
        const { id, key } = await activeControllerSession();
        const { pollLockedFollow, LOCKED_FOLLOW_AFTER_MS } = await import('../api/devices/session');
        h.signInRow = { id: 'dev-signin', online: false, verified: true };

        await hostSignal(id, key, { kind: 'secure-desktop', up: true });
        vi.advanceTimersByTime(LOCKED_FOLLOW_AFTER_MS + 500);
        await pollLockedFollow();
        await settle();
        expect(follow).not.toHaveBeenCalled();
        expect(await phaseOf(id)).toBe('active');

        h.signInRow = { id: 'dev-signin', online: true, verified: true };
        await pollLockedFollow();
        await settle();
        expect(follow, 'positive control: online flips the verdict').toHaveBeenCalled();
    });

    it('the secure desktop CLEARING (someone unlocked at the machine) stands the poller down', async () => {
        const { id, key } = await activeControllerSession();
        const { pollLockedFollow, LOCKED_FOLLOW_AFTER_MS } = await import('../api/devices/session');
        h.signInRow = { id: 'dev-signin', online: true, verified: true };

        await hostSignal(id, key, { kind: 'secure-desktop', up: true });
        vi.advanceTimersByTime(LOCKED_FOLLOW_AFTER_MS + 500);
        await hostSignal(id, key, { kind: 'secure-desktop', up: false });
        await pollLockedFollow();
        await settle();
        expect(follow).not.toHaveBeenCalled();
        expect(await phaseOf(id)).toBe('active');
    });

    it('a SHARE session is never handed over — the owner\'s sign-in row is not the grantee\'s', async () => {
        const { id, key } = await activeControllerSession({ capabilities: ['control'] });
        const { pollLockedFollow, LOCKED_FOLLOW_AFTER_MS } = await import('../api/devices/session');
        h.signInRow = { id: 'dev-signin', online: true, verified: true };

        await hostSignal(id, key, { kind: 'secure-desktop', up: true });
        vi.advanceTimersByTime(LOCKED_FOLLOW_AFTER_MS + 500);
        await pollLockedFollow();
        await settle();
        expect(follow).not.toHaveBeenCalled();
        expect(await phaseOf(id), 'the share keeps its freeze-and-resume').toBe('active');
    });

    it('idle cost is zero: no device-list read without a banner-bearing session', async () => {
        await activeControllerSession();
        const { pollLockedFollow } = await import('../api/devices/session');
        await pollLockedFollow();
        expect(h.listDevicesCalls, 'no secureDesktop → the poller must exit before listing').toBe(0);
    });
});
