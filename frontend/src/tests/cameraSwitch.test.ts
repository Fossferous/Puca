// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The call manager, for its count of switches under way (no peers, so no
// signalling and no ICE).
vi.mock('../api/websocket', () => ({ wsClient: { on: () => {}, off: () => {} } }));
vi.mock('../api/iceConfig', () => ({ withRelayOnlyIfRequested: (c: unknown) => c, fetchIceConfig: async () => ({ iceServers: [] }) }));

import { MediaManager, type CameraSwitch } from '../api/rtc/media';
import { WebRTCManager } from '../api/rtc/manager';
import { localCameraState, onLocalCameraState, selfViewMirrored, setLocalCameraState } from '../api/rtc/cameraChoice';
import { loadSettings, rememberedCamera, saveSettings } from '../components/settingsStore';

/**
 * The camera switch itself (MediaManager.flipCamera / switchCamera), against a
 * stand-in PHONE: it has the cameras a phone lists, opens exactly what the
 * constraints ask for (as the spec has an engine choose: exact must match, an
 * ideal is a preference), and — like Android's camera service, and iOS ending
 * the first — will not open a second camera while one is open. The owner's
 * report: "clicking 'flip' on camera just mirrors the image".
 *
 * The real thing, on a real Android camera stack and through a real call, is
 * e2e/android-camera-flip-live.mjs (and e2e/camera-switch-live.mjs on the web).
 */

type Facing = 'user' | 'environment';
interface Cam { deviceId: string; label: string; facing: Facing | null }

class FakeTrack {
    kind = 'video';
    readyState: 'live' | 'ended' = 'live';
    enabled = true;
    id = Math.random().toString(36).slice(2);
    readonly cam: Cam;
    private onStop: (t: FakeTrack) => void;
    constructor(cam: Cam, onStop: (t: FakeTrack) => void) {
        this.cam = cam;
        this.onStop = onStop;
    }
    get label() { return this.cam.label; }
    stop() { if (this.readyState === 'live') { this.readyState = 'ended'; this.onStop(this); } }
    getSettings() { return { deviceId: this.cam.deviceId, ...(this.cam.facing ? { facingMode: this.cam.facing } : {}) }; }
    addEventListener() { /* nothing fires here */ }
    removeEventListener() { /* nothing */ }
}

class FakeStream {
    private tracks: FakeTrack[];
    constructor(tracks: FakeTrack[] = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
    getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
    addTrack(t: FakeTrack) { if (!this.tracks.includes(t)) this.tracks.push(t); }
    removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}

function named(name: string, message = name): Error {
    const e = new Error(message);
    e.name = name;
    return e;
}

/** A phone: `cameras`, at most one open at a time, and a log of what was asked. */
function phone(cameras: Cam[], opts: { refuse?: (cam: Cam) => Error | null; listFacing?: boolean; hang?: (cam: Cam) => Promise<void> | null; noIds?: boolean } = {}) {
    const asked: MediaTrackConstraints[] = [];
    const open = new Set<FakeTrack>();
    const lateTracks: FakeTrack[] = [];
    let gate: Promise<void> | null = null;
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
        if (gate) await gate;
        const v = c.video as MediaTrackConstraints;
        asked.push(v);
        if (open.size > 0) throw named('NotReadableError', 'Could not start video source'); // one camera at a time
        const exactId = (v.deviceId as ConstrainDOMStringParameters | undefined)?.exact;
        const fm = v.facingMode as ConstrainDOMStringParameters | undefined;
        let cam: Cam | undefined;
        if (exactId) cam = cameras.find(x => x.deviceId === exactId);
        else if (fm?.exact) cam = cameras.find(x => x.facing === fm.exact);
        else if (fm?.ideal) cam = cameras.find(x => x.facing === fm.ideal) ?? cameras[0];
        else cam = cameras[0];
        if (!cam) throw named('OverconstrainedError');
        // A camera whose open never settles (a dismissed permission prompt,
        // a driver that hangs) until the test lets it: it then opens.
        const hung = opts.hang?.(cam);
        if (hung) {
            await hung;
            // A slow camera can refuse in the end, too.
            const lateRefusal = opts.refuse?.(cam);
            if (lateRefusal) throw lateRefusal;
            const late = new FakeTrack(cam, (x) => open.delete(x));
            open.add(late);
            lateTracks.push(late);
            return new FakeStream([late]);
        }
        const refusal = opts.refuse?.(cam);
        if (refusal) throw refusal;
        const t = new FakeTrack(cam, (x) => open.delete(x));
        open.add(t);
        return new FakeStream([t]);
    });
    // noIds: the camera not yet allowed in this page, so the browser hands
    // out neither ids nor names.
    const enumerateDevices = vi.fn(async () => cameras.map(cam => ({
        kind: 'videoinput', deviceId: opts.noIds ? '' : cam.deviceId, label: opts.noIds ? '' : cam.label,
        getCapabilities: () => (opts.listFacing === false || !cam.facing ? {} : { facingMode: [cam.facing] }),
    })));
    return {
        asked, open, lateTracks, getUserMedia, enumerateDevices,
        hold() { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return () => { gate = null; release(); }; },
    };
}

