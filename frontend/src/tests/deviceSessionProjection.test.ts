// @vitest-environment jsdom
/**
 * What the session layer hands OUT about its sessions (session.ts
 * publicSessions): the public projection, never the Internal objects.
 *
 * Internal carries the session key (`key`), the input channel's key
 * (`inputKey`), this side's ephemeral private key (`eph`), the peer
 * connection and the pending offer. emit() always sent an explicit projection
 * for exactly that reason ("handing those to every subscriber would put
 * secrets in React state"), but the FIRST call a new subscriber got, and every
 * activeSessions(), was the Internal objects themselves: every screen that
 * subscribed (the stage, the file browser, the Audio Hub panel, the power-off
 * card) held the keys in its state from its first render until the next
 * emit, and DeviceFileBrowser seeds its state from activeSessions().
 *
 * Driven through the real controller handlers, with a stand-in host that
 * answers the connect (the rig of deviceAudioHubController.test.ts), so the
 * Internal object really holds a derived key when it is read.
 */
import { describe, it, expect, vi } from 'vitest';

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
vi.mock('../api/devices/unattendedHost', () => ({
    issueUaChallenge: async () => null,
    verifyUaResponse: async () => false,
    unattendedState: async () => ({ armed: false }),
}));

import { generateControlEphemeral } from '../api/e2ee';

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

/** Names of Internal fields that are secret or live machinery. Not the whole
 *  list: the key-set comparison below is what catches any other. */
const SECRET = ['key', 'inputKey', 'eph', 'pc', 'pendingOffer', 'sigQueue', 'inputChannel', 'caretChannel'];

/** A Control session to 'dev-host' that the host has accepted: its Internal
 *  object now holds the derived session key. */
async function acceptedControl(): Promise<string> {
    const { installDeviceSessions, connectToDevice, endAllSessions } = await import('../api/devices/session');
    installDeviceSessions();
    endAllSessions('test reset');
    sent.length = 0;
    const id = await connectToDevice('dev-host', { peerName: 'Desk PC', machineRows: ['dev-host', 'dev-host-signin'] });
    const hostEph = generateControlEphemeral();
    handlers.get('DeviceConnectAnswered')!({ payload: { session_id: id, accepted: true, eph: hostEph.pubEncoded } });
    await settle();
    return id;
}

describe('the session list handed out of the session layer', () => {
    it("a new subscriber's FIRST call is the same projection every later call is, with no key material", async () => {
        const { subscribeSessions, endSession, connectToDevice } = await import('../api/devices/session');
        const id = await acceptedControl();
        const calls: Array<Array<Record<string, unknown>>> = [];
        const off = subscribeSessions(all => { calls.push(all as unknown as Array<Record<string, unknown>>); });
        // Premise: the session is there, active, and its key exists inside.
        const first = calls[0]?.find(s => s.id === id);
        expect(first?.phase, 'premise: the accepted session is in the first call').toBe('active');
        // A later call, through emit(): another connect, then its end.
        const other = await connectToDevice('dev-other');
        endSession(other);
        await settle();
        const later = calls.at(-1)!.find(s => s.id === id);
        expect(later, 'premise: an emit came after the first call').toBeTruthy();
        expect(calls.length, 'premise: more than the first call').toBeGreaterThan(1);
        for (const name of SECRET) {
            expect(Object.prototype.hasOwnProperty.call(first, name), `the first call carries no ${name}`).toBe(false);
            expect(Object.prototype.hasOwnProperty.call(later, name), `an emit carries no ${name}`).toBe(false);
        }
        expect(Object.keys(first!).sort(), 'the first call is the projection emit() sends').toEqual(Object.keys(later!).sort());
        off();
    });

    it('activeSessions() is that projection too (DeviceFileBrowser seeds its state from it)', async () => {
        const { activeSessions, subscribeSessions } = await import('../api/devices/session');
        const id = await acceptedControl();
        const listed = activeSessions().find(s => s.id === id) as unknown as Record<string, unknown> | undefined;
        expect(listed?.phase, 'premise: listed, active').toBe('active');
        for (const name of SECRET) {
            expect(Object.prototype.hasOwnProperty.call(listed, name), `activeSessions() carries no ${name}`).toBe(false);
        }
        let projected: Record<string, unknown> | undefined;
        const off = subscribeSessions(all => { projected = all.find(s => s.id === id) as unknown as Record<string, unknown>; });
        off();
        expect(Object.keys(listed!).sort()).toEqual(Object.keys(projected!).sort());
        // And a copy: what the caller holds is not the session layer's own
        // object, so nothing written to it reaches the session.
        (listed as { error: string | null }).error = 'written from outside';
        expect(activeSessions().find(s => s.id === id)?.error).toBeNull();
    });
});
