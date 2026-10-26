// @vitest-environment jsdom
/**
 * NO SCREEN ON THIS PC — the HOST half.
 *
 * A laptop with its lid shut has nothing for the agent to capture. The host
 * used to hand the agent the offer anyway; the agent answered, its capture
 * failed seconds later on a thread that had serviced no ICE, and the phone
 * could only say "could not connect to the device". Now the host asks the
 * agent first (`prepare_screen`, session.ts `prepareHostScreen`):
 *  - `ready` answers the offer, exactly as before;
 *  - `starting` tells the phone ONCE that a virtual screen is starting, and
 *    keeps asking;
 *  - `off` ends the session with the agent's code, and never starts a stream.
 *
 * The rig is deviceAgentReplaced.test.ts's (its header lists the traps). Every
 * "never answered" here is next to a case in the same rig that answers.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// What the agent's status poll answers. Default: an old agent's (no
// stream_live), so the 1 Hz poll never acts.
type Status = { secureDesktop: boolean; cursorClipped: boolean; streamLive?: boolean; streamEnd?: string; monitor?: number };
let status: Status = { secureDesktop: false, cursorClipped: false };
const sessionStatus = vi.fn(async (..._a: unknown[]): Promise<Status> => ({ ...status }));
/** The screens the agent lists (announceMonitors), and the one the person
 *  here picks in the consent prompt (255 = All displays). */
let monitorList: Array<{ id: number; label: string; width: number; height: number; primary: boolean; left: number; top: number }> = [];
let consentPick = 0;
const setMonitor = vi.fn(async (..._a: unknown[]) => {});
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
        listMonitors: async () => monitorList.map(m => ({ ...m })),
        setMonitor: (...a: unknown[]) => setMonitor(...a),
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
/** What the agent says about its screen, one answer per poll; the last
 *  repeats. Default: a screen is there. */
let screens: Array<Record<string, unknown>> = [{ state: 'ready' }];
let steeredTo: number | null = null;
const agentPrepareScreen = vi.fn(async (..._a: unknown[]) => (screens.length > 1 ? screens.shift()! : screens[0]));
vi.mock('../api/devices/hostAgent', () => ({
    agentPrepareScreen: (...a: unknown[]) => agentPrepareScreen(...a),
    // The screen the agent steered to, or null for "as asked".
    agentSteeredMonitor: () => steeredTo,
    agentAnswerOffer: (...a: unknown[]) => agentAnswerOffer(...a),
}));
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
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: consentPick }) }));
// UNARMED, in every test: see the header.
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl } from '../api/e2ee';
import { noScreenEndReason } from '../api/devices/noScreen';

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


