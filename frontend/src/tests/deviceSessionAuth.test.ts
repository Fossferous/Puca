/**
 * The two authorisation properties that 0.8.0 shipped WITHOUT, despite both
 * being described as enforced in comments and in a commit message.
 *
 * Each test here fails against the pre-0.8.1 code. That is the point: the
 * unattended passphrase already had passing tests proving the SIGNATURE
 * verified correctly, and the grant chain still has nine of them. None of it
 * mattered, because nothing read the result. A test that exercises a helper
 * proves the helper works; only a test that drives the actual handler proves
 * the program uses it.
 *
 * So these drive the real `wsClient` handlers installed by installDeviceSessions
 * and assert on what reaches the OS — injection and clipboard — rather than on
 * any flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- the seams. Everything below the session layer is replaced so the test
// --- observes exactly what would have hit the machine.
const injectEvent = vi.fn(async () => {});
const setMonitor = vi.fn(async (..._a: unknown[]) => {});
const powerAction = vi.fn(async (..._a: unknown[]) => {});
const displayTopologyChanged = vi.fn(async () => {});
/** What listMonitors answers — the topology tests shrink it to one screen. */
let monitorsList: Array<Record<string, unknown>> = [];
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
        listMonitors: async () => monitorsList,
        setMonitor: (...a: unknown[]) => setMonitor(...a),
        displayTopologyChanged: () => displayTopologyChanged(),
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
let fileConsentAnswer: { root: string } | null = { root: 'C:\\Shared' };
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
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
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

import { sealControl } from '../api/e2ee';

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
    peerSigSeq = 0;

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
    monitorsList = [];
    displayTopologyChanged.mockClear();
    displayTopologyChanged.mockResolvedValue(undefined);
    consentAnswer = { monitor: 0 };
    transportKind = 'agent-pc';
    hostCaps = { capture: true, files: true };
    injectEvent.mockClear();
    writeLocalClipboard.mockClear();
    agentAnswerOffer.mockClear();
    verifyUaResponse.mockClear();
    verifyUaResponse.mockImplementation(async () => false);
});

/** The peer's signalling counter. Signalling frames carry a strictly increasing
 *  `n` so the relay cannot replay one it already passed on; a test peer has to
 *  behave like a real one or every frame is dropped as a replay. Reset per
 *  session by activeHostSession. */
let peerSigSeq = 0;

/** Decode the signal kinds the host emitted after index `from`.
 *
 *  Asserting on kinds rather than on "a message was sent": the weaker form
 *  passed whether the host reported success or failure, which is precisely the
 *  distinction these tests exist to check. */
async function sentKinds(key: Uint8Array, from: number): Promise<string[]> {
    const { openControl } = await import('../api/e2ee');
    const out: string[] = [];
    for (const m of sent.slice(from)) {
        const blob = m.payload?.payload;
        if (!blob) continue;
        const plain = await openControl(key, blob);
        if (plain) out.push(String((JSON.parse(plain) as { kind?: string }).kind ?? ''));
    }
    return out;
}

/** Seal and deliver one signal frame as the peer would. */
async function signal(key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: 'ds-test', n: peerSigSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: sealed } });
    await settle();
}

/**
 * POSITIVE CONTROL — the most important test in this file.
 *
 * It proves the harness can actually drive an injection: right key, right
 * sequence number, right event shape, session genuinely active. Without it the
 * two tests below assert "nothing was injected" in a rig where nothing could
 * ever have been injected, which is precisely the failure this codebase keeps
 * producing — an assertion that cannot go red.
 *
 * If this one ever fails, the tests below prove NOTHING, whatever they report.
 */
describe('positive control: an UNARMED host', () => {
    it('DOES inject input, so the rig is known to work', async () => {
        armed = false;
        const { key } = await activeHostSession();
        const sealed = await sealControl(key, JSON.stringify({ s: 1, e: { t: 'mouse', x: 5, y: 5 } }));

        handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: sealed } });
        await settle();

        expect(injectEvent, 'the rig must be able to inject, or nothing below means anything')
            .toHaveBeenCalled();
    });
});

describe('an armed host, before the unattended passphrase is proved', () => {
    /**
     * THE 0.8.0 BUG, exactly. The attacker does not fight the passphrase — they
     * ignore it. Capture is already running by the time the challenge goes out,
     * so saying nothing at all used to leave a fully working control session.
     *
     * Against pre-0.8.1 code this test fails: injectEvent is called.
     */
    it('does NOT inject input from a controller that ignored the challenge', async () => {
        const { key } = await activeHostSession();
        const sealed = await sealControl(key, JSON.stringify({ s: 1, e: { t: 'mouse', x: 5, y: 5 } }));

        handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: sealed } });
        await settle();

        expect(injectEvent, 'silence must not be a way in').not.toHaveBeenCalled();
    });

    /** Clipboard writes to the OS too, so it needs the same gate, not a bypass. */
    it('does NOT write the clipboard either', async () => {
        const { key } = await activeHostSession();
        const sealed = await sealControl(key, JSON.stringify({ s: 1, e: { t: 'clip', data: 'stolen' } }));

        handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: sealed } });
        await settle();

        expect(writeLocalClipboard).not.toHaveBeenCalled();
    });
});

