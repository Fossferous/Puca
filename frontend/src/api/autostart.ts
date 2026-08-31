/**
 * Start-with-the-OS.
 *
 * This is what makes a device reachable without someone launching the app
 * first, so it is a precondition for hosting rather than a convenience — and it
 * is why the tray has to make a resident app obvious. An app that starts hidden
 * on every boot and can be remote-controlled is, from the outside,
 * indistinguishable from something unwanted; the difference has to be visible.
 */
import { isTauri } from './platform';

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
}

/** Whether autostart can be configured here at all (desktop only). */
export function autostartSupported(): boolean {
    return isTauri();
}

export async function isAutostartEnabled(): Promise<boolean> {
    if (!isTauri()) return false;
    try {
        return await invokeTauri<boolean>('autostart_enabled');
    } catch {
        return false;
    }
}

/**
 * Turn it on or off. Returns an error message, or null on success.
 *
 * The error is surfaced rather than swallowed: on Windows this writes to the
 * registry and security software does block it, and a toggle that silently
 * snaps back is indistinguishable from a broken app.
 */
export async function setAutostart(enabled: boolean): Promise<string | null> {
    if (!isTauri()) return 'Starting with the system is only available in the desktop app.';
    try {
        await invokeTauri<void>('set_autostart', { enabled });
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : 'Could not change the startup setting.';
    }
}