beforeEach(() => {
    shareCaps = null;
    screens = [{ state: 'ready' }];
    steeredTo = null;
    status = { secureDesktop: false, cursorClipped: false };
    monitorList = [];
    consentPick = 0;
    sessionStatus.mockClear();
    setMonitor.mockClear();
    agentPrepareScreen.mockClear();
    agentAnswerOffer.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

async function sentOf(type: string): Promise<Array<{ type: string; payload?: Record<string, unknown> }>> {
    return (sent as Array<{ type: string; payload?: Record<string, unknown> }>).filter(m => m.type === type);
}

describe('the host asks for a screen before it answers', () => {
    it('POSITIVE CONTROL: a PC with a screen answers the offer at once', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentPrepareScreen).toHaveBeenCalledTimes(1);
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
        expect(await sentKinds(key, 0)).not.toContain('screen-state');
    });

    it('no screen and no virtual screen: ends with the lid code and starts no stream', async () => {
        consentPick = 255;
        screens = [{ state: 'off', reason: 'no-screen:lid' }];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentAnswerOffer, 'no stream for a PC with nothing to show').not.toHaveBeenCalled();
        const ends = await sentOf('DeviceEnd');
        // The code first, then a sentence an older phone can show as it is.
        expect(ends.map(e => e.payload?.reason)).toEqual([noScreenEndReason('no-screen:lid')]);
        const { activeSessions } = sessionMod;
        expect(activeSessions().find(s => s.id === 'ds-test')?.phase ?? 'ended').toBe('ended');
    });

    it('one screen shared and none on at the start: said as the shared screen, not "turn on the lid option"', async () => {
        consentPick = 0;
        screens = [{ state: 'off', reason: 'no-screen:lid' }];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentAnswerOffer).not.toHaveBeenCalled();
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason))
            .toEqual([noScreenEndReason('no-screen:shared-off')]);
    });

    it('a virtual screen starting: the phone is told ONCE, then the offer is answered', async () => {
        screens = [{ state: 'waking' }, { state: 'starting' }, { state: 'starting' }, { state: 'ready' }];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        // Four polls, 500 ms apart, on real timers. Waited out until the
        // ANSWER has gone, not merely until the agent was asked: the answer
        // is sealed and sent a few macrotasks later, and a loaded machine
        // used to fail the order check below with no answer in the list.
        let kinds: string[] = [];
        for (let i = 0; i < 60 && !kinds.includes('answer'); i++) {
            await new Promise(r => setTimeout(r, 100));
            await settle(2);
            kinds = await sentKinds(key, 0);
        }
        expect(agentPrepareScreen).toHaveBeenCalledTimes(4);
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
        expect(kinds.filter(k => k === 'screen-state')).toHaveLength(1);
        // Said BEFORE the answer: the phone's wait-for-video clock restarts on it.
        expect(kinds.indexOf('screen-state')).toBeLessThan(kinds.indexOf('answer'));
        expect(await sentOf('DeviceEnd')).toHaveLength(0);
    }, 15_000);

    it('a files-only session never asks: it opens no screen', async () => {
        screens = [{ state: 'off', reason: 'no-screen:lid' }];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: FILES_OFFER, filesOnly: true });
        expect(agentPrepareScreen).not.toHaveBeenCalled();
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
    });

    it('an agent that never makes up its mind is ended with the virtual-screen code, not waited on for ever', async () => {
        screens = [{ state: 'starting' }];
        let t = 1_900_000_000_000;
        const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => t);
        try {
            const key = await activeHostSession();
            await signal(key, { kind: 'offer', sdp: OFFER });
            t += 25_000; // past HOST_SCREEN_PREP_CEILING_MS
            for (let i = 0; i < 20 && (await sentOf('DeviceEnd')).length === 0; i++) {
                await new Promise(r => setTimeout(r, 100));
                await settle(2);
            }
            expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason))
                .toEqual([noScreenEndReason('no-screen:virtual-failed')]);
            expect(agentAnswerOffer).not.toHaveBeenCalled();
        } finally {
            dateSpy.mockRestore();
        }
    }, 15_000);
});


describe('the screen the agent really captures', () => {
    it('a stream steered off the dark panel tells the viewer which screen it got', async () => {
        // All displays: every screen was shared, so the steer is followed.
        consentPick = 255;
        steeredTo = 1;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        const { openControl } = await import('../api/e2ee');
        const actives: number[] = [];
        for (const m of sent) {
            const blob = (m as { payload?: { payload?: string } }).payload?.payload;
            if (!blob) continue;
            const plain = await openControl(key, blob);
            const f = plain ? (JSON.parse(plain) as { kind?: string; active?: number }) : null;
            if (f?.kind === 'monitor-active' && typeof f.active === 'number') actives.push(f.active);
        }
        expect(actives).toEqual([1]);
    });

    it('NEGATIVE CONTROL: a stream on the screen it asked for sends no monitor-active', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(await sentKinds(key, 0)).not.toContain('monitor-active');
    });

    // REVIEW 2026-10-26, HIGH: an agent from before `steer_on_lid` steers off
    // a dark panel to the FIRST lit screen whatever it is told, and that can
    // be the external monitor a person here chose not to share.
    it('a steer to a screen the person here did NOT share is never answered: the session ends saying why', async () => {
        consentPick = 0;          // they shared the built-in panel only
        steeredTo = 1;            // the agent went to the external monitor anyway
        const key = await activeHostSession();
        stopSession.mockClear();  // the rig's reset stops the previous test's
        await signal(key, { kind: 'offer', sdp: OFFER });
        const kinds = await sentKinds(key, 0);
        expect(kinds, 'no answer: no picture of that screen ever reaches the viewer').not.toContain('answer');
        expect(kinds, 'and the viewer is not pointed at it').not.toContain('monitor-active');
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason))
            .toEqual([noScreenEndReason('no-screen:shared-off')]);
        expect(stopSession, 'the stream the agent started is stopped').toHaveBeenCalledWith('ds-test');
    });

    it('the agent is let follow a lid to another screen ONLY when every screen was shared', async () => {
        consentPick = 255;
        await signal(await activeHostSession(), { kind: 'offer', sdp: OFFER });
        expect((agentAnswerOffer.mock.calls[0][3] as { steerOnLid?: boolean }).steerOnLid, 'All displays').toBe(true);

        agentAnswerOffer.mockClear();
        consentPick = 0;
        await signal(await activeHostSession(), { kind: 'offer', sdp: OFFER });
        expect((agentAnswerOffer.mock.calls[0][3] as { steerOnLid?: boolean }).steerOnLid, 'one screen').toBe(false);
    });
});