/**
 * A CAPTURE-LESS HOST — a phone sharing files — accepts a session without the
 * screen-consent dialog, because there is no screen to consent to and file
 * access has its own prompt. That skip is only sound if an accepted-but-
 * unprompted session can do NOTHING on its own, and the first version of it
 * was not: the clipboard is neither capture nor input, so any enrolled device
 * could silently overwrite the phone's clipboard with no dialog and nothing
 * on screen. These pin both halves of "nothing".
 */
describe('a files-only host takes no input at all', () => {
    it('refuses injection and clipboard writes even fully unarmed', async () => {
        armed = false;                 // no passphrase gate on a phone
        hostCaps = { capture: false, files: true };
        const { key } = await activeHostSession();

        for (const e of [{ t: 'mouse', x: 5, y: 5 }, { t: 'clip', data: 'stolen' }]) {
            const sealed = await sealControl(key, JSON.stringify({ s: 1, e }));
            handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: sealed } });
            await settle();
        }

        expect(injectEvent, 'a phone injects nothing').not.toHaveBeenCalled();
        expect(writeLocalClipboard, 'and its clipboard is not a side door')
            .not.toHaveBeenCalled();
    });

    /**
     * POSITIVE CONTROL. Same rig, same events, a host that CAN capture: both
     * land. Without this the assertions above would pass against a build where
     * the whole handler was broken.
     */
    it('POSITIVE CONTROL: a capture-capable host still takes both', async () => {
        armed = false;
        hostCaps = { capture: true, files: true };
        const { key } = await activeHostSession();

        const mouse = await sealControl(key, JSON.stringify({ s: 1, e: { t: 'mouse', x: 5, y: 5 } }));
        handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: mouse } });
        await settle();
        const clip = await sealControl(key, JSON.stringify({ s: 2, e: { t: 'clip', data: 'ok' } }));
        handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: clip } });
        await settle();

        expect(injectEvent, 'the rig must be able to inject, or the test above proves nothing')
            .toHaveBeenCalled();
        expect(writeLocalClipboard).toHaveBeenCalled();
    });
});

describe('signalling is sealed, not merely relayed', () => {
    /**
     * These drive the ua-response branch rather than the SDP branch, for a
     * reason worth writing down: jsdom has no RTCPeerConnection, so a test that
     * feeds the host an offer proves nothing — the pre-fix code threw on
     * `new RTCPeerConnection` and sent no answer, so "no answer was sent" was
     * true for both the fixed and the vulnerable build. The first draft of this
     * file did exactly that and reported three green passes against code with
     * the hole wide open.
     *
     * ua-response rides the SAME DeviceSignalled envelope through the SAME
     * openSignal call, and reaches an observable mock with no WebRTC anywhere
     * near it. What holds for it holds for the SDP, because there is one gate.
     */
    it('ignores a signal the server injected in the clear', async () => {
        await activeHostSession();
        verifyUaResponse.mockClear();

        handlers.get('DeviceSignalled')!({
            payload: {
                session_id: 'ds-test',
                payload: JSON.stringify({ kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('x') }),
            },
        });
        await settle();

        expect(verifyUaResponse, 'an unsealed signal must never be processed').not.toHaveBeenCalled();
    });

    /** Sealed under a key the peer never had is the same as forged. */
    it('ignores a signal sealed under the wrong key', async () => {
        await activeHostSession();
        verifyUaResponse.mockClear();
        const wrong = new Uint8Array(32).fill(9);
        const sealed = await sealControl(wrong, JSON.stringify({
            sid: 'ds-test', n: 0, kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('x'),
        }));

        handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: sealed } });
        await settle();

        expect(verifyUaResponse).not.toHaveBeenCalled();
    });

    /**
     * Session binding. A server that captured a sealed frame from one session
     * between these two devices must not be able to splice it into another.
     */
    it('ignores a correctly-sealed frame carrying another session id', async () => {
        const { key } = await activeHostSession();
        verifyUaResponse.mockClear();
        const sealed = await sealControl(key, JSON.stringify({
            sid: 'ds-other', n: 0, kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('x'),
        }));

        handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: sealed } });
        await settle();

        expect(verifyUaResponse).not.toHaveBeenCalled();
    });

    /**
     * POSITIVE CONTROL for this block. A properly sealed, properly bound signal
     * MUST be processed — otherwise the three tests above pass because the
     * branch is unreachable, which is the exact failure they are written to
     * avoid.
     */
    it('positive control: a correctly sealed signal IS processed', async () => {
        const { key } = await activeHostSession();
        verifyUaResponse.mockClear();
        const sealed = await sealControl(key, JSON.stringify({
            sid: 'ds-test', n: 0, kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('x'),
        }));

        handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: sealed } });
        await settle();

        expect(verifyUaResponse, 'the sealed path must be reachable, or the tests above prove nothing')
            .toHaveBeenCalled();
    });
});


