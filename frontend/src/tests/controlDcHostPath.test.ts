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
 * The seam is the Tauri `inject_input_batch` invoke (per-event
 * `inject_input` for an older binary): what reaches it is what lands on the
 * desktop, so that is what these tests count.
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
        // Events reach the desktop in batches now (one IPC round trip per
        // coalesced motion + state event, in order); the per-event command
        // is the fallback for an older binary. Both land here.
        if (cmd === 'inject_input_batch') { injected.push(...(args?.events as unknown[])); return undefined; }
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
    FRAME_HELLO, FRAME_SEALED_INPUT, controlDcReady, decodeFrame, registerControlChannel,
    resetControlChannels,
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

describe('two sessions at once — ending one must not touch the other', () => {
    /** Drive THIS user into a VIEWER session with `peerId` (the identity
     *  mock serves the same key for every id) and return the key that peer
     *  holds, so it can seal a hello. */
    async function activeViewerWith(peerId: number): Promise<Uint8Array> {
        const rc = await import('../api/remoteControl');
        const me = makeIdentity(new Uint8Array(32).fill(3));
        const peer = makeIdentity(new Uint8Array(32).fill(4));
        sent.length = 0;
        rc.requestControl(peerId, 'other');
        await settle();
        const req = sent.find(m => m.type === 'ControlRequest' && m.payload?.target_user === peerId);
        const myEph = req?.payload?.eph as string;
        expect(myEph).toBeTruthy();
        const theirEph = generateControlEphemeral();
        handlers.get('ControlResponse')!({
            payload: { from_user: peerId, granted: true, eph: theirEph.pubEncoded, cap_w: 1920, cap_h: 1080 },
        });
        await settle();
        const key = deriveControlSessionKey(peer.privateKey, me.publicKeyEncoded, theirEph.priv, myEph);
        expect(key).not.toBeNull();
        sent.length = 0;
        return key!;
    }

    async function helloFrom(raw: ReturnType<typeof fakeDc>['raw'], key: Uint8Array) {
        raw.onmessage!({ data: await frameFor(key, 0, FRAME_HELLO) } as MessageEvent);
        await settle();
    }

    it('ending the HOST session leaves a live VIEWER session with ANOTHER peer on its lane', async () => {
        await activeHost();                       // hosting VIEWER (42)
        const OTHER = 43;
        const otherKey = await activeViewerWith(OTHER);
        const other = fakeDc();
        const otherFrames: Uint8Array[] = [];
        (other.raw as unknown as { send: (b: ArrayBuffer) => void }).send = (b) => { otherFrames.push(new Uint8Array(b)); };
        registerControlChannel(OTHER, other.dc);
        await helloFrom(other.raw, otherKey);
        expect(controlDcReady(OTHER, 'viewer'), 'the viewer session is on its lane').toBe(true);

        const rc = await import('../api/remoteControl');
        rc.revokeControl();                       // the HOST session ends
        await settle();
        expect(controlDcReady(OTHER, 'viewer'), 'the viewer session must keep it').toBe(true);

        otherFrames.length = 0;
        sent.length = 0;
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput'), 'not demoted to the relay').toHaveLength(0);
        expect(otherFrames.filter(f => decodeFrame(f)!.kind === FRAME_SEALED_INPUT)).toHaveLength(1);
    });

    it('mutual control over ONE connection: ending my host session keeps my viewer session on the lane', async () => {
        await activeHost();                       // VIEWER (42) controls me...
        const myViewerKey = await activeViewerWith(VIEWER); // ...while I control them
        const { dc, raw } = fakeDc();
        const frames: Uint8Array[] = [];
        (raw as unknown as { send: (b: ArrayBuffer) => void }).send = (b) => { frames.push(new Uint8Array(b)); };
        registerControlChannel(VIEWER, dc);
        // Their hello for MY viewer session (sealed under that session's key).
        await helloFrom(raw, myViewerKey);
        expect(controlDcReady(VIEWER, 'viewer')).toBe(true);
        expect(controlDcReady(VIEWER, 'host'), 'no hello for my host session yet').toBe(false);

        const rc = await import('../api/remoteControl');
        rc.revokeControl();
        await settle();
        expect(controlDcReady(VIEWER, 'viewer'), 'one flag per peer would have cleared this').toBe(true);
        frames.length = 0;
        sent.length = 0;
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        expect(sent.filter(m => m.type === 'ControlInput')).toHaveLength(0);
        expect(frames.filter(f => decodeFrame(f)!.kind === FRAME_SEALED_INPUT)).toHaveLength(1);
    });
});

