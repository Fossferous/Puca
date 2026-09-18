/**
 * THE AGENT UNDER A LIVE SESSION WAS REPLACED — the host half of the recovery.
 *
 * A session that starts while this machine is locked streams from the
 * lock-screen (SYSTEM) agent the app borrows. At unlock the service stops that
 * agent and the app falls through to its own, which has never heard of the
 * session: the viewer's picture froze until someone reconnected by hand. The
 * agent now answers the 1 Hz `session_status` poll with `stream_live`, and an
 * explicit `false` for a stream this host started sends the controller the
 * existing 'stream-died' — which restarts the media onto whichever agent
 * answers now, inside the same session.
 *
 * Every "sends nothing" case here is paired with a case in the same rig that
 * DOES send, so silence cannot come from a rig that never reaches the poll.
 *
 * Rig notes (each one has bitten a test in this repo):
 *  - armed = false everywhere: an armed host holds the offer and the
 *    restart-offer behind the passphrase, and every test would pass vacuously.
 *  - time is moved through Date.now only; the real 1 Hz interval that
 *    installDeviceSessions registers keeps running, so every explicit poll is
 *    followed by settle() and assertions are on DELTAS of what was sent.
 *  - the sessionStatus mock defaults to streamLive undefined (an old agent).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

type Status = { secureDesktop: boolean; cursorClipped: boolean; streamLive?: boolean; streamEnd?: string };

/** What the next sessionStatus answers. Default: an agent predating the field. */
let status: Status = { secureDesktop: false, cursorClipped: false };
/** When set, the NEXT sessionStatus call returns this promise instead. */
let pendingStatus: Promise<Status> | null = null;
const sessionStatus = vi.fn(async (..._a: unknown[]): Promise<Status> => {
    if (pendingStatus) {
        const p = pendingStatus;
        pendingStatus = null;
        return p;
    }
    return { ...status };
});
const getStreamQuality = vi.fn(async (..._a: unknown[]) => ({ fps: 30, bitrate_kbps: 6000 }));
const updateStream = vi.fn(async (..._a: unknown[]) => {});
const stopSession = vi.fn(async (..._a: unknown[]) => {});
const injectEvent = vi.fn(async (..._a: unknown[]) => {});

const sent: Array<{ type: string; payload?: { session_id?: string; payload?: string } }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('@tauri-apps/api/core', () => ({ invoke: async () => undefined }));
vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: { session_id?: string; payload?: string } }) => { sent.push(m); },
    },
}));
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return {
                capture: true, unattended: true, input: true,
                elevated: false, clipboard: true, files: true, monitors: [],
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: (...a: unknown[]) => stopSession(...a),
        listMonitors: async () => [],
        setMonitor: async () => {},
        updateStream: (...a: unknown[]) => updateStream(...a),
        getStreamQuality: (...a: unknown[]) => getStreamQuality(...a),
        sessionStatus: (...a: unknown[]) => sessionStatus(...a),
        setPrivacyMode: async () => {},
        setFileAccess: async () => {},
        injectEvent: (...a: unknown[]) => injectEvent(...a),
    }),
}));
vi.mock('../api/devices/fileAccessConsent', () => ({ requestFileAccessConsent: async () => ({ root: 'C:\\Shared' }) }));
vi.mock('../api/devices/controlGuard', () => ({
    armControlGuard: () => {},
    releaseControlGuard: () => {},
    noteControlActivity: () => {},
    DEVICE_CONTROL_IDLE_MS: 1_800_000,
}));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKeyRc', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/deviceIdentity/deviceKey', () => ({ ensureDeviceKey: async () => ({ sign_pub: 'ed25519:' + btoa('s') }) }));
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
const agentAnswerOffer = vi.fn(async (..._a: unknown[]) => 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n');
vi.mock('../api/devices/hostAgent', () => ({ agentAnswerOffer: (...a: unknown[]) => agentAnswerOffer(...a) }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/index', () => ({ currentUserId: () => 1 }));
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));
// UNARMED, in every test: see the header.
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl } from '../api/e2ee';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let sessionMod: typeof import('../api/devices/session');
beforeAll(async () => {
    sessionMod = await import('../api/devices/session');
});