describe('the SCREEN is gated on the passphrase, not just input', () => {
    /**
     * The defect four independent reviewers found in the 0.8.1 fix, which gated
     * injection and clipboard and left the media path wide open. A controller
     * that ignored the challenge still got live video for the full 120s
     * deadline, and could reconnect for another window indefinitely.
     *
     * The observable is agentAnswerOffer: on the agent transport that call IS
     * the machine starting to encode and send its screen. Against the 0.8.1
     * build this test fails — the offer is answered with no proof at all.
     */
    it('does NOT answer an offer from a controller that ignored the challenge', async () => {
        const { key } = await activeHostSession();

        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });

        expect(agentAnswerOffer, 'the screen must not stream before the passphrase is proved')
            .not.toHaveBeenCalled();
    });

    /**
     * POSITIVE CONTROL. An UNARMED host must answer, or the test above passes
     * because the offer branch is unreachable in this rig rather than because
     * the gate works.
     */
    it('positive control: an unarmed host DOES answer the offer', async () => {
        armed = false;
        const { key } = await activeHostSession();

        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });

        expect(agentAnswerOffer, 'the rig must be able to answer, or the test above proves nothing')
            .toHaveBeenCalled();
    });

    /**
     * The held offer must be RELEASED on proof, not dropped. A controller has no
     * way to know it should renegotiate, so dropping it leaves a session that
     * passed the passphrase and still shows a black tile.
     */
    it('answers the held offer once the passphrase IS proved', async () => {
        const { key } = await activeHostSession();

        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        expect(agentAnswerOffer).not.toHaveBeenCalled();

        verifyUaResponse.mockImplementation(async () => true);
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });

        expect(agentAnswerOffer, 'proving the passphrase must resume the session')
            .toHaveBeenCalled();
    });
});

describe('reflection: a sealed frame is valid in both directions', () => {
    /**
     * Both peers seal under the SAME key, so only the role distinguishes a frame
     * the peer sent from one reflected back at its sender. Without a role check
     * an armed HOST processes a challenge sent TO it: it prompts its own user
     * for the unattended passphrase, derives with an attacker-chosen salt, signs
     * an attacker-chosen nonce, and returns the signature.
     *
     * That is a phishing prompt on the victim's screen plus a signing oracle.
     */
    it('an armed host does NOT answer a challenge reflected at it', async () => {
        const { key } = await activeHostSession();
        const before = sent.length;

        await signal(key, { kind: 'ua-challenge', nonce: btoa('evil-nonce'), salt: btoa('evil-salt') });

        const replied = sent.slice(before).length > 0;
        expect(replied, 'a host must never sign an attacker-supplied challenge').toBe(false);
    });
});


describe('signalling frames cannot be replayed', () => {
    /**
     * Sealing does not stop a replay: a sealed frame stays valid forever and the
     * same key opens it every time, so the relay can simply deliver one twice.
     * Input frames carried a sequence number from the start; signalling did not,
     * so a server could re-deliver a captured ua-challenge to make the controller
     * prompt for the passphrase again, or re-deliver an offer to force
     * renegotiation whenever it liked.
     */
    it('drops a frame the relay delivers a second time', async () => {
        const { key } = await activeHostSession();
        verifyUaResponse.mockClear();
        verifyUaResponse.mockImplementation(async () => true);

        // Build ONE frame and deliver it twice, exactly as a relay would.
        const frame = await sealControl(key, JSON.stringify({
            sid: 'ds-test', n: 0, kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok'),
        }));

        handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: frame } });
        await settle();
        expect(verifyUaResponse, 'the first delivery is legitimate').toHaveBeenCalledTimes(1);

        handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: frame } });
        await settle();
        expect(verifyUaResponse, 'the replay must be dropped, not processed again')
            .toHaveBeenCalledTimes(1);
    });

    /** A frame with a stale counter is the same attack with an older capture. */
    it('drops a frame whose counter has already been used', async () => {
        const { key } = await activeHostSession();
        verifyUaResponse.mockClear();
        verifyUaResponse.mockImplementation(async () => true);

        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });
        expect(verifyUaResponse).toHaveBeenCalledTimes(1);

        const stale = await sealControl(key, JSON.stringify({
            sid: 'ds-test', n: 0, kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok'),
        }));
        handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: stale } });
        await settle();

        expect(verifyUaResponse, 'a rewound counter must not be accepted').toHaveBeenCalledTimes(1);
    });
});

