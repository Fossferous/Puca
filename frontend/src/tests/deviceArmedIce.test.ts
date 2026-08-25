/**
 * An ARMED host must not lose the controller's ICE candidates while it waits
 * for the unattended passphrase.
 *
 * THE BUG THIS PINS. On the agent transport the agent owns the peer connection,
 * so trickled candidates are forwarded to it over the pipe. But an armed host
 * HOLDS the offer until the passphrase is proved, which means `start_stream`
 * has not run and the agent has no stream to attach them to — it answers "no
 * such stream", the candidate is dropped, and the browser never sends it again.
 * When the passphrase finally lands, the stream starts with ZERO remote
 * candidates and ICE can only ever reach `Checking`.
 *
 * Observed exactly that way: unarmed sessions worked, armed ones sat on
 * "Waiting for the device's screen…" forever, and agent.log showed
 * `ice state -> Checking` under a rising `frames sent` count.
 *
 * So the assertion is about ORDER, not about "was it called". Delivering a
 * candidate before the stream exists is indistinguishable from delivering it
 * correctly if you only count calls — and that is the shape of test this
 * codebase keeps producing, one that cannot go red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// THE AGENT transport: startSession returns 'agent-pc', which is what makes
// session.ts leave s.pc null and route candidates over the pipe.
/** What this host reports it can show. Multi-monitor by default, because the
 *  screen switcher only exists above one. */
let hostMonitors: { id: number; label: string }[] = [
    { id: 0, label: 'Main display (2560x1440)' },
    { id: 1, label: 'Display 2 (1440x2560)' },
    { id: 2, label: 'Display 3 (1440x2560)' },
];
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'agent',
        async capabilities() {
            // The COUNT, not the full list: session.ts's every-screen default
            // now reads `capabilities().monitors.length` rather than a fresh
            // `listMonitors()` call (see the comment there — the real
            // Response::Capabilities.monitors is a bare usize, and this mock
            // must stay coupled to `hostMonitors` for the same reason a real
            // agent's two replies agree: they answer from the same
            // enumeration).
            return {
                capture: true, unattended: true, input: true, elevated: false,
                clipboard: false, files: false,
                monitors: hostMonitors.map(m => ({ id: m.id, label: m.label, width: 0, height: 0, primary: m.id === 0 })),
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => hostMonitors,
        setMonitor: async () => {},
        injectEvent: async () => {},
    }),
}));

/** Every agent call, in order. The order is the whole point. */
const calls: string[] = [];
const agentAnswerOffer = vi.fn(async () => {
    calls.push('start_stream');
    return 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n';
});
const agentAddRemoteCandidate = vi.fn(async (_sid: string, line: string) => {
    calls.push(`candidate:${line}`);
});
vi.mock('../api/devices/hostAgent', () => ({
    agentAnswerOffer: (...a: unknown[]) => agentAnswerOffer(...(a as [])),
    agentAddRemoteCandidate: (sid: string, line: string) => agentAddRemoteCandidate(sid, line),
}));

vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/devices/deviceKey', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/devices/index', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/hostConsent', () => ({ requestHostConsent: async () => ({ monitor: 0 }) }));

let armed = true;
const verifyUaResponse = vi.fn(async () => true);
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => (armed ? { nonce: btoa('nonce-abc'), salt: btoa('salt-abc') } : null),
    verifyUaResponse: () => verifyUaResponse(),
    unattendedState: async () => ({ armed }),
}));

import { sealControl } from '../api/e2ee';

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

let peerSigSeq = 0;

async function activeHostSession(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, activeSessions, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    peerSigSeq = 0;
    calls.length = 0;

    const eph = (await import('../api/e2ee')).generateControlEphemeral();
    handlers.get('DeviceConnectRequested')!({
        payload: { session_id: 'ds-test', from_device: 'dev-peer', eph: eph.pubEncoded },
    });
    await settle();

    const s = activeSessions().find(x => x.id === 'ds-test');
    expect(s, 'host session should exist').toBeTruthy();
    // Without this the tests below pass vacuously against a session that never
    // got far enough to forward anything.
    expect(s!.phase, 'harness must reach an ACTIVE host session').toBe('active');

    const accepted = sent.find(m => m.type === 'DeviceConnectResponse') as
        { payload?: { accepted?: boolean; eph?: string } } | undefined;
    expect(accepted?.payload?.accepted, 'host must have accepted').toBe(true);
    const { deriveDeviceControlKey } = await import('../api/e2ee');
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), eph.priv, accepted!.payload!.eph!);
    expect(key).not.toBeNull();
    return { id: 'ds-test', key: key! };
}

