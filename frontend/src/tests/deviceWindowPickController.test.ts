// @vitest-environment jsdom
/**
 * ONE WINDOW, CONTROLLER side (the viewer): what it offers, what it sends,
 * and how it reads — or refuses — what the host says (session.ts; the wire
 * in windowPick.ts). The host half (who may list or choose, the consent
 * boundary, following a window) is driven in deviceSessionAuth.test.ts,
 * "one window on its own". These drive the real controller handlers with a
 * stand-in host sealing frames under the real session key, the rig of
 * deviceAudioHubController.test.ts.
 *
 * Why it matters that it is the real handlers: the stage harness
 * (e2e/device-stage) swaps session.ts for a stand-in, so the browser walk
 * never runs this code.
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
vi.mock('../api/devices/deviceKeyRc', () => ({ deviceKeyDh: async () => new Uint8Array(32).fill(3) }));
vi.mock('../api/devices/unattendedPrompt', () => ({ requestUnattendedPassphrase: async () => null }));
vi.mock('../api/devices/unattended', () => ({
    deriveUaSeed: () => new Uint8Array(32),
    signUaChallengeSeed: () => new Uint8Array(64),
    rememberedUaSeed: () => null,
    rememberUaSeed: () => {},
    confirmUaSeed: () => {},
    forgetUaSeed: () => {},
}));
vi.mock('../api/platform', () => ({
    isTauri: () => false,
    isMobile: () => false,
    getApiBaseUrl: () => 'http://localhost:3000',
    getWebSocketUrl: () => 'ws://localhost:3000',
}));
vi.mock('../api/devices/peerKeys', () => ({ deviceStaticPubFor: async () => 'x25519:' + btoa('k') }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));
vi.mock('../api/devices/tunnel', () => ({ attachTunnelChannel: () => {}, closeTunnels: () => {} }));
vi.mock('../api/thisDevice', () => ({ thisDeviceId: () => 'dev-me' }));
vi.mock('../api/devices/hostBackend', () => ({
    getHostBackend: async () => ({
        kind: 'agent',
        async capabilities() {
            return { capture: true, unattended: true, input: true, elevated: false, clipboard: false, files: true, monitors: [] };
        },
        startSession: async () => ({ kind: 'agent-pc' }),
        stopSession: async () => {},
        listMonitors: async () => [],
        setMonitor: async () => {},
        injectEvent: async () => {},
    }),
}));
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { sealControl, openControl, generateControlEphemeral, deriveDeviceControlKey } from '../api/e2ee';

class ControllerPc {
    localDescription: unknown = null;
    remoteDescription: unknown = null;
    onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    oniceconnectionstatechange: (() => void) | null = null;
    connectionState = 'new';
    iceConnectionState = 'new';
    createDataChannel() {
        return { onopen: null, onclose: null, onmessage: null, readyState: 'connecting', close() {} };
    }
    addTransceiver() {
        return { receiver: { track: { onunmute: null, kind: 'video', stop() {} } } };
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\n' }; }
    async setLocalDescription(d: unknown) { this.localDescription = d; }
    async setRemoteDescription(d: unknown) { this.remoteDescription = d; }
    async addIceCandidate() { /* accepted */ }
    addTrack() { return {}; }
    close() { /* nothing to release */ }
}
Object.defineProperty(window, 'RTCPeerConnection', { value: ControllerPc, configurable: true, writable: true });

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
}

let hostSeq = 0;

async function activeController(): Promise<{ id: string; key: Uint8Array }> {
    const { installDeviceSessions, connectToDevice, endAllSessions, activeSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    hostSeq = 0;
    const id = await connectToDevice('dev-host');
    const controllerEph = sent.find(m => m.type === 'DeviceConnect')?.payload?.eph as string;
    const hostEph = generateControlEphemeral();
    const key = deriveDeviceControlKey(new Uint8Array(32).fill(3), hostEph.priv, controllerEph)!;
    handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded } });
    await settle();
    expect(activeSessions().find(s => s.id === id)?.phase, 'premise: the controller is active').toBe('active');
    return { id, key };
}

async function hostSignal(id: string, key: Uint8Array, obj: Record<string, unknown>): Promise<void> {
    const sealed = await sealControl(key, JSON.stringify({ sid: id, n: hostSeq++, ...obj }));
    handlers.get('DeviceSignalled')!({ payload: { session_id: id, payload: sealed } });
    await settle();
}

async function controllerFrames(key: Uint8Array): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const m of sent) {
        if (m.type !== 'DeviceSignal') continue;
        const plain = await openControl(key, m.payload!.payload as string);
        if (plain) out.push(JSON.parse(plain) as Record<string, unknown>);
    }
    return out;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAY';
const NOTEPAD = { hwnd: 66_000, pid: 4, title: 'notes.txt - Notepad', app: 'Notepad', icon: 'ia', monitor: 1 };

async function session(id: string) {
    const { activeSessions } = await import('../api/devices/session');
    return activeSessions().find(s => s.id === id)!;
}

beforeEach(() => { vi.useRealTimers(); });

