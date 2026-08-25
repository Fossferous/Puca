/**
 * The JS handle on SovereignLocationPlugin (Android): permissions, one-shot
 * position fixes for saving a place, and pushing the geofence set to the
 * native engine.
 *
 * PRIVACY CONTRACT — the reason this module exists at all: place coordinates
 * are DEVICE-LOCAL. They live in this device's localStorage (taskPlaces.ts)
 * and in the APK's own SharedPreferences; nothing here ever sends a
 * coordinate to the server, and the fences pushed natively carry no label and
 * no task text — only a task id and a circle. The backend even ships
 * `permissions-policy: geolocation=()` (src/main.rs), so the WEB build cannot
 * read location; only the Android plugin path can, and only for this.
 *
 * DEGRADES SILENTLY like mobileApp.ts: the native half only exists in APKs
 * that shipped it. On older APKs every call rejects once, the module latches
 * off, and the UI (which probes `mobileLocationAvailable()`) hides itself.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

/** One circle the native engine watches. Content-free by design: the id is a
 *  task id, never a label — SharedPreferences must not hold place names. */
export interface NativeFence {
    id: string;
    lat: number;
    lon: number;
    radiusM: number;
}

export interface LocationPermissionStatus {
    /** Foreground location granted (fine OR coarse). */
    foreground: boolean;
    /** ACCESS_FINE_LOCATION specifically — Android 12+ lets the user grant
     *  only "approximate" (~2 km), which can never trip a 150 m fence. */
    precise: boolean;
    /** "Allow all the time". On SDK < 29 this is the same grant as foreground. */
    background: boolean;
    /** Is the OS location toggle itself on? */
    locationOn: boolean;
}

interface SovereignLocationPlugin {
    status(): Promise<LocationPermissionStatus>;
    requestForegroundPermission(): Promise<{ granted: boolean; precise: boolean }>;
    requestBackgroundPermission(): Promise<{ granted: boolean }>;
    currentPosition(): Promise<{ lat: number; lon: number; accuracy: number }>;
    setFences(opts: { fences: NativeFence[] }): Promise<void>;
    openLocationSettings(): Promise<void>;
}

const Loc = registerPlugin<SovereignLocationPlugin>('SovereignLocation');

/** null = not yet determined; first-call-only latch, same discipline as
 *  mobileApp.ts — one transient bridge error mid-session must not convince
 *  the module the whole plugin is gone. */
let usable: boolean | null = null;

function android(): boolean {
    return Capacitor.getPlatform() === 'android';
}

export function mobileLocationAvailable(): boolean {
    return android() && usable !== false;
}

export async function locationStatus(): Promise<LocationPermissionStatus | null> {
    if (!android() || usable === false) return null;
    try {
        const s = await Loc.status();
        usable = true;
        return s;
    } catch {
        if (usable === null) usable = false;
        return null;
    }
}

export async function requestForegroundLocation(): Promise<boolean> {
    if (!android() || usable === false) return false;
    try {
        const r = await Loc.requestForegroundPermission();
        usable = true;
        return r.granted;
    } catch {
        if (usable === null) usable = false;
        return false;
    }
}

/**
 * Ask for "Allow all the time". Android 11+ shows no dialog for this — the
 * system bounces the user to the app's location settings page instead, so the
 * app backgrounds and returns. Must only be called AFTER foreground location
 * is granted: requesting both at once makes Android ignore the request.
 */
export async function requestBackgroundLocation(): Promise<boolean> {
    if (!android() || usable === false) return false;
    try {
        const r = await Loc.requestBackgroundPermission();
        usable = true;
        return r.granted;
    } catch {
        if (usable === null) usable = false;
        return false;
    }
}

/** One-shot fix for saving a place where the user is standing. null = no
 *  permission, location off, no fix inside the native timeout, or old APK. */
export async function currentPosition(): Promise<{ lat: number; lon: number; accuracy: number } | null> {
    if (!android() || usable === false) return null;
    try {
        const p = await Loc.currentPosition();
        usable = true;
        return p;
    } catch {
        if (usable === null) usable = false;
        return null;
    }
}

/** Replace the native fence set. An empty list clears it — that is the
 *  "feature turned off / signed out" path, so it must go through. */
export async function setNativeFences(fences: NativeFence[]): Promise<boolean> {
    if (!android() || usable === false) return false;
    try {
        await Loc.setFences({ fences });
        usable = true;
        return true;
    } catch {
        if (usable === null) usable = false;
        return false;
    }
}

/** Deep-link to the app's settings — the recovery once background location
 *  hits Android's silent denial lockout. */
export async function openLocationSettings(): Promise<boolean> {
    if (!android() || usable === false) return false;
    try {
        await Loc.openLocationSettings();
        usable = true;
        return true;
    } catch {
        if (usable === null) usable = false;
        return false;
    }
}
