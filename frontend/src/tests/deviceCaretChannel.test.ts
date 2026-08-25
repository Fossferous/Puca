/**
 * THE CARET CHANNEL — the viewer half of the wire.
 *
 * The caret rides its own WebRTC data channel rather than the sealed signalling
 * path, because DeviceSignal shares the server's general 50/s rate bucket and
 * one strictly-increasing sequence with SDP and ICE: a 10Hz position stream
 * there would compete with negotiation and be dropped silently.
 *
 * Three things here have already been shipped as field bugs on the neighbouring
 * cursor-ownership path, and each has a test below:
 *  - a request made BEFORE the channel opens must be replayed, not dropped
 *    (0.8.51, found only on real hardware);
 *  - a media restart rebuilds the pc and therefore the channel, and the intent
 *    must survive it, or the feature dies silently after any network blip;
 *  - "typeof, not truthiness" on everything the peer sends.
 *
 * Every "does not arrive" assertion is paired with the valid frame that proves
 * the rig can deliver one.
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

vi.mock('../api/devices/deviceKey', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ fetchIceConfig: async () => ({ iceServers: [] }) }));
// async, unlike the cursorOwnership rig: restartMedia awaits closeTunnels and
// calls .catch on the result, so a void return would throw its way into a
// teardown and the restart test would be measuring the wrong thing.
vi.mock('../api/devices/tunnel', () => ({
    attachTunnelChannel: () => {}, closeTunnels: async () => {},
}));
vi.mock('../api/devices/index', () => ({ thisDeviceId: () => 'dev-me' }));
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
    }),
}));

/** A recording data channel: which label it was opened with, what was written to
 *  it, and the three handlers the session installs. */
interface FakeChannel {
    label: string;
    readyState: 'connecting' | 'open' | 'closed';
    sends: string[];
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onmessage: ((e: { data: unknown }) => void) | null;
    send: (d: string) => void;
    close: () => void;
}

const channels: FakeChannel[] = [];
/** Ordered log of the pc calls that matter for negotiation ordering. */
const pcCalls: string[] = [];

function caretChannels(): FakeChannel[] {
    return channels.filter(c => c.label === 'caret');
}
function caret(): FakeChannel {
    const all = caretChannels();
    expect(all.length, 'a caret channel must have been created at all').toBeGreaterThan(0);
    return all[all.length - 1];
}
function open(ch: FakeChannel): void {
    ch.readyState = 'open';
    ch.onopen?.();
}
function trackFrames(ch: FakeChannel): unknown[] {
    return ch.sends.map(s => JSON.parse(s));
}

