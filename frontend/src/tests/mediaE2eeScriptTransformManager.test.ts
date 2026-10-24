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
import { advertiseDtlsPin, isScriptTransformSuspended, newFrameCounts, type FrameCounts } from '../api/rtc/mediaCrypto';
import { mediaE2eeExplanation } from '../api/rtc/e2eeStatus';
import { __runFrameAudit, __setScriptTransformWorkerFactory, PeerMediaCrypto, retryScriptTransformNextCall, type TransformWorkerLike } from '../api/rtc/scriptTransform';
import type { ScriptTransformCommand } from '../api/rtc/scriptTransformWorker';
import type { MediaE2eeStatus } from '../api/rtc/types';

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
    /** null until a description names it (the fake gives the video one the offer's mid). */
    mid: string | null = null;
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
    /** Receivers handed to ontrack by deliver(), beside the transceivers' own. */
    delivered: Array<{ track: unknown }> = [];
    closed = false;
    constructor(config: Record<string, unknown>) { this.config = config; pcs.push(this); }
    getSenders() { return this.senders; }
    getReceivers() { return [...this.transceivers.map(t => t.receiver), ...this.delivered]; }
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
    removedSenders: unknown[] = [];
    removeTrack(sender: unknown) { this.removedSenders.push(sender); }
    createDataChannel() { return { close: () => {}, addEventListener: () => {} }; }
    async setRemoteDescription(d: { type: string; sdp?: string }) {
        events.push(`srd:${d.type}`);
        const mid = /a=mid:(\S+)/.exec(d.sdp ?? '')?.[1];
        if (mid) this.transceivers[0].mid = mid;
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
    options: { op: string; slot: string; id: string };
    static failNext = false;
    constructor(_worker: unknown, options: { op: string; slot: string; id: string }) {
        if (FakeScriptTransform.failNext) { FakeScriptTransform.failNext = false; throw new Error('no transform'); }
        this.options = options;
    }
}

/** The worker as the page sees it; it answers every `report` with `counts`, as the real one does. */
class FakeWorker implements TransformWorkerLike {
    posted: ScriptTransformCommand[] = [];
    counts = new Map<string, FrameCounts>();
    private fns: Record<string, Array<(ev: never) => void>> = { message: [], error: [] };
    postMessage(m: ScriptTransformCommand) {
        this.posted.push(m);
        if (m.type === 'report') {
            this.emit('message', { data: { type: 'counts', seq: m.seq, transforms: [...this.counts].map(([id, c]) => ({ id, ...c })) } });
        }
    }
    addEventListener(type: 'message' | 'error', fn: (ev: never) => void) { this.fns[type].push(fn); }
    terminate() {}
    emit(type: 'message' | 'error', ev: unknown) { for (const fn of this.fns[type]) fn(ev as never); }
    /** The counts the worker keeps for the transform on this sender or receiver. */
    countsOf(target: { transform: unknown }): FrameCounts {
        const id = (target.transform as FakeScriptTransform).options.id;
        if (!this.counts.has(id)) this.counts.set(id, newFrameCounts());
        return this.counts.get(id)!;
    }
    /** The last state copy it was sent for this slot. */
    stateOf(slot: string) {
        return this.posted.filter((m): m is Extract<ScriptTransformCommand, { type: 'state' }> => m.type === 'state' && m.slot === slot).at(-1);
    }
}

let worker: FakeWorker;

/** An engine with the standard API and nothing else: Safari (H.264 first in
 *  its own codec order), or with `vp8First` Firefox. */