describe('a controller never waits forever for a screen', () => {
    /**
     * "Waiting for the device's screen…" with no end and no explanation is the
     * worst failure this feature has produced, and it has had three distinct
     * causes that all looked identical from the phone: an unanswered screen
     * picker, a host holding the offer for an unattended passphrase, and — the
     * one reported from a real phone — a peer whose signalling this build drops
     * because it predates the sequence number.
     *
     * jsdom has no RTCPeerConnection, so the controller path cannot start
     * without a stub. The FIRST version of this test had early returns for that
     * and passed with the deadline disarmed — vacuous, like three before it.
     * Hence the stub, and hence the assertion that the session is really gone.
     */
    class StubPc {
        onicecandidate: unknown = null;
        ontrack: unknown = null;
        onconnectionstatechange: unknown = null;
        connectionState = 'connecting';
        remoteDescription: unknown = null;
        // The production code captures the transceiver's receiver track
        // (Safari never fires ontrack for locally added transceivers) and
        // hangs the onunmute listener on it — hand back that shape. The
        // track's onunmute is never fired here, which is exactly the
        // "no video ever arrives" condition under test.
        addTransceiver() { return { receiver: { track: { onunmute: null } } }; }
        createDataChannel() { return { close() {}, addEventListener() {} }; }
        async createOffer() { return { type: 'offer', sdp: 'v=0\r\n' }; }
        async setLocalDescription() { /* no-op */ }
        async setRemoteDescription() { /* no-op */ }
        async addIceCandidate() { /* no-op */ }
        close() { /* no-op */ }
    }

    it('gives up and names the likely causes when no video arrives', async () => {
        vi.stubGlobal('RTCPeerConnection', StubPc);
        try {
            const { installDeviceSessions, activeSessions, endAllSessions, connectToDevice } =
                await import('../api/devices/session');
            installDeviceSessions();
            endAllSessions('test reset');
            sent.length = 0;
            peerSigSeq = 0;

            void connectToDevice('dev-peer').catch(() => { /* resolves on teardown */ });
            await settle();

            const req = sent.find(m => m.type === 'DeviceConnect') as
                { payload?: { session_id?: string } } | undefined;
            const sid = req?.payload?.session_id;
            expect(sid, 'the controller must have asked to connect').toBeTruthy();

            const hostEph = (await import('../api/e2ee')).generateControlEphemeral();
            handlers.get('DeviceConnectAnswered')!({
                payload: { session_id: sid, accepted: true, eph: hostEph.pubEncoded },
            });
            await settle();

            // PRECONDITION: without an active session there is nothing to time out,
            // and every assertion below would hold for the wrong reason.
            const live = activeSessions().find(x => x.id === sid);
            expect(live?.phase, 'controller must reach active').toBe('active');
            // The stream is now attached EAGERLY (Safari/WKWebView will not
            // start the media pipeline until the MediaStream is on a playing
            // <video>), so its existence no longer means video arrived. What
            // proves "no video yet" is that the receiver track never unmuted —
            // and therefore the deadline below must still fire.
            expect(live?.stream, 'the stream is attached before any video arrives').toBeTruthy();

            // Nothing ever arrives — the reported symptom.
            await new Promise(r => setTimeout(r, 31_000));

            expect(
                activeSessions().find(x => x.id === sid),
                'the controller must stop waiting instead of sitting there forever',
            ).toBeUndefined();
        } finally {
            vi.unstubAllGlobals();
        }
    }, 40_000);
});


describe('an UNARMED host asks before sharing its screen', () => {
    /**
     * Until 0.8.4 no installer contained the agent, so every host fell back to
     * getDisplayMedia and the browser's picker was — by accident, not design —
     * the only thing standing between an incoming session and the screen.
     *
     * The agent captures with no prompt. Without this gate an unarmed machine
     * would silently begin streaming to any device on the account, which trades
     * a usability bug for a consent regression.
     */
    it('does NOT start a session when the person declines', async () => {
        armed = false;
        consentAnswer = null;

        const { installDeviceSessions, activeSessions, endAllSessions } =
            await import('../api/devices/session');
        installDeviceSessions();
        endAllSessions('test reset');
        sent.length = 0;

        const eph = (await import('../api/e2ee')).generateControlEphemeral();
        handlers.get('DeviceConnectRequested')!({
            payload: { session_id: 'ds-deny', from_device: 'dev-peer', eph: eph.pubEncoded },
        });
        await settle();

        expect(
            activeSessions().find(x => x.id === 'ds-deny'),
            'a declined request must leave no session behind',
        ).toBeUndefined();

        const answer = sent.find(m => m.type === 'DeviceConnectResponse') as
            { payload?: { accepted?: boolean } } | undefined;
        expect(answer?.payload?.accepted, 'and the controller must be told no').toBe(false);
    });
});

describe('switching screens mid-session', () => {
    /**
     * The picker the browser showed forced a screen choice up front and could
     * never be revisited. The replacement has to be changeable while watching,
     * or a two-monitor machine is half unreachable once connected.
     *
     * Driven through the real signal handlers, since the value that matters is
     * what the HOST does with a set-monitor frame — not what the dropdown does.
     */
    it('a host acts on set-monitor and confirms what is actually showing', async () => {
        armed = false;
        const { key } = await activeHostSession();
        setMonitor.mockClear();
        const before = sent.length;

        await signal(key, { kind: 'set-monitor', monitor: 2 });

        expect(setMonitor, 'the host must actually switch capture').toHaveBeenCalledWith('ds-test', 2);
        // Decode what it answered. "Something was sent" would pass even if the
        // host reported a refusal, which is the failure the next test is about.
        expect(await sentKinds(key, before)).toContain('monitor-active');
    });

    /**
     * A webview host cannot switch — its source was fixed when the picker was
     * answered. That must reach the viewer as a message, not as a dropdown that
     * silently snaps back.
     */
    it('reports a failure instead of pretending it switched', async () => {
        armed = false;
        const { key } = await activeHostSession();
        setMonitor.mockRejectedValueOnce(new Error('cannot switch screens mid-session'));
        const before = sent.length;

        await signal(key, { kind: 'set-monitor', monitor: 1 });

        const kinds = await sentKinds(key, before);
        expect(kinds, 'a refusal must be reported as a failure').toContain('monitor-failed');
        expect(kinds, 'and must NOT claim the switch happened').not.toContain('monitor-active');
    });

});

