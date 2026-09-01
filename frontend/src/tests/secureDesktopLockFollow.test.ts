/**
 * THE UNSOLICITED-LOCK HANDOVER — a machine that locks itself follows to its
 * sign-in-screen row exactly as the manual Lock button does, but ONLY when it
 * is enrolled: a non-enrolled machine has no row to move to and keeps today's
 * freeze-and-resume.
 *
 * Drives the real `handleConsoleLock` against a live HOST session and asserts
 * on the DeviceEnd that reaches the wire — what the controller follows — not on
 * any flag. Every "must not happen" has a positive-control sibling.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- the seams. Everything below the session layer is replaced so the test
// --- observes exactly what would have hit the machine.
const injectEvent = vi.fn(async () => {});
const setMonitor = vi.fn(async (..._a: unknown[]) => {});
const powerAction = vi.fn(async (..._a: unknown[]) => {});
const writeLocalClipboard = vi.fn(async () => {});
const sent: Array<{ type: string; payload?: { session_id?: string; payload?: string } }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: { session_id?: string; payload?: string } }) => { sent.push(m); },
    },
}));
/** Which transport startSession hands back. 'agent-pc' (the default) makes
 *  session.ts treat the AGENT as owning the peer connection — the shape every
 *  test here historically ran with, except the rig used to say 'webview', a
 *  value production never produces, and only worked because the transport
 *  match had a catch-all else; an exhaustive match exposed it. 'webview-pc'
 *  exists for the one test that must keep the unattended gate the ONLY thing
 *  holding a file request (the agent path has a second, stream-existence hold
 *  in front of nothing-proved sessions, which would keep that test green even
 *  with the security gate deleted). */
let transportKind: 'agent-pc' | 'webview-pc' = 'agent-pc';
/** What this host says it can do. A phone hosting files reports
 *  `{capture:false, files:true}` — the shape whose consent skip the
 *  files-only tests below exist to bound. */
let hostCaps = { capture: true, files: true };
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return {
                capture: hostCaps.capture, unattended: true, input: hostCaps.capture,
                elevated: false, clipboard: true, files: hostCaps.files, monitors: [],
            };
        },
        startSession: async () => (transportKind === 'webview-pc'
            ? { kind: 'webview-pc', stream: new MediaStream(), width: 1920, height: 1080 }
            : { kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: (...a: unknown[]) => setMonitor(...a),
        setFileAccess: (...a: unknown[]) => setFileAccess(...a),
        // Optional on the interface; a phone host has none. `hasPowerAction`
        // false leaves it undefined so the arm's "cannot lock or shut down
        // from here" branch is reachable from a test.
        ...(hasPowerAction ? { powerAction: (...a: unknown[]) => powerAction(...a) } : {}),
        injectEvent,
    }),
}));
let hasPowerAction = true;

// What the host actually hands the agent when it grants file access. The only
// observable that distinguishes "granted one folder a human picked" from
// "granted the whole machine because nobody had to be asked".
const setFileAccess = vi.fn(async () => {});

// The folder-picking dialog an UNARMED host shows. Mocked because the real one
// fails closed after a 30s timeout when nothing is mounted to answer it, which
// would make the unarmed case look like a deliberate denial after half a minute.
const fileConsentAnswer: { root: string } | null = { root: 'C:\\Shared' };
const requestFileAccessConsent = vi.fn(async () => fileConsentAnswer);
vi.mock('../api/devices/fileAccessConsent', () => ({
    requestFileAccessConsent: () => requestFileAccessConsent(),
}));
vi.mock('../api/devices/clipboard', () => ({
    writeLocalClipboard,
    readLocalClipboard: async () => '',
    readLocalClipboardDetailed: async () => ({ ok: true, text: '' }),
    MAX_CLIPBOARD_BYTES: 6000,
    isClipboardEvent: (e: unknown) => (e as { t?: string })?.t === 'clip',
    buildClipboardEvent: (data: string) => ({ t: 'clip', data }),
}));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyDh: async () => new Uint8Array(32).fill(3),
}));
vi.mock('../api/deviceIdentity/deviceKey', () => ({
    ensureDeviceKey: async () => ({ sign_pub: 'ed25519:' + btoa('s') }),
}));
/** When non-null, activeHostSession connects UNDER A SHARE with exactly these
 *  capabilities (the server stamps `from_user`, and the host re-verifies the
 *  grant — every verification step is stubbed to succeed here, because what
 *  these tests bound is what a VERIFIED share is allowed to do). */
