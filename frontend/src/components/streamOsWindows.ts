/**
 * Púca's OWN stream pop-out windows — the desktop app's popout engine.
 *
 * WHY. The OS picture-in-picture window Chromium gives a <video> stops at 80%
 * of the screen and keeps the video's aspect ratio (video_overlay_window_
 * views.cc), and a page gets ONE of them. Document PiP is also one window per
 * page. So on the desktop shell each popped stream gets an ordinary top-level
 * window instead: always on top by default (a per-window pin), resizable to
 * any size including maximized, as many as there are streams to pop.
 *
 * HOW (proved on WebView2 before this was built; see the commit message).
 * `window.open("about:blank#puca-pop-<slot>")` from the main page reaches the
 * shell's new-window handler (src-tauri/src/popout.rs), which answers with a
 * real Tauri window. WebView2 keeps the opener relationship for a window
 * supplied that way, so the returned `Window` is a same-origin about:blank
 * document THIS realm scripts directly: React portals a muted <video> into it
 * bound to the SAME MediaStream the app already decodes. Nothing is
 * re-negotiated or re-decoded; stream audio stays on StreamAudioHost.
 *
 * Closing from the app goes through the shell (`popout_close`), never
 * `window.close()`: wry answers a script close by destroying only the
 * webview's container, leaving the frame standing with its label taken.
 *
 * Web and the Android app never reach this: the probe is only asked inside the
 * desktop shell, and an older shell that lacks the command keeps the browser
 * engines (Doc PiP grid, element PiP).
 */
import { invoke } from '@tauri-apps/api/core';
import { isMobile, isTauri } from '../api/platform';

/** Must equal `MAX_POPOUTS` in src-tauri/src/popout.rs: the shell refuses
 *  any slot above it. */
export const MAX_POPOUT_WINDOWS = 8;

export function popoutWindowUrl(slot: number): string {
    return `about:blank#puca-pop-${slot}`;
}

export function popoutWindowName(slot: number): string {
    return `puca-pop-${slot}`;
}

/**
 * Which window slot each popped stream uses. A stream already out keeps its
 * slot (its window, and the size and place the shell remembers for it). A new
 * stream takes the lowest free slot — but not one freed in this SAME change:
 * the shell is still destroying that window, and a second window with the
 * same label is refused. Streams past MAX_POPOUT_WINDOWS get no slot.
 */
export function assignSlots(
    prev: ReadonlyMap<number, number>,
    wanted: readonly number[],
    max: number = MAX_POPOUT_WINDOWS,
): Map<number, number> {
    const next = new Map<number, number>();
    for (const id of wanted) {
        const s = prev.get(id);
        if (s !== undefined && !next.has(id)) next.set(id, s);
    }
    const freedNow = new Set<number>();
    for (const [id, s] of prev) if (!next.has(id)) freedNow.add(s);
    for (const id of wanted) {
        if (next.has(id)) continue;
        const taken = new Set(next.values());
        let slot: number | null = null;
        for (let s = 1; s <= max && slot === null; s++) if (!taken.has(s) && !freedNow.has(s)) slot = s;
        // Only when every other slot is taken: a just-freed one is better
        // than no window at all (the shell may refuse it; that is reported).
        for (let s = 1; s <= max && slot === null; s++) if (!taken.has(s)) slot = s;
        if (slot !== null) next.set(id, slot);
    }
    return next;
}

export function sameSlots(a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) if (b.get(k) !== v) return false;
    return true;
}

// --- Is this engine available? ------------------------------------------

let support: 'unknown' | 'yes' | 'no' = 'unknown';
let latchedOff = false;
let everOpened = false;

/** True once the desktop shell has said it opens pop-out windows, and no
 *  refusal has latched the engine off. False until the probe answers. */
export function osWindowsSupported(): boolean {
    return support === 'yes' && !latchedOff;
}

/** Ask the shell once (Chat runs it at boot, beside the Android PiP probe).
 *  Nothing is asked outside the desktop shell. */
export async function primeOsWindowSupport(): Promise<boolean> {
    if (!isTauri() || isMobile()) {
        support = 'no';
        return false;
    }
    try {
        support = (await invoke<boolean>('popout_supported')) === true ? 'yes' : 'no';
    } catch {
        // An older shell: no such command. Keep the browser engines.
        support = 'no';
    }
    return support === 'yes';
}

export function noteOsWindowOpened(): void {
    everOpened = true;
}

/**
 * A window.open the shell refused. Before any window has ever opened this
 * session it means the engine does not work here — latch it off so the
 * browser engines take over. After one has opened it is about THIS request
 * (a slot still closing, the cap): un-pop that stream and keep the engine.
 */
export function noteOsWindowRefused(): 'latched' | 'transient' {
    if (everOpened) return 'transient';
    latchedOff = true;
    return 'latched';
}

export function __resetOsWindowsForTests(): void {
    support = 'unknown';
    latchedOff = false;
    everOpened = false;
}

// --- Shell calls --------------------------------------------------------

export function openOsWindow(slot: number): Window | null {
    try {
        return window.open(popoutWindowUrl(slot), popoutWindowName(slot));
    } catch {
        return null;
    }
}

/** Close a pop-out from the app. `fallback` is the popup's Window, closed
 *  directly only if the shell call itself fails. */
export function closeOsWindow(slot: number, fallback: Window | null): void {
    invoke('popout_close', { slot }).catch(() => {
        try { fallback?.close(); } catch { /* already gone */ }
    });
}

/** Read (`pinned` omitted) or set a slot's always-on-top pin; resolves to the
 *  pin the shell now holds. */
export async function osWindowPin(slot: number, pinned?: boolean): Promise<boolean> {
    const args: Record<string, unknown> = { slot };
    if (typeof pinned === 'boolean') args.pinned = pinned;
    return (await invoke<boolean>('popout_pin', args)) !== false;
}
