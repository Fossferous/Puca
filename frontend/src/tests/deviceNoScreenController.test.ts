// @vitest-environment jsdom
/**
 * "WORK LAPTOP'S SCREEN IS OFF" — the controller half.
 *
 * Before this, a laptop with its lid shut ended every remote-control attempt
 * in "could not connect to the device". The host now finds out first and
 * either ends the session with a code (noScreen.ts) or tells the phone it is
 * starting a virtual screen (`screen-state`). This file drives a REAL
 * controller session through both and reads what the stage would show.
 *
 * The same trust rule as the secure-desktop notice (secureDesktopNotice.test.ts,
 * whose rig this copies): `hostScreen` is only ever set because a HOST said so,
 * and a malformed or unknown notice changes nothing. Every "nothing happens"
 * here sits next to a case in the same rig where something does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../api/devices/deviceKeyRc', () => ({
    deviceKeyDh: async () => new Uint8Array(32).fill(3),
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/thisDevice', () => ({
    thisDeviceId: () => 'dev-me',
}));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'webview',
        async capabilities() {
            return {
                capture: true, unattended: false, input: true, elevated: false,
                clipboard: false, files: false, monitors: [],
            };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        injectEvent: async () => {},
        // NOTE: no sessionStatus — a webview host cannot tell, which is also
        // the shape the host-side poll must tolerate without throwing.
    }),
}));

/** jsdom has no RTCPeerConnection, and the controller builds a real one. */
class ControllerPc {
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    oniceconnectionstatechange: unknown = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel() {
        return { onopen: null, onclose: null, onmessage: null, readyState: 'connecting', close() {} };
    }
    addTransceiver() { return { receiver: { track: { onunmute: null, kind: 'video', stop() {} } } }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    async addIceCandidate() {}
    addTrack() { return {}; }
    close() {}
}
Object.defineProperty(window, 'RTCPeerConnection', {
    value: ControllerPc, configurable: true, writable: true,
});

import { sealControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';
import { noScreenEndReason } from '../api/devices/noScreen';

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

/** Drive a controller session to 'active', returning the key the HOST holds. */
async function activeController(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;

    const id = await connectToDevice('dev-host', { peerName: 'Work Laptop' });
    const connect = sent.find(m => m.type === 'DeviceConnect');
    const controllerEph = connect?.payload?.eph as string;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph);
    expect(key, 'the rig must agree a key').not.toBeNull();

    handlers.get('DeviceConnectAnswered')!({
        payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded },
    });
    await settle();
    return { id, key: key! };
}

/** Deliver one sealed signal frame as the host would. */
let peerSeq = 0;
async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: peerSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

function sessionById<T extends { id: string }>(list: readonly T[], id: string): T | undefined {
    return list.find(s => s.id === id);
}

beforeEach(() => { peerSeq = 0; });

/** Every snapshot subscribeSessions delivered, so the ENDED emit (which
 *  precedes the delete) can be read after the fact. */
async function endedErrorOf(id: string, run: () => Promise<void>): Promise<string | null | undefined> {
    const { subscribeSessions } = await import('../api/devices/session');
    let error: string | null | undefined;
    const off = subscribeSessions(list => {
        const s = list.find(x => x.id === id && x.phase === 'ended');
        if (s) error = s.error;
    });
    await run();
    off();
    return error;
}

describe('a session that ended because that PC has no screen on', () => {
    it('the lid code becomes the sentence that names the PC and the option', async () => {
        const { id } = await activeController();
        const error = await endedErrorOf(id, async () => {
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'no-screen:lid' } });
            await settle();
        });
        expect(error).toBe('Work Laptop’s screen is off — is its lid closed? '
            + 'Turn on “Allow remote control with the lid closed” on that PC.');
    });

    it('the virtual-screen code becomes its own sentence', async () => {
        const { id } = await activeController();
        const error = await endedErrorOf(id, async () => {
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'no-screen:virtual-failed' } });
            await settle();
        });
        expect(error).toMatch(/^Work Laptop’s screen is off, and its virtual screen did not start/);
    });

    it('a stream that never showed a picture becomes its own sentence, not "could not connect"', async () => {
        const { id } = await activeController();
        const error = await endedErrorOf(id, async () => {
            handlers.get('DeviceEnded')!({
                payload: { session_id: id, reason: noScreenEndReason('no-screen:no-frame') },
            });
            await settle();
        });
        expect(error).toMatch(/^Work Laptop’s screen did not show anything/);
    });

    it('NEGATIVE CONTROL: any other reason is shown as the host wrote it', async () => {
        const { id } = await activeController();
        const error = await endedErrorOf(id, async () => {
            handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: 'the person at that device declined' } });
            await settle();
        });
        expect(error).toBe('the person at that device declined');
    });
});