describe('the window choice, viewer side', () => {
    it('is not offered, and nothing is asked, until the host says it can (an older host never does)', async () => {
        const mod = await import('../api/devices/session');
        const { id, key } = await activeController();
        expect((await session(id)).windowsSupported).toBe(false);
        mod.requestWindowList(id);
        mod.chooseWindow(id, { hwnd: 1, pid: 1 });
        await settle();
        const kinds = (await controllerFrames(key)).map(f => f.kind);
        expect(kinds, 'an older host is asked nothing it cannot answer').not.toContain('list-windows');
        expect(kinds).not.toContain('set-window');
        // POSITIVE CONTROL: once the host says so, the same calls do go out.
        await hostSignal(id, key, { kind: 'features', windows: true });
        expect((await session(id)).windowsSupported).toBe(true);
        mod.requestWindowList(id);
        await settle();
        expect((await controllerFrames(key)).map(f => f.kind)).toContain('list-windows');
    });

    it('takes only the answer to the list it asked for last, checked, and its icons after it', async () => {
        const mod = await import('../api/devices/session');
        const { id, key } = await activeController();
        await hostSignal(id, key, { kind: 'features', windows: true });
        mod.requestWindowList(id);
        await settle();
        const ask = (await controllerFrames(key)).find(f => f.kind === 'list-windows')!;
        expect(typeof ask.rid).toBe('string');
        expect((await session(id)).windowList).toMatchObject({ rid: ask.rid, loading: true, error: null });
        await hostSignal(id, key, { kind: 'windows', rid: 'someone-else', windows: [NOTEPAD] });
        expect((await session(id)).windowList?.windows, 'an answer to another ask is dropped').toEqual([]);
        await hostSignal(id, key, { kind: 'windows', rid: ask.rid, windows: [NOTEPAD, { hwnd: 'x' }] });
        expect((await session(id)).windowList).toMatchObject({ loading: false, windows: [NOTEPAD] });
        await hostSignal(id, key, { kind: 'window-icons', rid: ask.rid, icons: { ia: PNG, ib: 'https://x.invalid/a.png' } });
        expect((await session(id)).windowList?.icons, 'a picture that would load from anywhere is refused').toEqual({ ia: PNG });
        // A host's failure is said.
        mod.requestWindowList(id);
        await settle();
        const again = (await controllerFrames(key)).filter(f => f.kind === 'list-windows').at(-1)!;
        await hostSignal(id, key, { kind: 'windows-failed', rid: again.rid, reason: 'the agent was busy' });
        expect((await session(id)).windowList).toMatchObject({
            loading: false, error: "Could not list that computer's windows: the agent was busy.",
            windows: [NOTEPAD], // kept while a fresh list was asked for
        });
    });

    it('shows a window only once the host CONFIRMS it, and says why it went back', async () => {
        const mod = await import('../api/devices/session');
        const { id, key } = await activeController();
        await hostSignal(id, key, { kind: 'features', windows: true });
        mod.chooseWindow(id, { hwnd: 66_000, pid: 4 });
        await settle();
        const choice = (await controllerFrames(key)).find(f => f.kind === 'set-window');
        expect(choice).toMatchObject({ hwnd: 66_000, pid: 4 });
        expect((await session(id)).activeWindow, 'not from the click').toBeNull();
        // A frame that does not say what it shows is not believed.
        await hostSignal(id, key, { kind: 'window-active', window: { hwnd: 66_000, pid: 4, title: 'x' } });
        expect((await session(id)).activeWindow).toBeNull();
        await hostSignal(id, key, { kind: 'window-active', window: { ...NOTEPAD, width: 900, height: 1300 }, front: true });
        expect((await session(id)).activeWindow).toEqual({ hwnd: 66_000, pid: 4, title: 'notes.txt - Notepad', app: 'Notepad', width: 900, height: 1300 });
        await hostSignal(id, key, { kind: 'window-front', front: false });
        expect((await session(id)).windowFront).toBe(false);
        await hostSignal(id, key, { kind: 'window-active', window: null, reason: 'closed' });
        expect((await session(id)).activeWindow).toBeNull();
        expect((await session(id)).windowNotice).toBe('“notes.txt - Notepad” was closed. Showing the whole screen.');
    });

    it('Whole screen asked for is silent; a refusal says the host\'s reason', async () => {
        const mod = await import('../api/devices/session');
        const { id, key } = await activeController();
        await hostSignal(id, key, { kind: 'features', windows: true });
        await hostSignal(id, key, { kind: 'window-active', window: { ...NOTEPAD, width: 900, height: 1300 } });
        mod.chooseWindow(id, null);
        await settle();
        expect((await controllerFrames(key)).filter(f => f.kind === 'set-window').at(-1)).toEqual(expect.objectContaining({ hwnd: null }));
        await hostSignal(id, key, { kind: 'window-active', window: null, reason: 'asked' });
        expect((await session(id)).windowNotice).toBeNull();
        await hostSignal(id, key, { kind: 'window-failed', reason: 'that window is on a screen that was not shared' });
        expect((await session(id)).windowNotice).toBe('Could not show that window: that window is on a screen that was not shared.');
        mod.dismissWindowNotice(id);
        expect((await session(id)).windowNotice).toBeNull();
    });
});