describe('the screen the host consents to is the screen that streams', () => {
    /**
     * The consent dialog offers "Screen to share", and until this test the
     * choice reached nothing: answerOffer passed a hardcoded null, which the
     * agent turns into monitor 0. So a host that deliberately picked Display 2
     * shared Display 1 — while the host dialog AND the controller's dropdown
     * both said Display 2.
     *
     * Consent that does not reach the thing being consented to is not consent,
     * and the comment on Internal.monitor claimed it did. Sixth such comment.
     */
    it('passes the consented monitor to the agent, not a default', async () => {
        armed = false;
        consentAnswer = { monitor: 2 };
        agentAnswerOffer.mockClear();

        const { key } = await activeHostSession();
        // The agent transport is what an always-on host uses.
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });

        expect(agentAnswerOffer, 'the chosen screen must reach the capture')
            .toHaveBeenCalledWith('ds-test', expect.any(String), 2, { dataOnly: false });
    });

    /** An ARMED host never sees the dialog, so it must keep defaulting. */
    it('leaves an armed host defaulting, since it never consented to a screen', async () => {
        armed = true;
        agentAnswerOffer.mockClear();

        const { key } = await activeHostSession();
        verifyUaResponse.mockImplementation(async () => true);
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });

        expect(agentAnswerOffer).toHaveBeenCalledWith('ds-test', expect.any(String), null, { dataOnly: false });
    });
});

/**
 * THE GATE THAT MUST NOT BE INVERTED.
 *
 * An armed host skips the folder prompt and grants the unattended policy scope —
 * the machine minus its system and secret-bearing paths. That decision reads the
 * POSITIVE pair `uaRequired && uaVerified`, and it has to, because every other
 * guard in this file is the negative `uaRequired && !uaVerified`, which PASSES
 * for an unarmed host (an unarmed host never sets uaVerified either). Read the
 * wrong way round, this hands whole-machine no-prompt access to every unarmed
 * device on the account — so the unarmed case here is not a nice-to-have, it is
 * the test that catches the catastrophe.
 */
