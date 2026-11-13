import { describe, it, expect } from 'vitest';

import {
    cameraConstraints, cameraDisplayName, camerasOf, canFlip, facingFromLabel, facingOf, flipLabel, flipTarget,
    localCameraState, mainCamera, onLocalCameraState, rememberedRequests, selfViewMirrored, setLocalCameraState,
    type CameraInfo,
} from '../api/rtc/cameraChoice';

/**
 * The rules behind Flip and the camera menu (api/rtc/cameraChoice.ts). The
 * owner's report: "clicking 'flip' on camera just mirrors the image, there
 * should be an option to use rear cameras too". Flip asked for the FRONT
 * camera every time (the button passed a constant "current facing mode" of
 * 'environment', so the opposite was always 'user'); the switch itself is in
 * cameraSwitch.test.ts and, for real, e2e/android-camera-flip-live.mjs.
 */

// What the browsers really call their cameras.
const ANDROID: CameraInfo[] = [
    { deviceId: 'a-front', label: 'camera2 1, facing front', facing: 'user' },
    { deviceId: 'a-back', label: 'camera2 0, facing back', facing: 'environment' },
];
const IPHONE: CameraInfo[] = [
    { deviceId: 'i-front', label: 'Front Camera', facing: 'user' },
    { deviceId: 'i-dualwide', label: 'Back Dual Wide Camera', facing: 'environment' },
    { deviceId: 'i-ultra', label: 'Back Ultra Wide Camera', facing: 'environment' },
    { deviceId: 'i-back', label: 'Back Camera', facing: 'environment' },
    { deviceId: 'i-tele', label: 'Back Telephoto Camera', facing: 'environment' },
];
const DESKTOP: CameraInfo[] = [
    { deviceId: 'd-1', label: 'Integrated Webcam (0bda:58f4)', facing: null },
    { deviceId: 'd-2', label: 'Logitech BRIO (046d:085e)', facing: null },
    { deviceId: 'd-3', label: 'OBS Virtual Camera', facing: null },
];

describe('which way a camera faces', () => {
    it.each([
        ['camera2 1, facing front', 'user'],
        ['camera2 0, facing back', 'environment'],
        ['camera 0, facing front', 'user'], // the Android emulator
        ['Front Camera', 'user'],
        ['Back Ultra Wide Camera', 'environment'],
        ['Microsoft Camera Rear', 'environment'],
        ['Microsoft Camera Front', 'user'],
        ['Integrated Webcam (0bda:58f4)', null],
        ['FaceTime HD Camera', null],
        ['', null],
    ])('%s -> %s', (label, want) => {
        expect(facingFromLabel(label)).toBe(want);
    });

    it("the browser's own word (getCapabilities) beats the name", () => {
        expect(facingOf({ label: 'Caméra arrière', getCapabilities: () => ({ facingMode: ['environment'] }) })).toBe('environment');
        expect(facingOf({ label: 'Back Camera', getCapabilities: () => ({ facingMode: ['user'] }) })).toBe('user');
        expect(facingOf({ label: 'Back Camera', getCapabilities: () => ({}) })).toBe('environment');
        expect(facingOf({ label: 'Back Camera', getCapabilities: () => { throw new Error('not a capture device'); } })).toBe('environment');
    });

    it('camerasOf keeps the video inputs, in the browser order, and names the unnamed', () => {
        const list = camerasOf([
            { kind: 'audioinput', deviceId: 'm', label: 'Mic' },
            { kind: 'videoinput', deviceId: 'x', label: '' },
            { kind: 'videoinput', deviceId: 'y', label: 'camera2 0, facing back' },
        ]);
        expect(list).toEqual([
            { deviceId: 'x', label: 'Camera 1', facing: null },
            { deviceId: 'y', label: 'camera2 0, facing back', facing: 'environment' },
        ]);
    });
});

