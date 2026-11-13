/**
 * Control of a PHONE from a call, the page's half (api/remoteControl.ts with
 * api/phoneControl.ts): the Android app sharing its whole screen as the host,
 * and a viewer of it. The native half (the AccessibilityService) is stood in
 * for by a mock of phoneControl.ts; what reaches `injectPhoneControl` is what
 * the phone would tap, so that is what these tests count. The native rules
 * themselves are JUnit (frontend/android/phone-control/src/test), and the
 * whole thing on a real APK is e2e/android-control-live.mjs.
 *
 * Each case says what would have to break for it to go red.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cryptoInFlight, trackCrypto } from './fixtures/cryptoInFlight';

const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
/** Everything the page did, in order, across the socket and the native side. */
const order: string[] = [];
type Handler = (m: unknown) => void;
const handlers = new Map<string, Handler>();

vi.mock('../api/websocket', () => ({
    wsClient: {
        isConnected: true,
        on: (t: string, h: Handler) => { handlers.set(t, h); },
        send: (m: { type: string; payload?: Record<string, unknown> }) => { sent.push(m); order.push(`ws:${m.type}`); },
        bufferedAmount: () => 0,
    },
}));
// Not the desktop app: the only host kind left is a phone.
vi.mock('../api/platform', () => ({ isTauri: () => false, isMobile: () => true }));
let sharing = true;
vi.mock('../components/voiceState', () => ({
    getCurrentStreamingUserId: () => (sharing ? 1 : null),
    getStreamData: () => null,
    selectStream: () => {},
}));
vi.mock('../api/rtc/receiverLatency', () => ({
    clearAllScreenLatency: () => {},
    setScreenLatencyMinimised: () => {},
}));
let peerIdentityPub = '';
vi.mock('../api/dms', () => ({ getCachedPublicKey: async () => peerIdentityPub }));

const notified: Array<{ key: string; title: string }> = [];
vi.mock('../api/mobileApp', () => ({
    postMobileNotification: async (key: string, title: string) => { notified.push({ key, title }); },
    clearMobileNotifications: async () => {},
}));

// The native side, stood in for.
const phone = {
    possible: true,
    begin: { ok: true, refusal: null as string | null },
    /** When set, begin waits for it (the native session still starting). */
    gate: null as Promise<void> | null,
    begun: [] as string[],
    ended: 0,
    /** A native session is live: set when begin answers ok, cleared by end. */
    active: false,
    /** Runs while begin waits (after the gate opens, before it answers). */
    duringBegin: null as (() => void) | null,
    injected: [] as Array<Record<string, unknown>>,
    endedCb: null as ((reason: string) => void) | null,
};
vi.mock('../api/phoneControl', async () => {
    const real = await vi.importActual<typeof import('../api/phoneControl')>('../api/phoneControl');
    return {
        refusalWords: real.refusalWords,
        endedWords: real.endedWords,
        phoneHostPossible: () => phone.possible,
        beginPhoneControl: async (viewer: string) => {
            phone.begun.push(viewer);
            order.push('native:begin');
            if (phone.gate) await phone.gate;
            phone.duringBegin?.();
            order.push('native:begun');
            if (phone.begin.ok) phone.active = true;
            return phone.begin;
        },
        endPhoneControl: () => { phone.ended++; phone.active = false; },
        injectPhoneControl: async (events: Array<Record<string, unknown>>) => { phone.injected.push(...events); },
        onPhoneControlEnded: (cb: (reason: string) => void) => { phone.endedCb = cb; return () => {}; },
    };
});

import {
    makeIdentity, generateControlEphemeral, deriveControlSessionKey, sealControl, openControl,
    setActiveIdentity,
} from '../api/e2ee';

const VIEWER = 42;

const settle = async (rounds = 10) => {
    const giveUp = performance.now() + 3_000;
    for (let i = 0, calm = 0; i < rounds || calm < 2; i++) {
        if (performance.now() > giveUp) throw new Error(`${cryptoInFlight()} WebCrypto calls still out after 3 s`);
        await new Promise(r => setTimeout(r, 0));
        calm = cryptoInFlight() === 0 ? calm + 1 : 0;
    }
};