describe('file access on an armed host needs no prompt, and on an unarmed one still does', () => {
    // Cleared AFTER the session is built, not before: activeHostSession() ends
    // the previous session, and tearing down a session that HAD a grant revokes
    // it through this very mock. Clearing first counted that revoke as if it
    // were this test's grant — which is how the "nothing is granted" case below
    // failed against a correct implementation.
    it('grants the unattended policy, with no dialog, once the passphrase is proved', async () => {
        armed = true;
        const { key } = await activeHostSession();
        setFileAccess.mockClear();
        requestFileAccessConsent.mockClear();
        verifyUaResponse.mockImplementation(async () => true);
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });
        // The offer is what gives the agent a stream to grant against; a file
        // request with no stream is HELD until one exists, so a session that
        // never negotiates never grants. Production always sends one.
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        await signal(key, { kind: 'file-access-request' });

        expect(setFileAccess, 'an armed host grants the policy scope')
            .toHaveBeenCalledWith('ds-test', { kind: 'policy' });
        expect(requestFileAccessConsent, 'and nobody at that machine is asked')
            .not.toHaveBeenCalled();
    });

    /**
     * THE ORDER THE WIRE ACTUALLY PRODUCES, which shipped broken in v0.8.23:
     * a file session sends its offer and its file request immediately, both
     * are held behind the passphrase, and the proof releases them. The replay
     * used to serve the file request FIRST — an IPC against the stream that
     * only answering the offer creates — so the real agent answered "no live
     * stream for that session" and the controller was told the host DECLINED,
     * every time, on exactly the armed no-prompt path the feature exists for.
     *
     * The default resolving setFileAccess mock cannot see that failure, which
     * is how the bug got past this file. This one refuses like the real agent
     * until a stream exists.
     */
    it('serves the held file request only AFTER the held offer, never before', async () => {
        armed = true;
        const { key } = await activeHostSession();
        setFileAccess.mockClear();
        requestFileAccessConsent.mockClear();
        verifyUaResponse.mockImplementation(async () => true);
        setFileAccess.mockImplementation(async () => {
            if (agentAnswerOffer.mock.calls.length === 0) {
                throw new Error('no live stream for that session');
            }
        });
        try {
            const before = sent.length;
            await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n', filesOnly: true });
            await signal(key, { kind: 'file-access-request' });
            await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });

            expect(setFileAccess, 'the grant must still happen')
                .toHaveBeenCalledWith('ds-test', { kind: 'policy' });
            expect(
                agentAnswerOffer.mock.invocationCallOrder[0],
                'and only once the agent has a stream to grant against',
            ).toBeLessThan(setFileAccess.mock.invocationCallOrder[0]);
            const kinds = await sentKinds(key, before);
            expect(kinds, 'the controller hears a grant').toContain('file-access-granted');
            expect(kinds, 'not a refusal it never earned').not.toContain('file-access-denied');
        } finally {
            setFileAccess.mockImplementation(async () => {});
        }
    });

    it('NEGATIVE CONTROL: an unarmed host still asks, and never gets the policy', async () => {
        armed = false;
        fileConsentAnswer = { root: 'C:\\Shared' };

        const { key } = await activeHostSession();
        setFileAccess.mockClear();
        requestFileAccessConsent.mockClear();
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        await signal(key, { kind: 'file-access-request' });

        expect(requestFileAccessConsent, 'an unarmed host must ask the person sitting at it')
            .toHaveBeenCalled();
        expect(setFileAccess).toHaveBeenCalledWith('ds-test', { kind: 'folder', root: 'C:\\Shared' });
        expect(setFileAccess, 'an unarmed host must NEVER be given the policy scope')
            .not.toHaveBeenCalledWith('ds-test', { kind: 'policy' });
    });

    it('grants nothing to an armed host whose peer never proved the passphrase', async () => {
        armed = true;
        verifyUaResponse.mockImplementation(async () => false);
        // On the WEBVIEW-PC transport, deliberately: the agent transport has a
        // second hold (no stream yet -> request deferred) standing in front of
        // an unproven session, and behind it this test stays green even with
        // the unattended gate deleted. This transport has no such hold, so
        // the assertion below is pinned to the gate it exists to pin. The
        // mutation check: remove `uaRequired && !uaVerified` from
        // serveFileAccessRequest and this test must go red.
        transportKind = 'webview-pc';

        const { key } = await activeHostSession();
        setFileAccess.mockClear();
        requestFileAccessConsent.mockClear();
        await signal(key, { kind: 'file-access-request' });

        expect(setFileAccess, 'unproven means no grant of any kind').not.toHaveBeenCalled();
        expect(requestFileAccessConsent, 'and no dialog either — the request is dropped')
            .not.toHaveBeenCalled();
    });

    it('refuses when the person at an unarmed host declines', async () => {
        armed = false;
        fileConsentAnswer = null;

        const { key } = await activeHostSession();
        setFileAccess.mockClear();
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        await signal(key, { kind: 'file-access-request' });

        expect(setFileAccess).not.toHaveBeenCalled();
        fileConsentAnswer = { root: 'C:\\Shared' };
    });

    it('revokes the grant when the session ends', async () => {
        // With the prompt gone, revocation is one of the two things standing in
        // for it, so pin it rather than trusting that the stream teardown gets
        // there. Found while writing the tests above: the teardown revoke is
        // what made "nothing was granted" fail, so it demonstrably fires.
        armed = true;
        const { key } = await activeHostSession();
        verifyUaResponse.mockImplementation(async () => true);
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        await signal(key, { kind: 'file-access-request' });
        expect(setFileAccess).toHaveBeenCalledWith('ds-test', { kind: 'policy' });

        setFileAccess.mockClear();
        const { endAllSessions } = await import('../api/devices/session');
        endAllSessions('test end');
        await settle();

        expect(setFileAccess, 'ending the session must take the grant with it')
            .toHaveBeenCalledWith('ds-test', null);
    });

    it('a revoked grant is not handed back when the peer simply asks again', async () => {
        // THE KILL SWITCH WOULD OTHERWISE BE DECORATIVE. The gate asks whether the
        // passphrase was proved, and after a revoke it still was — so an armed host
        // re-granted on the next request, with no prompt, and the person who
        // pressed "Stop file access" was never told it had been undone.
        armed = true;
        const { key } = await activeHostSession();
        verifyUaResponse.mockImplementation(async () => true);
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('ok') });
        await signal(key, { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' });
        await signal(key, { kind: 'file-access-request' });

        // POSITIVE CONTROL: the grant really does happen on this session, so the
        // refusal below is caused by the revoke and not by a broken fixture.
        expect(setFileAccess).toHaveBeenCalledWith('ds-test', { kind: 'policy' });

        const { revokeAllFileAccess } = await import('../api/devices/session');
        expect(revokeAllFileAccess()).toBe(1);
        // Settle BEFORE clearing: revokeAllFileAccess fires setFileAccess(id, null)
        // without awaiting it, so clearing straight away leaves that call to land
        // afterwards and be counted as this test's re-grant.
        await settle();
        setFileAccess.mockClear();

        await signal(key, { kind: 'file-access-request' });
        expect(setFileAccess, 'asking again must not undo the withdrawal')
            .not.toHaveBeenCalledWith('ds-test', { kind: 'policy' });
        expect(setFileAccess, 'and must not fall through to a folder grant either')
            .not.toHaveBeenCalledWith('ds-test', expect.objectContaining({ kind: 'folder' }));
    });
});

/**
 * POWER — lock / shut down on the controller's request. Both are machine-wide
 * and irreversible from the controller's side, so: gated exactly like input,
 * and the session is ended WITH A REASON before the OS call, not after.
 */