describe('injection order across batches', () => {
    it('a click that arrives after its move left on the leading edge still lands AFTER it', async () => {
        const key = await activeHost();
        const { dc, raw } = fakeDc();
        registerControlChannel(VIEWER, dc);
        raw.onmessage!({ data: await frameFor(key, 0, FRAME_HELLO) } as MessageEvent);
        await settle();
        injected.length = 0;
        // Slow the FIRST invoke down: a fast second invoke racing it is the
        // exact hazard. The mock records arrival order at the injector.
        const core = await import('@tauri-apps/api/core');
        const real = core.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        let stalled = false;
        (core as { invoke: typeof real }).invoke = async (cmd, args) => {
            if (!stalled && cmd === 'inject_input_batch') {
                stalled = true;
                await new Promise(r => setTimeout(r, 15));
            }
            return real(cmd, args);
        };
        try {
            const move = JSON.stringify({ s: 1, e: { t: 'move', x: 0.5, y: 0.5 } });
            const down = JSON.stringify({ s: 2, e: { t: 'down', button: 0 } });
            for (const body of [move, down]) {
                const bytes = await sealControlBytes(key, body);
                const wire = new Uint8Array(bytes.length + 1);
                wire[0] = FRAME_SEALED_INPUT;
                wire.set(bytes, 1);
                raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
                await settle(2); // the move leaves on the leading edge before the click arrives
            }
            await new Promise(r => setTimeout(r, 40));
            await settle();
            expect(injected.map(e => (e as { t: string }).t), 'move first, whatever the IPC did').toEqual(['move', 'down']);
        } finally {
            (core as { invoke: typeof real }).invoke = real;
        }
    });
});

describe('release order at session end', () => {
    it('the release never overtakes a batch still parked on the chain, and a batch queued for the ended session never lands after it', async () => {
        const key = await activeHost();
        const { dc, raw } = fakeDc();
        registerControlChannel(VIEWER, dc);
        raw.onmessage!({ data: await frameFor(key, 0, FRAME_HELLO) } as MessageEvent);
        await settle();
        injected.length = 0;
        // Batches are handed to the native queue one IPC round trip at a
        // time. Hold batch 1 inside its invoke (the round trip in flight),
        // queue batch 2 behind it, then end the session: the release must
        // not reach the native side ahead of anything the chain still holds,
        // or the native ReleaseAll (ordered only behind what has already
        // reached its FIFO) lets the late batch re-press its key for good.
        const core = await import('@tauri-apps/api/core');
        const real = core.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        /** Arrival order at the native seam: 'batch:<event kinds>' or 'release'. */
        const calls: string[] = [];
        let releaseBatch1!: () => void;
        const gate = new Promise<void>(r => { releaseBatch1 = r; });
        let stalled = false;
        (core as { invoke: typeof real }).invoke = async (cmd, args) => {
            if (cmd === 'inject_input_batch') {
                calls.push('batch:' + (args?.events as Array<{ t: string }>).map(e => e.t).join('+'));
                if (!stalled) { stalled = true; await gate; }
            } else if (cmd === 'release_control_input') {
                calls.push('release');
            }
            return real(cmd, args);
        };
        try {
            const sealed = async (seq: number, e: object) => {
                const bytes = await sealControlBytes(key, JSON.stringify({ s: seq, e }));
                const wire = new Uint8Array(bytes.length + 1);
                wire[0] = FRAME_SEALED_INPUT;
                wire.set(bytes, 1);
                raw.onmessage!({ data: wire.buffer.slice(0) } as MessageEvent);
                await settle(2);
            };
            await sealed(1, { t: 'move', x: 0.5, y: 0.5 });   // batch 1: left on the leading edge, now stalled
            expect(calls, 'batch 1 is in flight').toEqual(['batch:move']);
            await sealed(2, { t: 'key', code: 'KeyA', down: true }); // batch 2: parked behind it on the chain
            expect(calls, 'batch 2 waits for batch 1').toEqual(['batch:move']);

            const rc = await import('../api/remoteControl');
            rc.revokeControl();                                // endHostSession -> releaseInput
            await settle();
            expect(calls, 'the release must wait for batch 1 too').toEqual(['batch:move']);

            releaseBatch1();
            await settle();
            expect(calls, 'batch 1, then the release; the key-down queued for the ended session is dropped')
                .toEqual(['batch:move', 'release']);
            expect(calls.indexOf('release'), 'nothing is injected after the release').toBe(calls.length - 1);
            expect(injected.map(e => (e as { t: string }).t), 'the down never reached the desktop').toEqual(['move']);
        } finally {
            releaseBatch1();
            (core as { invoke: typeof real }).invoke = real;
        }
    });

    it('nothing in flight: ending the session still releases (the chain must not swallow an idle release)', async () => {
        await activeHost();
        const core = await import('@tauri-apps/api/core');
        const real = core.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        const calls: string[] = [];
        (core as { invoke: typeof real }).invoke = async (cmd, args) => {
            if (cmd === 'inject_input_batch' || cmd === 'release_control_input') calls.push(cmd);
            return real(cmd, args);
        };
        try {
            const rc = await import('../api/remoteControl');
            rc.revokeControl();
            await settle();
            expect(calls).toEqual(['release_control_input']);
        } finally {
            (core as { invoke: typeof real }).invoke = real;
        }
    });
});