/** A REAL localStorage (the shared setup's stubs store nothing): the camera
 *  choice is kept in Settings. */
const backing = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
        removeItem: (k: string) => { backing.delete(k); },
        clear: () => { backing.clear(); },
    },
});

const FRONT: Cam = { deviceId: 'front', label: 'camera2 1, facing front', facing: 'user' };
const BACK: Cam = { deviceId: 'back', label: 'camera2 0, facing back', facing: 'environment' };
const ULTRA: Cam = { deviceId: 'ultra', label: 'Back Ultra Wide Camera', facing: 'environment' };

let rig: ReturnType<typeof phone>;
function useCameras(cameras: Cam[], opts?: Parameters<typeof phone>[1]) {
    rig = phone(cameras, opts);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: rig.getUserMedia, enumerateDevices: rig.enumerateDevices } });
}
/** A MediaManager in a call (a local stream, no microphone). */
function inCall(): MediaManager {
    const media = new MediaManager();
    (media as unknown as { localStream: FakeStream }).localStream = new FakeStream();
    return media;
}
const videoOf = (media: MediaManager) => media.getLocalStreamSync()!.getVideoTracks() as unknown as FakeTrack[];
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
/** Everything already able to run has run: a switch answered "no camera"
 *  when the camera went off goes on opening in the background, and stops
 *  what it opens when that lands. */