/**
 * REVIEW 2026-10-26: the [rc-connect] line for such an end was the sentence
 * itself, so it carried the PC's name into Send diagnostics, whose lines name
 * no device (connectLog.ts). Shown named; logged as the code.
 */
describe('a no-screen end in the [rc-connect] log', () => {
    async function endLine(run: () => Promise<void>): Promise<string> {
        const { recentRcConnectLines } = await import('../api/devices/connectLog');
        const before = recentRcConnectLines().at(-1) ?? null;
        await run();
        const all = recentRcConnectLines();
        const fresh = all.slice(before === null ? 0 : all.lastIndexOf(before) + 1);
        const ended = fresh.filter(l => / control ended /.test(l));
        expect(ended, 'there is a line to look at (not vacuous)').toHaveLength(1);
        return ended[0];
    }

    it('the host\'s code: shown with the name, logged as the code', async () => {
        const { id } = await activeController();
        let error: string | null | undefined;
        const line = await endLine(async () => {
            error = await endedErrorOf(id, async () => {
                handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: noScreenEndReason('no-screen:lid') } });
                await settle();
            });
        });
        expect(error, 'CONTROL: the screen names the PC').toMatch(/^Work Laptop’s screen is off/);
        expect(line).toContain(': no-screen:lid (');
        expect(line).not.toContain('Work Laptop');
    });

    it('the shared screen that changed: its own sentence on screen, its code in the log', async () => {
        const { id } = await activeController();
        let error: string | null | undefined;
        const line = await endLine(async () => {
            error = await endedErrorOf(id, async () => {
                handlers.get('DeviceEnded')!({ payload: { session_id: id, reason: noScreenEndReason('no-screen:changed') } });
                await settle();
            });
        });
        expect(error).toBe('Work Laptop’s shared screen changed or was turned off. Connect again to choose a screen.');
        expect(line).toContain(': no-screen:changed (');
        expect(line).not.toContain('Work Laptop');
    });

    it('the virtual screen that never came: shown with the name, logged as the code', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const { id, key } = await activeController();
            await hostSignal(id, key, { kind: 'screen-state', state: 'virtual-starting' });
            let error: string | null | undefined;
            const line = await endLine(async () => {
                error = await endedErrorOf(id, async () => {
                    await vi.advanceTimersByTimeAsync(31_000);
                    await settle();
                });
            });
            expect(error, 'CONTROL: the screen names the PC')
                .toMatch(/^Work Laptop’s screen is off, and its virtual screen did not start/);
            expect(line).toContain(': no-screen:virtual-failed (');
            expect(line).not.toContain('Work Laptop');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the host says it is starting its virtual screen', () => {
    it('POSITIVE CONTROL: the notice reaches the stage, with the name to say it with', async () => {
        const { id, key } = await activeController();
        const { activeSessions } = await import('../api/devices/session');
        expect(sessionById(activeSessions(), id)?.hostScreen, 'a fresh session has no notice').toBeNull();

        await hostSignal(id, key, { kind: 'screen-state', state: 'virtual-starting' });
        const s = sessionById(activeSessions(), id);
        expect(s?.hostScreen).toBe('virtual-starting');
        expect(s?.peerName, 'the stage names the PC from this').toBe('Work Laptop');
    });

    it('an unknown or malformed state changes nothing', async () => {
        const { id, key } = await activeController();
        const { activeSessions } = await import('../api/devices/session');
        await hostSignal(id, key, { kind: 'screen-state', state: 'on-fire' });
        await hostSignal(id, key, { kind: 'screen-state', state: true });
        await hostSignal(id, key, { kind: 'screen-state' });
        expect(sessionById(activeSessions(), id)?.hostScreen).toBeNull();
    });
});
