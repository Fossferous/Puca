/**
 * The host's way OUT of a device control session: the physical-input kill
 * switch, the kill-switch hotkey, and an inactivity revoke.
 *
 * WHY THIS EXISTS. The kill switch was built, made configurable, and armed for
 * exactly ONE of the two control paths. The legacy in-call path
 * (`api/remoteControl.ts`) calls `start_control_guard` on every grant and
 * consumes the two native events. The DEVICE-SESSION path — which is what My
 * Devices, device shares and unattended access all use — never did: a
 * repo-wide grep for `start_control_guard` found hits in one file. So the two
 * settings the user is shown in Settings → Remote control ("Kill-switch
 * hotkey… works even while a controlled game has focus" and "Stop when I touch
 * my mouse or keyboard") did nothing at all for a device session, and the only
 * remaining way out was the on-screen Stop button — which is the control you
 * cannot reach when somebody else is driving your pointer.
 *
 * A safety control that is advertised and not armed is worse than one that was
 * never offered, because the person relying on it has stopped looking for
 * another exit.
 *
 * WHAT IS ARMED, AND WHAT STAYS OPT-IN. The HOTKEY half is always on: it costs
 * nothing and it is the deliberate act of somebody who wants out. The ANY-INPUT
 * half is read from the user's own setting and is OFF by default, and it must
 * stay that way — a stray mouse nudge kicking a friend out mid-game is the
 * reason it is opt-in on the legacy path, and arming it for device sessions
 * regardless would break that for everyone on update.
 *
 * THE IDLE REVOKE is deliberately narrower than "every session". It bounds
 * "armed and forgotten" — an UNATTENDED session, where by definition nobody is
 * at the host to press Stop. An attended session had a human consent to it at
 * the keyboard, and ending that after half an hour would disconnect a friend
 * who is watching rather than typing. The caller decides, by passing an idle
 * budget only for the sessions that need one.
 *
 * WHY THE LISTENERS ARE REGISTERED HERE AND NOT PER SESSION. There is one
 * native hook and two events. Registering per session would have N handlers
 * fighting over the same event; this module registers once and dispatches to
 * whichever device sessions are live. `remoteControl.ts` also listens for the
 * same two events, and that is fine: each side acts only on its own state, and
 * a device session's revoke never touches a legacy one.
 */
import { isTauri } from '../platform';

/**
 * How long an UNATTENDED control session may sit with no controller input.
 *
 * A constant, not a setting: a stored value with no control that changes it is
 * a feature nobody can use, and the settings card this belongs in is not this
 * change's to edit. Thirty minutes is chosen to be well past any plausible
 * "thinking about it" pause and well short of "left open overnight".
 */
export const DEVICE_CONTROL_IDLE_MS = 30 * 60 * 1000;

/**
 * End a guarded session.
 *
 * `deliberate` separates "the host reached for the kill switch" — which needs
 * no explanation afterwards, they just did it — from "the idle timer fired",
 * which does: nobody acted, so the machine has to say why its session ended.
 */
type Revoke = (reason: string, deliberate: boolean) => void;

interface ArmedSession {
    revoke: Revoke;
    idleMs: number | null;
    idle: ReturnType<typeof setTimeout> | null;
}

const armed = new Map<string, ArmedSession>();
let listening = false;

/** Which sessions currently hold the guard. Exported for tests. */
export function armedControlGuardIds(): string[] {
    return [...armed.keys()];
}

/**
 * Ask the native hook to start (or re-read its configuration — the command
 * updates the live config rather than respawning anything).
 */
async function startNative(): Promise<void> {
    if (!isTauri()) return;
    try {
        const { loadSettings } = await import('../../components/settingsStore');
        const s = loadSettings();
        // The kill switch may be unbound; vk 0 tells the native guard there is
        // no key to watch, leaving the Stop button and the any-input kill.
        const kk = s.remoteControlKillKey;
        const killMods = kk ? ((kk.ctrl ? 1 : 0) | (kk.alt ? 2 : 0) | (kk.shift ? 4 : 0)) : 0;
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('start_control_guard', {
            anyInput: !!s.remoteControlAnyInputKill,
            killVk: kk ? (kk.keyCode | 0) : 0,
            killMods,
        });
    } catch (e) {
        console.warn('[control-guard] start_control_guard failed (Stop still works):', e);
    }
}

