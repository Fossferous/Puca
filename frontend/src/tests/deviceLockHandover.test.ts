/**
 * The CONTROLLER's side of "Lock": the host ends the session with the
 * LOCK_HANDOVER_REASON, and this end decides what the person sees.
 *
 *  - The OWNER's session follows the machine to its sign-in-screen row
 *    (wakeSession.followToSignIn) — a handover, not a failure, no red banner.
 *  - A SHARE grantee cannot follow: the owner's machine is not in their device
 *    list and its sign-in row is the owner's to reach. The first version tore
 *    down deliberately (error nulled) and the follow then gave up silently, so
 *    the friend who tapped Lock watched the stage vanish with no explanation.
 *    Now the session ends WITH a reason.
 *
 * Same rig as deviceBackground.test.ts (a controller session needs the fake
 * RTCPeerConnection), plus a share-verification stub and a followToSignIn spy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../api/devices/fileAccessConsent', () => ({
    requestFileAccessConsent: async () => null,
}));
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
vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyDh: async () => new Uint8Array(32).fill(3),
}));
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
vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'dev-me',
}));
vi.mock('../api/devices/index', () => ({
    currentUserId: () => 1,
}));
vi.mock('../api/devices/hostConsent', () => ({
    requestHostConsent: async () => ({ monitor: 0 }),
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

class FakeTrack {
    kind = 'video';
    onunmute: (() => void) | null = null;
    stop(): void {}
}

class FakePc {
    static last: FakePc | null = null;
    connectionState = 'new';
    onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    ondatachannel: ((e: unknown) => void) | null = null;
    constructor() { FakePc.last = this; }
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
    /** Simulate ICE giving up, as it does when Android froze the process. */
    fail(): void { this.connectionState = 'failed'; this.onconnectionstatechange?.(); }
}

// MediaStream comes from setup.ts's MockMediaStream (non-configurable there);
// only the peer connection needs THIS file's richer fake, to drive
// connectionState transitions.
vi.stubGlobal('RTCPeerConnection', FakePc);

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

/** Drive a CONTROLLER session to 'active' through the real handshake. */
async function activeControllerSession(share?: { capabilities: string[] }): Promise<string> {
    const { installDeviceSessions, activeSessions, endAllSessions, connectToDevice } =
        await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const id = await connectToDevice('dev-host', share
        ? { share: { inviteId: 9, ownerUser: 42, ownerUsername: 'owner', capabilities: share.capabilities } }
        : undefined);
    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: eph.pubEncoded },
    });
    await settle();

    const s = activeSessions().find(x => x.id === id);
    expect(s?.phase, 'harness must reach an ACTIVE controller session').toBe('active');
    return id;
}

const LOCK_HANDOVER_REASON = 'console-locked-handover';

/** Every snapshot subscribeSessions delivered, so the ENDED emit (which
 *  precedes the delete) can be read after the fact. */
async function endedSnapshotOf(id: string, run: () => Promise<void>) {
    const { subscribeSessions } = await import('../api/devices/session');
    const seen: Array<{ id: string; phase: string; error: string | null }> = [];
    const off = subscribeSessions(list => {
        for (const s of list) seen.push({ id: s.id, phase: s.phase, error: s.error });
    });
    await run();
    off();
    return seen.find(s => s.id === id && s.phase === 'ended') ?? null;
}

beforeEach(() => { follow.mockClear(); });

describe('the lock handover, controller side', () => {
    it("the OWNER follows the machine to its sign-in-screen row — a handover, not an error", async () => {
        const id = await activeControllerSession();
        const ended = await endedSnapshotOf(id, async () => {
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: LOCK_HANDOVER_REASON } });
            await settle();
        });
        expect(ended, 'the session must end').toBeTruthy();
        expect(ended!.error, 'deliberate: no red banner').toBeNull();
        expect(follow).toHaveBeenCalledWith('dev-host', 1);
    });

    it('a SHARE grantee cannot follow, and is told WHY the picture went instead of watching it vanish', async () => {
        const id = await activeControllerSession({ capabilities: ['control'] });
        const ended = await endedSnapshotOf(id, async () => {
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: LOCK_HANDOVER_REASON } });
            await settle();
        });
        expect(ended, 'the session must end').toBeTruthy();
        expect(ended!.error).toMatch(/locked/);
        expect(follow, "the owner's sign-in row is not the grantee's to reach").not.toHaveBeenCalled();
    });
});