/** jsdom has no RTCPeerConnection, and the controller builds a real one. */
class ControllerPc {
    onicecandidate: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    oniceconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel(label: string) {
        pcCalls.push(`createDataChannel:${label}`);
        const ch: FakeChannel = {
            label,
            readyState: 'connecting',
            sends: [],
            onopen: null, onclose: null, onmessage: null,
            send(d: string) {
                if (this.readyState !== 'open') throw new Error('not open');
                this.sends.push(d);
            },
            close() { this.readyState = 'closed'; },
        };
        channels.push(ch);
        return ch;
    }
    addTransceiver() { return { receiver: { track: { onunmute: null, kind: 'video', stop() {} } } }; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription() { pcCalls.push('setLocalDescription'); }
    async setRemoteDescription() {}
    async addIceCandidate() {}
    addTrack() { return {}; }
    close() {}
}
Object.defineProperty(window, 'RTCPeerConnection', {
    value: ControllerPc, configurable: true, writable: true,
});

import { sealControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

/** Drive a controller session to 'active', returning the key the HOST holds. */
async function activeController(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    channels.length = 0;
    pcCalls.length = 0;

    const id = await connectToDevice('dev-host');
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

let peerSeq = 0;
async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: peerSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

const VALID = {
    t: 'caret', vis: true, x: 0.25, y: 0.5, w: 0.001, h: 0.02,
    src: 'win32', mon: 0, surf: 3, seq: 7,
};

beforeEach(() => { peerSeq = 0; });

describe('the channel itself', () => {
    it('is opened, with the label the agent looks for, before the offer is described', async () => {
        await activeController();
        expect(pcCalls).toContain('createDataChannel:caret');
        expect(
            pcCalls.indexOf('createDataChannel:caret'),
            'a channel created after setLocalDescription is never negotiated',
        ).toBeLessThan(pcCalls.indexOf('setLocalDescription'));
        // POSITIVE CONTROL that the log means anything: files is created there too.
        expect(pcCalls).toContain('createDataChannel:files');
    });
});

describe('asking for caret reports', () => {
    it('THE RACE: a request made before the channel opens is replayed on open', async () => {
        const { id } = await activeController();
        const { setCaretTracking } = await import('../api/devices/session');

        setCaretTracking(id, true);
        await settle();
        expect(caret().sends, 'nothing can be written to a channel that is not open').toEqual([]);

        open(caret());
        expect(trackFrames(caret())).toEqual([{ t: 'track', on: true }]);
    });

    it('writes to the CARET channel and to nothing else', async () => {
        const { id } = await activeController();
        const { setCaretTracking } = await import('../api/devices/session');
        open(caret());
        setCaretTracking(id, true);

        expect(trackFrames(caret())).toEqual([{ t: 'track', on: true }]);
        for (const ch of channels) {
            if (ch.label === 'caret') continue;
            expect(ch.sends, `${ch.label} must carry no caret traffic`).toEqual([]);
        }
    });

    it('dedupes: the stage re-asks on every band change', async () => {
        const { id } = await activeController();
        const { setCaretTracking } = await import('../api/devices/session');
        open(caret());

        setCaretTracking(id, true);
        setCaretTracking(id, true);
        setCaretTracking(id, true);
        expect(caret().sends).toHaveLength(1);

        setCaretTracking(id, false);
        expect(trackFrames(caret())).toEqual([{ t: 'track', on: true }, { t: 'track', on: false }]);
    });

    it('is refused for a session that does not exist, without throwing', async () => {
        await activeController();
        const { setCaretTracking } = await import('../api/devices/session');
        expect(() => setCaretTracking('no-such-session', true)).not.toThrow();
    });

    it('survives a media restart, on the NEW channel', async () => {
        // Missing this is how caret-follow would silently die after any network
        // blip: restartMedia builds a fresh pc, and with it a fresh channel.
        const { id, key } = await activeController();
        const { setCaretTracking } = await import('../api/devices/session');
        open(caret());
        setCaretTracking(id, true);
        expect(caretChannels()).toHaveLength(1);

        // The host reporting its stream died is the real trigger for a restart.
        // The premise is measured as a DELTA: the session's own connect already
        // sent an offer, so "some DeviceSignal exists" was true before the
        // restart and proved nothing about it.
        const signalsBefore = sent.filter(m => m.type === 'DeviceSignal').length;
        await hostSignal(id, key, { kind: 'stream-died' });
        await settle();
        expect(
            sent.filter(m => m.type === 'DeviceSignal').length,
            'the premise: a restart was actually negotiated (a restart-offer went out)',
        ).toBeGreaterThan(signalsBefore);
        expect(caretChannels(), 'the restart must build a new channel').toHaveLength(2);

        const fresh = caret();
        expect(fresh.sends, 'nothing before it opens').toEqual([]);
        open(fresh);
        expect(
            trackFrames(fresh),
            'the INTENT outlives the transport, so the fresh channel re-asserts it',
        ).toEqual([{ t: 'track', on: true }]);
    });
});

describe('reports reaching the stage', () => {
    it('POSITIVE CONTROL: a valid frame arrives parsed', async () => {
        const { id } = await activeController();
        const { subscribeCaret } = await import('../api/devices/session');
        const got: unknown[] = [];
        subscribeCaret(id, r => got.push(r));

        caret().onmessage!({ data: JSON.stringify(VALID) });
        expect(got).toEqual([{
            vis: true, x: 0.25, y: 0.5, w: 0.001, h: 0.02,
            src: 'win32', mon: 0, surf: 3, seq: 7,
        }]);
    });

    it('delivers vis:false too — "no caret here" is information', async () => {
        const { id } = await activeController();
        const { subscribeCaret } = await import('../api/devices/session');
        const got: Array<{ vis: boolean; mon: number | null }> = [];
        subscribeCaret(id, r => got.push({ vis: r.vis, mon: r.mon }));

        caret().onmessage!({ data: JSON.stringify({ t: 'caret', vis: false, mon: 255, surf: 2, seq: 1 }) });
        expect(got).toEqual([{ vis: false, mon: 255 }]);
    });

    it('drops everything malformed rather than acting on it', async () => {
        const { id } = await activeController();
        const { subscribeCaret } = await import('../api/devices/session');
        const got: unknown[] = [];
        subscribeCaret(id, r => got.push(r));

        const bad: unknown[] = [
            JSON.stringify({ ...VALID, x: '0.5' }),          // a string that would coerce
            JSON.stringify({ ...VALID, vis: 'yes' }),        // truthy, not a boolean
            JSON.stringify({ ...VALID, x: 1.5 }),            // out of range: DROPPED, not clamped
            JSON.stringify({ ...VALID, y: -0.001 }),
            JSON.stringify({ ...VALID, h: Number.NaN }),     // becomes null in JSON
            JSON.stringify({ ...VALID, mon: undefined }),     // a visible caret with no surface identity
            JSON.stringify({ ...VALID, surf: undefined }),
            JSON.stringify({ t: 'nope', vis: true }),
            JSON.stringify({ t: 'caret' }),
            'not json at all',
            'x'.repeat(5000),
            { t: 'caret', vis: true },                       // an object, not a string
            null,
            undefined,
        ];
        for (const b of bad) caret().onmessage!({ data: b });
        expect(got, 'a wrong caret obeyed is worse than no caret').toEqual([]);

        // ...and the channel is still alive afterwards.
        caret().onmessage!({ data: JSON.stringify(VALID) });
        expect(got).toHaveLength(1);
    });

    it('stops delivering after unsubscribe', async () => {
        const { id } = await activeController();
        const { subscribeCaret } = await import('../api/devices/session');
        const got: unknown[] = [];
        const off = subscribeCaret(id, r => got.push(r));

        caret().onmessage!({ data: JSON.stringify(VALID) });
        expect(got, 'the control: it was arriving').toHaveLength(1);
        off();
        caret().onmessage!({ data: JSON.stringify(VALID) });
        expect(got).toHaveLength(1);
    });

    it('a throwing subscriber neither kills the channel nor the other subscriber', async () => {
        const { id } = await activeController();
        const { subscribeCaret } = await import('../api/devices/session');
        const seen: string[] = [];
        subscribeCaret(id, () => { seen.push('first'); throw new Error('boom'); });
        subscribeCaret(id, () => { seen.push('second'); });

        expect(() => caret().onmessage!({ data: JSON.stringify(VALID) })).not.toThrow();
        expect(seen).toEqual(['first', 'second']);
    });

    it('ending the session drops the subscriptions with it', async () => {
        const { id } = await activeController();
        const { subscribeCaret, endSession, activeSessions } = await import('../api/devices/session');
        const got: unknown[] = [];
        subscribeCaret(id, r => got.push(r));
        const ch = caret();

        ch.onmessage!({ data: JSON.stringify(VALID) });
        expect(got, 'the control: it was arriving').toHaveLength(1);

        endSession(id, 'you disconnected');
        await settle();
        expect(activeSessions().find(s => s.id === id)).toBeUndefined();
        // A subscription keyed by an id the NEXT session may reuse would deliver
        // that session's frames to a dead stage.
        expect(() => ch.onmessage!({ data: JSON.stringify(VALID) })).not.toThrow();
        expect(got).toHaveLength(1);
    });
});

describe('the diagnostic tells the old-agent story', () => {
    it('reports an open channel with nothing ever received', async () => {
        const { id } = await activeController();
        const { setCaretTracking, deviceDiagnostics } = await import('../api/devices/session');
        open(caret());
        setCaretTracking(id, true);

        const row = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(row.caretChannel).toBe('open');
        expect(row.caretTracking).toBe(true);
        expect(
            row.caretCapable,
            'an open channel is NOT evidence the peer can report a caret',
        ).toBe(false);
        expect(row.caretReports).toBe(0);

        // POSITIVE CONTROL: one real frame and the same row says the opposite.
        caret().onmessage!({ data: JSON.stringify(VALID) });
        const after = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(after.caretCapable).toBe(true);
        expect(after.caretReports).toBe(1);
        expect((after.caretLast as { src: string }).src).toBe('win32');
    });

    it('counts malformed frames separately from real ones', async () => {
        const { id } = await activeController();
        const { deviceDiagnostics } = await import('../api/devices/session');
        caret().onmessage!({ data: '{' });
        const row = (await deviceDiagnostics()).find(r => r.id === id)!;
        expect(row.caretDropped).toEqual({ malformed: 1 });
        expect(row.caretReports).toBe(0);
    });
});
