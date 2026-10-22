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

// An old agent's status: no stream_live, so the 1 Hz poll never acts.
const sessionStatus = vi.fn(async (..._a: unknown[]) => ({ secureDesktop: false, cursorClipped: false }));
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
/** What the agent says about its screen, one answer per poll; the last
 *  repeats. Default: a screen is there. */
let screens: Array<Record<string, unknown>> = [{ state: 'ready' }];
const agentPrepareScreen = vi.fn(async (..._a: unknown[]) => (screens.length > 1 ? screens.shift()! : screens[0]));
vi.mock('../api/devices/hostAgent', () => ({
    agentPrepareScreen: (...a: unknown[]) => agentPrepareScreen(...a),
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
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));
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

    it('a virtual screen starting: the phone is told ONCE, then the offer is answered', async () => {
        screens = [{ state: 'waking' }, { state: 'starting' }, { state: 'starting' }, { state: 'ready' }];
        const key = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: OFFER });
        // Four polls, 500 ms apart, on real timers.
        for (let i = 0; i < 40 && agentAnswerOffer.mock.calls.length === 0; i++) {
            await new Promise(r => setTimeout(r, 100));
            await settle(2);
        }
        expect(agentPrepareScreen).toHaveBeenCalledTimes(4);
        expect(agentAnswerOffer).toHaveBeenCalledTimes(1);
        const kinds = await sentKinds(key, 0);
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
