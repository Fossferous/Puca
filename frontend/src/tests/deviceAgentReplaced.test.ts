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
        injectEvent: async () => {},
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
const OFFER = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n';
const FILES_OFFER = 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';

async function activeHostSession(): Promise<Uint8Array> {
    const { installDeviceSessions, activeSessions, endAllSessions } = sessionMod;
    installDeviceSessions();
    endAllSessions('test reset');
    await settle();
    sent.length = 0;
    peerSigSeq = 0;

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
    sessionMod?.noteConsoleLocked(false);
    // Time moves only when a test moves it — and only through Date.
    now = 1_900_000_000_000;
    dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
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
        const before = sent.length;
        status = { ...status, streamLive: true };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before)).toBe(0);
    });

    it('an agent that predates the field (streamLive undefined) sends nothing', async () => {
        const key = await streamingSession();
        const before = sent.length;
        status = { secureDesktop: false, cursorClipped: false, streamLive: undefined };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'absence is "cannot tell", never "gone"').toBe(0);
    });

    it('a dead pipe (the catch shape: no streamLive key at all) sends nothing', async () => {
        const key = await streamingSession();
        const before = sent.length;
        status = { secureDesktop: false, cursorClipped: false };
        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before)).toBe(0);
    });

    it('nothing is reported before this host has started a stream — and it is, once it has', async () => {
        const key = await activeHostSession();
        const before = sent.length;
        status = { ...status, streamLive: false };

        await poll();
        expect(sessionStatus, 'the poll ran for this session').toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'no stream yet, nothing to have died').toBe(0);

        // Same session, same answer, stream now started: the control.
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
        const mid = sent.length;
        await poll();
        expect(await streamDiedSince(key, mid)).toBe(1);
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

        const before = sent.length;
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

    it('a files-only session is never reported', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: FILES_OFFER, filesOnly: true });
        expect(agentAnswerOffer, 'the premise: the files session started a (data-only) stream').toHaveBeenCalledTimes(1);
        const before = sent.length;
        status = { ...status, streamLive: false };
        await poll();
        expect(await streamDiedSince(key, before)).toBe(0);
    });

    it('a stream that never produced a frame stays with the viewer\'s own message', async () => {
        const key = await streamingSession();
        const before = sent.length;
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
        const before = sent.length;
        status = { ...status, streamLive: false };

        await poll();
        expect(sessionStatus).toHaveBeenCalled();
        expect(await streamDiedSince(key, before), 'a restart now would show the friend the sign-in screen').toBe(0);

        // And at unlock it IS: the share recovers onto the owner's own agent.
        sessionMod.noteConsoleLocked(false);
        await poll();
        expect(await streamDiedSince(key, before)).toBe(1);
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
