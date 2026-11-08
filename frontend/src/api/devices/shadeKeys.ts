/**
 * SHADE KEYS: up to three pinned keys (pinnedKeys.ts) as buttons on the
 * Android notification a live remote-control session already shows ("Device
 * session active", KeepAliveService), so a press there types on the computer
 * without opening Púca.
 *
 * WHO DECIDES WHAT. The page is the authority on what is wanted, exactly as
 * it is for the keep-alive reasons (mobileApp.ts): it pushes the complete
 * list of buttons — or none — whenever the session, the pause or the pins
 * change. The native side (ShadeKeys.java) only draws them, and only while
 * the CONTROL reason holds, so a session that ends takes its buttons with it
 * even if this module never gets to say so.
 *
 * A PRESS IS AN ID, NEVER A KEY. The notification's buttons carry the pin's
 * id; the page looks the id up in the pins it holds NOW and sends that pin's
 * frames. A button left over from an earlier list (unpinned, moved out of the
 * notification) therefore sends nothing, and the native side never holds a
 * key code it could replay.
 *
 * LOCKED PHONE. The native side refuses before anything reaches this module:
 * every button requires the device to be unlocked (Android 12+ asks for the
 * unlock itself), and the receiver refuses a press while the keyguard is up
 * on any version. See ShadeKeys.java.
 *
 * DEGRADES SILENTLY on an APK without the plugin (SovereignShadeKeys, APKs
 * after 0.9.859) and in Lite, whose APK never registers it:
 * `shadeKeysAvailable()` is false and the editor offers no notification
 * checkboxes (docs/USER_GUIDE.md says why they can be missing).
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { MAX_SHADE, pinLabel, pinTapFrames, type PinnedKey } from './pinnedKeys';

export interface ShadeKeyButton { id: string; label: string }

interface ShadeKeysPlugin {
    /** Replace the notification's key buttons (empty = none) and its status
     *  line (null = none). */
    set(opts: { keys: ShadeKeyButton[]; status: string | null }): Promise<void>;
    addListener(eventName: 'press', listener: (data: { id: string }) => void): Promise<PluginListenerHandle>;
}

const PLUGIN = 'SovereignShadeKeys';
const Native = registerPlugin<ShadeKeysPlugin>(PLUGIN);

/** Can this app put keys in the notification at all? */
export function shadeKeysAvailable(): boolean {
    return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable(PLUGIN);
}

/** What the stage knows about the session at the moment of a press. */
export interface ShadeSessionState {
    /** A controller session with a picture is live (not ended, not files-only). */
    live: boolean;
    /** The host accepts input from this viewer (not a view-only share). */
    canInput: boolean;
    /** The stage's "Pause control" is off. */
    controlEnabled: boolean;
}

/** The buttons the notification should show right now: the pins marked for
 *  it, in the user's order, and none at all unless input can really land. */
export function shadeButtons(pins: readonly PinnedKey[], s: ShadeSessionState): ShadeKeyButton[] {
    if (!s.live || !s.canInput || !s.controlEnabled) return [];
    return pins.filter(p => p.shade).slice(0, MAX_SHADE).map(p => ({ id: p.id, label: pinLabel(p) }));
}

export type ShadePress =
    | { send: true; frames: Array<Record<string, unknown>>; label: string }
    | { send: false; why: 'unknown' | 'not-live' | 'paused' };

/**
 * A press from the notification: send, or say why not. The SAME rules that
 * decide which buttons show, re-checked at the moment of the press, because
 * the notification can lag the page by a frame (a pause or an unpin a moment
 * before the press).
 */
export function decideShadePress(pins: readonly PinnedKey[], id: unknown, s: ShadeSessionState): ShadePress {
    const pin = typeof id === 'string' ? pins.find(p => p.id === id && p.shade) : undefined;
    if (!pin) return { send: false, why: 'unknown' };
    if (!s.live || !s.canInput) return { send: false, why: 'not-live' };
    if (!s.controlEnabled) return { send: false, why: 'paused' };
    return { send: true, frames: pinTapFrames(pin), label: pinLabel(pin) };
}

// --- push, latest-state-wins ------------------------------------------------

let pushed: string | null = null;
let wanted: { keys: ShadeKeyButton[]; status: string | null } = { keys: [], status: null };
/** Part of the dedupe key, never sent: a new press is pushed even when its
 *  words match the last push (see DeviceStage's shadeNote). */
let wantedSeq = 0;
let inFlight = false;

function flush(): void {
    if (inFlight) return;
    const key = JSON.stringify([wanted, wantedSeq]);
    if (key === pushed) return;
    inFlight = true;
    const sent = wanted;
    Native.set(sent)
        .then(() => { pushed = key; })
        // A refusal (an old APK reaching here despite the availability check,
        // a bridge torn down by an OTA reload) is not retried until the state
        // changes — the keep-alive module's lesson about unbounded retry loops.
        .catch(() => { pushed = key; })
        .finally(() => {
            inFlight = false;
            flush();
        });
}

/** Declare the notification's buttons and status line. Deduplicated, except
 *  that a new `pressSeq` (a press happened) is always pushed. */
export function setShadeKeys(keys: ShadeKeyButton[], status: string | null, pressSeq = 0): void {
    if (!shadeKeysAvailable()) return;
    wanted = { keys, status };
    wantedSeq = pressSeq;
    flush();
}

/** Push the current state again even if unchanged — after the app comes back
 *  to the foreground, where a notification the user swiped away (Android 14+
 *  lets them) is posted afresh. */
export function repushShadeKeys(): void {
    if (!shadeKeysAvailable()) return;
    pushed = null;
    flush();
}

/** Listen for presses. Returns the unsubscribe. */
export function onShadeKeyPress(cb: (id: string) => void): () => void {
    if (!shadeKeysAvailable()) return () => { /* nothing registered */ };
    let handle: PluginListenerHandle | null = null;
    let gone = false;
    void Native.addListener('press', d => cb(d.id))
        .then(h => { if (gone) void h.remove(); else handle = h; })
        .catch(() => { /* old APK: no presses will come */ });
    return () => {
        gone = true;
        if (handle) void handle.remove();
    };
}

/** For tests: forget what was pushed. */
export function __resetShadeKeysForTests(): void {
    pushed = null;
    wanted = { keys: [], status: null };
    wantedSeq = 0;
    inFlight = false;
}