/** Drain pending work INCLUDING macrotasks — WebCrypto resolves on them. */
async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

let peerSigSeq = 0;
let peerInSeq = 0;
const OFFER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const FILES_OFFER = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

async function activeHostSession(): Promise<Uint8Array> {
    const { installDeviceSessions, activeSessions, endAllSessions } = sessionMod;
    installDeviceSessions();
    endAllSessions('test reset');
    await settle();
    sent.length = 0;
    peerSigSeq = 0;
    peerInSeq = 0;

    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectRequested')!({
        payload: {
            session_id: 'ds-test', from_device: 'dev-peer', eph: eph.pubEncoded,
            ...(shareCaps ? { from_user: 42, from_username: 'friend' } : {}),
        },
    });
    await settle();

    const s = activeSessions().find(x => x.id === 'ds-test');
    expect(s, 'host session should exist after a connect request').toBeTruthy();
    expect(s!.phase, 'harness must reach an ACTIVE host session').toBe('active');
    const accepted = sent.find(m => m.type === 'DeviceConnectResponse') as
        { payload?: { accepted?: boolean; eph?: string } } | undefined;
    expect(accepted?.payload?.accepted, 'host must have accepted').toBe(true);
    const { deriveDeviceControlKey } = await import('../api/e2ee');
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), eph.priv, accepted!.payload!.eph!);
    expect(key, 'controller must derive a session key').not.toBeNull();
    return key!;
}

async function signal(key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: 'ds-test', n: peerSigSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: sealed } });
    await settle();
}

/** One key press from the controller, sealed the way the relay carries it,
 *  through the host's real decrypt → coalesce → inject queues. */
async function input(key: Uint8Array): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ s: peerInSeq++, e: { t: 'key', code: 'KeyA', down: true } }));
    handlers.get('DeviceInputted')!({ payload: { session_id: 'ds-test', event: sealed } });
    await settle();
}

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

async function streamDiedSince(key: Uint8Array, from: number): Promise<number> {
    return (await sentKinds(key, from)).filter(k => k === 'stream-died').length;
}

/** One explicit poll, then let everything it started land. */
async function poll(): Promise<void> {
    await sessionMod.pollSecureDesktop();
    await settle();
}

/** A live host session whose agent stream this host started. */
async function streamingSession(): Promise<Uint8Array> {
    const key = await activeHostSession();
    await signal(key, { kind: 'offer', sdp: OFFER });
    expect(agentAnswerOffer, 'the premise: this host started an agent stream').toHaveBeenCalledTimes(1);
    return key;
}

let now = 0;
let dateSpy: ReturnType<typeof vi.spyOn> | null = null;
beforeEach(() => {
    shareCaps = null;
    status = { secureDesktop: false, cursorClipped: false };
    pendingStatus = null;
    sessionStatus.mockClear();
    agentAnswerOffer.mockClear();
    getStreamQuality.mockReset();
    getStreamQuality.mockImplementation(async () => ({ fps: 30, bitrate_kbps: 6000 }));
    updateStream.mockClear();
    stopSession.mockClear();
    injectEvent.mockReset();
    injectEvent.mockImplementation(async () => {});
    // Time moves only when a test moves it — and only through Date.
    dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    // Unlocked, with the last unlock at the epoch: no test starts inside the
    // unlock grace unless it asks to.
    now = 0;
    sessionMod?.noteConsoleLocked(false);
    now = 1_900_000_000_000;
});
afterEach(() => {
    dateSpy?.mockRestore();
    dateSpy = null;
});