function scriptEngine({ vp8First = false } = {}) {
    class Sender {}
    class Receiver {}
    for (const C of [Sender, Receiver]) (C.prototype as unknown as Record<string, unknown>).transform = null;
    vi.stubGlobal('RTCRtpSender', Sender);
    const codecs = [{ mimeType: 'video/H264', clockRate: 90000 }, { mimeType: 'video/VP8', clockRate: 90000 }];
    vi.stubGlobal('RTCRtpReceiver', Object.assign(Receiver, {
        getCapabilities: () => ({ codecs: vp8First ? [...codecs].reverse() : codecs, headerExtensions: [] }),
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

/** Their voice arrives on `receiver`; returns the track, to see whether it may play. */
function deliver(pc: FakeRTCPeerConnection, receiver: { transform: unknown; track?: unknown }) {
    const track = { kind: 'audio', id: 'their-voice', enabled: true };
    receiver.track = track;
    pc.delivered.push(receiver as { track: unknown });
    pc.ontrack?.({ track, streams: [{ id: 'theirs', getTracks: () => [track] }], receiver });
    return track;
}

/** What enableMediaWithRemote leaves once the handshake checked out. */
async function handshakeDone(mgr: WebRTCManager, id: number) {
    const peer = peerOf(mgr, id)! as unknown as { mediaCrypto: PeerMediaCrypto; mediaE2eeReason: string };
    peer.mediaCrypto.key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as CryptoKey;
    peer.mediaCrypto.enabled = true;
    peer.mediaE2eeReason = 'encrypted';
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
        expect(t.options).toEqual({ op: 'seal', slot, id: expect.any(String) });
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
            'the receiver beside the mic had no transform before the answer — Chromium would decode what it gets unopened').toEqual({ op: 'open', slot, id: expect.any(String) });

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

    it('opens inbound media in the worker and plays it under enforcement — silent until its transform has opened a frame', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        let played = false;
        mgr.setOnRemoteStream(() => { played = true; });
        const receiver = { transform: null as unknown };
        const track = deliver(pcs[0], receiver);
        expect((receiver.transform as FakeScriptTransform | null)?.options).toEqual({ op: 'open', slot: peerOf(mgr, 2)!.mediaCrypto.slot, id: expect.any(String) });
        expect(played, 'an engine that can open frames dropped the track').toBe(true);
        expect(track.enabled, 'SECURITY: it played before anything showed frames go through its transform').toBe(false);
        // The worker says, unasked, that this receiver's transform opened its first frame.
        const id = (receiver.transform as FakeScriptTransform).options.id;
        worker.emit('message', { data: { type: 'counts', seq: null, transforms: [{ id, seen: 1, done: 1, clear: 0, dropped: 0 }] } });
        expect(track.enabled, 'still silent once its transform opened a frame').toBe(true);
    });

    it('CONTROL: without enforcement, and on the createEncodedStreams path, a received track plays at once', async () => {
        scriptEngine();
        await inCall(false);
        expect(deliver(pcs[pcs.length - 1], { transform: null }).enabled, 'held although nothing requires encryption').toBe(true);
        vi.unstubAllGlobals();
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
        class Sender {}
        (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
        vi.stubGlobal('RTCRtpSender', Sender);
        await inCall(true);
        const pipes = () => { const t = new TransformStream(); return { readable: t.readable, writable: t.writable }; };
        expect(deliver(pcs[pcs.length - 1], { transform: null, createEncodedStreams: pipes } as unknown as { transform: unknown }).enabled,
            'held on the path whose pipe nothing can go by').toBe(true);
    });

    it('enforcement switched on mid-call silences a receiver whose transform has opened nothing; switched off, it plays again', async () => {
        scriptEngine();
        const mgr = await inCall(false);
        const opened = { transform: null as unknown };
        const unopened = { transform: null as unknown };
        const a = deliver(pcs[0], opened);
        const b = deliver(pcs[0], unopened);
        worker.countsOf(opened).done = 1;
        worker.emit('message', { data: { type: 'counts', seq: null, transforms: [{ id: (opened.transform as FakeScriptTransform).options.id, seen: 1, done: 1, clear: 0, dropped: 0 }] } });
        mgr.setRequireMediaE2ee(true);
        expect(b.enabled, 'a receiver nothing showed opening kept playing once encryption was required').toBe(false);
        expect(a.enabled, 'control: one that has opened frames plays on').toBe(true);
        mgr.setRequireMediaE2ee(false);
        expect(b.enabled).toBe(true);
    });

    it('says "encrypted" only once the worker has shown this peer\'s frames sealed and opened, and says so when it changes', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const seen: MediaE2eeStatus[] = [];
        mgr.setOnMediaE2eeChange((s) => seen.push(s));
        await handshakeDone(mgr, 2);
        const receiver = { transform: null as unknown };
        deliver(pcs[0], receiver);
        expect(mgr.mediaE2eeStatus(2), 'encrypted on the page\'s word alone').toMatchObject({ encrypted: false, reason: 'negotiating' });
        expect(mgr.isMediaEncrypted(2)).toBe(false);
        expect(mgr.mediaEncryptionSummary()).toMatchObject({ total: 1, encrypted: 0 });

        worker.emit('message', { data: { type: 'ready' } });
        await __runFrameAudit();
        const sealed = worker.countsOf(pcs[0].senders[0]);
        const opened = worker.countsOf(receiver);
        sealed.seen = sealed.done = 50;
        opened.seen = opened.done = 50;
        await __runFrameAudit();
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ encrypted: true, reason: 'encrypted' });
        expect(mgr.isMediaEncrypted(2)).toBe(true);
        expect(mgr.mediaEncryptionSummary()).toMatchObject({ total: 1, encrypted: 1 });
        expect(seen.at(-1), 'the change was not announced').toMatchObject({ userId: 2, encrypted: true });

        for (let i = 0; i < 5; i++) {
            opened.seen += 50;
            opened.dropped += 50;
            sealed.seen += 50;
            sealed.done += 50;
            await __runFrameAudit();
            if (i === 0) expect(mgr.mediaE2eeStatus(2), 'inbound stopped opening').toMatchObject({ encrypted: false, reason: 'negotiating' });
        }
        expect(mgr.mediaE2eeStatus(2), 'five windows of nothing opening is a failure, not a set-up').toMatchObject({ encrypted: false, reason: 'verification-failed' });
    });

    it('SECURITY: frames a receiver takes without its transform seeing them rebuild every peer, blocked, as "could not be confirmed on this call"', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        let taken = 0;
        const receiver = { transform: null as unknown, getStats: async () => new Map([['in', { type: 'inbound-rtp', kind: 'audio', packetsReceived: taken }]]) };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        deliver(pcs[0], receiver);
        worker.emit('message', { data: { type: 'ready' } });
        await __runFrameAudit();
        for (let i = 0; i < 2; i++) {
            taken += 100; // the connection took them; the worker saw none
            await __runFrameAudit();
        }
        await settle();
        expect(pcs[0].closed, 'a connection whose frames go by their transform stayed up').toBe(true);
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'unconfirmed', enforced: true, encrypted: false });
        expect(mgr.mediaEncryptionSummary()).toMatchObject({ supported: false, unconfirmed: true });
        expect(pcs[pcs.length - 1].senders, 'the rebuilt connection was sent media nothing can seal').toEqual([]);
        expect(warn.mock.calls.some((c) => /frames that (never went|mostly did not go) through its transform/.test(String(c[0])))).toBe(true);
        warn.mockRestore();
    });

    it('SECURITY: a connection substituted on the path is sent nothing and plays nothing, though encryption is not required', async () => {
        const KEY = new Uint8Array(32).fill(7);
        const FP = 'a=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB';
        const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' + FP + '\r\na=setup:actpass';
        for (const engine of ['script', 'none'] as const) {
            if (engine === 'script') scriptEngine(); else noEngine();
            const mgr = await inCall(false);
            const pc = pcs[pcs.length - 1];
            const peer = peerOf(mgr, 2)! as unknown as { mediaStaticKeyRaw: Uint8Array | null; mediaCrypto: PeerMediaCrypto };
            peer.mediaStaticKeyRaw = KEY;
            const track = deliver(pc, { transform: null });
            expect(pc.senders[0]?.track, `${engine}: precondition, sending`).toBe(mic);
            expect(track.enabled, `${engine}: precondition, playing`).toBe(true);
            const verify = (s: string) => (mgr as unknown as { verifyRemoteDtls: (u: number, s: string) => void }).verifyRemoteDtls(2, s);
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            verify(advertiseDtlsPin(sdp, new Uint8Array(32).fill(9))); // a pin someone else made
            warn.mockRestore();
            expect(pc.senders[0].replaced, `${engine}: our microphone went on to whoever is in the middle`).toEqual([null]);
            expect(track.enabled, `${engine}: what came over it played`).toBe(false);
            expect(mgr.sendsTo(2), `${engine}: a later track could be put back on it`).toBe(false);
            expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'fingerprint-mismatch', encrypted: false, enforced: false });
            expect(peer.mediaCrypto.hold).toBe(true);
            if (engine === 'script') expect(worker.stateOf(peer.mediaCrypto.slot), 'the worker was not told').toMatchObject({ hold: true });
            verify(advertiseDtlsPin(sdp, KEY)); // a later honest description does not lift it
            expect(track.enabled).toBe(false);
            for (const m of managers.splice(0)) m.closeAll();
            vi.unstubAllGlobals();
            vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
        }
    });

    it('CONTROL: an honest pin holds nothing back', async () => {
        scriptEngine();
        const KEY = new Uint8Array(32).fill(7);
        const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB\r\na=setup:actpass';
        const mgr = await inCall(false);
        const peer = peerOf(mgr, 2)! as unknown as { mediaStaticKeyRaw: Uint8Array | null };
        peer.mediaStaticKeyRaw = KEY;
        const track = deliver(pcs[0], { transform: null });
        (mgr as unknown as { verifyRemoteDtls: (u: number, s: string) => void }).verifyRemoteDtls(2, advertiseDtlsPin(sdp, KEY));
        expect(mgr.mediaE2eeStatus(2)?.dtls).toBe('bound');
        expect(pcs[0].senders[0].replaced).toEqual([]);
        expect(track.enabled).toBe(true);
        expect(mgr.sendsTo(2)).toBe(true);
    });

    it('wraps every receiver a remote offer created as soon as it is applied — one it SENDS nothing on gets no ontrack', async () => {
        scriptEngine();
        const mgr = manager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        const media = (mgr as unknown as { media: { getLocalStreamSync: () => unknown; getScreenShareStreamSync: () => unknown } }).media;
        media.getLocalStreamSync = () => null;
        media.getScreenShareStreamSync = () => null;
        const srd = FakeRTCPeerConnection.prototype.setRemoteDescription;
        let made: FakeTransceiver | null = null;
        FakeRTCPeerConnection.prototype.setRemoteDescription = async function (this: FakeRTCPeerConnection, d: { type: string; sdp?: string }) {
            if (d.type === 'offer' && !made) { made = new FakeTransceiver('audio'); this.transceivers.push(made); } // receive-only on their side: no ontrack
            return srd.call(this, d);
        };
        try {
            const offer = JSON.stringify({ type: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=recvonly\r\n', connId: 'remote-1' });
            await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> }).handleIncomingDescription(2, offer);
        } finally {
            FakeRTCPeerConnection.prototype.setRemoteDescription = srd;
        }
        expect((made!.receiver.transform as FakeScriptTransform | null)?.options?.op,
            'a receiver the offer made was left to be wrapped in a later offerer\'s ontrack, which Chromium ignores').toBe('open');
    });

    it('wraps a receiver no one wrapped yet before an offer is made', async () => {
        scriptEngine();
        const mgr = await inCall(true);
        const pc = pcs[0];
        const stray = new FakeTransceiver('audio');
        pc.transceivers.push(stray);
        await (mgr as unknown as { makeOffer: (u: number, p: unknown) => Promise<void> }).makeOffer(2, pc);
        expect((stray.receiver.transform as FakeScriptTransform | null)?.options?.op).toBe('open');
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
        expect(worker.stateOf(slot)).toMatchObject({ type: 'state', requireE2ee: false });
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

    const answerTo = async (sdp: string) => {
        scriptEngine();
        const mgr = manager();
        mgr.setLocalUserId(1);
        mgr.setRequireMediaE2ee(true);
        const offer = JSON.stringify({ type: 'offer', sdp, connId: 'remote-1' });
        await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> }).handleIncomingDescription(2, offer);
    };

    it('an offer that put H.264 first is answered after VP8 was put first', async () => {
        await answerTo('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 102 96\r\na=mid:0\r\na=rtpmap:102 H264/90000\r\na=rtpmap:96 VP8/90000\r\n');
        expect(events).toEqual(['srd:offer', 'prefs:video/VP8', 'sld:answer']);
        expect(sent.filter(s => s.type === 'answer')).toHaveLength(1);
    });

    it('CONTROL: an offer that already put VP8 first is answered as it is (Firefox must not be given preferences there)', async () => {
        await answerTo('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 102\r\na=mid:0\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:102 H264/90000\r\n');
        expect(events).toEqual(['srd:offer', 'sld:answer']);
    });

    it('before a later offer, a transceiver the peer\'s offer created is left alone', async () => {
        await answerTo('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96 102\r\na=mid:0\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:102 H264/90000\r\n');
        const mgr = managers[managers.length - 1];
        const pc = pcs[pcs.length - 1];
        events.length = 0;
        pc.signalingState = 'stable';
        await (mgr as unknown as { makeOffer: (u: number, p: unknown) => Promise<void> }).makeOffer(2, pc);
        expect(events, 'a negotiated transceiver was given preferences before our offer').toEqual(['sld:offer']);
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

    it('an engine whose own order already puts VP8 first (Firefox) is given no preferences before an offer at all', async () => {
        scriptEngine({ vp8First: true });
        const mgr = await inCall(true);
        await (mgr as unknown as { makeOffer: (u: number, p: unknown) => Promise<void> }).makeOffer(2, pcs[0]);
        expect(events, 'preferences that change nothing, and that Firefox mis-numbers after glare').toEqual(['sld:offer']);
        expect(sent.filter(s => s.type === 'offer')).toHaveLength(1);
    });

    it('CONTROL: an engine that cannot seal frames leaves the codec order to the browser', async () => {
        noEngine();
        const mgr = await inCall(false);
        await (mgr as unknown as { makeOffer: (u: number, p: unknown) => Promise<void> }).makeOffer(2, pcs[0]);
        expect(events).toEqual(['sld:offer']);
    });
});