describe('a stream that never produced a picture', () => {
    it('ends the session with the no-frame reason instead of leaving the phone to time out', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
        status = { secureDesktop: false, cursorClipped: false, streamLive: false, streamEnd: 'no_frame' };
        await sessionMod.pollSecureDesktop();
        await settle();
        const ends = (await sentOf('DeviceEnd')).map(e => e.payload?.reason);
        expect(ends).toEqual([noScreenEndReason('no-screen:no-frame')]);
        // ...and it is not ALSO restarted: a restart cannot wake a dark screen.
        expect(await sentKinds(key, 0)).not.toContain('stream-died');
    });

    it('NEGATIVE CONTROL: a stream that died for another reason is restarted, not ended', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: false };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await sentOf('DeviceEnd')).toHaveLength(0);
        expect(await sentKinds(key, 0)).toContain('stream-died');
    });
});

/** Every sealed frame this host sent from `from` on, opened. */
async function sentFrames(key: Uint8Array, from = 0): Promise<Array<Record<string, unknown>>> {
    const { openControl } = await import('../api/e2ee');
    const out: Array<Record<string, unknown>> = [];
    for (const m of sent.slice(from)) {
        const blob = m.payload?.payload;
        if (!blob) continue;
        const plain = await openControl(key, blob);
        if (plain) out.push(JSON.parse(plain) as Record<string, unknown>);
    }
    return out;
}
const actives = async (key: Uint8Array, from = 0) =>
    (await sentFrames(key, from)).filter(f => f.kind === 'monitor-active').map(f => f.active);

