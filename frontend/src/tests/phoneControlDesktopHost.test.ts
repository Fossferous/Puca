/**
 * A DESKTOP host and the phone's own events: a viewer that thinks its host is
 * a phone (or a modified one) may send `nav` and `text`. The desktop's batch
 * injector would refuse a whole batch over one variant it does not know, so
 * they must never reach it, and the events around them must still land.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cryptoInFlight, trackCrypto } from './fixtures/cryptoInFlight';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();
const injected: Array<Record<string, unknown>> = [];

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); },
        bufferedAmount: () => 0,
    },
}));
vi.mock('../api/platform', () => ({ isTauri: () => true, isMobile: () => false }));
vi.mock('@tauri-apps/api/core', () => ({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === 'inject_input_batch') { injected.push(...(args?.events as Array<Record<string, unknown>>)); return undefined; }
        if (cmd === 'list_anticheat_processes') return [];
        if (cmd === 'list_monitors') return { monitors: [], virt_left: 0, virt_top: 0, virt_width: 0, virt_height: 0 };
        return undefined;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: async () => false, sendNotification: () => {} }));
vi.mock('../components/voiceState', () => ({
    getCurrentStreamingUserId: () => 1,
    getStreamData: () => null,
    selectStream: () => {},
}));
vi.mock('../api/rtc/receiverLatency', () => ({ clearAllScreenLatency: () => {}, setScreenLatencyMinimised: () => {} }));
let viewerPub = '';
vi.mock('../api/dms', () => ({ getCachedPublicKey: async () => viewerPub }));

import { makeIdentity, generateControlEphemeral, deriveControlSessionKey, sealControl, setActiveIdentity } from '../api/e2ee';

const VIEWER = 77;
const settle = async (rounds = 10) => {
    const giveUp = performance.now() + 3_000;
    for (let i = 0, calm = 0; i < rounds || calm < 2; i++) {
        if (performance.now() > giveUp) throw new Error(`${cryptoInFlight()} WebCrypto calls still out after 3 s`);
        await new Promise(r => setTimeout(r, 0));
        calm = cryptoInFlight() === 0 ? calm + 1 : 0;
    }
};

let untrack: () => void = () => {};
beforeEach(() => { untrack = trackCrypto(); sent.length = 0; injected.length = 0; });
afterEach(() => { untrack(); });

describe('a desktop host given a phone\'s events', () => {
    it('drops nav and text, injects the rest, and tells its viewer nothing about being a phone', async () => {
        const rc = await import('../api/remoteControl');
        const me = makeIdentity(new Uint8Array(32).fill(7));
        const viewer = makeIdentity(new Uint8Array(32).fill(8));
        setActiveIdentity(me);
        viewerPub = viewer.publicKeyEncoded;
        rc.initRemoteControl();
        const eph = generateControlEphemeral();
        handlers.get('ControlRequested')!({ payload: { from_user: VIEWER, from_username: 'v', eph: eph.pubEncoded } });
        await settle();
        await rc.respondToControlRequest(true);
        await settle();
        const resp = sent.find(m => m.type === 'ControlResponse')!;
        const key = deriveControlSessionKey(viewer.privateKey, me.publicKeyEncoded, eph.priv, resp.payload!.eph as string)!;
        expect(sent.some(m => m.type === 'ControlInput'), 'a desktop sends no HostInfo').toBe(false);

        const send = async (s: number, e: Record<string, unknown>) => {
            handlers.get('ControlInput')!({ payload: { from_user: VIEWER, event: await sealControl(key, JSON.stringify({ s, e })) } });
            await settle();
        };
        await send(1, { t: 'nav', a: 'home' });
        await send(2, { t: 'text', s: 'abc' });
        await send(3, { t: 'down', button: 0 });
        await new Promise(r => setTimeout(r, 30));
        expect(injected.map(e => e.t)).toEqual(['down']);
        expect(injected.some(e => 'at' in e), 'no arrival stamp leaks into the desktop\'s events').toBe(false);
        rc.resetRemoteControl();
    });
});