const settle = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
    localStorage.clear();
    setLocalCameraState({ deviceId: null, trackId: null, facing: null, cameras: [] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Flip on a phone', () => {
    it('the camera starts on the FRONT camera, mirrored, asking for no camera in particular (the browser\'s default)', async () => {
        // Chromium on Android lists the front camera first (measured on the
        // emulator: "camera 0, facing front", then the back one), and so does
        // Safari on iOS; the default is the first.
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        await flush();
        expect(rig.asked[0].facingMode, 'the default request named a facing mode').toBeUndefined();
        expect(rig.asked[0].deviceId).toBeUndefined();
        expect(videoOf(media)[0].cam).toBe(FRONT);
        expect(localCameraState().facing).toBe('user');
        expect(selfViewMirrored(localCameraState().facing)).toBe(true);
    });

    it('THE BUG: Flip puts the REAR camera on, asked for exactly, and the self-view stops mirroring', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        const front = videoOf(media)[0];

        const r = await media.flipCamera();
        await flush();

        expect(r.ok).toBe(true);
        expect(videoOf(media)).toHaveLength(1);
        expect(videoOf(media)[0].cam, 'Flip reopened the front camera (the bug)').toBe(BACK);
        expect(rig.asked.at(-1)?.deviceId).toEqual({ exact: 'back' });
        expect(front.readyState, 'the front camera was let go of').toBe('ended');
        expect(localCameraState().facing).toBe('environment');
        expect(selfViewMirrored(localCameraState().facing)).toBe(false);
    });

    it('Flip again: front, mirrored again; and every switch stops the old camera BEFORE opening the next (a phone opens one)', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        await media.flipCamera();
        const r = await media.flipCamera();
        await flush();
        expect(r.ok).toBe(true);
        expect(videoOf(media)[0].cam).toBe(FRONT);
        expect(localCameraState().facing).toBe('user');
        // The stand-in refuses a second open camera: three opens, none refused.
        expect(rig.getUserMedia).toHaveBeenCalledTimes(3);
        expect(rig.open.size).toBe(1);
    });

    it('whatever holds a copy of the camera is told to let go of it BEFORE the next opens (a clone keeps the camera open, and a phone opens one)', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        const front = videoOf(media)[0];
        const told: Array<{ track: unknown; live: boolean; asked: number }> = [];
        const off = media.onCameraReleasing((t) => told.push({ track: t, live: t.readyState === 'live', asked: rig.asked.length }));
        const asked = rig.asked.length;
        await media.flipCamera();
        off();
        expect(told, 'nobody holding a copy was told').toHaveLength(1);
        expect(told[0].track).toBe(front);
        expect(told[0].live, 'told after the camera was stopped').toBe(true);
        expect(told[0].asked, 'told after the next camera was asked for').toBe(asked);
        await media.flipCamera();
        expect(told, 'an unregistered listener is not told').toHaveLength(1);
    });

    it('the choice is remembered: the camera turned off and on again is the rear one', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        await media.flipCamera();
        expect(rememberedCamera()).toEqual({ deviceId: 'back', label: 'camera2 0, facing back', facing: 'environment' });
        await media.toggleVideo(false);
        expect(rig.open.size).toBe(0);
        await media.toggleVideo(true);
        await flush();
        expect(videoOf(media)[0].cam).toBe(BACK);
        expect(localCameraState().facing).toBe('environment');
    });

    it('a remembered camera is found again by its name when its id changed (site data cleared)', async () => {
        useCameras([FRONT, BACK]);
        saveSettings({ ...loadSettings(), camera: { deviceId: 'an-old-id', label: 'camera2 0, facing back', facing: 'environment' } });
        const media = inCall();
        await media.toggleVideo(true);
        expect(videoOf(media)[0].cam).toBe(BACK);
        expect(rig.asked[0].deviceId).toEqual({ exact: 'back' });
    });

    it('the first camera of a launch (no ids or names yet): the remembered MAIN rear camera, by its id, not the first rear one an engine finds', async () => {
        // Chromium on Android lists the ultra wide before the main rear camera
        // (descending camera numbers); asked only for "the rear camera" it
        // takes the first. The stand-in does the same for an exact facingMode.
        const ULTRA_FIRST: Cam = { deviceId: 'ultra', label: 'camera2 2, facing back', facing: 'environment' };
        const MAIN: Cam = { deviceId: 'main', label: 'camera2 0, facing back', facing: 'environment' };
        useCameras([FRONT, ULTRA_FIRST, MAIN], { noIds: true });
        saveSettings({ ...loadSettings(), camera: { deviceId: 'main', label: 'camera2 0, facing back', facing: 'environment' } });
        const media = inCall();
        await media.toggleVideo(true);
        expect(videoOf(media)[0].cam, 'the remembered main camera came back as the ultra wide').toBe(MAIN);
        expect(rig.asked[0].deviceId).toEqual({ exact: 'main' });
    });

    it('a remembered id that no longer opens, with no list yet: the way it faced, then the default', async () => {
        useCameras([FRONT, BACK], { noIds: true });
        saveSettings({ ...loadSettings(), camera: { deviceId: 'an-old-id', label: 'camera2 0, facing back', facing: 'environment' } });
        const media = inCall();
        await media.toggleVideo(true);
        expect(rig.asked.map(a => a.deviceId ?? a.facingMode)).toEqual([{ exact: 'an-old-id' }, { exact: 'environment' }]);
        expect(videoOf(media)[0].cam).toBe(BACK);
    });

    it('a switch still opening when the call ended does not answer the next call\'s first press, nor count as under way there', async () => {
        let letBackOpen!: () => void;
        const backHangs = new Promise<void>(r => { letBackOpen = r; });
        useCameras([FRONT, BACK], { hang: (cam) => (cam === BACK ? backHangs : null) });
        const media = inCall();
        await media.toggleVideo(true);
        const old = media.flipCamera(); // the back camera never opens
        await flush();
        expect(media.cameraSwitchInProgress()).toBe(true);
        media.stopLocalStream(); // the call ends
        expect(media.cameraSwitchInProgress(), 'the next call starts with a switch under way').toBe(false);
        (media as unknown as { localStream: FakeStream }).localStream = new FakeStream(); // the next call
        await media.toggleVideo(true);
        const next = await media.switchCamera({ deviceId: 'front' });
        expect(next.ok, 'the next call\'s press was answered with the old call\'s switch').toBe(true);
        letBackOpen();
        const r = await old;
        await settle();
        expect(r.ok).toBe(false);
        expect(rig.lateTracks.map(t => t.readyState), 'the old switch\'s camera was left on').toEqual(['ended']);
        expect(videoOf(media).map(t => t.cam)).toEqual([FRONT]);
    });

    it('the camera turned off while a switch hangs: turned on again, it is not held up by that switch', async () => {
        let letBackOpen!: () => void;
        const backHangs = new Promise<void>(r => { letBackOpen = r; });
        useCameras([FRONT, BACK], { hang: (cam) => (cam === BACK ? backHangs : null) });
        const media = inCall();
        await media.toggleVideo(true);
        const hung = media.flipCamera();
        let answer: CameraSwitch | 'none yet' = 'none yet';
        void hung.then(r => { answer = r; });
        await flush();
        await media.toggleVideo(false);
        expect(media.cameraSwitchInProgress(), 'the hold sweep would keep waiting on the hung switch').toBe(false);
        await flush();
        expect(answer, 'the press waits on a camera that is off (the panel takes no other press until it is answered)')
            .toEqual({ ok: false, reason: 'no-camera', track: null });
        await media.toggleVideo(true);
        const next = await media.switchCamera({ deviceId: 'front' });
        expect(next.ok, 'a press answered with the hung switch').toBe(true);
        letBackOpen();
        await hung;
        await settle();
        expect(rig.lateTracks.map(t => t.readyState)).toEqual(['ended']);
        expect(videoOf(media).map(t => t.cam)).toEqual([FRONT]);
    });

    it('in the call manager: turned off while a switch hangs, it is no longer a switch under way there at once (the hold sweep keeps a stand-in of the old camera, and its light, while one is)', async () => {
        let letBackOpen!: () => void;
        const backHangs = new Promise<void>(r => { letBackOpen = r; });
        useCameras([FRONT, BACK], { hang: (cam) => (cam === BACK ? backHangs : null) });
        const mgr = new WebRTCManager();
        const media = (mgr as unknown as { media: MediaManager }).media;
        (media as unknown as { localStream: FakeStream }).localStream = new FakeStream();
        const underWay = () => (mgr as unknown as { cameraSwitchesUnderWay: number }).cameraSwitchesUnderWay;
        try {
            await media.toggleVideo(true);
            let answer: CameraSwitch | 'none yet' = 'none yet';
            void mgr.flipCamera().then(r => { answer = r; });
            await flush();
            expect(underWay(), 'precondition: the switch is under way').toBe(1);
            await mgr.toggleVideo(false);
            await settle();
            expect(underWay(), 'still under way after Turn off: the sweep waits up to 20 s').toBe(0);
            expect(answer).toEqual({ ok: false, reason: 'no-camera', track: null });
            letBackOpen();
            await settle();
            expect(rig.lateTracks.map(t => t.readyState), 'the camera that opened late was left on').toEqual(['ended']);
            expect(videoOf(media)).toEqual([]);
        } finally {
            mgr.closeAll();
        }
    });

    it('turned off while a remembered camera is slow to refuse: no other camera is tried (no camera light after Turn off)', async () => {
        let letBackRefuse!: () => void;
        const backSlow = new Promise<void>(r => { letBackRefuse = r; });
        useCameras([FRONT, BACK], {
            hang: (cam) => (cam === BACK ? backSlow : null),
            refuse: (cam) => (cam === BACK ? named('NotReadableError') : null),
        });
        saveSettings({ ...loadSettings(), camera: { deviceId: 'back', label: BACK.label, facing: 'environment' } });
        const media = inCall();
        const turningOn = media.toggleVideo(true);
        await settle();
        expect(rig.asked.map(a => a.deviceId), 'precondition: the remembered camera is being opened').toEqual([{ exact: 'back' }]);
        await media.toggleVideo(false);
        letBackRefuse();
        expect(await turningOn).toBeNull();
        await settle();
        expect(rig.asked.length, 'the default camera was opened after the camera was turned off').toBe(1);
        expect(rig.open.size).toBe(0);
        expect(videoOf(media)).toEqual([]);
    });

    it('CONTROL: left on, the same slow refusal does open the default camera', async () => {
        let letBackRefuse!: () => void;
        const backSlow = new Promise<void>(r => { letBackRefuse = r; });
        useCameras([FRONT, BACK], {
            hang: (cam) => (cam === BACK ? backSlow : null),
            refuse: (cam) => (cam === BACK ? named('NotReadableError') : null),
        });
        saveSettings({ ...loadSettings(), camera: { deviceId: 'back', label: BACK.label, facing: 'environment' } });
        const media = inCall();
        const turningOn = media.toggleVideo(true);
        await settle();
        letBackRefuse();
        expect(await turningOn).not.toBeNull();
        expect(videoOf(media).map(t => t.cam)).toEqual([FRONT]);
    });

    it('a remembered camera that is gone opens the default one instead of no camera', async () => {
        // Listed when chosen, gone now; and an id the phone refuses outright.
        useCameras([FRONT, BACK]);
        saveSettings({ ...loadSettings(), camera: { deviceId: 'usb-cam', label: 'Old USB camera', facing: null } });
        const media = inCall();
        await media.toggleVideo(true);
        expect(videoOf(media)[0].cam).toBe(FRONT);
        useCameras([]);
        rig.enumerateDevices.mockResolvedValue([]); // no list: the id itself is asked for, and refused
        const media2 = inCall();
        rig = phone([FRONT]);
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: rig.getUserMedia, enumerateDevices: vi.fn(async () => []) } });
        await media2.toggleVideo(true);
        expect(rig.asked.map(a => a.deviceId)).toEqual([{ exact: 'usb-cam' }, undefined]);
        expect(videoOf(media2)[0].cam).toBe(FRONT);
    });

    it('a camera chosen from the menu: exactly that one (an ultra wide, not the main rear one)', async () => {
        useCameras([FRONT, BACK, ULTRA]);
        const media = inCall();
        await media.toggleVideo(true);
        const r = await media.switchCamera({ deviceId: 'ultra' });
        await flush();
        expect(r.ok && videoOf(media)[0].cam).toBe(ULTRA);
        expect(localCameraState().deviceId).toBe('ultra');
        expect(localCameraState().cameras.map(c => c.deviceId)).toEqual(['front', 'back', 'ultra']);
        // And Flip from it goes to the front.
        await media.flipCamera();
        expect(videoOf(media)[0].cam).toBe(FRONT);
    });

    it('names it cannot read (iOS localises them): Flip asks for the other way exactly, from what the open track says', async () => {
        const avant: Cam = { deviceId: 'f1', label: 'Caméra avant', facing: 'user' };
        const arriere: Cam = { deviceId: 'f2', label: 'Caméra arrière', facing: 'environment' };
        useCameras([avant, arriere], { listFacing: false }); // the list says nothing; the tracks do
        const media = inCall();
        await media.toggleVideo(true);
        await media.flipCamera();
        expect(rig.asked.at(-1)?.facingMode).toEqual({ exact: 'environment' });
        expect(videoOf(media)[0].cam).toBe(arriere);
    });
});

