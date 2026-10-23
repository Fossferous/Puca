// @vitest-environment jsdom
/**
 * The mesh manager on an engine with the STANDARD WebRTC Encoded Transform
 * (RTCRtpScriptTransform: Firefox, Safari, the iPhone home-screen app) and no
 * createEncodedStreams.
 *
 * Until it had this path, the manager treated those engines as unable to
 * encrypt: with "Require encryption for calls" on — the default — it
 * published nothing and dropped every inbound track, so an iPhone user could
 * not take part in a mesh call at all. These pin the other side of that:
 * such an engine now publishes, with every sender sealed and every receiver
 * opened in the worker, and the guards that made the old behaviour safe still
 * hold wherever a transform is missing — a sender or receiver it could not be
 * attached to, or a worker that would not start, which rebuilds every peer
 * into exactly what an engine without the API gets.
 *
 * The negative cases run on the same rig as their positive controls, so a
 * manager that refused everyone, or published everything, cannot pass both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));
const sent = vi.hoisted(() => [] as Array<{ type: string; to: number; body: string }>);
vi.mock('../api/websocket', () => ({
    wsClient: {
        on: () => {}, off: () => {},
        sendOffer: (to: number, body: string) => { sent.push({ type: 'offer', to, body }); },
        sendAnswer: (to: number, body: string) => { sent.push({ type: 'answer', to, body }); },
        sendIceCandidate: () => {},
    },
}));

import { WebRTCManager } from '../api/rtc/manager';
import { __setScriptTransformWorkerFactory, PeerMediaCrypto, type TransformWorkerLike } from '../api/rtc/scriptTransform';
import type { ScriptTransformCommand } from '../api/rtc/scriptTransformWorker';

/** What happened, in order, across every connection: codec preferences, descriptions. */
const events: string[] = [];

class FakeSender {
    track: unknown;
    transform: unknown = null;
    replaced: unknown[] = [];
    constructor(track: unknown) { this.track = track; }
    replaceTrack(t: unknown) { this.replaced.push(t); this.track = t; return Promise.resolve(); }
}

/** Set to hand every new receiver a createEncodedStreams (the Chromium engine). */
let receiverPipe: (() => unknown) | null = null;

class FakeTransceiver {
    sender: { track: unknown };
    receiver: { track: { kind: string }; transform: unknown; createEncodedStreams?: () => unknown };
    constructor(kind: string, sender?: FakeSender) {
        this.sender = sender ?? { track: null };
        this.receiver = { track: { kind }, transform: null, ...(receiverPipe ? { createEncodedStreams: receiverPipe } : {}) };
    }
    setCodecPreferences(codecs: Array<{ mimeType: string }>) { events.push(`prefs:${codecs[0].mimeType}`); }
}