/** A viewer's request reaching this phone; returns what the viewer holds. */
async function request() {
    const rc = await import('../api/remoteControl');
    const me = makeIdentity(new Uint8Array(32).fill(3));
    const viewer = makeIdentity(new Uint8Array(32).fill(4));
    setActiveIdentity(me);
    peerIdentityPub = viewer.publicKeyEncoded;
    rc.initRemoteControl();
    sent.length = 0;
    const viewerEph = generateControlEphemeral();
    handlers.get('ControlRequested')!({
        payload: { from_user: VIEWER, from_username: 'Aoife', eph: viewerEph.pubEncoded },
    });
    await settle();
    return { rc, me, viewer, viewerEph };
}

/** Allowed on the phone; returns the session key the viewer derives. */
async function allowed(): Promise<Uint8Array> {
    const { rc, me, viewer, viewerEph } = await request();
    await rc.respondToControlRequest(true);
    await settle();
    const resp = sent.find(m => m.type === 'ControlResponse');
    expect(resp?.payload?.granted, 'the grant went out').toBe(true);
    const key = deriveControlSessionKey(viewer.privateKey, me.publicKeyEncoded, viewerEph.priv, resp!.payload!.eph as string);
    expect(key).not.toBeNull();
    return key!;
}

/** The viewer's sealed input arriving over the relay (`extra`: more of the
 *  sealed plaintext, such as the lane tag). */
async function input(key: Uint8Array, s: number, e: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const sealed = await sealControl(key, JSON.stringify({ s, e, ...extra }));
    handlers.get('ControlInput')!({ payload: { from_user: VIEWER, event: sealed } });
    await settle();
}

/** The HostInfo frames sent to the viewer so far, opened. */
async function hostInfos(key: Uint8Array) {
    const out: unknown[] = [];
    for (const m of sent) {
        if (m.type !== 'ControlInput' || m.payload?.target_user !== VIEWER) continue;
        const plain = await openControl(key, m.payload.event as string);
        if (plain) out.push(JSON.parse(plain));
    }
    return out;
}

let untrack: () => void = () => {};
beforeEach(async () => {
    untrack = trackCrypto();
    const rc = await import('../api/remoteControl');
    rc.resetRemoteControl();
    sent.length = 0;
    order.length = 0;
    notified.length = 0;
    sharing = true;
    phone.possible = true;
    phone.begin = { ok: true, refusal: null };
    phone.gate = null;
    phone.begun.length = 0;
    phone.ended = 0;
    phone.active = false;
    phone.duringBegin = null;
    phone.injected.length = 0;
});
afterEach(() => { untrack(); });