describe('when a camera will not open', () => {
    it('the camera that was on is put back, and the switch says it failed', async () => {
        useCameras([FRONT, BACK], { refuse: (cam) => (cam === BACK ? named('NotReadableError') : null) });
        const media = inCall();
        await media.toggleVideo(true);
        const r = await media.flipCamera();
        await flush();
        expect(r.ok).toBe(false);
        expect(!r.ok && r.reason).toBe('unavailable');
        expect(r.track && (r.track as unknown as FakeTrack).cam).toBe(FRONT);
        expect(videoOf(media).map(t => t.cam)).toEqual([FRONT]);
        expect(localCameraState().facing).toBe('user');
        expect(rememberedCamera(), 'a camera that never opened is not remembered').toBeNull();
    });

    it('the camera put back is a NEW track, and the self-view is told (it re-binds, or it shows the stopped one: black)', async () => {
        useCameras([FRONT, BACK], { refuse: (cam) => (cam === BACK ? named('NotReadableError') : null) });
        const media = inCall();
        await media.toggleVideo(true);
        await flush();
        const before = videoOf(media)[0];
        let told = 0;
        const off = onLocalCameraState(() => { told++; });
        await media.flipCamera();
        await flush();
        off();
        const after = videoOf(media)[0];
        expect(after.cam, 'the camera that was on is back').toBe(FRONT);
        expect(after, 'the same camera, opened again: a new track').not.toBe(before);
        expect(before.readyState).toBe('ended');
        expect(localCameraState().trackId, 'the store still names the stopped track').toBe(after.id);
        expect(told, 'nobody was told the camera changed, so the self-view kept the stopped track').toBeGreaterThan(0);
    });

    it('a camera that never opens is given up after 20 s: the one that was on is back, and if it opens late it is stopped (no light left on)', async () => {
        let letBackOpen!: () => void;
        const backHangs = new Promise<void>(r => { letBackOpen = r; });
        useCameras([FRONT, BACK], { hang: (cam) => (cam === BACK ? backHangs : null) });
        const media = inCall();
        await media.toggleVideo(true);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const flipping = media.flipCamera();
            await vi.advanceTimersByTimeAsync(MediaManager.SWITCH_OPEN_TIMEOUT_MS + 10);
            const r = await flipping;
            expect(r.ok, 'the switch waited for ever (and every press after it)').toBe(false);
            expect(!r.ok && r.reason).toBe('unavailable');
            expect(videoOf(media).map(t => t.cam)).toEqual([FRONT]);
            expect(media.cameraSwitchInProgress()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
        letBackOpen();
        await flush();
        expect(rig.lateTracks.map(t => t.readyState), 'the camera that opened late was left on').toEqual(['ended']);
    });

    it('a switch is under way from its start to its answer (the hold sweep waits for it)', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        expect(media.cameraSwitchInProgress()).toBe(false);
        const release = rig.hold();
        const flipping = media.flipCamera();
        await flush();
        expect(media.cameraSwitchInProgress()).toBe(true);
        release();
        await flipping;
        expect(media.cameraSwitchInProgress()).toBe(false);
    });

    it('turned off while the switch waits to ask again: it does not ask (no camera light, nothing a phone would then refuse)', async () => {
        const media = inCall();
        let refusedOnce = false;
        useCameras([FRONT, BACK], {
            refuse: (cam) => {
                if (cam !== BACK || refusedOnce) return null;
                refusedOnce = true;
                setTimeout(() => { void media.toggleVideo(false); }, 50); // during the 400 ms wait
                return named('NotReadableError');
            },
        });
        await media.toggleVideo(true);
        const r = await media.flipCamera();
        expect(r.ok).toBe(false);
        expect(rig.asked.filter(a => (a.deviceId as ConstrainDOMStringParameters | undefined)?.exact === 'back').length, 'asked for the camera again after it was turned off').toBe(1);
        expect(rig.open.size).toBe(0);
    });

    it('a camera still being let go of is asked for once more, a moment later', async () => {
        let refusals = 1;
        useCameras([FRONT, BACK], { refuse: (cam) => (cam === BACK && refusals-- > 0 ? named('NotReadableError') : null) });
        const media = inCall();
        await media.toggleVideo(true);
        const r = await media.flipCamera();
        expect(r.ok).toBe(true);
        expect(videoOf(media)[0].cam).toBe(BACK);
    });

    it('neither opens: no camera, and it says so (the panel then turns the camera off)', async () => {
        let first = true;
        useCameras([FRONT, BACK], { refuse: () => (first ? (first = false, null) : named('NotReadableError')) });
        const media = inCall();
        await media.toggleVideo(true);
        const r = await media.flipCamera();
        expect(r.ok).toBe(false);
        expect(r.track).toBeNull();
        expect(videoOf(media)).toEqual([]);
    });

    it('a permission refusal is told apart', async () => {
        useCameras([FRONT, BACK], { refuse: (cam) => (cam === BACK ? named('NotAllowedError') : null) });
        const media = inCall();
        await media.toggleVideo(true);
        const r = await media.flipCamera();
        expect(!r.ok && r.reason).toBe('denied');
    });

    it('one camera: Flip changes nothing and opens nothing', async () => {
        useCameras([FRONT]);
        const media = inCall();
        await media.toggleVideo(true);
        const before = videoOf(media)[0];
        const r = await media.flipCamera();
        expect(!r.ok && r.reason).toBe('only-one');
        expect(videoOf(media)[0]).toBe(before);
        expect(before.readyState).toBe('live');
        expect(rig.getUserMedia).toHaveBeenCalledTimes(1);
    });
});