describe('where Flip goes', () => {
    it('Android: front -> back -> front', () => {
        expect(flipTarget(ANDROID, { deviceId: 'a-front', facing: 'user' })).toEqual({ deviceId: 'a-back' });
        expect(flipTarget(ANDROID, { deviceId: 'a-back', facing: 'environment' })).toEqual({ deviceId: 'a-front' });
    });

    it('THE BUG: from the front camera, Flip never asks for a front camera again', () => {
        // What the old button did: switchCamera('environment') -> "opposite" = 'user'.
        const target = flipTarget(ANDROID, { deviceId: 'a-front', facing: 'user' });
        expect(target).not.toEqual({ facing: 'user' });
        expect(target).not.toEqual({ deviceId: 'a-front' });
    });

    it("iPhone: front -> the plain Back Camera, not the ultra wide, the telephoto or a virtual one", () => {
        expect(flipTarget(IPHONE, { deviceId: 'i-front', facing: 'user' })).toEqual({ deviceId: 'i-back' });
        expect(mainCamera(IPHONE, 'environment')?.deviceId).toBe('i-back');
        // From any rear lens back to the front.
        expect(flipTarget(IPHONE, { deviceId: 'i-ultra', facing: 'environment' })).toEqual({ deviceId: 'i-front' });
    });

    it("the open track's word beats the list's guess", () => {
        const misnamed: CameraInfo[] = [
            { deviceId: 'p', label: 'Camera A', facing: null },
            { deviceId: 'q', label: 'Back camera', facing: 'environment' },
        ];
        // The track says it faces the user: the list's rear camera is the target.
        expect(flipTarget(misnamed, { deviceId: 'p', facing: 'user' })).toEqual({ deviceId: 'q' });
    });

    it('names in a language we do not read (iOS localises them): the other way, EXACTLY', () => {
        const french: CameraInfo[] = [
            { deviceId: 'f1', label: 'Caméra avant', facing: null },
            { deviceId: 'f2', label: 'Caméra arrière', facing: null },
        ];
        expect(flipTarget(french, { deviceId: 'f1', facing: 'user' })).toEqual({ facing: 'environment' });
        expect(flipTarget(french, { deviceId: 'f2', facing: 'environment' })).toEqual({ facing: 'user' });
        // And with no list at all (enumerateDevices refused).
        expect(flipTarget([], { deviceId: null, facing: 'user' })).toEqual({ facing: 'environment' });
    });

    it("a laptop's infrared (Windows Hello) camera is passed over: Flip goes on to a camera with a picture", () => {
        const laptop: CameraInfo[] = [
            { deviceId: 'l-cam', label: 'Integrated Camera', facing: null },
            { deviceId: 'l-ir', label: 'Integrated IR Camera', facing: null },
            { deviceId: 'l-usb', label: 'Logitech C920', facing: null },
        ];
        expect(flipTarget(laptop, { deviceId: 'l-cam', facing: null })).toEqual({ deviceId: 'l-usb' });
        expect(flipTarget(laptop, { deviceId: 'l-usb', facing: null })).toEqual({ deviceId: 'l-cam' });
        // One webcam and an IR camera: nowhere to Flip to (it would open the
        // IR camera and remember it for every call), and no Flip shown.
        expect(flipTarget(laptop.slice(0, 2), { deviceId: 'l-cam', facing: null })).toBeNull();
        expect(canFlip({ cameras: laptop.slice(0, 2), deviceId: 'l-cam', facing: null })).toBe(false);
        expect(canFlip({ cameras: laptop, deviceId: 'l-cam', facing: null })).toBe(true);
        // The IR camera on (chosen from the menu): Flip leaves it.
        expect(flipTarget(laptop, { deviceId: 'l-ir', facing: null })).toEqual({ deviceId: 'l-usb' });
        // Words that merely contain the letters are not infrared.
        expect(flipTarget([{ deviceId: 'a', label: 'Fairphone Camera', facing: null }, { deviceId: 'b', label: 'Mirror Cam', facing: null }],
            { deviceId: 'a', facing: null })).toEqual({ deviceId: 'b' });
    });

    it('desktop webcams face no known way: the next one, round', () => {
        expect(flipTarget(DESKTOP, { deviceId: 'd-1', facing: null })).toEqual({ deviceId: 'd-2' });
        expect(flipTarget(DESKTOP, { deviceId: 'd-3', facing: null })).toEqual({ deviceId: 'd-1' });
    });

    it('a laptop whose one known camera faces you and a USB one that says nothing: the USB one', () => {
        const mixed: CameraInfo[] = [
            { deviceId: 'm1', label: 'Front Camera', facing: 'user' },
            { deviceId: 'm2', label: 'USB Camera', facing: null },
        ];
        expect(flipTarget(mixed, { deviceId: 'm1', facing: 'user' })).toEqual({ deviceId: 'm2' });
    });

    it('Flip is shown only where it has somewhere to go', () => {
        expect(canFlip({ cameras: ANDROID, deviceId: 'a-front', facing: 'user' })).toBe(true);
        expect(canFlip({ cameras: DESKTOP, deviceId: 'd-1', facing: null })).toBe(true);
        expect(canFlip({ cameras: [ANDROID[0]], deviceId: 'a-front', facing: 'user' })).toBe(false);
        expect(canFlip({ cameras: [], deviceId: null, facing: null })).toBe(false);
    });

    it('one camera: nowhere to go', () => {
        expect(flipTarget([ANDROID[0]], { deviceId: 'a-front', facing: 'user' })).toBeNull();
        expect(flipTarget([DESKTOP[0]], { deviceId: 'd-1', facing: null })).toBeNull();
    });

    it('says what it will do', () => {
        expect(flipLabel({ cameras: ANDROID, deviceId: 'a-front', facing: 'user' })).toBe('Switch to the rear camera');
        expect(flipLabel({ cameras: ANDROID, deviceId: 'a-back', facing: 'environment' })).toBe('Switch to the front camera');
        expect(flipLabel({ cameras: DESKTOP, deviceId: 'd-1', facing: null })).toBe('Switch camera');
        // Localised names: the engine is asked for the other way.
        expect(flipLabel({ cameras: [{ deviceId: 'f1', label: 'Caméra avant', facing: null }, { deviceId: 'f2', label: 'Caméra arrière', facing: null }],
            deviceId: 'f1', facing: 'user' })).toBe('Switch to the rear camera');
    });

    it('it says where it actually goes: a laptop camera that faces the user flips to a USB webcam, not "to the rear camera"', () => {
        const laptop: CameraInfo[] = [
            { deviceId: 'm1', label: 'Integrated Camera', facing: 'user' },
            { deviceId: 'm2', label: 'Logitech C920', facing: null },
        ];
        expect(flipTarget(laptop, { deviceId: 'm1', facing: 'user' })).toEqual({ deviceId: 'm2' });
        expect(flipLabel({ cameras: laptop, deviceId: 'm1', facing: 'user' })).toBe('Switch camera');
    });
});