describe('the hello handshake arms BOTH directions, not just the receiver', () => {
    it('echoes a hello back when one opens, exactly once per session', async () => {
        // THE BUG THIS PINS. Each side announces when its own key appears, and
        // the HOST's appears first — it derives on granting, while the viewer
        // only derives after the ControlResponse arrives, behind an await that
        // can include fetching the host's public key. So the host's hello lands
        // on a viewer with no key yet and is dropped, correctly and silently.
        // The viewer's own hello then arms the HOST's direction, and the host
        // never sends another — but the VIEWER is the side that sends input, so
        // input stayed on the relay for the whole call. Every sampler row of a
        // real session read lane=relay.
        const key = await activeHost();
        const { dc, raw } = fakeDc();
        const outbound: ArrayBuffer[] = [];
        raw.send = (b: ArrayBuffer) => { outbound.push(b); };
        registerControlChannel(VIEWER, dc);
        // A channel becoming usable ANNOUNCES on its own — that hello is not
        // the echo under test, and leaving it in the buffer would make this
        // pass with the echo removed.
        await settle();
        outbound.length = 0;

        raw.onmessage!({ data: await frameFor(key, 1, FRAME_HELLO) } as MessageEvent);
        await settle();

        const kinds = outbound.map(b => decodeFrame(b)?.kind);
        expect(kinds, 'the host answers a hello with a hello').toContain(FRAME_HELLO);

        // ...and only once, so two peers cannot ping-pong hellos at each other
        // for the life of the session.
        const after = outbound.length;
        raw.onmessage!({ data: await frameFor(key, 2, FRAME_HELLO) } as MessageEvent);
        await settle();
        expect(outbound.length, 'a second hello must not be echoed again').toBe(after);
    });

    it('does not echo a hello it could not open', async () => {
        // An unsealed or forged hello proves nothing; answering one would tell
        // an unauthenticated peer that this session exists.
        await activeHost();
        const { dc, raw } = fakeDc();
        const outbound: ArrayBuffer[] = [];
        raw.send = (b: ArrayBuffer) => { outbound.push(b); };
        registerControlChannel(VIEWER, dc);
        await settle();
        outbound.length = 0; // drop the channel-open announcement

        const wrongKey = new Uint8Array(32).fill(9);
        raw.onmessage!({ data: await frameFor(wrongKey, 1, FRAME_HELLO) } as MessageEvent);
        await settle();
        expect(outbound).toHaveLength(0);
    });
});