describe('presses and the call ending', () => {
    it('a second Flip while one is opening waits for it: one camera opened, not two', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        const release = rig.hold();
        const a = media.flipCamera();
        await flush();
        const b = media.flipCamera();
        release();
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.ok && rb.ok).toBe(true);
        expect(ra.track).toBe(rb.track);
        expect(videoOf(media).map(t => t.cam)).toEqual([BACK]);
        expect(rig.getUserMedia).toHaveBeenCalledTimes(2);
    });

    it('the camera turned off while the next one opens: it is let go of, nothing goes on', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        const release = rig.hold();
        const flipping = media.flipCamera();
        await flush();
        await media.toggleVideo(false);
        release();
        const r = await flipping;
        await settle();
        expect(r.ok).toBe(false);
        expect(videoOf(media)).toEqual([]);
        expect(rig.open.size, 'the camera opened meanwhile is still on (LED lit, nothing holds it)').toBe(0);
    });

    it('the call ended while the next one opens: the same', async () => {
        useCameras([FRONT, BACK]);
        const media = inCall();
        await media.toggleVideo(true);
        const release = rig.hold();
        const flipping = media.flipCamera();
        await flush();
        media.stopLocalStream();
        release();
        await flipping;
        await settle();
        expect(rig.open.size).toBe(0);
        expect(localCameraState().deviceId).toBeNull();
    });
});