describe('the constraints that open it', () => {
    it('a camera by id or a way it faces is asked for EXACTLY (an ideal lets the browser keep the one it has)', () => {
        expect(cameraConstraints({ deviceId: 'a-back' }).deviceId).toEqual({ exact: 'a-back' });
        expect(cameraConstraints({ facing: 'environment' }).facingMode).toEqual({ exact: 'environment' });
        expect(cameraConstraints({ facing: 'environment' }).deviceId).toBeUndefined();
    });

    it('none asks for no camera in particular: the browser\'s default (the front one on a phone), as before this change', () => {
        // Not even ideal 'user': Chromium scores a built-in camera that says it
        // faces the user above a USB webcam that says nothing, so a docked
        // laptop with its lid shut would get the black built-in camera.
        expect(cameraConstraints(null).facingMode).toBeUndefined();
        expect(cameraConstraints(null).deviceId).toBeUndefined();
    });

    it('the size and rate are preferences, never limits (a max a camera cannot meet refuses to open it)', () => {
        for (const c of [cameraConstraints({ deviceId: 'x' }), cameraConstraints({ facing: 'environment' }), cameraConstraints(null)]) {
            expect(c.width).toEqual({ ideal: 1280 });
            expect(c.height).toEqual({ ideal: 720 });
            expect(c.frameRate).toEqual({ ideal: 30 });
        }
    });
});

describe('the remembered camera', () => {
    it('found by id', () => {
        expect(rememberedRequests(ANDROID, { deviceId: 'a-back', label: 'x', facing: 'environment' })).toEqual([{ deviceId: 'a-back' }]);
    });

    it('found by name when the ids changed (site data cleared)', () => {
        expect(rememberedRequests(IPHONE, { deviceId: 'gone', label: 'Back Telephoto Camera', facing: 'environment' })).toEqual([{ deviceId: 'i-tele' }]);
    });

    it('found by the way it faced when neither is there', () => {
        expect(rememberedRequests(IPHONE, { deviceId: 'gone', label: 'Rückkamera', facing: 'environment' })).toEqual([{ deviceId: 'i-back' }]);
    });

    it('gone altogether (a webcam unplugged): the default', () => {
        expect(rememberedRequests(DESKTOP, { deviceId: 'gone', label: 'Old cam', facing: null })).toEqual([]);
    });

    it('no list to look in yet (the camera not yet allowed in this page): its id FIRST, then the way it faced', () => {
        // Asked only for "the rear camera", Chromium on Android takes the first
        // rear one it lists: a secondary lens on a phone with several.
        expect(rememberedRequests([{ deviceId: '', label: 'Camera 1', facing: null }], { deviceId: 'a-back', label: 'camera2 0, facing back', facing: 'environment' }))
            .toEqual([{ deviceId: 'a-back' }, { facing: 'environment' }]);
        expect(rememberedRequests([], { deviceId: 'd-2', label: 'BRIO', facing: null })).toEqual([{ deviceId: 'd-2' }]);
        expect(rememberedRequests([], { deviceId: '', label: '', facing: 'environment' })).toEqual([{ facing: 'environment' }]);
    });

    it('nothing remembered: the default', () => {
        expect(rememberedRequests(ANDROID, null)).toEqual([]);
    });
});