describe('the agent answering no longer holds this session\'s stream', () => {
    it('POSITIVE CONTROL: an explicit false for a stream this host started sends ONE stream-died', async () => {
        const key = await streamingSession();
        const before = sent.length;
        status = { ...status, streamLive: false };

        await poll();

        expect(sessionStatus, 'the poll must actually have asked').toHaveBeenCalled();
        expect(await streamDiedSince(key, before)).toBe(1);
    });

    it('a live stream sends nothing', async () => {
        const key = await streamingSession();
        const before = 0; // the whole session: a report from any tick would count
        status = { ...status, streamLive: true };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before)).toBe(0);
    });

    it('an agent that predates the field (streamLive undefined) sends nothing', async () => {
        const key = await streamingSession();
        const before = 0; // the whole session: a report from any tick would count
        status = { secureDesktop: false, cursorClipped: false, streamLive: undefined };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'absence is "cannot tell", never "gone"').toBe(0);
    });

    // A DEAD PIPE reaches this code in the same shape as the old agent above
    // (no streamLive key): hostAgent's catch arm builds it, and that arm is
    // pinned in secureDesktopStatus.test.ts ('a dead pipe and an old agent
    // refusal carry no streamLive at all'). hostAgent is mocked away here, so
    // a separate case would only repeat the one above.

    it('nothing is reported before this host has started a stream — and it is, once it has', async () => {
        const key = await activeHostSession();
        const before = 0; // the whole session: a report from any tick would count
        status = { ...status, streamLive: false };

        await poll();
        expect(sessionStatus, 'the poll ran for this session').toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'no stream yet, nothing to have died').toBe(0);

        // Same session, same answer, stream now started: the control. Counted
        // from the START, not from after the offer: a real 1 Hz tick landing
        // between the offer and this poll reports first and spends the 30 s
        // throttle, and a window opened after the offer would then see 0.
        // The first half already proved nothing came before the stream.
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
        await poll();
        expect(await streamDiedSince(key, 0)).toBe(1);
    });

    it('is throttled to one report per 30 s, and repeats after it', async () => {
        const key = await streamingSession();
        const before = sent.length;
        status = { ...status, streamLive: false };

        await poll();
        now += 1_000;
        await poll();
        expect(await streamDiedSince(key, before), 'two polls a second apart: one report').toBe(1);

        now += 31_000;
        await poll();
        expect(await streamDiedSince(key, before), 'past the throttle: reported again').toBe(2);
    });

    it('a restart resets the throttle: the NEW stream\'s death is not held back by the old one\'s report', async () => {
        const key = await streamingSession();
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, 0), 'the premise: the old stream was reported').toBe(1);

        // The controller restarts the media onto whichever agent answers now.
        now += 1_000;
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(agentAnswerOffer, 'the premise: the restart started a new stream').toHaveBeenCalledTimes(2);

        // The new stream dies too, 16 s after the first report: well inside
        // the old 30 s throttle, and past the controller's 15 s restart mute.
        now += 15_000;
        status = { ...status, streamLive: false };
        await poll();
        expect(
            await streamDiedSince(key, 0),
            'reported now, not up to 30 s late with a frozen picture meanwhile',
        ).toBe(2);
    });

    it('a reply read ACROSS a restart describes the replaced stream and is not reported', async () => {
        const key = await streamingSession();
        let resolve!: (v: Status) => void;
        pendingStatus = new Promise<Status>(r => { resolve = r; });
        // The poll captures which stream it is asking about, then waits.
        const inFlight = sessionMod.pollSecureDesktop();
        await settle();
        expect(pendingStatus, 'the premise: the poll is parked on the deferred reply').toBeNull();

        // The restart lands while it waits: stop, then a NEW stream.
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(agentAnswerOffer, 'the premise: the restart started a new stream').toHaveBeenCalledTimes(2);
        // Any later poll finds the new stream live.
        status = { ...status, streamLive: true };

        const before = 0; // the whole session: a report from any tick would count
        resolve({ secureDesktop: false, cursorClipped: false, streamLive: false });
        await inFlight;
        await settle();

        expect(await streamDiedSince(key, before), 'the old stream\'s "gone" must not kill the new one').toBe(0);
    });

    it('REGRESSION GUARD: the restart the report leads to continues the same session on the same screen', async () => {
        // Existing restart-offer handling, not new behaviour: pinned here so the
        // recovery path this feature depends on stays intact.
        const key = await streamingSession();
        const [firstId, , firstMonitor] = agentAnswerOffer.mock.calls[0];

        await signal(key, { kind: 'restart-offer', sdp: OFFER });

        expect(stopSession, 'the dead stream is stopped first').toHaveBeenCalledWith('ds-test');
        expect(agentAnswerOffer).toHaveBeenCalledTimes(2);
        const [id, , monitor, opts] = agentAnswerOffer.mock.calls[1] as [string, string, number | null, { inputAuth?: unknown }];
        expect(id).toBe(firstId);
        expect(id).toBe('ds-test');
        expect(monitor).toBe(firstMonitor);
        expect(opts.inputAuth, 'the input grant is re-derived for the new stream').toBeDefined();
    });

    it('REGRESSION GUARD: a files-only session is never reported', async () => {
        // Held by the poll's pre-existing `hosts` filter (files-only sessions
        // are never asked about), not by the new condition's `!s.filesOnly` —
        // this passes with that term deleted. Pinned so the recovery can
        // never start "restarting" a files session's data channel.
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: FILES_OFFER, filesOnly: true });
        expect(agentAnswerOffer, 'the premise: the files session started a (data-only) stream').toHaveBeenCalledTimes(1);
        const before = 0; // the whole session: a report from any tick would count
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, before)).toBe(0);
    });

    it('a stream that never produced a frame stays with the viewer\'s own message', async () => {
        const key = await streamingSession();
        const before = 0; // the whole session: a report from any tick would count
        status = { ...status, streamLive: false, streamEnd: 'no_frame' };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'a restart cannot wake a sleeping panel').toBe(0);

        // The control, same session: any other end is reported.
        status = { ...status, streamLive: false, streamEnd: undefined };
        await poll();
        expect(await streamDiedSince(key, before)).toBe(1);
    });
});

