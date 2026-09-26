/**
 * What the mesh manager's diagnostics say about each video, for the health
 * line (healthLog.ts reads these rows when a call is peer-to-peer).
 *
 * THE CASES THIS PINS. On a mesh call a camera switched off keeps its sender on
 * one side and its receiver on the other; turning it on again adds a NEW sender
 * and receiver and leaves the old ones in place. Without care, every off/on
 * cycle added a row reading like a camera whose capture died (sending side) and
 * a row reading like that peer's camera frozen at 0 fps (receiving side), for
 * the rest of the call. And an incoming row said nothing about whether it was a
 * peer's camera or their share.
 *
 * Driven through the real WebRTCManager with a fake peer connection whose
 * getStats returns fixed rows, the way rtcPeerCreation.test.ts builds one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';

type Row = Record<string, unknown>;
const track = (id: string, readyState = 'live', frameRate = 30) =>
    ({ id, kind: 'video', readyState, getSettings: () => ({ frameRate }) });

/** A fake peer connection: fixed stats rows, fixed senders and receivers. */
function fakePc(rows: Row[], senders: unknown[] = [], receivers: unknown[] = []) {
    return {
        getStats: async () => new Map(rows.map(r => [String(r.id), r])),
        getSenders: () => senders,
        getReceivers: () => receivers,
        signalingState: 'stable', connectionState: 'connected',
    };
}

/** Put a peer into the manager as if a call had connected it. */
function addPeer(mgr: WebRTCManager, userId: number, pc: unknown): void {
    (mgr as unknown as { peers: Map<number, unknown> }).peers.set(userId, {
        userId, connection: pc, connId: 'conn-0001-abcd', remoteConnId: null, remoteStream: null,
    });
}

/** The manager's own delivery of an incoming video (what ontrack does). */
function deliver(mgr: WebRTCManager, userId: number, kind: 'camera' | 'screen', trackId: string): void {
    (mgr as unknown as { deliverVideo: (u: number, k: string, s: unknown, r: unknown) => void })
        .deliverVideo(userId, kind, { id: 's-' + trackId }, { track: track(trackId) });
}

const inbound = (id: string, trackId: string, fps: number | undefined) =>
    ({ id, type: 'inbound-rtp', kind: 'video', trackIdentifier: trackId, framesPerSecond: fps, frameWidth: 640, frameHeight: 360 });

async function incoming(mgr: WebRTCManager): Promise<Array<{ source: string; ended?: boolean; fps: number | null }>> {
    const [peer] = await mgr.meshDiagnostics();
    return ((peer.latency as { inbound: Array<{ source: string; ended?: boolean; fps: number | null }> }).inbound)
        .map(i => ({ source: i.source, fps: i.fps, ...(i.ended && { ended: true }) }));
}

beforeEach(() => { vi.stubGlobal('RTCPeerConnection', class {}); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('incoming video rows on a mesh call', () => {
    it('are labelled by what the peer is sending: camera or share', async () => {
        const mgr = new WebRTCManager();
        mgr.setPeerCamera(7, true);
        mgr.setPeerSharing(7, true);
        deliver(mgr, 7, 'camera', 'cam1');
        deliver(mgr, 7, 'screen', 'scr1');
        addPeer(mgr, 7, fakePc([inbound('a', 'cam1', 30), inbound('b', 'scr1', 22), inbound('c', 'unknown', 5)],
            [], [{ track: track('cam1') }, { track: track('scr1') }]));
        expect(await incoming(mgr)).toEqual([
            { source: 'camera', fps: 30 },
            { source: 'screen_share', fps: 22 },
            { source: 'video', fps: 5 },
        ]);
    });

    it('call a camera switched off "ended", and the old copy after an off/on cycle too', async () => {
        const mgr = new WebRTCManager();
        mgr.setPeerCamera(7, true);
        deliver(mgr, 7, 'camera', 'cam1');
        // Off: announced off, and its receiver is still here with nothing flowing.
        mgr.setPeerCamera(7, false);
        addPeer(mgr, 7, fakePc([inbound('a', 'cam1', 0)], [], [{ track: track('cam1') }]));
        expect(await incoming(mgr)).toEqual([{ source: 'camera', fps: 0, ended: true }]);

        // On again: a NEW receiver; the old one stays, and must not read as live.
        mgr.setPeerCamera(7, true);
        deliver(mgr, 7, 'camera', 'cam2');
        addPeer(mgr, 7, fakePc([inbound('a', 'cam1', 0), inbound('b', 'cam2', 30)], [],
            [{ track: track('cam1') }, { track: track('cam2') }]));
        expect(await incoming(mgr)).toEqual([
            { source: 'camera', fps: 0, ended: true },
            { source: 'camera', fps: 30 },
        ]);
    });

    it('never call a FLOWING camera ended just because no announcement arrived (an older peer)', async () => {
        const mgr = new WebRTCManager();
        deliver(mgr, 7, 'camera', 'cam1'); // delivered, but no CameraStarted ever came
        addPeer(mgr, 7, fakePc([inbound('a', 'cam1', 30)], [], [{ track: track('cam1') }]));
        expect(await incoming(mgr)).toEqual([{ source: 'camera', fps: 30 }]);
    });
});

describe('outgoing video rows on a mesh call', () => {
    const outbound = (trackId: string) => [
        { id: 'o', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'm', framesPerSecond: 30, framesEncoded: 900, ssrc: 77 },
        { id: 'm', type: 'media-source', kind: 'video', trackIdentifier: trackId, framesPerSecond: 30 },
    ];

    it('mark a sender whose track ended (a camera switched off), and read no setting from it', async () => {
        const mgr = new WebRTCManager();
        const sender = { track: track('mycam', 'ended'), getParameters: () => ({ encodings: [{ maxFramerate: 30 }] }) };
        addPeer(mgr, 7, fakePc(outbound('mycam'), [sender]));
        const [peer] = await mgr.meshDiagnostics();
        const row = (peer.rtp as Row[]).find(r => r.dir === 'outbound-rtp')!;
        expect(row.ended).toBe(true);
        expect(row.source).toBe('camera');
        expect(row.setFps, 'an ended track\'s settings are not a choice').toBeUndefined();
    });

    it('carry source, chosen and captured rates, cap and sender id for a live sender', async () => {
        const mgr = new WebRTCManager();
        const sender = { track: track('mycam', 'live', 24), getParameters: () => ({ encodings: [{ maxFramerate: 60 }] }) };
        addPeer(mgr, 7, fakePc(outbound('mycam'), [sender]));
        const [peer] = await mgr.meshDiagnostics();
        const row = (peer.rtp as Row[]).find(r => r.dir === 'outbound-rtp')!;
        expect(row).toMatchObject({ source: 'camera', setFps: 24, maxFps: 60, captureFps: 30, ssrc: 77 });
        expect(row.ended).toBeUndefined();
    });
});
