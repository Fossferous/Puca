/**
 * Which senders/receivers carry a stream, for Show Stream Stats: matched by
 * TRACK IDENTITY on both transports — a watched stream's tracks are its
 * receivers' tracks, your own share's are its senders' (once per viewer on a
 * mesh). And streamStatsLive asks the SFU first, then the mesh.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/iceConfig', () => ({
    withRelayOnlyIfRequested: (c: unknown) => c,
    fetchIceConfig: vi.fn(async () => ({ iceServers: [], iceTransportPolicy: 'all' })),
}));

import { WebRTCManager } from '../api/rtc/manager';
import { SfuManager } from '../api/rtc/sfuManager';

const t = (id: string, kind = 'video') => ({ id, kind }) as unknown as MediaStreamTrack;
const endpoint = (track: MediaStreamTrack | null) => ({ track, getStats: vi.fn(async () => new Map()) });

describe('mesh: rtpEndpointsFor', () => {
    it("finds a watched stream's receivers, and your share's senders on every peer", () => {
        const mgr = new WebRTCManager();
        const shareV = t('share-v');
        const shareA = t('share-a', 'audio');
        const theirs = t('their-screen');
        const camera = t('their-camera');
        const peers = (mgr as unknown as { peers: Map<number, unknown> }).peers;
        const rx1 = endpoint(theirs);
        const tx1 = endpoint(shareV);
        const tx1a = endpoint(shareA);
        const tx2 = endpoint(shareV);
        peers.set(1, { connection: { getReceivers: () => [rx1, endpoint(camera), endpoint(null)], getSenders: () => [tx1, tx1a, endpoint(t('mic', 'audio'))] } });
        peers.set(2, { connection: { getReceivers: () => [], getSenders: () => [tx2] } });

        const watched = mgr.rtpEndpointsFor([theirs]);
        expect(watched.map(e => [e.key, e.direction, e.kind])).toEqual([[rx1, 'inbound', 'video']]);

        const own = mgr.rtpEndpointsFor([shareV, shareA]);
        expect(own.map(e => [e.key, e.direction, e.kind])).toEqual([
            [tx1, 'outbound', 'video'], [tx1a, 'outbound', 'audio'], [tx2, 'outbound', 'video'],
        ]);
        // The read goes to that endpoint.
        void own[0].getStats();
        expect(tx1.getStats).toHaveBeenCalled();
    });

    it('nothing for a stream no connection carries', () => {
        const mgr = new WebRTCManager();
        expect(mgr.rtpEndpointsFor([t('x')])).toEqual([]);
    });
});

describe('SFU: rtpEndpointsFor', () => {
    function withRoom(room: unknown): SfuManager {
        const m = new SfuManager();
        (m as unknown as { room: unknown }).room = room;
        return m;
    }

    it("finds a remote publication's receiver and your publication's sender", () => {
        const theirs = t('their-screen');
        const mine = t('my-screen');
        const receiver = { getStats: vi.fn(async () => new Map()) };
        const sender = { getStats: vi.fn(async () => new Map()) };
        const room = {
            remoteParticipants: new Map([['u1', { trackPublications: new Map([
                ['p1', { track: { mediaStreamTrack: theirs, receiver } }],
                ['p2', { track: { mediaStreamTrack: t('their-camera'), receiver: {} } }],
                ['p3', { track: undefined }],
            ]) }]]),
            localParticipant: { trackPublications: new Map([
                ['l1', { track: { mediaStreamTrack: mine, sender } }],
                ['l2', { track: { mediaStreamTrack: t('mic', 'audio'), sender: {} } }],
            ]) },
        };
        const m = withRoom(room);
        expect(m.rtpEndpointsFor([theirs]).map(e => [e.key, e.direction])).toEqual([[receiver, 'inbound']]);
        expect(m.rtpEndpointsFor([mine]).map(e => [e.key, e.direction])).toEqual([[sender, 'outbound']]);
    });

    it('nothing when not in an SFU call', () => {
        expect(withRoom(null).rtpEndpointsFor([t('x')])).toEqual([]);
    });
});

describe('streamStatsLive: the SFU first, then the mesh', () => {
    it('uses the mesh only when the SFU carries nothing', async () => {
        vi.resetModules();
        const sfu = vi.fn(() => [] as unknown[]);
        const mesh = vi.fn(() => [{ key: {}, direction: 'inbound', kind: 'video', getStats: async () => new Map() }]);
        vi.doMock('../api/rtc/sfuManager', () => ({ sfuManager: { rtpEndpointsFor: sfu } }));
        vi.doMock('../api/webrtc', () => ({ webrtcManager: { rtpEndpointsFor: mesh } }));
        const { streamStatsSampler } = await import('../api/rtc/streamStatsLive');
        const stream = { getTracks: () => [t('v')] } as unknown as MediaStream;
        await streamStatsSampler(stream).sample();
        expect(sfu).toHaveBeenCalledTimes(1);
        expect(mesh).toHaveBeenCalledTimes(1);

        sfu.mockReturnValue([{ key: {}, direction: 'inbound', kind: 'video', getStats: async () => new Map() }]);
        mesh.mockClear();
        await streamStatsSampler(stream).sample();
        expect(mesh, 'an SFU call must not also walk the mesh').not.toHaveBeenCalled();
        vi.doUnmock('../api/rtc/sfuManager');
        vi.doUnmock('../api/webrtc');
    });
});