describe('power actions', () => {
    // Spelled here as literals on purpose: the wire strings the host sends and
    // the controller matches on. If either side renames, this goes red.
    const LOCK_HANDOVER_REASON = 'console-locked-handover';
    const SHUTDOWN_REASON = 'the device is shutting down';
    const deviceEnds = () => sent
        .filter(m => m.type === 'DeviceEnd')
        .map(m => (m.payload as { reason?: string } | undefined)?.reason);

    it('an ARMED host refuses power actions from a peer that never proved the passphrase', async () => {
        armed = true;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'shutdown' });
        await signal(key, { kind: 'power', action: 'lock' });
        expect(powerAction, 'the same gate as input').not.toHaveBeenCalled();
        expect(deviceEnds()).toEqual([]);
    });

    it('shutdown: the OS call first, then the host tells the controller WHY it is going', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        // Recorded AT the moment of the OS call: had the goodbye already left?
        let endHadLeftWhenCalled: boolean | null = null;
        powerAction.mockImplementation(async () => {
            endHadLeftWhenCalled = deviceEnds().includes(SHUTDOWN_REASON);
        });

        await signal(key, { kind: 'power', action: 'shutdown' });

        expect(powerAction).toHaveBeenCalledWith('shutdown');
        expect(deviceEnds()).toContain(SHUTDOWN_REASON);
        // The order matters and is the OPPOSITE of the first version: the
        // goodbye must follow the call, because teardown drops the session
        // key and a refused ExitWindowsEx would then have no way to say so.
        // ExitWindowsEx returns as soon as the shutdown is initiated, and the
        // DeviceEnd still leaves ahead of Windows closing the app.
        expect(endHadLeftWhenCalled).toBe(false);
    });

    it('a shutdown the OS REFUSES is reported as power-failed and the session stays up', async () => {
        // The bug this pins: with teardown before the OS call, the session key
        // was already gone when the catch ran, sendSignal dropped the
        // power-failed frame, and the controller had been told "the device is
        // shutting down" about a machine that never went anywhere.
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockRejectedValueOnce(new Error('this account does not hold SeShutdownPrivilege'));
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'shutdown' });
        expect(await sentKinds(key, before)).toContain('power-failed');
        expect(deviceEnds(), 'the machine is still up — the session must be too').toEqual([]);
    });

    it('a VIEW-ONLY share may not lock or power off the owner\'s machine', async () => {
        // The same line the input injector draws: a grant without 'control'
        // watches, and nothing more. Lock and shutdown are more than input.
        armed = false;
        shareCaps = ['view_only'];
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'lock' });
        await signal(key, { kind: 'power', action: 'shutdown' });
        expect(powerAction).not.toHaveBeenCalled();
        expect(deviceEnds()).toEqual([]);
    });

    it('POSITIVE CONTROL: a share WITH control reaches the power action', async () => {
        // Proves the share rig actually produces an active, acting host —
        // without this the refusal above could be a session that never got
        // going, for reasons that have nothing to do with the gate.
        armed = false;
        shareCaps = ['control'];
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'lock' });
        expect(powerAction).toHaveBeenCalledWith('lock');
    });

    it('lock: the host locks, then hands the session over to the sign-in screen', async () => {
        // Real timers: the harness's settle() is setTimeout-based, and the
        // handover delay is a real 1.5 s (LockWorkStation returns before the
        // console has actually locked).
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'lock' });
        expect(powerAction).toHaveBeenCalledWith('lock');
        expect(deviceEnds(), 'not yet — LockWorkStation returns before the console locks').toEqual([]);
        await new Promise(r => setTimeout(r, 1_800));
        await settle();
        expect(deviceEnds()).toContain(LOCK_HANDOVER_REASON);
    }, 10_000);

    it('a lock the OS refuses is reported as power-failed and does not end the session', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockRejectedValueOnce(new Error('LockWorkStation failed'));
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'lock' });
        const kinds = await sentKinds(key, before);
        expect(kinds).toContain('power-failed');
        expect(deviceEnds(), 'and must NOT end the session as if it had locked').toEqual([]);
    });

    it('a host WITHOUT a power backend (a phone) says so instead of pretending', async () => {
        // The interface method is optional; this pins the branch that answers
        // for a backend that never had it, which a rejecting mock cannot reach.
        armed = false;
        hasPowerAction = false;
        const { key } = await activeHostSession();
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'lock' });
        const { openControl } = await import('../api/e2ee');
        const reasons: string[] = [];
        for (const m of sent.slice(before)) {
            const blob = m.payload?.payload;
            if (!blob) continue;
            const plain = await openControl(key, blob);
            if (!plain) continue;
            const f = JSON.parse(plain) as { kind?: string; reason?: string };
            if (f.kind === 'power-failed') reasons.push(f.reason ?? '');
        }
        expect(reasons.length).toBe(1);
        expect(reasons[0]).toMatch(/cannot lock or shut down/);
        expect(deviceEnds()).toEqual([]);
    });

    it('an unknown action is ignored, never guessed', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'reboot' });
        expect(powerAction).not.toHaveBeenCalled();
    });
});

/**
 * DISPLAY POWER (W4) — the session arm. Same gates as lock/shutdown (UA,
 * view-only), but the OPPOSITE lifecycle: the session continues over dark
 * panels, and success is ACKED because it produces no other visible signal —
 * silence must keep meaning "old host ignored it".
 */