describe('a phone sharing its screen, as the host', () => {
    it('asks the person (no auto-deny) and says so in the notification shade', async () => {
        const { rc } = await request();
        expect(rc.getControlState().incomingRequest?.username, 'the prompt is up').toBe('Aoife');
        expect(sent.some(m => m.type === 'ControlResponse'), 'nothing answered before the person did').toBe(false);
        // The phone is usually showing another app while it shares.
        expect(notified.map(n => n.title)).toContain('Aoife wants to control this phone');
    });

    it('a phone NOT sharing from the app refuses at once, with no prompt', async () => {
        phone.possible = false;
        const { rc } = await request();
        expect(rc.getControlState().incomingRequest).toBeNull();
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
    });

    it('Allow starts the native session for THAT viewer before the grant goes out', async () => {
        await allowed();
        expect(phone.begun).toEqual(['Aoife']);
        // The ORDER is the point: a grant before the native session had
        // started would hand the viewer a key while nothing could land, or
        // while the native side was still free to refuse.
        const begun = order.indexOf('native:begun');
        const grant = order.lastIndexOf('ws:ControlResponse');
        expect(begun, 'the native session started').toBeGreaterThanOrEqual(0);
        expect(grant, 'the grant went out after it').toBeGreaterThan(begun);
    });

    it('the native side refusing (the Accessibility switch off) grants nothing', async () => {
        phone.begin = { ok: false, refusal: 'service-disabled' };
        const { rc } = await request();
        await rc.respondToControlRequest(true);
        await settle();
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
        expect(rc.getControlState().controlledBy, 'no session').toBeNull();
        expect(rc.getControlState().notice).toMatch(/Accessibility/);
    });

    it('tells its viewer it is a phone, sealed, with no sequence number of the input namespace', async () => {
        const key = await allowed();
        const info = sent.filter(m => m.type === 'ControlInput' && m.payload?.target_user === VIEWER);
        expect(info, 'one HostInfo frame').toHaveLength(1);
        const plain = await openControl(key, info[0].payload!.event as string);
        expect(plain, 'it opens under the session key').not.toBeNull();
        const obj = JSON.parse(plain!);
        expect(obj).toEqual({ n: 1, i: { kind: 'phone' } });
        expect('s' in obj, 'never an `s`: a reflected one must not move the host input counter').toBe(false);
    });

    it('the viewer\'s input reaches the phone in order, nav and text included, each with its arrival time', async () => {
        const key = await allowed();
        await input(key, 1, { t: 'move', x: 0.5, y: 0.25 });
        await input(key, 2, { t: 'down', button: 0 });
        await input(key, 3, { t: 'up', button: 0 });
        await input(key, 4, { t: 'nav', a: 'back' });
        await input(key, 5, { t: 'text', s: 'hi' });
        expect(phone.injected.map(e => e.t)).toEqual(['move', 'down', 'up', 'nav', 'text']);
        expect(phone.injected.every(e => typeof e.at === 'number'), 'arrival times for the live replay').toBe(true);
        expect(phone.injected[3]).toMatchObject({ a: 'back' });
        expect(phone.injected[4]).toMatchObject({ s: 'hi' });
    });

    it('a phone\'s own event that is malformed is dropped', async () => {
        const key = await allowed();
        await input(key, 1, { t: 'nav', a: 'power' });
        await input(key, 2, { t: 'text', s: 'x'.repeat(65) });
        await input(key, 3, { t: 'text', s: '' });
        expect(phone.injected).toHaveLength(0);
        // POSITIVE CONTROL: a well-formed one after them lands.
        await input(key, 4, { t: 'nav', a: 'home' });
        expect(phone.injected).toHaveLength(1);
    });

    it('its own HostInfo reflected back at it (the server could) does not break the viewer\'s input', async () => {
        const key = await allowed();
        const info = sent.find(m => m.type === 'ControlInput')!;
        handlers.get('ControlInput')!({ payload: { from_user: VIEWER, event: info.payload!.event } });
        await settle();
        expect(phone.injected, 'the info frame is not input').toHaveLength(0);
        await input(key, 1, { t: 'down', button: 0 });
        expect(phone.injected, 'the viewer\'s FIRST input still lands').toHaveLength(1);
    });

    it('the phone ending it itself (Stop in the notification) tells the viewer and stops input', async () => {
        const key = await allowed();
        const { getControlState } = await import('../api/remoteControl');
        sent.length = 0;
        phone.endedCb!('notification');
        await settle();
        expect(sent.some(m => m.type === 'ControlEnd' && m.payload?.target_user === VIEWER), 'the viewer is told').toBe(true);
        expect(getControlState().controlledBy).toBeNull();
        expect(getControlState().notice).toBe('You stopped remote control.');
        await input(key, 1, { t: 'down', button: 0 });
        expect(phone.injected, 'NEGATIVE CONTROL: nothing after the end').toHaveLength(0);
    });

    it('the in-app Stop ends the native session too', async () => {
        await allowed();
        const rc = await import('../api/remoteControl');
        rc.revokeControl();
        await settle();
        expect(phone.ended).toBeGreaterThanOrEqual(1);
    });

    it('a viewer who withdraws while the phone starts its session gets no grant, and the session is taken down', async () => {
        let release: () => void = () => {};
        phone.gate = new Promise<void>(r => { release = r; });
        const { rc } = await request();
        const answered = rc.respondToControlRequest(true);
        await settle();
        expect(phone.begun, 'the native session is starting').toEqual(['Aoife']);
        // The viewer cancels meanwhile.
        handlers.get('ControlEnded')!({ payload: { from_user: VIEWER } });
        expect(phone.ended, 'Android\'s dialog, still asking, is taken down at once').toBe(1);
        // Its Allow was pressed meanwhile: the native session starts anyway.
        release();
        await answered;
        await settle();
        expect(sent.some(m => m.type === 'ControlResponse' && m.payload?.granted === true), 'no grant to nobody').toBe(false);
        expect(rc.getControlState().controlledBy).toBeNull();
        expect(phone.active, 'and the session that started after the withdrawal is ended').toBe(false);
    });

    it('the share ending ends control at once, natively too, and sharing again gives nothing back', async () => {
        const key = await allowed();
        await input(key, 1, { t: 'down', button: 0 });
        expect(phone.injected, 'POSITIVE CONTROL: in control before').toHaveLength(1);
        const rc = await import('../api/remoteControl');
        sent.length = 0;
        const endedBefore = phone.ended;
        // Any way a share stops ends in voiceState.dropOwnStream, which says so.
        sharing = false;
        window.dispatchEvent(new CustomEvent('ownShareEnded'));
        await settle();
        expect(sent.some(m => m.type === 'ControlEnd' && m.payload?.target_user === VIEWER), 'the viewer is told').toBe(true);
        expect(rc.getControlState().controlledBy, 'no session').toBeNull();
        expect(phone.ended, 'the native session ended').toBeGreaterThan(endedBefore);
        // Sharing again: the old session must not come back.
        sharing = true;
        await input(key, 2, { t: 'up', button: 0 });
        await input(key, 3, { t: 'down', button: 0 });
        expect(phone.injected, 'nothing lands without a new Allow').toHaveLength(1);
    });

    it('a request waiting when the share ends is answered No and its prompt goes', async () => {
        const { rc } = await request();
        expect(rc.getControlState().incomingRequest).not.toBeNull();
        sharing = false;
        window.dispatchEvent(new CustomEvent('ownShareEnded'));
        await settle();
        expect(rc.getControlState().incomingRequest).toBeNull();
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
        expect(phone.begun).toHaveLength(0);
    });

    it('Allow pressed after the share ended under the prompt grants nothing', async () => {
        const { rc } = await request();
        sharing = false; // no event: the prompt is still up
        await rc.respondToControlRequest(true);
        await settle();
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
        expect(phone.begun, 'no native session').toHaveLength(0);
        expect(rc.getControlState().controlledBy).toBeNull();
    });

    it('the share ending while the native session starts gets a No, and the session is taken down', async () => {
        let release: () => void = () => {};
        phone.gate = new Promise<void>(r => { release = r; });
        const { rc } = await request();
        const answered = rc.respondToControlRequest(true);
        await settle();
        sharing = false;
        release();
        await answered;
        await settle();
        expect(sent.some(m => m.type === 'ControlResponse' && m.payload?.granted === true)).toBe(false);
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
        expect(phone.ended).toBeGreaterThanOrEqual(1);
        expect(rc.getControlState().controlledBy).toBeNull();
    });

    it('says what it is again once the viewer proves it has the key, and only once', async () => {
        const key = await allowed();
        expect(await hostInfos(key), 'the one sent with the grant').toHaveLength(1);
        await input(key, 1, { t: 'move', x: 0.5, y: 0.5 });
        const infos = await hostInfos(key);
        expect(infos, 'again on the first input (the first may have reached a viewer with no key yet)').toHaveLength(2);
        expect(infos[1]).toEqual({ n: 2, i: { kind: 'phone' } });
        await input(key, 2, { t: 'move', x: 0.4, y: 0.5 });
        await input(key, 3, { t: 'move', x: 0.3, y: 0.5 });
        expect(await hostInfos(key), 'not on every input').toHaveLength(2);
    });

    it('takes relay input sealed for the relay (or by an older viewer, untagged), never a frame sealed for the data lane', async () => {
        const key = await allowed();
        // A frame from the SFU's data path, replayed on the relay by the
        // server: its number is far ahead of the relay's counter.
        await input(key, 5000, { t: 'down', button: 0 }, { l: 'p' });
        expect(phone.injected, 'a data-lane frame on the relay is dropped').toHaveLength(0);
        await input(key, 1, { t: 'down', button: 0 }, { l: 'r' });
        expect(phone.injected, 'POSITIVE CONTROL: a relay frame lands').toHaveLength(1);
        await input(key, 2, { t: 'up', button: 0 });
        expect(phone.injected, 'an older viewer, with no tag, still works').toHaveLength(2);
        const { laneOk } = await import('../api/remoteControl');
        expect(laneOk({ l: 'r' }, 'p')).toBe(false);
        expect(laneOk({ l: 'p' }, 'p')).toBe(true);
        expect(laneOk({ l: 'x' }, 'r')).toBe(false);
        expect(laneOk({}, 'p')).toBe(true);
    });

    it('a viewer who withdraws while the phone starts an OFFERED session gets no grant, and the session is taken down', async () => {
        const rc = await import('../api/remoteControl');
        const me = makeIdentity(new Uint8Array(32).fill(3));
        const viewer = makeIdentity(new Uint8Array(32).fill(4));
        setActiveIdentity(me);
        peerIdentityPub = viewer.publicKeyEncoded;
        rc.initRemoteControl();
        rc.offerControl(VIEWER, 'Aoife');
        sent.length = 0;
        let release: () => void = () => {};
        phone.gate = new Promise<void>(r => { release = r; });
        // The viewer takes the offer: its request is the acceptance.
        handlers.get('ControlRequested')!({
            payload: { from_user: VIEWER, from_username: 'Aoife', eph: generateControlEphemeral().pubEncoded },
        });
        await settle();
        expect(phone.begun, 'the native session is starting').toEqual(['Aoife']);
        handlers.get('ControlEnded')!({ payload: { from_user: VIEWER } });
        release();
        await settle();
        expect(sent.some(m => m.type === 'ControlResponse' && m.payload?.granted === true), 'no grant to nobody').toBe(false);
        expect(rc.getControlState().controlledBy).toBeNull();
        expect(phone.active, 'the session that started after the withdrawal is ended').toBe(false);
    });

    it('a native end before the page recorded its grant (Allow, then the screen off) grants nothing', async () => {
        const { rc } = await request();
        // The phone answers "started" and, before the page goes on, says the
        // session is over (the order Capacitor delivers them in makes this
        // narrow; it must not matter).
        phone.duringBegin = () => phone.endedCb!('screen-off');
        await rc.respondToControlRequest(true);
        await settle();
        expect(sent.some(m => m.type === 'ControlResponse' && m.payload?.granted === true), 'no grant').toBe(false);
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
        expect(rc.getControlState().controlledBy, 'no session the phone does not have').toBeNull();
        expect(rc.getControlState().notice).toBe('Remote control ended: the phone\'s screen went off.');
    });

    it('a second request while a phone is still starting the session it allowed is refused', async () => {
        let release: () => void = () => {};
        phone.gate = new Promise<void>(r => { release = r; });
        const { rc } = await request();
        const answered = rc.respondToControlRequest(true);
        await settle();
        sent.length = 0;
        handlers.get('ControlRequested')!({
            payload: { from_user: 77, from_username: 'Other', eph: generateControlEphemeral().pubEncoded },
        });
        await settle();
        expect(sent.find(m => m.payload?.target_user === 77)?.payload?.granted, 'refused at once').toBe(false);
        expect(rc.getControlState().incomingRequest, 'no second prompt').toBeNull();
        release();
        await answered;
        await settle();
        expect(rc.getControlState().controlledBy?.userId, 'the first one goes on').toBe(VIEWER);
    });

    it('Cancel in Android\'s own dialog is a Deny: no grant, and the next request is refused without a prompt', async () => {
        phone.begin = { ok: false, refusal: 'declined' };
        const rc = await import('../api/remoteControl');
        rc.initRemoteControl();
        sent.length = 0;
        handlers.get('ControlRequested')!({ payload: { from_user: 99, from_username: 'Cian', eph: 'x' } });
        await settle();
        await rc.respondToControlRequest(true);
        await settle();
        expect(phone.begun, 'the page asked the phone').toEqual(['Cian']);
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
        expect(rc.getControlState().controlledBy).toBeNull();
        expect(rc.getControlState().notice).toBe('Control not started: you chose Cancel.');
        sent.length = 0;
        handlers.get('ControlRequested')!({ payload: { from_user: 99, from_username: 'Cian', eph: 'x' } });
        await settle();
        expect(rc.getControlState().incomingRequest, 'on the denial ladder: no prompt').toBeNull();
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
    });

    it('a request taken back before it is answered steps the denial ladder: a Request / Cancel loop gets one prompt', async () => {
        const rc = await import('../api/remoteControl');
        rc.initRemoteControl();
        sent.length = 0;
        notified.length = 0;
        const ask = () => handlers.get('ControlRequested')!({ payload: { from_user: 66, from_username: 'Loop', eph: 'x' } });
        ask();
        await settle();
        expect(rc.getControlState().incomingRequest?.userId, 'POSITIVE CONTROL: the first is asked').toBe(66);
        expect(notified.filter(n => /Loop/.test(n.title))).toHaveLength(1);
        // Its own cancel button, at once.
        handlers.get('ControlEnded')!({ payload: { from_user: 66 } });
        await settle();
        expect(rc.getControlState().incomingRequest).toBeNull();
        sent.length = 0;
        ask();
        await settle();
        expect(rc.getControlState().incomingRequest, 'no second prompt').toBeNull();
        expect(notified.filter(n => /Loop/.test(n.title)), 'and no second notification').toHaveLength(1);
        expect(sent.find(m => m.payload?.target_user === 66)?.payload?.granted, 'refused unseen').toBe(false);
    });

    it('an OFFER taken up says so in the shade while Android\'s own dialog asks', async () => {
        let release: () => void = () => {};
        phone.gate = new Promise<void>(r => { release = r; });
        const rc = await import('../api/remoteControl');
        const me = makeIdentity(new Uint8Array(32).fill(3));
        const viewer = makeIdentity(new Uint8Array(32).fill(4));
        setActiveIdentity(me);
        peerIdentityPub = viewer.publicKeyEncoded;
        rc.initRemoteControl();
        rc.offerControl(VIEWER, 'Aoife');
        notified.length = 0;
        handlers.get('ControlRequested')!({
            payload: { from_user: VIEWER, from_username: 'Aoife', eph: generateControlEphemeral().pubEncoded },
        });
        await settle();
        expect(phone.begun, 'Android\'s dialog is asking').toEqual(['Aoife']);
        expect(notified.map(n => n.title), 'the person, usually in another app, is told').toContain('Aoife took your offer to control this phone');
        release();
        await settle();
        expect(rc.getControlState().controlledBy?.userId).toBe(VIEWER);
    });

    it('input after the share stopped is not injected', async () => {
        const key = await allowed();
        sharing = false;
        await input(key, 1, { t: 'down', button: 0 });
        expect(phone.injected).toHaveLength(0);
    });

    // LAST: a Deny puts this viewer on the host's denial ladder, which
    // silently refuses their next request for a while.
    it('Deny starts nothing natively', async () => {
        const { rc } = await request();
        await rc.respondToControlRequest(false);
        await settle();
        expect(phone.begun).toHaveLength(0);
        expect(sent.find(m => m.type === 'ControlResponse')?.payload?.granted).toBe(false);
    });
});