describe('a share session while the console is locked', () => {
    it('is NOT reported while locked — a lock freezes a share on purpose', async () => {
        shareCaps = ['control'];
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);
        const before = 0; // the whole session: a report from any tick would count
        status = { ...status, streamLive: false };

        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'a restart now would show the friend the sign-in screen').toBe(0);

        // And after the unlock (once its grace has passed — see below) it IS:
        // the share recovers onto the owner's own agent.
        sessionMod.noteConsoleLocked(false);
        now += 3_000;
        await poll();
        expect(await streamDiedSince(key, before)).toBe(1);
    });

    it('stays frozen for a short grace after the unlock, then is reported', async () => {
        // The service stops the lock-screen agent on the same unlock event,
        // and until it has, that agent can still answer. A share restarted at
        // once would land on the agent being terminated.
        shareCaps = ['control'];
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, 0), 'the premise: frozen while locked').toBe(0);

        sessionMod.noteConsoleLocked(false);
        await poll(); // the unlock listener's own nudge poll
        expect(await streamDiedSince(key, 0), 'the unlock nudge must not restart it yet').toBe(0);

        now += 2_900;
        await poll();
        expect(await streamDiedSince(key, 0), 'still inside the grace').toBe(0);

        now += 200;
        await poll();
        expect(await streamDiedSince(key, 0), 'past the grace: recovered').toBe(1);
    });

    it('a clock stepped BACKWARDS after the unlock does not hold the share frozen', async () => {
        // An NTP correction or a manual change moves the wall clock back. The
        // grace is measured on that clock, so a step back makes "time since
        // the unlock" negative — which must end the grace, not extend it by
        // the size of the step.
        shareCaps = ['control'];
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);
        sessionMod.noteConsoleLocked(false);
        status = { ...status, streamLive: false };

        // The forward case, same session: still inside the grace, still frozen.
        now += 1_000;
        await poll();
        expect(await streamDiedSince(key, 0), 'the premise: inside the grace, frozen').toBe(0);

        // The clock steps back an hour. Without the lower bound the grace
        // would last until the clock caught up again.
        now -= 3_600_000;
        await poll();
        expect(await streamDiedSince(key, 0), 'a backwards step ends the grace').toBe(1);
    });

    it('POSITIVE CONTROL: the owner\'s own session is reported the instant the console unlocks', async () => {
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);
        sessionMod.noteConsoleLocked(false);
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, 0), 'the grace is for shares only').toBe(1);
    });

    it('POSITIVE CONTROL: a share on an unlocked console is reported', async () => {
        shareCaps = ['control'];
        const key = await streamingSession();
        const before = sent.length;
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, before)).toBe(1);
    });

    it('the owner\'s own session IS reported while locked', async () => {
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);
        const before = sent.length;
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, before)).toBe(1);
    });
});

