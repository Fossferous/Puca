/**
 * P2P INPUT, HOST RECEIVE PATH — the branch that actually types on someone
 * else's machine, and the one the first cut of this work shipped with zero
 * coverage (review finding).
 *
 * Every gate the WS `ControlInput` handler applies must apply here too,
 * because this transport does not pass through that handler:
 *   - only the peer this host GRANTED (hostCrypto binding),
 *   - only frames that open under the session key (a forged one injects
 *     nothing — the server cannot type),
 *   - strictly increasing sequence in the CHANNEL's own namespace,
 *   - the shared rate cap and coalescer, via handleIncomingInput,
 *   - and only while this host is actually sharing.
 *
 * The seam is the Tauri `inject_input` invoke: what reaches it is what lands
 * on the desktop, so that is what these tests count.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();
/** Everything that reached the native injector. */
const injected: unknown[] = [];

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
        if (cmd === 'inject_input') { injected.push(args?.event); return undefined; }
        if (cmd === 'list_anticheat_processes') return [];      // nothing blocking
        if (cmd === 'list_monitors') return { monitors: [], virt_left: 0, virt_top: 0, virt_width: 0, virt_height: 0 };
        return undefined;
    },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => false,
    sendNotification: () => {},
}));
const STREAMING_AS = 1;
vi.mock('../components/voiceState', () => ({
    getCurrentStreamingUserId: () => STREAMING_AS,
    getStreamData: () => null,
    selectStream: () => {},
}));
vi.mock('../api/rtc/receiverLatency', () => ({
    clearAllScreenLatency: () => {},
    setScreenLatencyMinimised: () => {},
}));

const VIEWER = 42;
let viewerIdentityPub = '';
vi.mock('../api/dms', () => ({ getCachedPublicKey: async () => viewerIdentityPub }));

import {
    FRAME_HELLO, FRAME_SEALED_INPUT, registerControlChannel, resetControlChannels,
} from '../api/rtc/controlDc';
import {
    makeIdentity, generateControlEphemeral, deriveControlSessionKey, sealControlBytes,
    setActiveIdentity,
} from '../api/e2ee';

function fakeDc() {
    const dc = {
        label: 'sov-ctl-s',
        readyState: 'open' as RTCDataChannelState,
        binaryType: 'blob',
        bufferedAmount: 0,
        onmessage: null as ((ev: MessageEvent) => void) | null,
        onopen: null as (() => void) | null,
        onclose: null as (() => void) | null,
        send: () => {},
        close: () => { dc.readyState = 'closed'; dc.onclose?.(); },
    };
    return { dc: dc as unknown as RTCDataChannel, raw: dc };
}

const settle = async (rounds = 10) => {
    for (let i = 0; i < rounds; i++) await new Promise(r => setTimeout(r, 0));
};

/** Drive a HOST session to granted; returns the key the VIEWER holds. */
async function activeHost(): Promise<Uint8Array> {
    const rc = await import('../api/remoteControl');
    const me = makeIdentity(new Uint8Array(32).fill(3));
    const viewer = makeIdentity(new Uint8Array(32).fill(4));
    setActiveIdentity(me);
    viewerIdentityPub = viewer.publicKeyEncoded;

    rc.initRemoteControl();
    sent.length = 0;
    const viewerEph = generateControlEphemeral();
    handlers.get('ControlRequested')!({
        payload: { from_user: VIEWER, from_username: 'viewer', eph: viewerEph.pubEncoded },
    });
    await settle();
    await rc.respondToControlRequest(true);
    await settle();

    const resp = sent.find(m => m.type === 'ControlResponse');
    const hostEph = resp?.payload?.eph as string;
    expect(hostEph, 'the grant carries the host ephemeral').toBeTruthy();
    const key = deriveControlSessionKey(
        viewer.privateKey, me.publicKeyEncoded, viewerEph.priv, hostEph,
    );
    expect(key, 'both ends agree a session key').not.toBeNull();
    sent.length = 0;
    return key!;
}

async function frameFor(key: Uint8Array, seq: number, kind = FRAME_SEALED_INPUT): Promise<ArrayBuffer> {
    const body = kind === FRAME_HELLO
        ? JSON.stringify({ hello: 1 })
        : JSON.stringify({ s: seq, e: { t: 'down', button: 0 } });
    const bytes = await sealControlBytes(key, body);
    const wire = new Uint8Array(bytes.length + 1);
    wire[0] = kind;
    wire.set(bytes, 1);
    return wire.buffer.slice(0);
}

beforeEach(async () => {
    const rc = await import('../api/remoteControl');
    rc.resetRemoteControl();
    resetControlChannels();
    sent.length = 0;
    injected.length = 0;
});

describe('what the host will and will not inject from a data channel', () => {
    it('a granted viewer’s sealed frame injects; a REPLAY of it does not', async () => {
        const key = await activeHost();
        const { dc, raw } = fakeDc();
        registerControlChannel(VIEWER, dc);

        raw.onmessage!({ data: await frameFor(key, 1) } as MessageEvent);
        await settle();
        expect(injected, 'granted, sealed, fresh — this is the feature').toHaveLength(1);

        raw.onmessage!({ data: await frameFor(key, 1) } as MessageEvent);
        await settle();
        expect(injected, 'the same number again is a captured frame replayed').toHaveLength(1);

        raw.onmessage!({ data: await frameFor(key, 2) } as MessageEvent);
        await settle();
        expect(injected, 'POSITIVE CONTROL: forward still lands').toHaveLength(2);
    });

    it('a frame sealed under the WRONG key injects nothing — the server cannot type', async () => {
        await activeHost();
        const { dc, raw } = fakeDc();
        registerControlChannel(VIEWER, dc);
        raw.onmessage!({ data: await frameFor(new Uint8Array(32).fill(9), 1) } as MessageEvent);
        await settle();
        expect(injected).toHaveLength(0);
    });

    it('a frame from a peer this host granted NOTHING injects nothing', async () => {
        const key = await activeHost();
        const { dc, raw } = fakeDc();
        // A bystander peer's channel: no hostCrypto is bound to it.
        registerControlChannel(VIEWER + 1, dc);
        raw.onmessage!({ data: await frameFor(key, 1) } as MessageEvent);
        await settle();
        expect(injected, 'the binding is the grant, not the channel').toHaveLength(0);
    });

    it('after the session ends, a frame that would have been valid injects nothing', async () => {
        const key = await activeHost();
        const { dc, raw } = fakeDc();
        registerControlChannel(VIEWER, dc);
        const rc = await import('../api/remoteControl');
        rc.revokeControl();
        await settle();
        raw.onmessage!({ data: await frameFor(key, 1) } as MessageEvent);
        await settle();
        expect(injected, 'revoking must end injection immediately').toHaveLength(0);
    });

    it('a malformed or truncated frame injects nothing', async () => {
        await activeHost();
        const { dc, raw } = fakeDc();
        registerControlChannel(VIEWER, dc);
        raw.onmessage!({ data: new Uint8Array([FRAME_SEALED_INPUT]).buffer } as MessageEvent);
        raw.onmessage!({ data: new Uint8Array([]).buffer } as MessageEvent);
        raw.onmessage!({ data: 'text' } as unknown as MessageEvent);
        await settle();
        expect(injected).toHaveLength(0);
    });
});