/** A track that can be cloned and stopped, as a real one can. */
interface FakeTrack { kind: 'audio' | 'video'; id: string; enabled: boolean; readyState: 'live' | 'ended'; stop(): void; clone(): FakeTrack }
function track(kind: 'audio' | 'video', id: string): FakeTrack {
    const t: FakeTrack = {
        kind, id, enabled: true, readyState: 'live',
        stop() { t.readyState = 'ended'; },
        clone() { return track(kind, `${id}+stand`); },
    };
    return t;
}
const streamOf = (id: string, tracks: FakeTrack[]) => ({
    id, getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
});

/** In a call with peer 2, sending `tracks` (and a share of `share`). */
async function callWith(required: boolean, tracks: FakeTrack[], share: FakeTrack[] = []) {
    const mgr = manager();
    mgr.setLocalUserId(1);
    mgr.setRequireMediaE2ee(required);
    const media = (mgr as unknown as { media: Record<string, unknown> }).media;
    media.getLocalStreamSync = () => streamOf('local', tracks);
    media.getScreenShareStreamSync = () => (share.length ? streamOf('screen', share) : null);
    await mgr.callUser(2);
    await settle();
    return { mgr, media, pc: pcs[pcs.length - 1] };
}
const sealedFirst = (sender: FakeSender) => worker.emit('message', {
    data: { type: 'counts', seq: null, transforms: [{ id: (sender.transform as FakeScriptTransform).options.id, seen: 1, done: 1, clear: 0, dropped: 0 }] },
});
const sweep = (mgr: WebRTCManager) => (mgr as unknown as { sweepHeldSenders: () => void }).sweepHeldSenders();
const aesKey = async () => await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']) as CryptoKey;
/** As if this sender's hold, and encryption with its peer, began `ms` ago. */
function backdate(mgr: WebRTCManager, c: PeerMediaCrypto, sender: FakeSender, ms: number): void {
    const held = (mgr as unknown as { heldSenders: Map<unknown, { since: number }> }).heldSenders.get(sender);
    if (!held) throw new Error('not held');
    held.since -= ms;
    c.enabledSince = Date.now() - ms;
}
const PIN_SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=fingerprint:sha-256 ' + 'AB:'.repeat(31) + 'AB\r\na=setup:actpass\r\n';
const PIN_KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