describe('the inject path ("no such capture session") reports through the same gate', () => {
    const gone = (): void => { injectEvent.mockRejectedValue(new Error('no such capture session')); };

    it('an inject the agent answers "no such capture session" sends stream-died', async () => {
        shareCaps = ['control'];
        const key = await streamingSession();
        gone();
        await input(key);
        expect(injectEvent, 'the premise: the key press reached the backend').toHaveBeenCalled();
        expect(await streamDiedSince(key, 0)).toBe(1);
    });

    it('the inject and the poll share ONE throttle — and it still repeats after 30 s', async () => {
        const key = await streamingSession();
        gone();
        await input(key);
        expect(injectEvent).toHaveBeenCalled();
        expect(await streamDiedSince(key, 0), 'the inject reported it').toBe(1);

        // The poll learns the same death 5 s later: no second report.
        now += 5_000;
        status = { ...status, streamLive: false };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, 0), 'two detectors, one death: one report').toBe(1);

        // POSITIVE CONTROL: 31 s after that poll the throttle has lapsed.
        now += 31_000;
        await poll();
        expect(await streamDiedSince(key, 0), 'past the throttle: reported again').toBe(2);
    });

    it('a share on a locked console sends nothing from an inject either', async () => {
        shareCaps = ['control'];
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);
        gone();
        await input(key);
        expect(injectEvent, 'the premise: the key press reached the backend').toHaveBeenCalled();
        expect(
            await streamDiedSince(key, 0),
            'a restart now would show the friend the owner\'s sign-in screen',
        ).toBe(0);
    });

    it('POSITIVE CONTROL: the same share on an unlocked console is reported from an inject', async () => {
        shareCaps = ['control'];
        const key = await streamingSession();
        gone();
        await input(key);
        expect(injectEvent).toHaveBeenCalled();
        expect(await streamDiedSince(key, 0)).toBe(1);
    });
});

describe('the real unlock order, end to end', () => {
    it('dead pipe, then a fresh agent that never heard of it, then the restart, then live: ONE report', async () => {
        // The owner's own session, streaming from the lock-screen agent the
        // app borrowed while the machine was locked.
        const key = await streamingSession();
        sessionMod.noteConsoleLocked(true);

        // 1. The unlock: the service stops the lock-screen agent, and the
        //    tick that lands meanwhile finds the pipe dead — hostAgent's catch
        //    arm answers with no streamLive at all ("could not ask").
        sessionMod.noteConsoleLocked(false);
        status = { secureDesktop: false, cursorClipped: false };
        await poll();
        expect(sessionStatus, 'the poll asked across the dead pipe').toHaveBeenCalled();
        expect(await streamDiedSince(key, 0), 'a dead pipe is not "gone"').toBe(0);

        // 2. The app falls through to its own agent, which has never heard of
        //    this session.
        now += 1_000;
        status = { secureDesktop: false, cursorClipped: false, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, 0), 'the fresh agent says the stream is gone').toBe(1);

        // 3. The controller answers the report with a media restart, which
        //    starts a new stream on the agent answering now. From the moment
        //    that stream exists, the agent reports it live (set BEFORE the
        //    signal: the restart resets the throttle, so a real tick landing
        //    after it on a stale `false` would be a rig artefact).
        now += 1_000;
        status = { secureDesktop: false, cursorClipped: false, streamLive: true };
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(agentAnswerOffer, 'the restart started a new stream').toHaveBeenCalledTimes(2);

        // 4. That stream is live: nothing more, however long it runs — and
        //    well past the throttle, so silence here is not the throttle.
        await poll();
        now += 40_000;
        await poll();
        expect(sessionStatus.mock.calls.length, 'the poll kept asking').toBeGreaterThanOrEqual(4);
        expect(await streamDiedSince(key, 0), 'recovered: one report in total').toBe(1);
    });
});