const pcs: FakeRTCPeerConnection[] = [];
class FakeRTCPeerConnection {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: ((e: unknown) => void) | null = null;
    onconnectionstatechange: unknown = null;
    oniceconnectionstatechange: unknown = null;
    ondatachannel: unknown = null;
    connectionState = 'new';
    signalingState = 'stable';
    iceConnectionState = 'new';
    localDescription: { type: string; sdp: string } | null = null;
    remoteDescription: unknown = null;
    config: Record<string, unknown>;
    senders: FakeSender[] = [];
    transceivers: FakeTransceiver[] = [new FakeTransceiver('video')];
    closed = false;
    constructor(config: Record<string, unknown>) { this.config = config; pcs.push(this); }
    getSenders() { return this.senders; }
    getReceivers() { return []; }
    getTransceivers() { return this.transceivers; }
    addTrack(track: unknown) {
        if (this.closed) throw new DOMException('closed', 'InvalidStateError');
        const s = new FakeSender(track);
        this.senders.push(s);
        this.transceivers.push(new FakeTransceiver((track as { kind: string }).kind, s));
        return s;
    }
    addTransceiver(kind: string) {
        const t = new FakeTransceiver(kind);
        this.transceivers.push(t);
        return t;
    }
    createDataChannel() { return { close: () => {}, addEventListener: () => {} }; }
    async setRemoteDescription(d: { type: string }) {
        events.push(`srd:${d.type}`);
        this.remoteDescription = d;
        this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
    }
    async setLocalDescription() {
        const type = this.signalingState === 'have-remote-offer' ? 'answer' : 'offer';
        events.push(`sld:${type}`);
        this.localDescription = { type, sdp: 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
        this.signalingState = type === 'answer' ? 'stable' : 'have-local-offer';
    }
    async addIceCandidate() {}
    async getStats() { return new Map(); }
    close() { this.closed = true; }
}

class FakeScriptTransform {
    options: { op: string; slot: string };
    static failNext = false;
    constructor(_worker: unknown, options: { op: string; slot: string }) {
        if (FakeScriptTransform.failNext) { FakeScriptTransform.failNext = false; throw new Error('no transform'); }
        this.options = options;
    }
}

class FakeWorker implements TransformWorkerLike {
    posted: ScriptTransformCommand[] = [];
    private fns: Record<string, Array<(ev: never) => void>> = { message: [], error: [] };
    postMessage(m: ScriptTransformCommand) { this.posted.push(m); }
    addEventListener(type: 'message' | 'error', fn: (ev: never) => void) { this.fns[type].push(fn); }
    terminate() {}
    emit(type: 'message' | 'error', ev: unknown) { for (const fn of this.fns[type]) fn(ev as never); }
}

let worker: FakeWorker;

/** An engine with the standard API and nothing else (Firefox, Safari). */
function scriptEngine() {
    class Sender {}
    class Receiver {}
    for (const C of [Sender, Receiver]) (C.prototype as unknown as Record<string, unknown>).transform = null;
    vi.stubGlobal('RTCRtpSender', Sender);
    vi.stubGlobal('RTCRtpReceiver', Object.assign(Receiver, {
        getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000 }, { mimeType: 'video/VP8', clockRate: 90000 }], headerExtensions: [] }),
    }));
    vi.stubGlobal('RTCRtpScriptTransform', FakeScriptTransform);
    vi.stubGlobal('Worker', class {});
}

/** An engine with neither API (an older browser) — but with codec capabilities,
 *  as every WebRTC engine has, so a codec pin COULD be applied here. */
function noEngine() {
    vi.stubGlobal('RTCRtpSender', class {});
    vi.stubGlobal('RTCRtpReceiver', Object.assign(class {}, {
        getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000 }, { mimeType: 'video/VP8', clockRate: 90000 }], headerExtensions: [] }),
    }));
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const mic = { kind: 'audio', id: 'mic', enabled: true, readyState: 'live', stop: () => {} };

/** Every manager a test made, left by afterEach (which clears their timers). */
const managers: WebRTCManager[] = [];
function manager(): WebRTCManager {
    const mgr = new WebRTCManager();
    managers.push(mgr);
    return mgr;
}

async function inCall(required: boolean) {
    const mgr = manager();
    mgr.setLocalUserId(1);
    mgr.setRequireMediaE2ee(required);
    const local = { id: 'local', getTracks: () => [mic], getAudioTracks: () => [mic], getVideoTracks: () => [] };
    const media = (mgr as unknown as { media: { getLocalStreamSync: () => unknown; getScreenShareStreamSync: () => unknown } }).media;
    media.getLocalStreamSync = () => local;
    media.getScreenShareStreamSync = () => null;
    await mgr.callUser(2);
    await settle();
    return mgr;
}

const peerOf = (mgr: WebRTCManager, id: number) =>
    (mgr as unknown as { peers: Map<number, { mediaCrypto: PeerMediaCrypto; connection: FakeRTCPeerConnection }> }).peers.get(id);

function deliver(pc: FakeRTCPeerConnection, receiver: { transform: unknown }) {
    const track = { kind: 'audio', id: 'their-voice' };
    pc.ontrack?.({ track, streams: [{ id: 'theirs', getTracks: () => [track] }], receiver });
}

beforeEach(() => {
    pcs.length = 0;
    events.length = 0;
    sent.length = 0;
    worker = new FakeWorker();
    receiverPipe = null;
    FakeScriptTransform.failNext = false;
    __setScriptTransformWorkerFactory(() => worker);
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
});

