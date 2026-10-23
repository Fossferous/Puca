// @vitest-environment jsdom
/**
 * "Require encryption for calls" switched on WHILE a screen share or a camera
 * flip is being published, on an engine that cannot encrypt (audit 2026-10,
 * second review, finding 5).
 *
 * addScreenShareToPeers and switchCamera read the guard once, then walked the
 * LIVE peers Map, awaiting each peer (the share's encoder tuning, the camera's
 * replaceTrack). setRequireMediaE2ee(true) meanwhile rebuilds every peer into
 * that Map, and a Map iteration goes on to entries added while it runs: the
 * loop handed the share, or the camera, to the rebuilt connections that the
 * join-time guard had just left empty. Plain DTLS-SRTP, under a setting that
 * said media was blocked. The SECURITY cases go red against that loop; the
 * control is that, left alone, the same publish reaches every peer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({
        iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
        iceTransportPolicy: 'all',
    })),
}));

import { WebRTCManager } from '../api/rtc/manager';

type Track = { kind: string; id: string; enabled: boolean; readyState: string; stop: () => void; addEventListener?: () => void };

/** Every connection the manager built, in order. */
const pcs: FakeRTCPeerConnection[] = [];

/** What every sender's setParameters and replaceTrack wait on until the test opens it. */
let gate: { promise: Promise<void>; open: () => void };
function closeGate() {
    let open!: () => void;
    const promise = new Promise<void>((r) => { open = r; });
    gate = { promise, open };
}

class FakeRTCPeerConnection {
    onicecandidate: unknown = null;
    onnegotiationneeded: unknown = null;
    ontrack: unknown = null;
    onconnectionstatechange: unknown = null;
    connectionState = 'new';
    signalingState = 'stable';
    /** Every track put on this connection: added, or swapped in by replaceTrack. */
    added: string[] = [];
    senders: { track: Track }[] = [];
    closed = false;
    constructor() { pcs.push(this); }
    getSenders() { return this.senders; }
    getTransceivers() { return []; }
    addTrack(track: Track) {
        this.added.push(track.id);
        const sender = {
            track,
            replaceTrack: async (t: Track) => { await gate.promise; sender.track = t; this.added.push(t.id); },
            getParameters: () => ({ encodings: [{}] }),
            setParameters: () => gate.promise,
        };
        this.senders.push(sender);
        return sender;
    }
    addTransceiver() { return {}; }
    createDataChannel() { return { close: () => {} }; }
    close() { this.closed = true; }
}

/** An engine with no Encoded Transform API, as isMediaE2eeSupported() sees it. */
function noEncodedTransform() {
    vi.stubGlobal('RTCRtpSender', class FakeSender {});
}

/** WebCrypto and the ICE-config fetch resolve on macrotasks: drain those. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

const track = (kind: string, id: string): Track => ({ kind, id, enabled: true, readyState: 'live', stop: () => {}, addEventListener: () => {} });
const mic = track('audio', 'mic');
const frontCamera = track('video', 'front-camera');
const backCamera = track('video', 'back-camera');
const screen = track('video', 'screen');

/** In a mesh call with peers 2 and 3, the setting off, sending a mic and (optionally) a camera. */
async function inCall(opts: { camera: boolean }) {
    noEncodedTransform();
    const mgr = new WebRTCManager();
    mgr.setLocalUserId(1);
    mgr.setRequireMediaE2ee(false);
    const tracks = opts.camera ? [mic, frontCamera] : [mic];
    const local = { id: 'local', getTracks: () => tracks, getAudioTracks: () => [mic], getVideoTracks: () => tracks.filter(t => t.kind === 'video') };
    let share: unknown = null;
    const media = (mgr as unknown as { media: Record<string, unknown> }).media;
    media.getLocalStreamSync = () => local;
    media.getScreenShareStreamSync = () => share;
    media.switchCamera = async () => backCamera;
    closeGate();
    gate.open(); // building the call waits on nothing
    await mgr.callUser(2);
    await mgr.callUser(3);
    await settle();
    expect(pcs, 'precondition: one connection per peer').toHaveLength(2);
    return {
        mgr,
        startShare: () => { share = { id: 'share', getTracks: () => [screen], getAudioTracks: () => [], getVideoTracks: () => [screen] }; },
    };
}

beforeEach(() => {
    pcs.length = 0;
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the setting switched on while a share or a camera is being published', () => {
    it('SECURITY: a share being published is not handed to the connections the setting rebuilt', async () => {
        const { mgr, startShare } = await inCall({ camera: false });
        startShare();
        closeGate();

        const publishing = mgr.addScreenShareToPeers();
        await settle(); // parked on the first peer's encoder tuning
        mgr.setRequireMediaE2ee(true);
        await settle(); // every peer rebuilt, under the join-time guard
        gate.open();
        await publishing;
        await settle();

        const rebuilt = pcs.slice(2);
        expect(rebuilt, 'precondition: both peers were rebuilt').toHaveLength(2);
        for (const pc of rebuilt) {
            expect(pc.added, 'the share went out on a connection rebuilt because encryption is required').toEqual([]);
        }
    });

    it('SECURITY: a camera being flipped is not handed to the connections the setting rebuilt', async () => {
        const { mgr } = await inCall({ camera: true });
        closeGate();

        const flipping = mgr.switchCamera('user');
        await settle(); // parked on the first peer's replaceTrack
        mgr.setRequireMediaE2ee(true);
        await settle();
        gate.open();
        await flipping;
        await settle();

        const rebuilt = pcs.slice(2);
        expect(rebuilt, 'precondition: both peers were rebuilt').toHaveLength(2);
        for (const pc of rebuilt) {
            expect(pc.added, 'the camera went out on a connection rebuilt because encryption is required').toEqual([]);
        }
    });

    it('CONTROL: left alone, the same share and the same flip reach every peer (the rig sees a publish)', async () => {
        const { mgr, startShare } = await inCall({ camera: true });
        startShare();
        closeGate();
        gate.open();

        await mgr.addScreenShareToPeers();
        await mgr.switchCamera('user');
        await settle();

        expect(pcs).toHaveLength(2);
        for (const pc of pcs) {
            expect(pc.added).toEqual(['mic', 'front-camera', 'screen', 'back-camera']);
        }
    });
});
