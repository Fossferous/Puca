/**
 * WHICH CAMERA. A phone has a front camera and one or more rear ones (an
 * iPhone lists "Back Camera", "Back Ultra Wide Camera", "Back Telephoto
 * Camera" and the virtual "Back Dual Wide Camera"; Android lists what the
 * maker exposes, "camera2 0, facing back" and so on); a desktop has whatever
 * webcams are plugged in. This file decides, from what the browser reports:
 *
 *  - which way each camera faces (facingOf);
 *  - where Flip goes from the camera in use (flipTarget): from a front camera
 *    to the MAIN rear one, from a rear one to the front, and on a machine
 *    whose cameras face no known way, on to the next camera in the list;
 *  - the getUserMedia constraints that open exactly that camera
 *    (cameraConstraints): `exact`, because an `ideal` facingMode lets the
 *    browser hand back the camera already in use. Flip used to ask for the
 *    front camera EVERY time (the button passed a constant "current facing
 *    mode" of 'environment', so the opposite was always 'user'), which reopened
 *    the selfie camera — the owner's "flip just mirrors the image";
 *  - the remembered choice (rememberedRequests): a camera picked in the menu is
 *    found again by its id, else by its name (ids change when site data is
 *    cleared), else by the way it faced;
 *  - whether the self-view is mirrored (selfViewMirrored): your own FRONT
 *    camera is shown as a mirror shows you, as every call app does; a rear
 *    camera is shown as it is, or text it films reads backwards. A camera that
 *    faces no known way (a desktop webcam) is taken to face you.
 *
 * Pure apart from the small store at the bottom (what the open camera is), so
 * the rules are unit-tested without a browser (src/tests/cameraChoice.test.ts)
 * and the switch itself in one (e2e/android-camera-flip-live.mjs,
 * e2e/camera-switch-live.mjs).
 */

export type Facing = 'user' | 'environment' | null;

/** One camera the browser lists, with the way it faces when known. */
export interface CameraInfo {
    deviceId: string;
    /** What the browser calls it; "Camera 2" when it gives no name (no permission yet). */
    label: string;
    facing: Facing;
}

/** The camera chosen in the menu (or by Flip), as kept in Settings. */
export interface RememberedCamera {
    deviceId: string;
    label: string;
    facing: Facing;
}

/** What to open: one camera by id, or the main camera facing a way. */
export type CameraRequest = { deviceId: string } | { facing: 'user' | 'environment' };

/** The words a camera's name uses for the way it faces, in the names browsers
 *  give: Android "camera2 1, facing front", iOS "Front Camera" / "Back Ultra
 *  Wide Camera", Windows tablets "Microsoft Camera Front" / "... Rear". */
export function facingFromLabel(label: string): Facing {
    const l = label.toLowerCase();
    if (/\bfacing front\b|\bfront\b|\bselfie\b/.test(l)) return 'user';
    if (/\bfacing back\b|\bback\b|\brear\b|\benvironment\b/.test(l)) return 'environment';
    return null;
}

/** The way a listed camera faces: what the browser says outright
 *  (InputDeviceInfo.getCapabilities().facingMode, Chromium), else its name. */
export function facingOf(device: { label: string; getCapabilities?: () => { facingMode?: string[] } }): Facing {
    try {
        const said = device.getCapabilities?.().facingMode;
        if (said?.includes('user')) return 'user';
        if (said?.includes('environment')) return 'environment';
    } catch { /* not a capture device, or the engine has no capabilities */ }
    return facingFromLabel(device.label);
}

/** A track's own word for the way its camera faces, when the engine gives one. */
export function facingOfSettings(settings: { facingMode?: string } | null | undefined): Facing {
    const f = settings?.facingMode;
    return f === 'user' || f === 'environment' ? f : null;
}