describe('the self-view', () => {
    it('mirrored for a front camera and one that faces no known way (a webcam), never for a rear one', () => {
        expect(selfViewMirrored('user')).toBe(true);
        expect(selfViewMirrored(null)).toBe(true);
        expect(selfViewMirrored('environment')).toBe(false);
    });

    it('the store tells its listeners once per change, and not for the same state again', () => {
        let calls = 0;
        const off = onLocalCameraState(() => { calls++; });
        setLocalCameraState({ deviceId: 'a-back', facing: 'environment', cameras: ANDROID });
        setLocalCameraState({ deviceId: 'a-back', facing: 'environment', cameras: [...ANDROID.map(c => ({ ...c }))] });
        expect(calls).toBe(1);
        expect(localCameraState().facing).toBe('environment');
        setLocalCameraState({ deviceId: null, facing: null });
        expect(calls).toBe(2);
        expect(localCameraState().cameras).toHaveLength(2); // a partial update keeps the list
        off();
        setLocalCameraState({ deviceId: 'a-front', facing: 'user' });
        expect(calls).toBe(2);
    });
});

describe('the names the menu shows', () => {
    it("Android's camera-service names become Front camera / Back camera, numbered when several", () => {
        expect(cameraDisplayName(ANDROID[0], ANDROID)).toBe('Front camera');
        expect(cameraDisplayName(ANDROID[1], ANDROID)).toBe('Back camera');
        const three = [...ANDROID, { deviceId: 'a-wide', label: 'camera2 2, facing back', facing: 'environment' as const }];
        expect(three.map(c => cameraDisplayName(c, three))).toEqual(['Front camera', 'Back camera 1', 'Back camera 2']);
    });

    it("Chromium's own Android order: the main rear camera (camera2 0) is Back camera 1 and where Flip goes, though it is listed last", () => {
        // video_capture_device_factory_android.cc GetDevicesInfo walks the
        // indices DOWNWARDS, putting front cameras first and appending the rest:
        // ids 0 (main rear), 1 (front), 2 (ultra wide) come out 1, 2, 0.
        const listed = camerasOf([
            { kind: 'videoinput', deviceId: 'id1', label: 'camera2 1, facing front' },
            { kind: 'videoinput', deviceId: 'id2', label: 'camera2 2, facing back' },
            { kind: 'videoinput', deviceId: 'id0', label: 'camera2 0, facing back' },
        ]);
        expect(listed.map(c => c.deviceId), 'the menu and the cycle follow the camera service').toEqual(['id1', 'id0', 'id2']);
        expect(flipTarget(listed, { deviceId: 'id1', facing: 'user' }), 'Flip opened the secondary lens').toEqual({ deviceId: 'id0' });
        expect(mainCamera(listed, 'environment')?.deviceId).toBe('id0');
        expect(listed.map(c => cameraDisplayName(c, listed))).toEqual(['Front camera', 'Back camera 1', 'Back camera 2']);
        // Straight from the browser's order too (mainCamera sorts on its own).
        const raw: CameraInfo[] = [
            { deviceId: 'id1', label: 'camera2 1, facing front', facing: 'user' },
            { deviceId: 'id2', label: 'camera2 2, facing back', facing: 'environment' },
            { deviceId: 'id0', label: 'camera2 0, facing back', facing: 'environment' },
        ];
        expect(flipTarget(raw, { deviceId: 'id1', facing: 'user' })).toEqual({ deviceId: 'id0' });
        expect(cameraDisplayName(raw[2], raw)).toBe('Back camera 1');
        // A list with any other name is the browser's order, untouched.
        const mixed = camerasOf([
            { kind: 'videoinput', deviceId: 'b', label: 'camera2 2, facing back' },
            { kind: 'videoinput', deviceId: 'u', label: 'USB Camera' },
        ]);
        expect(mixed.map(c => c.deviceId)).toEqual(['b', 'u']);
    });

    it("iOS's names as they are; a webcam's USB id dropped", () => {
        expect(IPHONE.map(c => cameraDisplayName(c, IPHONE))).toEqual(IPHONE.map(c => c.label));
        expect(cameraDisplayName(DESKTOP[0], DESKTOP)).toBe('Integrated Webcam');
        expect(cameraDisplayName(DESKTOP[2], DESKTOP)).toBe('OBS Virtual Camera');
    });
});