afterEach(() => {
    for (const m of managers.splice(0)) m.closeAll();
    vi.unstubAllGlobals();
    __setScriptTransformWorkerFactory(null);
});

describe('mesh calls on an engine with only RTCRtpScriptTransform', () => {
    it('publishes under the default enforcement, every sender sealed in the worker (no longer blocked)', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const pc = pcs[0];
        expect(pc.senders.map(s => (s.track as { id: string }).id), 'the mic was held back on an engine that can encrypt').toEqual(['mic']);
        const t = pc.senders[0].transform as FakeScriptTransform;
        expect(t, 'a sender went out with no frame transform').toBeInstanceOf(FakeScriptTransform);
        const slot = peerOf(mgr, 2)!.mediaCrypto.slot;
        expect(t.options).toEqual({ op: 'seal', slot });
        expect(worker.posted[0]).toMatchObject({ type: 'state', slot, requireE2ee: true, enabled: false, key: null });
        expect(pc.config.encodedInsertableStreams, 'the createEncodedStreams flag belongs to the other path').toBeUndefined();
        expect(mgr.mediaE2eeStatus(2)?.reason).not.toBe('local-unsupported');
    });

    it('wraps the receivers of its own transceivers BEFORE negotiation (Chromium ignores one set in the offerer\'s ontrack)', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const slot = peerOf(mgr, 2)!.mediaCrypto.slot;
        const mine = pcs[0].transceivers.find(t => t.sender.track === mic)!;
        expect((mine.receiver.transform as FakeScriptTransform | null)?.options,
            'the receiver beside the mic had no transform before the answer — Chromium would decode what it gets unopened').toEqual({ op: 'open', slot });

        // Listen-only: the receive-only transceiver is ours too.
        const quiet = manager();
        quiet.setLocalUserId(1);
        quiet.setRequireMediaE2ee(true);
        (quiet as unknown as { media: { getLocalStreamSync: () => unknown; getScreenShareStreamSync: () => unknown } }).media.getLocalStreamSync = () => null;
        await quiet.callUser(3);
        await settle();
        const recvOnly = pcs[pcs.length - 1].transceivers.find(t => t.receiver.track.kind === 'audio')!;
        expect((recvOnly.receiver.transform as FakeScriptTransform | null)?.options?.op, 'the listen-only receiver was left for ontrack').toBe('open');
    });

    it('opens inbound media in the worker and plays it under enforcement', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        const receiver = { transform: null as unknown };
        deliver(pcs[0], receiver);
        expect((receiver.transform as FakeScriptTransform | null)?.options).toEqual({ op: 'open', slot: peerOf(mgr, 2)!.mediaCrypto.slot });
        expect(played, 'an engine that can open frames dropped the track').toBe(true);
    });

    it('CONTROL: an engine with neither API still publishes nothing and plays nothing under enforcement', async () => {
        noEngine();
        const mgr = await inCall(true);
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        deliver(pcs[0], { transform: null });
        expect(pcs[0].senders).toEqual([]);
        expect(played).toBe(false);
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'local-unsupported', enforced: true });
    });

    it('SECURITY: a receiver whose transform would not attach plays nothing under enforcement', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        FakeScriptTransform.failNext = true;
        deliver(pcs[0], { transform: null });
        expect(played, 'frames nothing opened were played while encryption is required').toBe(false);
    });

    it('SECURITY: a sender whose transform would not attach is emptied under enforcement', async () => {
        scriptEngine();
        FakeScriptTransform.failNext = true;
        await inCall(true);
        expect(pcs[0].senders[0]?.replaced, 'an unwrapped sender kept its track while encryption is required').toEqual([null]);
    });

    it('SECURITY: a worker that never starts rebuilds every peer into the blocked state', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        expect(pcs[0].senders, 'precondition: publishing').toHaveLength(1);
        worker.emit('error', new Event('error')); // its script did not load
        await settle();
        expect(pcs[0].closed, 'the connection counting on dead transforms stayed up').toBe(true);
        const fresh = pcs[pcs.length - 1];
        expect(pcs.length).toBe(2);
        expect(fresh.senders, 'the rebuilt connection was sent media nothing can seal').toEqual([]);
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'local-unsupported', enforced: true, encrypted: false });
    });

    it('CONTROL: without enforcement the same loss rebuilds into transport-only, labelled', async () => {
        scriptEngine();
        const mgr = await inCall(false);
        worker.emit('error', new Event('error'));
        await settle();
        const fresh = pcs[pcs.length - 1];
        expect(fresh.senders.map(s => (s.track as { id: string }).id)).toEqual(['mic']);
        expect(fresh.senders[0].transform, 'a transform on a dead worker').toBeNull();
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'local-unsupported', enforced: false });
    });

    it('"Require encryption" changed mid-call reaches the worker, with no rebuild', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const slot = peerOf(mgr, 2)!.mediaCrypto.slot;
        mgr.setRequireMediaE2ee(false);
        await settle();
        expect(pcs, 'an engine whose transforms enforce every frame was rebuilt').toHaveLength(1);
        expect(worker.posted.filter(m => m.slot === slot).at(-1)).toMatchObject({ type: 'state', requireE2ee: false });
    });

    it('a peer that goes is forgotten by the worker, key and all', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const slot = peerOf(mgr, 2)!.mediaCrypto.slot;
        mgr.closePeer(2);
        expect(worker.posted.at(-1)).toEqual({ type: 'forget', slot });

        const again = await inCall(true);
        const slot2 = peerOf(again, 2)!.mediaCrypto.slot;
        again.closeAll();
        expect(worker.posted.at(-1)).toEqual({ type: 'forget', slot: slot2 });
    });
});

