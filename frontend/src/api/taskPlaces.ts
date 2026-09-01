/**
 * Location-based task reminders — the device-local place store.
 *
 * A "place" is a label + circle the USER saved on THIS phone ("Home",
 * "Tesco"); a task can be assigned one, and the native geofence engine
 * (KeepAliveService) fires a content-free notification when the phone
 * arrives. Due-time reminders (taskReminders.ts) are the timed sibling;
 * these are the spatial one. A task can carry both.
 *
 * WHY DEVICE-LOCAL, DELIBERATELY: due_at ships to the server as plaintext
 * because the server must serve /task-reminders — "the server learns WHEN,
 * never WHAT". That trade does NOT transfer to WHERE. Puca instances
 * are operated by someone who is frequently not the user, and a saved-places
 * table (home, work, clinic) is the most re-identifying dataset this app
 * could hold — while the server has NO functional need for it: the fence is
 * evaluated on-device by the OS. So coordinates live in localStorage here
 * and in the APK's SharedPreferences, never in a request body. The cost is
 * honest: places do not sync between devices, and a fresh install starts
 * empty. docs/SECURITY_MODEL.md §2's "what the operator can see"
 * list stays unchanged by this feature.
 *
 * The native side receives ONLY {taskId, lat, lon, radius} — no label, no
 * task text — so even SharedPreferences never holds a place name.
 */
import { loadSettings } from '../components/settingsStore';
import { setNativeFences, mobileLocationAvailable, type NativeFence } from './mobileLocation';
import { repushKeepAlive, setGeofenceKeepAlive } from './mobileApp';
import { decodeJwtPayload, getToken } from './auth';

export interface TaskPlace {
    id: string;
    label: string;
    lat: number;
    lon: number;
    radiusM: number;
}

const PLACES_KEY = 'sovereignTaskPlaces';
const ASSIGN_KEY = 'sovereignTaskPlaceAssign';

/**
 * Storage is namespaced PER ACCOUNT (key suffix `:<userId>`), unlike most
 * device-local stores here (settings, mutes). Those survive account switches
 * harmlessly; a place store must not: on a shared device, user B signing in
 * would otherwise get user A's fences pushed under B's session — B's phone
 * silently watching A's saved addresses and announcing arrivals at them.
 * Signed out there is no namespace, so reads are empty and writes drop.
 */
function currentUid(): string | null {
    const t = getToken();
    if (!t) return null;
    const sub = decodeJwtPayload(t)?.sub;
    return typeof sub === 'number' ? String(sub) : null;
}

/** Below ~100 m a fence is inside typical Wi-Fi/cell fix error and can
 *  never trigger reliably; above a few km it is a region, not a place. */
export const MIN_PLACE_RADIUS_M = 100;
export const MAX_PLACE_RADIUS_M = 5000;
export const DEFAULT_PLACE_RADIUS_M = 150;

/** Android caps OS geofences at ~100 per app; stay inside it with margin. */
export const MAX_FENCES = 100;

export function clampRadius(r: number): number {
    if (!Number.isFinite(r)) return DEFAULT_PLACE_RADIUS_M;
    return Math.min(MAX_PLACE_RADIUS_M, Math.max(MIN_PLACE_RADIUS_M, Math.round(r)));
}

/** Parse the stored places blob, degrading malformed input to []. Exported
 *  for tests (same discipline as parseTaskAttachments). */
export function parseStoredPlaces(raw: string | null): TaskPlace[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const out: TaskPlace[] = [];
        for (const p of parsed as unknown[]) {
            if (typeof p !== 'object' || p === null) continue;
            const o = p as Record<string, unknown>;
            if (typeof o.id !== 'string' || o.id === '' || typeof o.label !== 'string') continue;
            if (typeof o.lat !== 'number' || !Number.isFinite(o.lat) || Math.abs(o.lat) > 90) continue;
            if (typeof o.lon !== 'number' || !Number.isFinite(o.lon) || Math.abs(o.lon) > 180) continue;
            const radiusM = clampRadius(typeof o.radiusM === 'number' ? o.radiusM : NaN);
            // Canonical shape only — unknown extra fields are dropped.
            out.push({ id: o.id, label: o.label, lat: o.lat, lon: o.lon, radiusM });
        }
        return out;
    } catch {
        return [];
    }
}