/**
 * Stop the native hook — but only once nothing needs it.
 *
 * `stop_control_guard` also releases every held key and button
 * (`remote_control::stop_guard` → `release_all_ordered`), so calling it while
 * the LEGACY in-call path is mid-session would both disarm that session's kill
 * switch and drop whatever it is holding down. The legacy module is consulted
 * dynamically: a lite build has neither module, and a build that has them must
 * not import one from the other at module scope.
 */
async function maybeStopNative(): Promise<void> {
    if (armed.size > 0 || !isTauri()) return;
    try {
        const { getControlState } = await import('../remoteControl');
        if (getControlState().controlledBy) return;
    } catch {
        // Not present (or not loaded) — then nothing else is holding it.
    }
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stop_control_guard');
    } catch {
        /* best effort: the session is ending either way */
    }
}

/** End every armed device session — the host asked to be out of all of them. */
function revokeAll(reason: string): void {
    for (const [id, a] of [...armed]) {
        // Removed BEFORE the callback, because the callback tears the session
        // down and that calls back into releaseControlGuard.
        armed.delete(id);
        if (a.idle) clearTimeout(a.idle);
        try {
            a.revoke(reason, true);
        } catch (e) {
            console.warn('[control-guard] revoking', id, 'failed:', e);
        }
    }
    void maybeStopNative();
}

async function installListeners(): Promise<void> {
    if (listening) return;
    listening = true;
    if (typeof window !== 'undefined') {
        // A kill-key or any-input change made DURING a session must take
        // effect at once; start_control_guard just updates the live config.
        window.addEventListener('settingsChanged', () => {
            if (armed.size > 0) void startNative();
        });
    }
    if (!isTauri()) return;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        await listen('host-input-detected', () => {
            revokeAll('You took over — remote control released.');
        });
        await listen('host-killswitch-hotkey', () => {
            revokeAll('Kill switch pressed — remote control released.');
        });
    } catch (e) {
        // Leave `listening` true: retrying on every session would re-add the
        // settings listener each time. Say so once; Stop still works.
        console.warn('[control-guard] the native kill-switch events are unavailable:', e);
    }
}

/**
 * Arm the guard for one host-side device session.
 *
 * `idleMs` is the inactivity budget, or null for "no idle revoke" — see the
 * module header for why an attended session gets none. Idempotent: arming a
 * session that is already armed refreshes its revoke callback and its idle
 * clock rather than stacking a second timer.
 */
export function armControlGuard(id: string, revoke: Revoke, idleMs: number | null): void {
    const existing = armed.get(id);
    if (existing) {
        existing.revoke = revoke;
        existing.idleMs = idleMs;
        noteControlActivity(id);
        return;
    }
    armed.set(id, { revoke, idleMs, idle: null });
    noteControlActivity(id);
    void installListeners();
    void startNative();
}

/** The controller did something. Restart this session's inactivity clock. */
export function noteControlActivity(id: string): void {
    const a = armed.get(id);
    if (!a) return;
    if (a.idle) {
        clearTimeout(a.idle);
        a.idle = null;
    }
    if (a.idleMs === null) return;
    a.idle = setTimeout(() => {
        armed.delete(id);
        try {
            a.revoke('Control ended after a long silence.', false);
        } catch (e) {
            console.warn('[control-guard] idle revoke of', id, 'failed:', e);
        }
        void maybeStopNative();
    }, a.idleMs);
}

/** This session is over. Drop its timer and release the hook if it was last. */
export function releaseControlGuard(id: string): void {
    const a = armed.get(id);
    if (!a) return;
    if (a.idle) clearTimeout(a.idle);
    armed.delete(id);
    void maybeStopNative();
}
