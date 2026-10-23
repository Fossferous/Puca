/**
 * Fullscreen for the remote-control stage, and the keys that come with it.
 *
 * Two layers, because each does half the job:
 *  - The DESKTOP APP's window goes fullscreen over the taskbar (the shell's
 *    `stage_fullscreen` command). The Fullscreen API inside WebView2 only
 *    fills the window (elementFullscreen.ts), and driving another computer
 *    with the local taskbar in the way is not fullscreen.
 *  - The stage ELEMENT asks the Fullscreen API too, because the Keyboard
 *    Lock API only works in it: locked, the keys the local OS would otherwise
 *    keep — the Windows key, Alt+Tab, Esc — reach the page and so the remote
 *    machine, the way a remote-desktop client in fullscreen sends them. A
 *    browser gives this half alone; a long press of Esc still leaves.
 *
 * Every step is best effort and nothing here throws: a refused layer leaves
 * the other working.
 */
import { isTauri } from '../api/platform';
import {
    exitElementFullscreen, fullscreenElement, onFullscreenChange, requestElementFullscreen,
} from './elementFullscreen';

type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
const keyboard = (): KeyboardLock | undefined =>
    (typeof navigator !== 'undefined' ? (navigator as unknown as { keyboard?: KeyboardLock }).keyboard : undefined);

async function shellFullscreen(on: boolean): Promise<boolean> {
    if (!isTauri()) return false;
    try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('stage_fullscreen', { on });
        return true;
    } catch {
        // An app built before the command (or Lite, which has no stage).
        return false;
    }
}

/**
 * Enter. MUST be called from the user's click or key press (the Fullscreen
 * API requires the gesture). Resolves true when at least one layer took.
 */
export async function enterStageFullscreen(el: HTMLElement): Promise<boolean> {
    // The element first, while the gesture is fresh; the window after.
    const element = await requestElementFullscreen(el);
    const shell = await shellFullscreen(true);
    if (element) {
        try { await keyboard()?.lock?.(); } catch { /* the keys stay the OS's */ }
    }
    return element || shell;
}

/** Leave both layers. Never throws. */
export async function leaveStageFullscreen(): Promise<void> {
    try { keyboard()?.unlock?.(); } catch { /* nothing locked */ }
    await exitElementFullscreen();
    await shellFullscreen(false);
}

/** Is the element layer on? (The window layer has no event; the stage tracks it.) */
export function stageElementFullscreen(): boolean {
    return fullscreenElement() !== null;
}

export { onFullscreenChange };