describe('the viewer of a phone', () => {
    // Its own peer: the host tests above pinned HOST's identity key, and
    // serving another key for the same id is (rightly) refused as a change.
    const HOST = 43;
    /** I request control of a host, which grants; returns the session key. */
    async function viewing(): Promise<Uint8Array> {
        const rc = await import('../api/remoteControl');
        const me = makeIdentity(new Uint8Array(32).fill(5));
        const host = makeIdentity(new Uint8Array(32).fill(6));
        setActiveIdentity(me);
        peerIdentityPub = host.publicKeyEncoded;
        rc.initRemoteControl();
        sent.length = 0;
        rc.requestControl(HOST, 'Phone person');
        const req = sent.find(m => m.type === 'ControlRequest')!;
        const hostEph = generateControlEphemeral();
        handlers.get('ControlResponse')!({ payload: { from_user: HOST, granted: true, eph: hostEph.pubEncoded } });
        await settle();
        const key = deriveControlSessionKey(host.privateKey, me.publicKeyEncoded, hostEph.priv, req.payload!.eph as string);
        return key!;
    }
    async function info(key: Uint8Array, body: unknown) {
        const sealed = await sealControl(key, JSON.stringify(body));
        handlers.get('ControlInput')!({ payload: { from_user: HOST, event: sealed } });
        await settle();
    }

    it('learns its host is a phone from the sealed HostInfo', async () => {
        const key = await viewing();
        const rc = await import('../api/remoteControl');
        expect(rc.getControlHostKind(), 'a desktop until told').toBeNull();
        await info(key, { n: 1, i: { kind: 'phone' } });
        expect(rc.getControlHostKind()).toBe('phone');
    });

    it('a HostInfo under the wrong key, or shaped as input, says nothing', async () => {
        const key = await viewing();
        const rc = await import('../api/remoteControl');
        await info(new Uint8Array(32).fill(9), { n: 1, i: { kind: 'phone' } });
        expect(rc.getControlHostKind(), 'the server cannot tell me what the host is').toBeNull();
        await info(key, { s: 1, i: { kind: 'phone' } });
        expect(rc.getControlHostKind(), 'no `n`, no info').toBeNull();
        // POSITIVE CONTROL.
        await info(key, { n: 1, i: { kind: 'phone' } });
        expect(rc.getControlHostKind()).toBe('phone');
    });

    it('seals its relay input with the relay\'s lane tag', async () => {
        const key = await viewing();
        const rc = await import('../api/remoteControl');
        sent.length = 0;
        rc.sendControlEvent({ t: 'down', button: 0 });
        await settle();
        const frame = sent.find(m => m.type === 'ControlInput' && m.payload?.target_user === HOST);
        expect(frame, 'sent on the relay').toBeDefined();
        const plain = await openControl(key, frame!.payload!.event as string);
        expect(JSON.parse(plain!)).toMatchObject({ s: 1, l: 'r', e: { t: 'down', button: 0 } });
    });

    it('a request it takes back makes it wait before asking again, and says so without calling it a decline', async () => {
        const rc = await import('../api/remoteControl');
        rc.initRemoteControl();
        rc.requestControl(55, 'Someone');
        expect(rc.getControlState().controlling?.status).toBe('requesting');
        rc.stopControlling();
        sent.length = 0;
        rc.requestControl(55, 'Someone');
        expect(sent.some(m => m.type === 'ControlRequest'), 'nothing sent the host would refuse unseen').toBe(false);
        expect(rc.getControlState().notice).toMatch(/^You can ask Someone again in /);
    });

    it('forgets it when the session ends', async () => {
        const key = await viewing();
        const rc = await import('../api/remoteControl');
        await info(key, { n: 1, i: { kind: 'phone' } });
        rc.stopControlling();
        expect(rc.getControlHostKind()).toBeNull();
    });
});