async function signal(key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: 'ds-test', n: peerSigSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: 'ds-test', payload: sealed } });
    await settle();
}

const CAND = {
    candidate: 'candidate:1 1 udp 1677729535 203.0.113.44 54321 typ srflx',
    sdpMid: '0',
    sdpMLineIndex: 0,
};

beforeEach(() => {
    armed = true;
    calls.length = 0;
    agentAnswerOffer.mockClear();
    agentAddRemoteCandidate.mockClear();
    verifyUaResponse.mockClear();
    verifyUaResponse.mockImplementation(async () => true);
});

describe('armed host + agent transport: trickled ICE', () => {
    it('holds candidates that arrive before the passphrase, then delivers them', async () => {
        const { key } = await activeHostSession();

        // The controller offers and trickles immediately — it has no idea the
        // host is going to sit on the offer waiting for a human to type.
        await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
        await signal(key, { kind: 'ice', candidate: CAND });

        // THE HELD STATE. Nothing may have reached the agent yet: there is no
        // stream to attach a candidate to, and forwarding one here is exactly
        // the bug — it is answered "no such stream" and lost for good.
        expect(agentAnswerOffer, 'the offer must be HELD until the passphrase').not.toHaveBeenCalled();
        expect(calls, 'nothing may reach the agent before the passphrase').toEqual([]);

        // Passphrase proved.
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('sig') });
        await settle();

        // Now the stream starts AND the held candidate is delivered — in that
        // order. Reversed, the agent would have refused it.
        expect(calls[0], 'the stream must be created first').toBe('start_stream');
        expect(calls).toContain(`candidate:${CAND.candidate}`);
        expect(
            calls.indexOf(`candidate:${CAND.candidate}`),
            'the candidate must arrive AFTER start_stream, or the agent refuses it',
        ).toBeGreaterThan(calls.indexOf('start_stream'));
    });

    /**
     * POSITIVE CONTROL. Proves the rig can actually observe a candidate
     * reaching the agent, so the ordering assertion above is measuring
     * something. Unarmed, the offer is answered immediately, so a candidate
     * that follows it goes straight through.
     */
    it('unarmed: a candidate after the answer reaches the agent directly', async () => {
        armed = false;
        const { key } = await activeHostSession();

        await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
        expect(agentAnswerOffer, 'an unarmed host answers at once').toHaveBeenCalled();

        await signal(key, { kind: 'ice', candidate: CAND });
        expect(calls).toEqual(['start_stream', `candidate:${CAND.candidate}`]);
    });

    /** A candidate for a session that never got an offer must not be forwarded
     *  to a stream that does not exist. */
    it('does not forward a candidate when no offer has been answered', async () => {
        const { key } = await activeHostSession();
        await signal(key, { kind: 'ice', candidate: CAND });
        expect(agentAddRemoteCandidate).not.toHaveBeenCalled();
    });
});

/**
 * An ARMED host must still offer its screen switcher — once the passphrase is
 * proved, and not a moment before.
 *
 * The list of screens is withheld from an unauthenticated controller on purpose:
 * the labels are this machine's display names. But the only code that sent it
 * sat behind that same check with nothing to run afterwards, so on an armed host
 * it was never sent at all — leaving every armed multi-monitor session with no
 * way to change screens, which is the configuration that needs one most.
 */
describe('armed host: the screen list', () => {
    /** The monitor list the host sealed and sent, if any. */
    async function monitorsSignal(key: Uint8Array): Promise<Record<string, unknown> | null> {
        const { openControl } = await import('../api/e2ee');
        for (const m of sent) {
            if (m.type !== 'DeviceSignal') continue;
            const plain = await openControl(key, m.payload!.payload as string);
            if (!plain) continue;
            const obj = JSON.parse(plain) as Record<string, unknown>;
            if (obj.kind === 'monitors') return obj;
        }
        return null;
    }

    it('is withheld until the passphrase is proved, then sent', async () => {
        const { key } = await activeHostSession();

        expect(
            await monitorsSignal(key),
            'an unauthenticated controller must not be told this machine\'s displays',
        ).toBeNull();

        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('sig') });
        await settle();

        const announced = await monitorsSignal(key);
        expect(announced, 'proving the passphrase must release the screen list').toBeTruthy();
        expect((announced!.monitors as { id: number }[]).map(m => m.id)).toEqual([0, 1, 2]);
    });

    /** POSITIVE CONTROL: the same rig sees an UNARMED host announce, so the
     *  "withheld" assertion above is measuring something real. */
    it('unarmed: the screen list is sent without any passphrase', async () => {
        armed = false;
        const { key } = await activeHostSession();
        await settle();
        expect(await monitorsSignal(key)).toBeTruthy();
    });

    it('is not sent at all when there is only one screen', async () => {
        armed = false;
        hostMonitors = [{ id: 0, label: 'Main display' }];
        try {
            const { key } = await activeHostSession();
            await settle();
            expect(await monitorsSignal(key), 'one screen needs no switcher').toBeNull();
        } finally {
            hostMonitors = [
                { id: 0, label: 'Main display (2560x1440)' },
                { id: 1, label: 'Display 2 (1440x2560)' },
                { id: 2, label: 'Display 3 (1440x2560)' },
            ];
        }
    });
});