/** Parse the stored taskId → placeId map, degrading malformed input to {}. */
export function parseStoredAssignments(raw: string | null): Record<string, string> {
    if (!raw) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
        return Object.fromEntries(
            Object.entries(parsed as Record<string, unknown>)
                .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''),
        );
    } catch {
        return {};
    }
}

/**
 * The pure join the native push is built from: assignments × places →
 * content-free fences. `enabled` collapses everything to [] — that is how
 * "setting off" and "signed out" clear the native store.
 */
export function planFences(
    assignments: Record<string, string>,
    places: TaskPlace[],
    enabled: boolean,
): NativeFence[] {
    if (!enabled) return [];
    const byId = new Map(places.map(p => [p.id, p]));
    const out: NativeFence[] = [];
    for (const [taskId, placeId] of Object.entries(assignments)) {
        const place = byId.get(placeId);
        if (!place) continue; // place deleted; assignment is inert until pruned
        if (out.length >= MAX_FENCES) break; // OS cap — oldest-key order, capped not errored
        out.push({ id: taskId, lat: place.lat, lon: place.lon, radiusM: clampRadius(place.radiusM) });
    }
    return out;
}

// --- external-store subscription -------------------------------------------
// TaskTree renders chips straight from this module, so every mutation bumps a
// version consumed via useSyncExternalStore — no component-owned mirror state
// to drift (and no set-state-in-effect to suppress).

let version = 0;
const listeners = new Set<() => void>();

function bump(): void {
    version++;
    for (const l of listeners) l();
}

export function subscribePlaces(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
}

export function placesVersion(): number {
    return version;
}

// --- storage --------------------------------------------------------------
// Parsed-blob cache: TaskTree calls getTaskPlace once per rendered row, and
// re-parsing localStorage JSON per row per render is silly. Every write goes
// through save*/clear below, which keep the cache coherent (this app has one
// webview — no cross-tab writers on the platform the feature exists on).

let placesCache: TaskPlace[] | null = null;
let assignCache: Record<string, string> | null = null;
/** Which account the caches were read for; an account switch drops them. */
let cacheUid: string | null = null;

function ensureCacheAccount(): string | null {
    const uid = currentUid();
    if (uid !== cacheUid) {
        placesCache = null;
        assignCache = null;
        cacheUid = uid;
    }
    return uid;
}

function loadPlaces(): TaskPlace[] {
    const uid = ensureCacheAccount();
    if (placesCache === null) {
        try {
            placesCache = uid === null ? []
                : parseStoredPlaces(localStorage.getItem(`${PLACES_KEY}:${uid}`));
        } catch {
            placesCache = [];
        }
    }
    return placesCache;
}

function loadAssignments(): Record<string, string> {
    const uid = ensureCacheAccount();
    if (assignCache === null) {
        try {
            assignCache = uid === null ? {}
                : parseStoredAssignments(localStorage.getItem(`${ASSIGN_KEY}:${uid}`));
        } catch {
            assignCache = {};
        }
    }
    return assignCache;
}

function savePlaces(places: TaskPlace[]): void {
    const uid = ensureCacheAccount();
    if (uid === null) return; // signed out — nothing to attribute this to
    placesCache = places;
    try {
        localStorage.setItem(`${PLACES_KEY}:${uid}`, JSON.stringify(places));
    } catch { /* storage full/blocked — the in-session state still works */ }
    bump();
}

function saveAssignments(map: Record<string, string>): void {
    const uid = ensureCacheAccount();
    if (uid === null) return;
    assignCache = map;
    try {
        localStorage.setItem(`${ASSIGN_KEY}:${uid}`, JSON.stringify(map));
    } catch { /* as above */ }
    bump();
}