describe('a lid shut DURING a session (the agent follows it, 2026-10-26)', () => {
    it('nowhere to move the picture: ends with the lid code, and is not restarted', async () => {
        consentPick = 255;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: false, streamEnd: 'no-screen:lid' };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason)).toEqual([noScreenEndReason('no-screen:lid')]);
        expect(await sentKinds(key, 0), 'a restart cannot open a lid').not.toContain('stream-died');
    });

    it('a person here who shared ONE screen: the lid end says the shared screen went dark, not "turn on the lid option"', async () => {
        consentPick = 0;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        // Not let follow the lid (steer_on_lid false), the agent ends the
        // stream with the lid code when that screen goes dark.
        status = { secureDesktop: false, cursorClipped: false, streamLive: false, streamEnd: 'no-screen:lid' };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason))
            .toEqual([noScreenEndReason('no-screen:shared-off')]);
        expect(await sentKinds(key, 0)).not.toContain('stream-died');
    });

    it('a pinned stream whose capture showed another screen: ends with no-screen:changed, and is not restarted', async () => {
        consentPick = 0;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        // Windows renumbered the screens under a stream pinned to the one
        // shared: the agent sent nothing of the other and ended it.
        status = { secureDesktop: false, cursorClipped: false, streamLive: false, streamEnd: 'no-screen:changed' };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason))
            .toEqual([noScreenEndReason('no-screen:changed')]);
        expect(await sentKinds(key, 0), 'a restart by index could land on a screen nobody shared').not.toContain('stream-died');
    });

    it('the virtual screen it moved to never came: ends with that code', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: false, streamEnd: 'no-screen:virtual-failed' };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason)).toEqual([noScreenEndReason('no-screen:virtual-failed')]);
        expect(await sentKinds(key, 0)).not.toContain('stream-died');
    });

    it('NEGATIVE CONTROL: an end code nobody here knows is still restarted, not named', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: false, streamEnd: 'no-screen:something-new' };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await sentOf('DeviceEnd')).toHaveLength(0);
        expect(await sentKinds(key, 0)).toContain('stream-died');
    });

    it('the agent moved the picture to another screen: the viewer is told, once, with the new layout', async () => {
        consentPick = 255;
        monitorList = [
            { id: 0, label: 'Built-in display', width: 1920, height: 1080, primary: true, left: 0, top: 0 },
            { id: 1, label: 'Virtual display', width: 1920, height: 1080, primary: false, left: 1920, top: 0 },
        ];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        const from = sent.length;
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 1 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, from)).toEqual([1]);
        const lists = (await sentFrames(key, from)).filter(f => f.kind === 'monitors');
        expect(lists, 'and the layout it is now in').toHaveLength(1);
        expect(lists[0].active).toBe(1);
        // Said once: the next poll with the same answer says nothing.
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, from)).toEqual([1]);
        // The lid opens and the picture comes back: told again.
        status = { ...status, monitor: 0 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, from)).toEqual([1, 0]);
    });

    it('NEGATIVE CONTROL: the screen the viewer was told sends nothing', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        // The person here picked screen 0, and the stream is on it.
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 0 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await sentKinds(key, 0)).not.toContain('monitor-active');
    });

    it('NEGATIVE CONTROL: an agent that does not say (an older one) changes nothing', async () => {
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: true };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await sentKinds(key, 0)).not.toContain('monitor-active');
    });

    // REVIEW 2026-10-26, HIGH. This test used to say the viewer was told
    // `monitor-active 1` here and call that fine, with screen 1 named
    // "Virtual display", which made a leak look harmless: the agent's rule is
    // the FIRST lit screen, and on a laptop at a desk that is the external
    // monitor the person here chose not to share.
    it('a person here who shared ONE screen: a picture moved off it ends the session, never follows', async () => {
        consentPick = 0;
        monitorList = [
            { id: 0, label: 'Built-in display', width: 1920, height: 1080, primary: true, left: 0, top: 0 },
            { id: 1, label: 'External monitor', width: 2560, height: 1440, primary: false, left: 1920, top: 0 },
        ];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        stopSession.mockClear();
        const from = sent.length;
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 1 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, from), 'the viewer is not pointed at the other screen').toEqual([]);
        expect((await sentFrames(key, from)).filter(f => f.kind === 'monitors')).toHaveLength(0);
        expect((await sentOf('DeviceEnd')).map(e => e.payload?.reason))
            .toEqual([noScreenEndReason('no-screen:shared-off')]);
        expect(stopSession, 'and that picture stops leaving').toHaveBeenCalledWith('ds-test');
    });

    it('NEGATIVE CONTROL: the screen they shared, still shown, ends nothing', async () => {
        consentPick = 1;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 1 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await sentOf('DeviceEnd')).toHaveLength(0);
        expect(await sentKinds(key, 0)).not.toContain('monitor-active');
    });

    // REVIEW 2026-10-26: `monitor` used to take the screen a lid moved the
    // picture to, so a media restart ASKED for that screen. An explicit ask
    // is one the agent keeps, so the picture never came back when the lid
    // opened.
    it('a restart asks for the screen that was asked for, not the one a lid moved the picture to', async () => {
        consentPick = 255;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        expect(agentAnswerOffer.mock.calls[0][2]).toBe(255);
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 1 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, 0), 'premise: the viewer was told about the move').toEqual([1]);
        await signal(key, { kind: 'restart-offer', sdp: OFFER });
        expect(agentAnswerOffer).toHaveBeenCalledTimes(2);
        expect(agentAnswerOffer.mock.calls[1][2], 'All displays, as asked').toBe(255);
    });

    // REVIEW 2026-10-26: told once, then never again, even if the frame was
    // lost: `monitor` was updated whether or not the viewer heard.
    it('a move the viewer may have missed in a relay interruption is said again when the relay is back', async () => {
        consentPick = 255;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 1 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, 0)).toEqual([1]);
        // The viewer's side of the relay drops: whatever went out around it
        // may not have arrived.
        handlers.get('DevicePeerReconnecting')!({ payload: { session_id: 'ds-test' } });
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, 0), 'nothing is sent into a dropped relay').toEqual([1]);
        handlers.get('DevicePeerReconnected')!({ payload: { session_id: 'ds-test' } });
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, 0), 'said again').toEqual([1, 1]);
        // And once: the next poll is quiet again.
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, 0)).toEqual([1, 1]);
    });

    it('a switch the viewer asked for, committed while the poll waited, is not undone by the older answer', async () => {
        consentPick = 255;
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        const from = sent.length;
        // The poll asks; the agent's answer is the screen BEFORE the switch.
        let answer: (s: Status) => void = () => { /* set below */ };
        sessionStatus.mockImplementationOnce(() => new Promise<Status>(r => { answer = r; }));
        const polling = sessionMod.pollSecureDesktop();
        await settle();
        await signal(key, { kind: 'set-monitor', monitor: 1 });
        expect(setMonitor, 'the switch went to the agent').toHaveBeenCalled();
        answer({ secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 255 });
        await polling;
        await settle();
        expect(await actives(key, from), 'the switch, and nothing after it').toEqual([1]);
        // CONTROL: the next poll, with the agent now on the new screen, is quiet.
        status = { secureDesktop: false, cursorClipped: false, streamLive: true, monitor: 1 };
        await sessionMod.pollSecureDesktop();
        await settle();
        expect(await actives(key, from)).toEqual([1]);
    });
});