let shareCaps: string[] | null = null;
vi.mock('../api/devices/shares', () => ({
    shareForGrantee: async () => (shareCaps
        ? { id: 9, grant_record: 'rec', grant_sig: 'sig', capabilities: shareCaps }
        : null),
    shareAuthorises: async () => true,
    verifiedSharePeerDevice: async () => ({ device_pub: 'x25519:' + btoa('k') }),
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));

// The AGENT transport: what an armed unattended host actually uses. It has no
// picker and no human in the loop, which is exactly why the passphrase has to
// gate it. agentAnswerOffer starting to stream is the observable that matters.
const agentAnswerOffer = vi.fn(async () => 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n');
vi.mock('../api/devices/hostAgent', () => ({ agentAnswerOffer }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));

// connectToDevice refuses without an enrolled identity, so the controller path
// cannot start at all unless this is mocked.
vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'dev-me',
}));
vi.mock('../api/devices/index', () => ({
    currentUserId: () => 1,
}));

// An UNARMED host now asks the person sitting at it before sharing, because
// shipping the agent removed the browser picker that was doing that by accident.
// Default: they clicked Allow. Set to null for the deny case.
let consentAnswer: { monitor: number } | null = { monitor: 0 };
vi.mock('../api/devices/hostConsent', () => ({
    requestHostConsent: async () => consentAnswer,
}));

// Whether THIS machine is armed for unattended access. Per-test, because the
// suite needs both: an armed host (the security property) and an unarmed one
// (the positive control that proves the harness can drive injection at all).
let armed = true;
const verifyUaResponse = vi.fn(async () => false);
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => (armed ? { nonce: btoa('nonce-abc'), salt: btoa('salt-abc') } : null),
    verifyUaResponse: () => verifyUaResponse(),
    unattendedState: async () => ({ armed }),
}));


// Whether THIS machine is enrolled for sign-in-screen access — the whole gate.
let enrolled = false;
vi.mock('../api/devices/lockScreen', () => ({
    unattendedAccessState: async () => ({
        serviceInstalled: enrolled, enrolled, armed: enrolled,
        deviceId: enrolled ? 'signin-row' : null, binsHash: null,
    }),
}));

/**
 * Drain pending async work, INCLUDING macrotasks.
 *
 * `await Promise.resolve()` in a loop only drains microtasks. The injection path
 * runs through WebCrypto (openControl -> crypto.subtle.decrypt), which resolves
 * on a macrotask, so a microtask-only spin returns with the work still queued —
 * the assertion then reads zero and the call lands during the NEXT test, after
 * mockClear had already run. That is not a flake: it reported the wrong answer
 * in BOTH directions at once, a false "rig broken" in one test and a false
 * "vulnerable" in the next, from a single cause. Hence this helper, and hence
 * the positive control that made the contradiction visible.
 */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) {
        await new Promise(r => setTimeout(r, 0));
    }
}

/** Drive a host session to 'active' the way the real handshake does.
 *
 *  installDeviceSessions is install-once, so the handlers are registered a
 *  single time and each test resets the SESSIONS rather than the handlers. */
