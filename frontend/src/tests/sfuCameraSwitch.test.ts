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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
        expect((pub.track as unknown as { sender: unknown }).sender, 'the publication went to another sender').toBe(sender);
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

    it('a publication that will not take it (connected): the new camera is published afresh, the old one taken off', async () => {
        const { sfu, s, pub, pubs, lp } = await rig();
        (s.room as { state: string }).state = 'connected';
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

    it('a switch while LiveKit reconnects, that the publication cannot take yet: nothing published afresh then; once reconnected, the new camera is put on', async () => {
        const { sfu, s, pub, pubs, lp } = await rig();
        (s.room as { state: string }).state = 'reconnecting';
        const original = pub.track!.replaceTrack.bind(pub.track!);
        pub.track!.replaceTrack = vi.fn(async () => { throw new Error('unable to replace an unpublished track'); }) as never;
        const rear = new FakeCamTrack('cam-back');
        await sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        expect(lp.publishTrack, 'a camera was published while LiveKit was reconnecting').not.toHaveBeenCalled();
        void original;

        (s.room as { state: string }).state = 'connected';
        await sfu.reassertCamera();
        expect(pubs.map(p => p.track?.mediaStreamTrack), 'after the reconnect the room still has no camera, or the stopped one').toEqual([rear]);
    });

    it('a full reconnect that re-published the stopped camera: the camera wanted goes back on, on that publication', async () => {
        const { sfu, s, pubs } = await rig();
        (s.room as { state: string }).state = 'connected';
        const rear = new FakeCamTrack('cam-back');
        await sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        // LiveKit's republishAllTracks: a new publication of the track it had
        // before (the front camera, stopped by the switch).
        const stoppedFront = new FakeCamTrack('cam-front');
        stoppedFront.readyState = 'ended';
        const again = new LocalVideoTrack(stoppedFront as unknown as MediaStreamTrack, undefined, true);
        const sender2 = new FakeSender(stoppedFront);
        (again as unknown as { sender: FakeSender }).sender = sender2;
        pubs.splice(0, pubs.length, { source: Track.Source.Camera, track: again, trackSid: 'TR_camera_3' });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        await new Promise(r => setTimeout(r, 0));
        sender2.replaced.length = 0;

        await sfu.reassertCamera();
        expect(again.mediaStreamTrack, 'the room kept the stopped camera after the reconnect').toBe(rear);
        expect(sender2.track).toBe(rear);
    });

    it('the camera turned off while the swap is under way: the publication is not handed back, nothing published', async () => {
        const { sfu, s, pub, lp } = await rig();
        (s.room as { state: string }).state = 'connected';
        let release!: () => void;
        const gate = new Promise<void>(r => { release = r; });
        const original = pub.track!.replaceTrack.bind(pub.track!);
        pub.track!.replaceTrack = vi.fn(async (t: MediaStreamTrack, u: boolean) => { await gate; return original(t, u); }) as never;
        const rear = new FakeCamTrack('cam-back');
        const swapping = sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        await Promise.resolve();
        await sfu.unpublishCamera();
        rear.readyState = 'ended'; // the media layer stopped it with the camera
        release();
        await swapping;
        expect(s.cameraPub, 'the publication Turn off took off came back').toBeNull();
        expect(lp.publishTrack).not.toHaveBeenCalled();
    });

    /** The swap fails, so the new camera is published afresh; the FIRST publish is held at `gate`. */
    async function heldFreshPublish() {
        const r = await rig();
        (r.s.room as { state: string }).state = 'connected';
        r.pub.track!.replaceTrack = vi.fn(async () => { throw new Error('unable to replace an unpublished track'); }) as never;
        let release!: () => void;
        const gate = new Promise<void>(res => { release = res; });
        const publish = r.lp.publishTrack.getMockImplementation()!;
        let first = true;
        r.lp.publishTrack.mockImplementation(async (t: MediaStreamTrack) => {
            if (first) { first = false; await gate; }
            return publish(t);
        });
        return { ...r, release };
    }

    it('the camera turned off while the new camera is being published afresh: it is taken back off, no camera left published', async () => {
        const { sfu, s, pubs, lp, release } = await heldFreshPublish();
        const rear = new FakeCamTrack('cam-back');
        const swapping = sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        await vi.waitFor(() => expect(lp.publishTrack).toHaveBeenCalledTimes(1));
        await sfu.unpublishCamera();
        rear.readyState = 'ended'; // the media layer stopped it with the camera
        release();
        await swapping;
        expect(pubs.filter(p => p.source === Track.Source.Camera), 'a stopped camera is still published (a ghost tile)').toEqual([]);
        expect(s.cameraPub, 'Turn off\'s null was overwritten').toBeNull();
    });

    it('switched again while the first new camera was being published afresh: only the last camera is published, and it is the one held', async () => {
        const { sfu, s, pubs, lp, release } = await heldFreshPublish();
        const rear = new FakeCamTrack('cam-back');
        const ultra = new FakeCamTrack('cam-ultra');
        const first = sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        await vi.waitFor(() => expect(lp.publishTrack).toHaveBeenCalledTimes(1));
        rear.readyState = 'ended'; // the media layer stops one camera before opening the next
        await sfu.replaceCameraTrack(ultra as unknown as MediaStreamTrack);
        release();
        await first;
        const cams = pubs.filter(p => p.source === Track.Source.Camera).map(p => p.track?.mediaStreamTrack);
        expect(cams, 'the camera switched away from is still published').toEqual([ultra]);
        expect((s.cameraPub as Pub).track?.mediaStreamTrack, 'the handle is not the last camera\'s').toBe(ultra);
    });

    it('VoicePanel hands every switch to the SFU manager, connected or reconnecting', () => {
        const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../components/VoicePanel.tsx'), 'utf8');
        const call = src.indexOf('await sfuManager.replaceCameraTrack(live)');
        expect(call, 'the switch no longer reaches the SFU manager').toBeGreaterThan(0);
        const guard = src.lastIndexOf('if (', call);
        expect(src.slice(guard, call), 'held back while LiveKit is not Connected (a reconnect) the publication kept the stopped camera').not.toMatch(/\.connected/);
    });

    it('a camera that ENDED under LiveKit (unplugged) and was muted by it: the camera switched to goes out unmuted and enabled', async () => {
        const { sfu, pub, sender } = await rig();
        // LocalParticipant.handleTrackEnded mutes a track we supplied.
        await pub.track!.mute();
        expect(pub.track!.isMuted).toBe(true);
        const other = new FakeCamTrack('cam-usb');
        await sfu.replaceCameraTrack(other as unknown as MediaStreamTrack);
        expect(sender.track).toBe(other);
        expect(other.enabled, 'the new camera went out disabled: black for everyone, and for ourselves').toBe(true);
        expect(pub.track!.isMuted, 'the publication stayed muted').toBe(false);
    });

    it('a ghost publication of the stopped camera beside the live one (a reconnect race): the ghost goes, the live camera is kept and NOT stopped', async () => {
        const { sfu, s, pubs, lp } = await rig();
        (s.room as { state: string }).state = 'connected';
        const rear = new FakeCamTrack('cam-back');
        await sfu.replaceCameraTrack(rear as unknown as MediaStreamTrack);
        // The ghost first, as LiveKit lists it; the live camera after.
        const ghostTrack = new FakeCamTrack('ghost');
        ghostTrack.readyState = 'ended';
        const ghost = new LocalVideoTrack(ghostTrack as unknown as MediaStreamTrack, undefined, true);
        pubs.unshift({ source: Track.Source.Camera, track: ghost, trackSid: 'TR_ghost' });
        await sfu.reassertCamera();
        expect(rear.readyState, 'the live camera was stopped by its own swap: black for everyone').toBe('live');
        expect(pubs.map(p => p.trackSid)).toEqual(['TR_camera_1']);
        expect(pubs[0].track!.mediaStreamTrack).toBe(rear);
        expect(lp.unpublishTrack).toHaveBeenCalledWith(ghostTrack, true);
    });

    it('no camera published: nothing happens', async () => {
        const { sfu, s, lp } = await rig();
        s.cameraPub = null;
        await sfu.replaceCameraTrack(new FakeCamTrack('cam-back') as unknown as MediaStreamTrack);
        expect(lp.publishTrack).not.toHaveBeenCalled();
        expect(lp.unpublishTrack).not.toHaveBeenCalled();
    });
});
