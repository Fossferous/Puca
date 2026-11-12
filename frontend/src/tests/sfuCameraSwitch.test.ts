// @vitest-environment jsdom
/**
 * A camera switched in an SFU call (Flip, or another camera from the menu)
 * stays on the SAME publication and the SAME RTCRtpSender
 * (sfuManager.replaceCameraTrack).
 *
 * LiveKit's E2EE is a frame transform on the publication's sender, so the
 * sender staying is what keeps the new camera encrypted without anything being
 * set up again; viewers keep their subscription (no tile dropping out and
 * coming back). It used to unpublish the camera and publish the new one: a new
 * publication, a new sender, a resubscribe on every viewer.
 *
 * The publication's track is the REAL livekit-client LocalVideoTrack, so the
 * replaceTrack here is the library's own, down to sender.replaceTrack; only
 * the sender, the participant and the room are stand-ins. Live, through a
 * real LiveKit: e2e/camera-switch-live.mjs with SFU=1.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('livekit-client/e2ee-worker?worker', () => ({ default: class { terminate() { /* fake */ } } }));
vi.mock('../api/channelKeys', () => ({ ensureChannelKey: vi.fn(async () => ({ key: new Uint8Array(32), epoch: 1 })) }));
vi.mock('../api/client', () => ({ apiClient: { get: vi.fn() } }));

import { LocalVideoTrack, Track } from 'livekit-client';
import { SfuManager } from '../api/rtc/sfuManager';

class FakeCamTrack extends EventTarget {
    kind = 'video';
    readyState = 'live';
    enabled = true;
    muted = false;
    contentHint = '';
    readonly id: string;
    constructor(id: string) {
        super();
        this.id = id;
    }
    getSettings() { return { width: 640, height: 480, deviceId: this.id }; }
    getConstraints() { return {}; }
    clone() { return new FakeCamTrack(this.id + '-clone'); }
    stop() { this.readyState = 'ended'; }
}

/** The sender LiveKit put its E2EE transform on. */
class FakeSender {
    track: unknown;
    transform = { sealing: 'the publication key' };
    transport = { state: 'connected' };
    replaced: unknown[] = [];
    constructor(track: unknown) { this.track = track; }
    async replaceTrack(t: unknown) { this.replaced.push(t); this.track = t; }
    getParameters() { return { encodings: [] }; }
    async setParameters() { /* fake */ }
}

type Pub = { source: Track.Source; track: LocalVideoTrack | null; trackSid: string };

async function rig() {
    const sfu = new SfuManager();
    const old = new FakeCamTrack('cam-front');
    const lkTrack = new LocalVideoTrack(old as unknown as MediaStreamTrack, undefined, true);
    const sender = new FakeSender(old);
    (lkTrack as unknown as { sender: FakeSender }).sender = sender;
    const pub: Pub = { source: Track.Source.Camera, track: lkTrack, trackSid: 'TR_camera_1' };
    const pubs: Pub[] = [pub];
    const lp = {
        getTrackPublications: () => pubs,
        unpublishTrack: vi.fn(async (t: MediaStreamTrack) => {
            const i = pubs.findIndex(p => p.track?.mediaStreamTrack === t);
            if (i >= 0) pubs.splice(i, 1);
        }),
        publishTrack: vi.fn(async (t: MediaStreamTrack) => {
            const p: Pub = { source: Track.Source.Camera, track: new LocalVideoTrack(t, undefined, true), trackSid: 'TR_camera_2' };
            pubs.push(p);
            return p;
        }),
    };
    const s = sfu as unknown as { room: unknown; cameraPub: unknown };
    s.room = { localParticipant: lp };
    s.cameraPub = pub;
    // LiveKit's constructor finishes setting its track up asynchronously (it
    // hands the camera it was made with to the sender): let it, then count.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise(r => setTimeout(r, 0));
    sender.replaced.length = 0;
    return { sfu, s, pub, pubs, lp, sender, old };
}

describe('SFU: a camera switch keeps its publication and its sender', () => {
    beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });

    it('the new camera goes onto the SAME sender (its E2EE transform with it), nothing unpublished or published', async () => {
        const { sfu, s, pub, pubs, lp, sender } = await rig();
        const rear = new FakeCamTrack('cam-back');
        const transform = sender.transform;

        await sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);

        // (LiveKit hands it over in replaceTrack, and again as it resumes the
        // upstream: every hand-over is the rear camera.)
        expect(sender.replaced.length, 'the sender was not handed the rear camera').toBeGreaterThan(0);
        expect(sender.replaced.every(t => t === rear), 'the sender was handed something else').toBe(true);
        expect(sender.track).toBe(rear);
        expect(sender.transform, 'the sealing transform is the one that was there').toBe(transform);
        expect(pub.track!.mediaStreamTrack).toBe(rear);
        expect(lp.unpublishTrack, 'the camera was unpublished (the old republish)').not.toHaveBeenCalled();
        expect(lp.publishTrack, 'a second camera publication was made').not.toHaveBeenCalled();
        expect(pubs.map(p => p.trackSid)).toEqual(['TR_camera_1']);
        expect(s.cameraPub).toBe(pub);
    });

    it('the camera it replaces is ours to stop: LiveKit does not stop it (the media layer already did, before opening the next)', async () => {
        const { sfu, old } = await rig();
        await sfu.replaceCameraTrack(new FakeCamTrack('cam-back') as unknown as MediaStreamTrack);
        expect(old.readyState).toBe('live');
    });

    it('a publication that will not take it: the new camera is published afresh, the old one taken off', async () => {
        const { sfu, s, pub, pubs, lp } = await rig();
        pub.track!.replaceTrack = vi.fn(async () => { throw new Error('unable to replace an unpublished track'); }) as never;
        const rear = new FakeCamTrack('cam-back');
        await sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        expect(lp.unpublishTrack).toHaveBeenCalledTimes(1);
        expect(lp.publishTrack).toHaveBeenCalledTimes(1);
        expect(pubs.map(p => p.track?.mediaStreamTrack)).toEqual([rear]);
        expect((s.cameraPub as Pub).trackSid).toBe('TR_camera_2');
    });

    it('a second camera publication left by a reconnect is taken off, the first one swapped', async () => {
        const { sfu, pubs, lp, sender } = await rig();
        const stray = new FakeCamTrack('stray');
        pubs.push({ source: Track.Source.Camera, track: new LocalVideoTrack(stray as unknown as MediaStreamTrack, undefined, true), trackSid: 'TR_stray' });
        const rear = new FakeCamTrack('cam-back');
        await sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        expect(lp.unpublishTrack).toHaveBeenCalledWith(stray, true);
        expect(sender.track).toBe(rear);
        expect(sender.replaced.every(t => t === rear)).toBe(true);
        expect(pubs.map(p => p.trackSid)).toEqual(['TR_camera_1']);
    });

    it('no camera published: nothing happens', async () => {
        const { sfu, s, lp } = await rig();
        s.cameraPub = null;
        await sfu.replaceCameraTrack(new FakeCamTrack('cam-back') as unknown as MediaStreamTrack);
        expect(lp.publishTrack).not.toHaveBeenCalled();
        expect(lp.unpublishTrack).not.toHaveBeenCalled();
    });
});