describe('the third review: a give-up lasts one call, the pin comes first, senders wait for a sealed frame', () => {
    it('a give-up is "could not be confirmed on this call" (no browser to change, no setting to turn off), blocks under enforcement, and the next call tries again', async () => {
        scriptEngine();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mgr = await inCall(true);
        worker.emit('message', { data: { type: 'ready' } });
        worker.emit('error', new Event('error')); // fails after starting
        await settle();
        expect(pcs[0].closed).toBe(true);
        const st = mgr.mediaE2eeStatus(2)!;
        expect(st).toMatchObject({ reason: 'unconfirmed', enforced: true, encrypted: false });
        const told = mediaE2eeExplanation(st.reason, 'Alex', true, false)!;
        expect(told).toMatch(/could not be confirmed on this call/);
        expect(told, 'a passing failure answered with a setting that stays off for good').not.toMatch(/turn off|Require encryption|older browser/i);
        expect(pcs[pcs.length - 1].senders, 'sent media while it could not be confirmed, under enforcement').toEqual([]);
        expect(isScriptTransformSuspended()).toBe(true);

        mgr.closeAll(); // the call ends
        await settle();
        expect(isScriptTransformSuspended(), 'still given up after the call').toBe(false);
        const again = await inCall(true);
        expect(pcs[pcs.length - 1].senders[0]?.transform, 'the next call did not get its transforms back').toBeInstanceOf(FakeScriptTransform);
        expect(again.mediaE2eeStatus(2)?.reason).not.toBe('unconfirmed');
        warn.mockRestore();
    });

    it('tried again within the call: the connections are rebuilt WITH transforms when the path comes back', async () => {
        scriptEngine();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await inCall(true);
        worker.emit('message', { data: { type: 'ready' } });
        worker.emit('error', new Event('error'));
        await settle();
        const blocked = pcs[pcs.length - 1];
        expect(blocked.senders).toEqual([]);
        retryScriptTransformNextCall(); // the path comes back while still in the call (as the cool-down's end does)
        await settle();
        const back = pcs[pcs.length - 1];
        expect(back, 'nothing rebuilt when the path came back').not.toBe(blocked);
        expect(back.senders[0]?.transform).toBeInstanceOf(FakeScriptTransform);
        warn.mockRestore();
    });

    it('the DTLS pin is checked BEFORE an answer is applied, and its hold reaches the worker as ONE copy, before anything else', async () => {
        scriptEngine();
        const mgr = await inCall(false);
        const peer = peerOf(mgr, 2)! as unknown as { mediaStaticKeyRaw: Uint8Array | null; mediaCrypto: PeerMediaCrypto };
        peer.mediaStaticKeyRaw = PIN_KEY;
        await handshakeDone(mgr, 2); // encryption on: the worst moment for a half-changed state
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (m) => {
            if (m.type === 'state') events.push(`state:hold=${m.hold}:enabled=${m.enabled}:key=${m.key ? 'set' : 'none'}`);
            post(m);
        };
        events.length = 0;
        pcs[0].signalingState = 'have-local-offer'; // our offer is out
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> })
            .handleIncomingDescription(2, JSON.stringify({ type: 'answer', sdp: advertiseDtlsPin(PIN_SDP, OTHER_KEY) }));
        warn.mockRestore();
        const hold = events.findIndex(e => e.startsWith('state:hold=true'));
        expect(hold, 'no hold reached the worker').toBeGreaterThanOrEqual(0);
        expect(events.indexOf('srd:answer'), 'the answer was applied before the hold').toBeGreaterThan(hold);
        expect(events[hold], 'the hold came with encryption off and the key gone, as one copy').toBe('state:hold=true:enabled=false:key=none');
        expect(events.slice(0, hold).filter(e => e.startsWith('state:')), 'a half-changed state reached the worker first').toEqual([]);
    });

    it('CONTROL: an honest pin in the answer holds nothing, and the answer is applied', async () => {
        scriptEngine();
        const mgr = await inCall(false);
        (peerOf(mgr, 2)! as unknown as { mediaStaticKeyRaw: Uint8Array | null }).mediaStaticKeyRaw = PIN_KEY;
        events.length = 0;
        pcs[0].signalingState = 'have-local-offer';
        await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> })
            .handleIncomingDescription(2, JSON.stringify({ type: 'answer', sdp: advertiseDtlsPin(PIN_SDP, PIN_KEY) }));
        expect(events).toContain('srd:answer');
        expect(mgr.mediaE2eeStatus(2)?.dtls).toBe('bound');
        expect(mgr.sendsTo(2)).toBe(true);
    });

    it('SECURITY: after a pin hold no path puts a track back: camera published, toggled on, switched; a share; the noise mode; NO RECEIVE lifted', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const cam = track('video', 'cam');
        const cam2 = track('video', 'cam2');
        const mic2 = track('audio', 'mic2');
        const screen = track('video', 'screen');
        const local: FakeTrack[] = [mic];
        const { mgr, media, pc } = await callWith(false, local);
        (peerOf(mgr, 2)! as unknown as { mediaStaticKeyRaw: Uint8Array | null }).mediaStaticKeyRaw = PIN_KEY;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        (mgr as unknown as { verifyRemoteDtls: (u: number, s: string) => void }).verifyRemoteDtls(2, advertiseDtlsPin(PIN_SDP, OTHER_KEY));
        await settle();
        const sending = () => pc.senders.filter(s => s.track).map(s => (s.track as FakeTrack).id);
        expect(sending(), 'precondition: the hold emptied the senders').toEqual([]);
        const count = pc.senders.length;

        local.push(cam);
        media.toggleVideo = async () => cam;
        mgr.publishCameraTrack(cam as unknown as MediaStreamTrack);
        await mgr.toggleVideo(true);
        media.switchCamera = async () => cam2;
        await mgr.switchCamera('user');
        media.getScreenShareStreamSync = () => streamOf('screen', [screen]);
        await mgr.addScreenShareToPeers();
        media.reacquireAudioTrack = async () => ({ oldTrack: mic, newTrack: mic2 });
        await mgr.reapplyNoiseMode();
        mgr.setPeerReceives(2, false);
        mgr.setPeerReceives(2, true);
        await settle();
        warn.mockRestore();
        expect(sending(), 'a track went to the substituted connection').toEqual([]);
        expect(pc.senders.length, 'a sender was added to the substituted connection').toBe(count);
    });

    it('CONTROL: the same kind of path DOES reach a peer whose pin is fine (the test above can fail)', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const cam = track('video', 'cam');
        const local: FakeTrack[] = [mic];
        const { mgr, media, pc } = await callWith(false, local);
        local.push(cam);
        media.toggleVideo = async () => cam;
        await mgr.toggleVideo(true);
        await settle();
        expect(pc.senders.filter(s => s.track).map(s => (s.track as FakeTrack).id)).toEqual(['mic', 'cam']);
    });

    it('SECURITY: under enforcement on the worker path a new sender carries a silent, black stand-in until its transform seals a frame — then its own track', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { pc } = await callWith(true, [mic]);
        const sender = pc.senders[0];
        const stand = sender.track as FakeTrack;
        expect(stand, 'the microphone itself went on before anything was sealed').not.toBe(mic);
        expect(stand.kind).toBe('audio');
        expect(stand.enabled, 'the stand-in carries sound').toBe(false);
        sealedFirst(sender);
        await settle();
        expect(sender.track, 'its own track did not follow the first sealed frame').toBe(mic);
        expect(stand.readyState, 'the stand-in was left running').toBe('ended');
    });

    it('CONTROL: no stand-in without enforcement, or on the createEncodedStreams path (its pipe cannot be passed by)', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const loose = await callWith(false, [mic]);
        expect(loose.pc.senders[0].track).toBe(mic);
        vi.unstubAllGlobals();
        vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
        class Sender {}
        (Sender.prototype as unknown as Record<string, unknown>).createEncodedStreams = () => ({});
        vi.stubGlobal('RTCRtpSender', Sender);
        const orig = FakeRTCPeerConnection.prototype.addTrack;
        FakeRTCPeerConnection.prototype.addTrack = function (this: FakeRTCPeerConnection, t: unknown) {
            const s = orig.call(this, t) as FakeSender & { createEncodedStreams?: () => unknown };
            s.createEncodedStreams = () => { const ts = new TransformStream(); return { readable: ts.readable, writable: ts.writable }; };
            return s;
        };
        try {
            const mic2 = track('audio', 'mic2');
            const chromium = await callWith(true, [mic2]);
            expect(chromium.pc.senders[0].track).toBe(mic2);
        } finally {
            FakeRTCPeerConnection.prototype.addTrack = orig;
        }
    });

    it('SECURITY: a held sender emptied meanwhile (NO RECEIVE) does not get its track back when its transform seals', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { mgr, pc } = await callWith(true, [mic]);
        const sender = pc.senders[0];
        const stand = sender.track as FakeTrack;
        mgr.setPeerReceives(2, false);
        await settle();
        expect(sender.track).toBeNull();
        expect(stand.readyState).toBe('ended');
        sealedFirst(sender);
        await settle();
        expect(sender.track, 'the microphone went back to a member who may not receive it').toBeNull();
    });

    it('a real track that ends during the hold (camera off) takes the stand-in with it, and nothing is put back', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const cam = track('video', 'cam');
        const { mgr, pc } = await callWith(true, [mic, cam]);
        const camSender = pc.senders.find(s => (s.track as FakeTrack | null)?.id === 'cam+stand')!;
        const stand = camSender.track as FakeTrack;
        cam.stop();
        sweep(mgr);
        await settle();
        expect(camSender.track).toBeNull();
        expect(stand.readyState, 'a stand-in kept the camera running after it was turned off').toBe('ended');
    });

    it('a camera switched during the hold: the stand-in follows the new camera (letting the old go), which goes on when sealed', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const cam = track('video', 'cam');
        const cam2 = track('video', 'cam2');
        const local: FakeTrack[] = [mic, cam];
        const { mgr, media, pc } = await callWith(true, local);
        const camSender = pc.senders.find(s => (s.track as FakeTrack | null)?.id === 'cam+stand')!;
        const oldStand = camSender.track as FakeTrack;
        local[1] = cam2;
        media.switchCamera = async () => cam2;
        await mgr.switchCamera('user');
        await settle();
        expect((camSender.track as FakeTrack).id, 'the new camera went on before anything was sealed').toBe('cam2+stand');
        expect(oldStand.readyState, 'the stand-in of the camera switched away from kept running').toBe('ended');
        expect(pc.senders.length, 'a second camera sender was added').toBe(2);
        sealedFirst(camSender);
        await settle();
        expect(camSender.track).toBe(cam2);
    });

    it('stopping a share finds its held sender (by the track it waits to send) and removes it', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const screen = track('video', 'screen');
        const { mgr, media, pc } = await callWith(true, [mic], [screen]);
        const shareSender = pc.senders.find(s => (s.track as FakeTrack | null)?.id === 'screen+stand');
        expect(shareSender, 'precondition: the share is held').toBeTruthy();
        const stand = shareSender!.track as FakeTrack;
        media.stopScreenShare = () => true;
        mgr.stopScreenShare();
        expect(pc.removedSenders, 'a held share sender was left on the connection').toContain(shareSender);
        expect(stand.readyState, 'the share\'s stand-in kept the capture alive').toBe('ended');
    });

    it('a peer that goes, and a call that ends, take their stand-ins with them', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { mgr, pc } = await callWith(true, [mic]);
        const stand = pc.senders[0].track as FakeTrack;
        mgr.closePeer(2);
        expect(stand.readyState, 'a gone peer\'s stand-in kept the microphone open').toBe('ended');
        const mic2 = track('audio', 'mic2');
        const again = await callWith(true, [mic2]);
        const stand2 = again.pc.senders[0].track as FakeTrack;
        expect(stand2.id).toBe('mic2+stand');
        again.mgr.closeAll();
        expect(stand2.readyState, 'an ended call\'s stand-in kept the microphone open').toBe('ended');
    });

    it('SECURITY: answering an offer whose pin only checks out once our key is ready: still held BEFORE our answer is made', async () => {
        scriptEngine();
        const mgr = await inCall(false);
        const peer = peerOf(mgr, 2)! as unknown as { mediaStaticKeyRaw: Uint8Array | null };
        peer.mediaStaticKeyRaw = null; // not derived yet when the offer lands
        (mgr as unknown as { setupMediaKey: (u: number) => Promise<void> }).setupMediaKey = async () => { peer.mediaStaticKeyRaw = PIN_KEY; };
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (m) => {
            if (m.type === 'state' && m.hold) events.push('state:hold');
            post(m);
        };
        events.length = 0;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await (mgr as unknown as { handleIncomingDescription: (u: number, s: string) => Promise<void> })
            .handleIncomingDescription(2, JSON.stringify({ type: 'offer', sdp: advertiseDtlsPin(PIN_SDP, OTHER_KEY) }));
        warn.mockRestore();
        expect(events.indexOf('state:hold'), 'no hold').toBeGreaterThanOrEqual(0);
        expect(events.indexOf('sld:answer'), 'our answer went out before the substitution was held').toBeGreaterThan(events.indexOf('state:hold'));
        expect(mgr.mediaE2eeStatus(2)).toMatchObject({ reason: 'fingerprint-mismatch', dtls: 'mismatch' });
    });

    it('the valve: 10 s of the hold with encryption on and NOTHING sent on the sender (an engine that sends nothing for a disabled track), the track goes on — said', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { mgr, pc } = await callWith(true, [mic]);
        const sender = pc.senders[0];
        const c = peerOf(mgr, 2)!.mediaCrypto;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        c.set({ key: await aesKey(), enabled: true });
        worker.emit('message', { data: { type: 'ready' } });
        await __runFrameAudit(); // its look: the connection names no stream for the sender (nothing sent)
        sweep(mgr);
        await settle();
        expect(sender.track, 'released before the valve').not.toBe(mic);
        backdate(mgr, c, sender, 11_000);
        sweep(mgr);
        await settle();
        expect(sender.track).toBe(mic);
        expect(warn.mock.calls.some(x => String(x[0]).includes('sent nothing in 10 s'))).toBe(true);
        warn.mockRestore();
    });

    it('SECURITY: a sender added long after encryption came on (a share an hour in) is held until sealed — the valve counts from the hold, not from the call', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const screen = track('video', 'screen');
        const share: FakeTrack[] = [];
        const { mgr, pc } = await callWith(true, [mic], share);
        const c = peerOf(mgr, 2)!.mediaCrypto;
        c.set({ key: await aesKey(), enabled: true });
        c.enabledSince = Date.now() - 3_600_000;
        worker.emit('message', { data: { type: 'ready' } });
        sealedFirst(pc.senders[0]);
        await settle();
        expect(pc.senders[0].track, 'precondition: the microphone, sealed, is on').toBe(mic);
        share.push(screen);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the fake sender takes no encoding tuning
        await mgr.addScreenShareToPeers();
        await settle();
        warn.mockRestore();
        const shareSender = pc.senders.find(s => s !== pc.senders[0])!;
        expect((shareSender.track as FakeTrack).id, 'precondition: the share is held').toBe('screen+stand');
        await __runFrameAudit();
        sweep(mgr);
        await settle();
        expect(shareSender.track, 'the screen went out at the first sweep, its transform never seen to seal').not.toBe(screen);
        sealedFirst(shareSender);
        await settle();
        expect(shareSender.track).toBe(screen);
    });

    it('SECURITY: frames that went out on a held sender without reaching its transform keep the hold, whatever the clock says — the audit decides, and gives the path up', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { mgr, pc } = await callWith(true, [mic]);
        const sender = pc.senders[0] as FakeSender & { getStats?: () => Promise<Map<string, unknown>> };
        let packets = 0;
        sender.getStats = async () => new Map([['out', { type: 'outbound-rtp', kind: 'audio', packetsSent: packets }]]);
        const c = peerOf(mgr, 2)!.mediaCrypto;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        c.set({ key: await aesKey(), enabled: true });
        worker.emit('message', { data: { type: 'ready' } });
        packets = 50; // the stand-in's silence went out; its transform saw none of it
        await __runFrameAudit();
        backdate(mgr, c, sender, 11_000);
        sweep(mgr);
        await settle();
        expect(sender.track, 'the valve put the microphone on a sender whose frames go past its transform').not.toBe(mic);
        for (let i = 0; i < 3 && !isScriptTransformSuspended(); i++) {
            packets += 50;
            await __runFrameAudit();
        }
        await settle();
        warn.mockRestore();
        expect(isScriptTransformSuspended(), 'the audit let it be').toBe(true);
        expect(sender.track, 'the microphone went on after all').not.toBe(mic);
    });

    it('SECURITY: a worker still starting has said nothing about a held sender, so the valve waits for it', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { mgr, pc } = await callWith(true, [mic]);
        const sender = pc.senders[0];
        const c = peerOf(mgr, 2)!.mediaCrypto;
        c.set({ key: await aesKey(), enabled: true });
        backdate(mgr, c, sender, 11_000);
        await __runFrameAudit(); // not started: no look at anything
        sweep(mgr);
        await settle();
        expect(sender.track, 'the valve put the microphone on before the worker had started').not.toBe(mic);
    });

    it('enforcement switched off releases every held sender at once', async () => {
        scriptEngine();
        const mic = track('audio', 'mic');
        const { mgr, pc } = await callWith(true, [mic]);
        expect(pc.senders[0].track).not.toBe(mic);
        mgr.setRequireMediaE2ee(false);
        await settle();
        expect(pc.senders[0].track).toBe(mic);
    });
});