/** The video inputs of an enumerateDevices() list, named and faced. */
export function camerasOf(devices: ReadonlyArray<{ kind: string; deviceId: string; label: string; getCapabilities?: () => { facingMode?: string[] } }>): CameraInfo[] {
    const videos = devices.filter(d => d.kind === 'videoinput');
    return androidOrder(videos.map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Camera ${i + 1}`,
        facing: facingOf(d),
    })));
}

/** The camera service's number in an Android name ("camera2 2, facing back"
 *  -> 2), or null for any other name. */
function androidIndex(label: string): number | null {
    const m = /^camera2? (\d+), facing (?:front|back)$/i.exec(label.trim());
    return m ? Number(m[1]) : null;
}

/**
 * Android's cameras in the camera service's own order: front ones first, then
 * the rest by their number, 0 (the main rear camera, by Android's convention)
 * first. Chromium lists them otherwise: its GetDevicesInfo walks the indices
 * DOWNWARDS, putting front cameras at the start and appending the rest, so a
 * phone exposing "camera2 0" (main) and "camera2 2" (ultra wide, or depth)
 * listed camera2 2 first, and Flip opened it. Any list with a name that is
 * not Android's is left as the browser gave it.
 */
function androidOrder(cameras: CameraInfo[]): CameraInfo[] {
    if (cameras.length < 2 || cameras.some(c => androidIndex(c.label) === null)) return cameras;
    return [...cameras].sort((a, b) => ((a.facing === 'user' ? 0 : 1) - (b.facing === 'user' ? 0 : 1))
        || (androidIndex(a.label)! - androidIndex(b.label)!));
}

/** Every camera the browser lists now ([] when it will not say). Names and
 *  ids come only once the camera has been allowed. */
export async function listCameras(): Promise<CameraInfo[]> {
    try {
        return camerasOf(await navigator.mediaDevices.enumerateDevices());
    } catch {
        return [];
    }
}

/** A secondary lens or a virtual camera made of several: not what Flip picks
 *  when there is a plain one facing the same way. */
const AUXILIARY = /ultra|wide|tele|macro|depth|dual|triple|zoom|infrared|\bir\b/i;

/** The camera of `facing` a person means by "the rear camera": the first
 *  plain one (iOS "Back Camera"; on Android the lowest number, "camera2 0"),
 *  else the first of any. */
export function mainCamera(cameras: CameraInfo[], facing: 'user' | 'environment'): CameraInfo | null {
    const of = androidOrder(cameras).filter(c => c.facing === facing);
    return of.find(c => !AUXILIARY.test(c.label)) ?? of[0] ?? null;
}

/**
 * Where Flip goes from the camera in use. `current.facing` is what the open
 * track says about itself (getSettings), which beats the list's guess: iOS
 * gives its cameras localised names and no capabilities, but the open track
 * still says which way it faces.
 *
 * Answers null when there is nowhere to go (one camera).
 */
export function flipTarget(cameras: CameraInfo[], current: { deviceId: string | null; facing: Facing }): CameraRequest | null {
    const mine = cameras.find(c => c.deviceId === current.deviceId) ?? null;
    const facing = current.facing ?? mine?.facing ?? null;
    if (facing) {
        const want = facing === 'user' ? 'environment' : 'user';
        const target = mainCamera(cameras.filter(c => c.deviceId !== current.deviceId), want);
        if (target) return { deviceId: target.deviceId };
        // The list says nothing about any camera (no names yet, or names in a
        // language we do not read): ask the engine for the other way, exactly.
        if (cameras.length !== 1 && cameras.every(c => c.facing === null)) return { facing: want };
    }
    // Cameras that face no known way (desktop webcams), or only one way: the
    // next one in the list, round. Never to an infrared or depth camera (a
    // laptop's Windows Hello "IR Camera"): it shows no picture a call wants,
    // Flip would remember it for every call after, and one that will not open
    // would stand between Flip and a third camera. So a laptop with one webcam
    // and an IR camera has nowhere to Flip to; the camera menu still lists the
    // IR camera for anyone who means it.
    if (cameras.length < 2) return null;
    const seeing = cameras.filter(c => !SENSOR_ONLY.test(c.label) || c.deviceId === current.deviceId);
    if (seeing.length < 2) return null;
    const at = seeing.findIndex(c => c.deviceId === current.deviceId);
    const next = seeing[(at + 1) % seeing.length];
    return next && next.deviceId !== current.deviceId ? { deviceId: next.deviceId } : null;
}

/** Whether Flip has anywhere to go from the camera on (it is shown only then). */
export function canFlip(state: { cameras: CameraInfo[]; deviceId: string | null; facing: Facing }): boolean {
    return state.cameras.length > 1 && flipTarget(state.cameras, { deviceId: state.deviceId, facing: state.facing }) !== null;
}

/** A camera that is a sensor rather than a picture: infrared, depth. */
const SENSOR_ONLY = /infrared|\bir\b|depth/i;

const ANDROID_NAME = /^camera2? \d+, facing (front|back)$/i;

/**
 * The name the camera menu shows. Android's names are the camera service's
 * ("camera2 0, facing back"): those become "Back camera" (numbered when the
 * phone lists several facing the same way, in its own order). A USB webcam's
 * trailing "(046d:0825)" is dropped. Everything else, iOS's "Back Ultra Wide
 * Camera" among them, is shown as the browser gives it.
 */
export function cameraDisplayName(camera: CameraInfo, all: CameraInfo[]): string {
    const m = ANDROID_NAME.exec(camera.label.trim());
    if (m) {
        const front = m[1].toLowerCase() === 'front';
        const same = androidOrder(all).filter(c => {
            const o = ANDROID_NAME.exec(c.label.trim());
            return o && (o[1].toLowerCase() === 'front') === front;
        });
        const base = front ? 'Front camera' : 'Back camera';
        return same.length > 1 ? `${base} ${same.findIndex(c => c.deviceId === camera.deviceId) + 1}` : base;
    }
    return camera.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') || camera.label;
}

/** What the Flip control says it will do: by where it actually goes. A
 *  laptop camera that says it faces the user, with a USB webcam that says
 *  nothing beside it, flips to the webcam: "Switch camera", not "to the rear
 *  camera". */
export function flipLabel(state: { cameras: CameraInfo[]; deviceId: string | null; facing: Facing }): string {
    const target = flipTarget(state.cameras, { deviceId: state.deviceId, facing: state.facing });
    const to = !target ? null
        : 'facing' in target ? target.facing
            : state.cameras.find(c => c.deviceId === target.deviceId)?.facing ?? null;
    return to === 'environment' ? 'Switch to the rear camera'
        : to === 'user' ? 'Switch to the front camera'
            : 'Switch camera';
}

/** What every camera is asked for: preferences, never limits. A `max` is a
 *  requirement, and a camera that cannot meet one (a capture device with only
 *  a 60 fps mode, in an engine that will not decimate) refuses to open at all;
 *  the camera used to open with ideal sizes only. */
const BASE: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
};

/**
 * getUserMedia video constraints. A request opens exactly that camera (or
 * fails, and the caller falls back: openCamera in media.ts). None asks for no
 * camera in particular: the browser's default, which on a phone is the front
 * camera (Chromium on Android lists it first; so does Safari on iOS) and on a
 * computer the system's default webcam. Not even `ideal: 'user'`: it scores a
 * built-in camera that says it faces the user above a USB webcam that says
 * nothing, so a docked laptop with its lid shut would open the black built-in
 * camera instead of the webcam it always had.
 */
export function cameraConstraints(request: CameraRequest | null): MediaTrackConstraints {
    if (request && 'deviceId' in request) return { ...BASE, deviceId: { exact: request.deviceId } };
    if (request && 'facing' in request) return { ...BASE, facingMode: { exact: request.facing } };
    return { ...BASE };
}

/**
 * The remembered camera, as the requests to try, in order (the default camera
 * after them all). In today's list: by id, by name, then the main camera
 * facing the way it faced. Without a list to look in (a browser hands out
 * ids and names only once the camera is allowed in that page: the first
 * camera of every launch of the Android app, every load on an iPhone) its id
 * FIRST, then the way it faced: asked only for "the rear camera", Chromium on
 * Android takes the first rear one it lists, which is a secondary lens on a
 * phone with several (see androidOrder).
 */
export function rememberedRequests(cameras: CameraInfo[], remembered: RememberedCamera | null | undefined): CameraRequest[] {
    if (!remembered) return [];
    const usable = cameras.filter(c => c.deviceId);
    if (usable.length > 0) {
        const byId = usable.find(c => c.deviceId === remembered.deviceId);
        if (byId) return [{ deviceId: byId.deviceId }];
        const byName = remembered.label ? usable.find(c => c.label === remembered.label) : undefined;
        if (byName) return [{ deviceId: byName.deviceId }];
        if (remembered.facing) {
            const main = mainCamera(usable, remembered.facing);
            if (main) return [{ deviceId: main.deviceId }];
        }
        // Gone: the default camera.
        return [];
    }
    const out: CameraRequest[] = [];
    if (remembered.deviceId) out.push({ deviceId: remembered.deviceId });
    if (remembered.facing) out.push({ facing: remembered.facing });
    return out;
}

/** Your own camera is mirrored unless it faces away from you. */
export function selfViewMirrored(facing: Facing): boolean {
    return facing !== 'environment';
}

/** Is this a refusal that means "that camera is not there / cannot be opened"
 *  (try another), as opposed to a permission refusal (stop and say so)? */
export function isCameraUnavailable(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return name === 'OverconstrainedError' || name === 'NotFoundError'
        || name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError';
}

// ---- the open camera, for the controls and the self-view ----------------------

export interface LocalCameraState {
    /** The open camera's id (its track's settings), or null with none open. */
    deviceId: string | null;
    /** The open camera's TRACK. A camera opened again is the same device but a
     *  new track: what shows it (the self-view) has to bind the new one, or
     *  it shows the stopped one, black. */
    trackId: string | null;
    facing: Facing;
    /** Every camera the browser lists, as of the last look. */
    cameras: CameraInfo[];
}

let state: LocalCameraState = { deviceId: null, trackId: null, facing: null, cameras: [] };
const listeners = new Set<() => void>();

export function localCameraState(): LocalCameraState {
    return state;
}

export function setLocalCameraState(next: Partial<LocalCameraState>): void {
    const merged = { ...state, ...next };
    if (merged.deviceId === state.deviceId && merged.trackId === state.trackId && merged.facing === state.facing
        && sameCameras(merged.cameras, state.cameras)) return;
    state = merged;
    listeners.forEach(fn => { try { fn(); } catch { /* a listener's own fault */ } });
}

export function onLocalCameraState(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

function sameCameras(a: CameraInfo[], b: CameraInfo[]): boolean {
    return a.length === b.length && a.every((c, i) => c.deviceId === b[i].deviceId && c.label === b[i].label && c.facing === b[i].facing);
}