describe('a request nobody answers', () => {
    it('gives up after VIEWER_REQUEST_TIMEOUT_MS and tells the host it is withdrawn', async () => {
        vi.useFakeTimers();
        try {
            const rc = await import('../api/remoteControl');
            rc.initRemoteControl();
            sent.length = 0;
            rc.requestControl(VIEWER, 'Lite person');
            expect(rc.getControlState().controlling?.status).toBe('requesting');
            vi.advanceTimersByTime(rc.VIEWER_REQUEST_TIMEOUT_MS - 1);
            expect(rc.getControlState().controlling?.status, 'still waiting just before').toBe('requesting');
            vi.advanceTimersByTime(1);
            expect(rc.getControlState().controlling).toBeNull();
            expect(sent.some(m => m.type === 'ControlEnd' && m.payload?.target_user === VIEWER)).toBe(true);
            expect(rc.getControlState().notice).toMatch(/No answer from Lite person/);
        } finally {
            vi.useRealTimers();
        }
    });

    it('an answer in time cancels the give-up', async () => {
        vi.useFakeTimers();
        try {
            const rc = await import('../api/remoteControl');
            rc.initRemoteControl();
            rc.requestControl(VIEWER, 'Someone');
            handlers.get('ControlResponse')!({ payload: { from_user: VIEWER, granted: false } });
            sent.length = 0;
            vi.advanceTimersByTime(rc.VIEWER_REQUEST_TIMEOUT_MS * 2);
            expect(sent.some(m => m.type === 'ControlEnd'), 'no stray withdrawal after a refusal').toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('a phone prompt\'s deadline', () => {
    it('is extended for Android\'s settings to 120 s from the REQUEST, however often the button is pressed', async () => {
        vi.useFakeTimers();
        try {
            const rc = await import('../api/remoteControl');
            rc.initRemoteControl();
            sent.length = 0;
            // No await on this path: it runs to the end at once.
            handlers.get('ControlRequested')!({ payload: { from_user: 88, from_username: 'Slow', eph: 'x' } });
            expect(rc.getControlState().incomingRequest?.userId).toBe(88);
            vi.advanceTimersByTime(30_000);
            rc.extendControlPrompt(); // went to Android's settings
            vi.advanceTimersByTime(80_000);
            rc.extendControlPrompt(); // and again, at 110 s
            vi.advanceTimersByTime(10_000 - 1);
            expect(rc.getControlState().incomingRequest, 'still up just before 120 s').not.toBeNull();
            vi.advanceTimersByTime(1);
            expect(rc.getControlState().incomingRequest, 'gone at 120 s, inside the viewer\'s own wait').toBeNull();
            expect(sent.find(m => m.payload?.target_user === 88)?.payload?.granted).toBe(false);
            // Android's own dialog can open as late as that, and the viewer
            // must still be waiting when it is answered.
            expect(rc.PHONE_SETTINGS_DEADLINE_MS + rc.PHONE_CONFIRM_MS).toBeLessThan(rc.VIEWER_REQUEST_TIMEOUT_MS);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the wire\'s phone vocabulary', () => {
    it('validEvent takes the three buttons and short text, and nothing else of them', async () => {
        const { validEvent } = await import('../api/remoteControl');
        expect(validEvent({ t: 'nav', a: 'back' })).toBe(true);
        expect(validEvent({ t: 'nav', a: 'recents' })).toBe(true);
        expect(validEvent({ t: 'nav', a: 'power' })).toBe(false);
        expect(validEvent({ t: 'nav' })).toBe(false);
        expect(validEvent({ t: 'text', s: 'héllo' })).toBe(true);
        expect(validEvent({ t: 'text', s: '' })).toBe(false);
        expect(validEvent({ t: 'text', s: 'x'.repeat(65) })).toBe(false);
        expect(validEvent({ t: 'text', s: 5 })).toBe(false);
    });
});