// --- public API (each mutation re-syncs the native engine) -----------------

export function listPlaces(): TaskPlace[] {
    return loadPlaces();
}

export function getTaskPlace(taskId: number): TaskPlace | null {
    const placeId = loadAssignments()[String(taskId)];
    if (!placeId) return null;
    return loadPlaces().find(p => p.id === placeId) ?? null;
}

export function createPlace(label: string, lat: number, lon: number, radiusM: number): TaskPlace {
    const place: TaskPlace = {
        id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `p${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
        label: label.trim() || 'Saved place',
        lat, lon,
        radiusM: clampRadius(radiusM),
    };
    savePlaces([...loadPlaces(), place]);
    return place;
}

export function assignTaskPlace(taskId: number, placeId: string | null): void {
    const map = loadAssignments();
    if (placeId === null) delete map[String(taskId)];
    else map[String(taskId)] = placeId;
    saveAssignments(map);
    void syncTaskPlacesToNative();
}

/** Drop assignments for tasks observed completed (or deleted with their
 *  subtree). Returns whether anything changed so callers can re-render. */
export function unassignTasks(taskIds: Iterable<number>): boolean {
    const map = loadAssignments();
    let changed = false;
    for (const id of taskIds) {
        if (String(id) in map) {
            delete map[String(id)];
            changed = true;
        }
    }
    if (changed) {
        saveAssignments(map);
        void syncTaskPlacesToNative();
    }
    return changed;
}

/** Wipe every place and assignment on this device, and clear the native
 *  engine. The Settings "delete all" button — the one-tap answer to "what
 *  does this phone know about where I go". */
export function clearAllPlaces(): void {
    const uid = ensureCacheAccount();
    placesCache = [];
    assignCache = {};
    try {
        if (uid !== null) {
            localStorage.removeItem(`${PLACES_KEY}:${uid}`);
            localStorage.removeItem(`${ASSIGN_KEY}:${uid}`);
        }
    } catch { /* nothing better available */ }
    bump();
    void syncTaskPlacesToNative();
}

// --- native sync ------------------------------------------------------------

/** Auth gate, declared by App.tsx alongside the notify keep-alive: a signed-
 *  out app must not keep a location watch running behind a notification the
 *  user can no longer explain. */
let authed = false;

export function setPlacesAuthed(loggedIn: boolean): void {
    if (authed === loggedIn) return;
    authed = loggedIn;
    void syncTaskPlacesToNative();
}

/** Last state the native side accepted — skip no-op pushes (settingsChanged
 *  fires on EVERY settings save). */
let lastPushedKey: string | null = null;

/**
 * Reconcile the native fence store + keep-alive reason with current state.
 * Safe to call often; deduped. Failures leave lastPushedKey unset so the
 * next call retries.
 *
 * `force` re-sends even an unchanged state AND re-pushes the keep-alive
 * verbatim. Needed after a permission grant: the fences and reasons haven't
 * changed, but what the service may DO with them has — without a fresh
 * onStartCommand it keeps running under the pre-grant FGS type (no location)
 * and never re-evaluates the watch, so reminders stay dead until some other
 * state change happens to poke it.
 */
export async function syncTaskPlacesToNative(opts?: { force?: boolean }): Promise<void> {
    if (!mobileLocationAvailable()) return;
    const s = loadSettings();
    const enabled = authed && s.locationReminders && s.mobileNotifications;
    const fences = planFences(loadAssignments(), loadPlaces(), enabled);
    const key = JSON.stringify(fences);
    if (!opts?.force && key === lastPushedKey) return;
    const ok = await setNativeFences(fences);
    if (ok) {
        lastPushedKey = key;
        // The keep-alive reason follows the fence set: the service must run
        // (and may add the FGS location type) only while there is something
        // to watch.
        setGeofenceKeepAlive(fences.length > 0);
        if (opts?.force && fences.length > 0) repushKeepAlive();
    }
}