/**
 * EVERY SCREEN BY DEFAULT — the host's half, on the rig that already plays an
 * ARMED agent host with three screens. Nobody at an armed machine is asked, so
 * until this change `s.monitor` stayed null and resolved to output 0 all the
 * way down; now the composite (255) is the starting screen, the agent is told
 * so at start_stream, the viewer is told so in the screen list — and if the
 * agent refuses the composite (it reserves EVERY output; one held elsewhere
 * refuses the whole start), the host falls back to output 0 and corrects what
 * it announced. Each "is 255" has a sibling where it must NOT be.
 */
describe('armed host: every screen by default', () => {
    async function findSignal(key: Uint8Array, kind: string): Promise<Record<string, unknown> | null> {
        const { openControl } = await import('../api/e2ee');
        for (const m of sent) {
            if (m.type !== 'DeviceSignal') continue;
            const plain = await openControl(key, m.payload!.payload as string);
            if (!plain) continue;
            const obj = JSON.parse(plain) as Record<string, unknown>;
            if (obj.kind === kind) return obj;
        }
        return null;
    }
    /** The `monitor` argument start_stream was given, per call. */
    const startedOn = () => agentAnswerOffer.mock.calls.map(c => (c as unknown as [string, string, number | null])[2]);

    it('starts the stream on the composite and announces active: 255', async () => {
        const { key } = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('sig') });
        await settle();
        expect(startedOn(), 'the agent is asked for the composite, not output 0').toEqual([255]);
        const announced = await findSignal(key, 'monitors');
        expect(announced?.active, 'and the viewer is told that is what it is getting').toBe(255);
    });

    it('one screen: output 0 exactly as before (the composite of one is pointless)', async () => {
        hostMonitors = [{ id: 0, label: 'Main display' }];
        try {
            const { key } = await activeHostSession();
            await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
            await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('sig') });
            await settle();
            // null here: hostAgent's own `monitor ?? 0` is behind the mock.
            expect(startedOn()).toEqual([null]);
        } finally {
            hostMonitors = [
                { id: 0, label: 'Main display (2560x1440)' },
                { id: 1, label: 'Display 2 (1440x2560)' },
                { id: 2, label: 'Display 3 (1440x2560)' },
            ];
        }
    });

    it('attended: the screen the person picked is NOT replaced by the default', async () => {
        // The consent mock answers {monitor: 0} — a person chose Display 1.
        armed = false;
        const { key } = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
        await settle();
        expect(startedOn()).toEqual([0]);
        expect((await findSignal(key, 'monitors'))?.active).toBe(0);
    });

    it('falls back to output 0 when the agent refuses the composite, and corrects the announcement', async () => {
        agentAnswerOffer.mockImplementationOnce(async () => {
            calls.push('start_stream:refused');
            throw new Error('that monitor is already reserved by another streaming session');
        });
        const { key } = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
        await signal(key, { kind: 'ua-response', nonce: btoa('nonce-abc'), sig: btoa('sig') });
        await settle();
        expect(startedOn(), 'composite refused → first screen, once').toEqual([255, 0]);
        // The screen list went out saying 255 (it precedes the answer); the
        // correction is what a confirmed switch sends, so every viewer-side
        // consumer of `activeMonitor` learns the truth.
        expect((await findSignal(key, 'monitors'))?.active).toBe(255);
        expect((await findSignal(key, 'monitor-active'))?.active).toBe(0);
        const { activeSessions } = await import('../api/devices/session');
        expect(activeSessions().find(x => x.id === 'ds-test')?.phase, 'the session survives').toBe('active');
    });

    it('POSITIVE CONTROL: a refusal of a screen a PERSON picked is not papered over', async () => {
        armed = false;   // consent → {monitor: 0}, chosen by a person
        agentAnswerOffer.mockImplementationOnce(async () => {
            throw new Error('that monitor is already reserved by another streaming session');
        });
        const { key } = await activeHostSession();
        await signal(key, { kind: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' });
        await settle();
        expect(startedOn(), 'no silent second attempt on a different screen').toEqual([0]);
        expect(await findSignal(key, 'monitor-active')).toBeNull();
    });
});