describe('display power actions', () => {
    /** Frames the host sent since `from`, unsealed to full objects. */
    async function sentFrames(key: Uint8Array, from: number): Promise<Record<string, unknown>[]> {
        const { openControl } = await import('../api/e2ee');
        const out: Record<string, unknown>[] = [];
        for (const m of sent.slice(from)) {
            const blob = m.payload?.payload;
            if (!blob) continue;
            const plain = await openControl(key, blob);
            if (plain) out.push(JSON.parse(plain) as Record<string, unknown>);
        }
        return out;
    }
    const deviceEnds = () => sent.filter(m => m.type === 'DeviceEnd');

    it('displays_off runs the shell action, ACKS, and the session STAYS UP', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        const before = sent.length;
        const endsBefore = deviceEnds().length;
        await signal(key, { kind: 'power', action: 'displays_off' });
        expect(powerAction).toHaveBeenCalledWith('displays_off');
        const frames = await sentFrames(key, before);
        const ack = frames.find(f => f.kind === 'power-ack');
        expect(ack, 'success must be acked — silence means "old host"').toBeTruthy();
        expect(ack!.action).toBe('displays_off');
        expect(deviceEnds().length, 'dark panels are not a goodbye').toBe(endsBefore);
    });

    it('keep_primary relays the shell’s per-monitor DETAIL in the ack', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        powerAction.mockResolvedValueOnce('Turned off 1 of 2 other display(s); DELL U2720Q did not respond');
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'displays_off_keep_primary' });
        expect(powerAction).toHaveBeenCalledWith('displays_off_keep_primary');
        const frames = await sentFrames(key, before);
        const ack = frames.find(f => f.kind === 'power-ack');
        expect(ack?.detail).toBe('Turned off 1 of 2 other display(s); DELL U2720Q did not respond');
    });

    it('a shell refusal becomes power-failed, never a dead session', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockRejectedValueOnce(new Error('None of the 2 other display(s) responded to the power command'));
        const before = sent.length;
        const endsBefore = deviceEnds().length;
        await signal(key, { kind: 'power', action: 'displays_on' });
        expect(await sentKinds(key, before)).toContain('power-failed');
        expect(deviceEnds().length).toBe(endsBefore);
    });

    it('the UA gate holds: an ARMED host with an unproved peer does nothing', async () => {
        armed = true;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'displays_off' });
        await signal(key, { kind: 'power', action: 'displays_on' });
        expect(powerAction, 'the same gate as input and lock').not.toHaveBeenCalled();
    });

    it('a VIEW-ONLY share may not touch the owner’s displays', async () => {
        armed = false;
        shareCaps = ['view_only'];
        const { key } = await activeHostSession();
        powerAction.mockClear();
        await signal(key, { kind: 'power', action: 'displays_off' });
        expect(powerAction).not.toHaveBeenCalled();
    });

    /**
     * THE TOPOLOGY PAIR. Unlike panel power, a detach changes the desktop
     * under every live capture — so the host must poke the agent's rebuild
     * and re-announce its screens, and the announce must go out even at ONE
     * screen, because retiring the controller's stale multi-screen list is
     * exactly the point.
     */
    it('displays_detach_others pokes the agent rebuild, re-announces one screen, and ACKs the detail', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        powerAction.mockResolvedValueOnce('Disabled 2 other display(s) — they come back when the session ends');
        monitorsList = [{ id: 0, label: 'Main', left: 0, top: 0, width: 1920, height: 1080 }];
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'displays_detach_others' });
        expect(powerAction).toHaveBeenCalledWith('displays_detach_others');
        expect(displayTopologyChanged, 'the agent must rebuild its captures').toHaveBeenCalledTimes(1);
        const frames = await sentFrames(key, before);
        const monitors = frames.find(f => f.kind === 'monitors');
        expect(monitors, 'the one-screen announce retires the stale list').toBeTruthy();
        expect((monitors!.monitors as unknown[]).length).toBe(1);
        const ack = frames.find(f => f.kind === 'power-ack');
        expect(ack?.detail).toMatch(/^Disabled 2/);
    });

    it('an old agent’s refused rebuild poke does not block the reattach ack', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        displayTopologyChanged.mockRejectedValueOnce(new Error('bad request'));
        monitorsList = [
            { id: 0, label: 'Main', left: 0, top: 0, width: 1920, height: 1080 },
            { id: 1, label: 'Side', left: 1920, top: 0, width: 1920, height: 1080 },
        ];
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'displays_reattach' });
        expect(powerAction).toHaveBeenCalledWith('displays_reattach');
        const frames = await sentFrames(key, before);
        expect(frames.find(f => f.kind === 'power-ack'), 'the ack must survive the poke failing').toBeTruthy();
        expect(frames.find(f => f.kind === 'monitors'), 'and the screens are still re-announced').toBeTruthy();
    });

    it('POSITIVE CONTROL: plain panel power neither pokes the agent nor re-announces', async () => {
        armed = false;
        const { key } = await activeHostSession();
        powerAction.mockClear();
        monitorsList = [{ id: 0, label: 'Main', left: 0, top: 0, width: 1920, height: 1080 }];
        const before = sent.length;
        await signal(key, { kind: 'power', action: 'displays_off' });
        expect(displayTopologyChanged).not.toHaveBeenCalled();
        const frames = await sentFrames(key, before);
        expect(frames.find(f => f.kind === 'monitors'),
            'a single-screen announce is topology-only').toBeUndefined();
    });
});