/**
 * The same two guards on the createEncodedStreams path, where a failed attach
 * does NOT take the path down: the engine still reports that it can encrypt,
 * so "can this engine encrypt?" no longer answers "is THIS sender or receiver
 * encrypted?". (Chromium accepts the call in every case measured; these keep
 * the day it does not from being a plaintext one.)
 */
describe('a pipe that would not attach on the createEncodedStreams path', () => {
    /** Chromium: createEncodedStreams on the prototype, and on every sender and receiver it hands out. */
    function encodedEngine() {
        class Sender {}
        (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
        vi.stubGlobal('RTCRtpSender', Sender);
    }
    const refuses = () => { throw new DOMException('too late', 'InvalidStateError'); };
    const pipes = () => {
        const t = new TransformStream();
        return { readable: t.readable, writable: t.writable };
    };

    it('SECURITY: a receiver it would not attach to plays nothing under enforcement', async () => {
        encodedEngine();
        const mgr = await inCall(true);
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        deliver(pcs[0], { transform: null, createEncodedStreams: refuses } as unknown as { transform: unknown });
        expect(played, 'frames nothing opened were played while encryption is required').toBe(false);
    });

    it('CONTROL: receivers are still wrapped in ontrack here, not before negotiation (the Chromium path is unchanged)', async () => {
        encodedEngine();
        const piped = vi.fn(pipes);
        receiverPipe = piped;
        // Senders that DO attach, so the early-wrap step beside them is reached.
        const orig = FakeRTCPeerConnection.prototype.addTrack;
        FakeRTCPeerConnection.prototype.addTrack = function (this: FakeRTCPeerConnection, track: unknown) {
            const s = orig.call(this, track) as FakeSender & { createEncodedStreams?: () => unknown };
            s.createEncodedStreams = pipes;
            return s;
        };
        let mgr: WebRTCManager;
        try {
            mgr = await inCall(true);
        } finally {
            FakeRTCPeerConnection.prototype.addTrack = orig;
        }
        expect(pcs[0].senders[0].replaced, 'precondition: the sender attached').toEqual([]);
        expect(piped, 'createEncodedStreams was called on a receiver before any track arrived').not.toHaveBeenCalled();
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        deliver(pcs[0], pcs[0].transceivers.find(t => t.receiver.track.kind === 'audio')!.receiver);
        expect(piped).toHaveBeenCalledTimes(1);
        expect(played).toBe(true);
    });

    it('CONTROL: a receiver it attaches to plays', async () => {
        encodedEngine();
        const mgr = await inCall(true);
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        deliver(pcs[0], { transform: null, createEncodedStreams: pipes } as unknown as { transform: unknown });
        expect(played).toBe(true);
    });

    it('SECURITY: a sender it would not attach to is emptied under enforcement; CONTROL: one it attaches to keeps its track', async () => {
        encodedEngine();
        const orig = FakeRTCPeerConnection.prototype.addTrack;
        let make: () => unknown = refuses;
        FakeRTCPeerConnection.prototype.addTrack = function (this: FakeRTCPeerConnection, track: unknown) {
            const s = orig.call(this, track) as FakeSender & { createEncodedStreams?: () => unknown };
            s.createEncodedStreams = make;
            return s;
        };
        try {
            await inCall(true);
            expect(pcs[0].senders[0].replaced, 'an unwrapped sender kept its track while encryption is required').toEqual([null]);
            make = pipes;
            await inCall(true);
            expect(pcs[pcs.length - 1].senders[0].replaced, 'a wrapped sender lost its track').toEqual([]);
            expect(pcs[pcs.length - 1].config.encodedInsertableStreams, 'createEncodedStreams needs the flag at construction').toBe(true);
        } finally {
            FakeRTCPeerConnection.prototype.addTrack = orig;
        }
    });
});

describe('VP8 first, before every offer and answer, where frames are sealed', () => {
    it('the offer is made after the video codecs were reordered', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const pc = pcs[0];
        await (mgr as unknown as { makeOffer: (u: number, p: unknown) => Promise<void> }).makeOffer(2, pc);
        expect(events.indexOf('prefs:video/VP8'), 'VP8 was never put first').toBeGreaterThanOrEqual(0);
        expect(events.indexOf('prefs:video/VP8')).toBeLessThan(events.indexOf('sld:offer'));
        expect(sent.filter(s => s.type === 'offer')).toHaveLength(1);
    });

    it('the answer is made after the offer\'s transceivers were reordered', async () => {
        scriptEngine();
        const mgr = manager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        const offer = JSON.stringify({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102 96\r\n', connId: 'remote-1' });
        await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> }).handleIncomingDescription(2, offer);
        expect(events).toEqual(['srd:offer', 'prefs:video/VP8', 'sld:answer']);
        expect(sent.filter(s => s.type === 'answer')).toHaveLength(1);
    });

    it('once the answer is made, our own video is sent as VP8 even though the offer put H.264 first', async () => {
        scriptEngine();
        const mgr = manager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        const cam = { kind: 'video', id: 'cam', enabled: true, readyState: 'live', stop: () => {} };
        const local = { id: 'local', getTracks: () => [cam], getAudioTracks: () => [], getVideoTracks: () => [cam] };
        (mgr as unknown as { media: { getLocalStreamSync: () => unknown } }).media.getLocalStreamSync = () => local;
        const setParameters = vi.fn(async (_p: { encodings: Array<{ codec?: { mimeType: string } }> }) => {});
        const orig = FakeRTCPeerConnection.prototype.addTrack;
        FakeRTCPeerConnection.prototype.addTrack = function (this: FakeRTCPeerConnection, track: unknown) {
            const s = orig.call(this, track) as FakeSender & Record<string, unknown>;
            s.getParameters = () => ({ codecs: [{ mimeType: 'video/H264', clockRate: 90000 }, { mimeType: 'video/VP8', clockRate: 90000 }], encodings: [{}], transactionId: 't' });
            s.setParameters = setParameters;
            return s;
        };
        try {
            const offer = JSON.stringify({ type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102 96\r\n', connId: 'remote-1' });
            await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> }).handleIncomingDescription(2, offer);
            await settle();
        } finally {
            FakeRTCPeerConnection.prototype.addTrack = orig;
        }
        expect(setParameters, 'our camera went out in the offer\'s order (H.264) on a sealed link').toHaveBeenCalledTimes(1);
        expect(setParameters.mock.calls[0][0].encodings[0].codec?.mimeType).toBe('video/VP8');
    });

    it('CONTROL: an engine that cannot seal frames leaves the codec order to the browser', async () => {
        noEngine();
        const mgr = await inCall(false);
        await (mgr as unknown as { makeOffer: (u: number, p: unknown) => Promise<void> }).makeOffer(2, pcs[0]);
        expect(events).toEqual(['sld:offer']);
    });
});