describe('the lock flag those tests set is the one the Windows events drive', () => {
    // The tests above set the flag through noteConsoleLocked, because the
    // Tauri listeners never register under jsdom (isTauri() is false). So pin
    // the wiring in the source: without it the share gate reads "unlocked"
    // forever and every test above still passes.
    const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'devices', 'session.ts'), 'utf8',
    ).replace(/\r/g, '');
    const listener = (event: string): string => {
        const at = src.indexOf(`listen('${event}'`);
        expect(at, `session.ts listens for ${event}`).toBeGreaterThan(0);
        return src.slice(at, src.indexOf('});', at));
    };

    it('a lock event sets it', () => {
        expect(listener('system-suspend-or-lock')).toContain('noteConsoleLocked(true)');
    });

    it('the unlock event clears it', () => {
        expect(listener('system-session-unlock')).toContain('noteConsoleLocked(false)');
    });
});

describe('a restart after the stream is gone keeps the quality the viewer chose', () => {
    type Opts = { fps?: number; bitrateKbps?: number };
    const restartOpts = (): Opts => (agentAnswerOffer.mock.calls.at(-1) as [string, string, number | null, Opts])[3];

    it('falls back to the last ACKNOWLEDGED quality when the dead stream cannot be asked', async () => {
        const key = await streamingSession();
        await signal(key, { kind: 'update-stream', fps: 60, bitrate: 10_000 });
        expect(updateStream, 'the premise: the change was applied').toHaveBeenCalledWith('ds-test', 60, 10_000);

        // The agent answering now is a replacement: it has no stream to ask.
        getStreamQuality.mockRejectedValue(new Error('no live stream for that session'));
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(agentAnswerOffer).toHaveBeenCalledTimes(2);
        expect(restartOpts()).toMatchObject({ fps: 60, bitrateKbps: 10_000 });

        // What the restart started at is itself acknowledged: a second loss
        // before anyone touches the setting keeps it too.
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(restartOpts()).toMatchObject({ fps: 60, bitrateKbps: 10_000 });
    });

    it('POSITIVE CONTROL: a live stream\'s own answer still wins over the cache', async () => {
        const key = await streamingSession();
        await signal(key, { kind: 'update-stream', fps: 60, bitrate: 10_000 });
        getStreamQuality.mockResolvedValue({ fps: 15, bitrate_kbps: 3_000 });
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(restartOpts()).toMatchObject({ fps: 15, bitrateKbps: 3_000 });
    });

    it('a partial update keeps the other rate at what the stream was running', async () => {
        const key = await streamingSession();
        await signal(key, { kind: 'update-stream', fps: 15 });
        getStreamQuality.mockRejectedValue(new Error('no live stream for that session'));
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        const opts = restartOpts();
        expect(opts.fps).toBe(15);
        expect(opts.bitrateKbps, 'never changed: the agent default it had').toBeUndefined();
    });

    it('nothing ever changed: the restart starts at the defaults the stream had', async () => {
        const key = await streamingSession();
        getStreamQuality.mockRejectedValue(new Error('no live stream for that session'));
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        const opts = restartOpts();
        expect(opts.fps).toBeUndefined();
        expect(opts.bitrateKbps).toBeUndefined();
    });
});