async function activeHostSession(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, activeSessions, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectRequested')!({
        payload: {
            session_id: 'ds-test', from_device: 'dev-peer', eph: eph.pubEncoded,
            // A share connect is routed with the grantee's user id stamped on.
            ...(shareCaps ? { from_user: 42, from_username: 'friend' } : {}),
        },
    });
    // Let the handshake settle.
    await settle();

    const s = activeSessions().find(x => x.id === 'ds-test');
    expect(s, 'host session should exist after a connect request').toBeTruthy();
    // THE PRECONDITION. Without this assertion every test below passes
    // vacuously: a session stuck in 'connecting' injects nothing for reasons
    // that have nothing to do with the gate under test. The first version of
    // this file did exactly that and went green against the vulnerable code.
    expect(s!.phase, 'harness must reach an ACTIVE host session').toBe('active');

    // The session key: the CONTROLLER's half. The host derived it from its own
    // ephemeral private key (internal to the module) and our public half; we
    // derive the mirror image from our private half and the ephemeral the host
    // published in its DeviceConnectResponse.
    //
    // Getting this wrong is how the first draft of this file went green against
    // vulnerable code: a mismatched key means openControl returns null and the
    // handler drops the frame, so "no injection" was true for a reason that had
    // nothing to do with the gate. The positive control below is what catches
    // that, and it must stay.
    const accepted = sent.find(m => m.type === 'DeviceConnectResponse') as
        { payload?: { accepted?: boolean; eph?: string } } | undefined;
    expect(accepted?.payload?.accepted, 'host must have accepted').toBe(true);
    const hostEph = accepted!.payload!.eph!;
    const { deriveDeviceControlKey } = await import('../api/e2ee');
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), eph.priv, hostEph);
    expect(key, 'controller must derive a session key').not.toBeNull();
    return { id: 'ds-test', key: key! };
}

beforeEach(() => {
    armed = true;
    shareCaps = null;
    hasPowerAction = true;
    consentAnswer = { monitor: 0 };
    transportKind = 'agent-pc';
    hostCaps = { capture: true, files: true };
    injectEvent.mockClear();
    writeLocalClipboard.mockClear();
    agentAnswerOffer.mockClear();
    verifyUaResponse.mockClear();
    verifyUaResponse.mockImplementation(async () => false);
});
beforeEach(() => { enrolled = false; });

describe('an unsolicited console lock', () => {
    it('POSITIVE CONTROL: an enrolled machine hands the session to its sign-in row', async () => {
        enrolled = true;
        const { activeSessions, handleConsoleLock } = await import('../api/devices/session');
        await activeHostSession();
        const before = sent.length;

        await handleConsoleLock();
        await settle();

        const ended = sent.slice(before).find(m => m.type === 'DeviceEnd') as
            { type: string; payload?: { session_id?: string; reason?: string } } | undefined;
        expect(ended, 'the host must end the session so the controller follows').toBeTruthy();
        expect(ended!.payload!.reason, 'with the lock-handover reason the controller keys on')
            .toBe('console-locked-handover');
        expect(activeSessions().find(x => x.id === 'ds-test'), 'the host session is gone').toBeUndefined();
    });

    it('a NON-enrolled machine keeps the session — there is nowhere to follow to', async () => {
        enrolled = false;
        const { activeSessions, handleConsoleLock } = await import('../api/devices/session');
        await activeHostSession();
        const before = sent.length;

        await handleConsoleLock();
        await settle();

        expect(
            sent.slice(before).some(m => m.type === 'DeviceEnd'),
            'ending an unsolicited-locked session with no sign-in row would trade '
            + 'freeze-and-resume for a session that died on its own',
        ).toBe(false);
        const s = activeSessions().find(x => x.id === 'ds-test');
        expect(s, 'the session survives the lock').toBeTruthy();
        expect(s!.phase, 'and stays active, ready to resume on unlock').toBe('active');
    });

    it('does NOT hand over a share session — the friend cannot follow to my sign-in row', async () => {
        enrolled = true;
        shareCaps = ['control']; // a friend controlling under an accepted share
        const { activeSessions, handleConsoleLock } = await import('../api/devices/session');
        await activeHostSession();
        const before = sent.length;

        await handleConsoleLock();
        await settle();

        expect(
            sent.slice(before).some(m => m.type === 'DeviceEnd'),
            'a share grantee gains nothing from a handover it cannot follow, and loses its resume',
        ).toBe(false);
        expect(activeSessions().find(x => x.id === 'ds-test')?.phase, 'the share session survives').toBe('active');
    });

    it('does nothing when there is no host session', async () => {
        enrolled = true;
        const { installDeviceSessions, endAllSessions, handleConsoleLock } = await import('../api/devices/session');
        installDeviceSessions();
        endAllSessions('test reset');
        sent.length = 0;

        await handleConsoleLock();
        await settle();

        expect(sent.some(m => m.type === 'DeviceEnd'), 'no session, no handover').toBe(false);
    });
});
