/**
 * Android all-files storage access — the SovereignFiles micro-plugin.
 *
 * WHY THIS IS NOT IN api/devices/. This is shared infrastructure, not a
 * remote-control concern. `api/capacitorSink.ts` uses it to write an ORDINARY
 * DM/P2P attachment straight to disk on Android, which is what removes the
 * 100 MB in-memory cap for normal chat downloads. Reaching it through
 * `devices/hostCapacitor` put a preserved download path inside the
 * remote-control module tree: a build that excludes remote control would have
 * silently regressed every large attachment back to the capped sink, with no
 * error and no test covering it.
 *
 * The remote-control file browser ALSO uses these (it needs the same roots and
 * the same permission), and `devices/hostCapacitor.ts` re-exports them for
 * that purpose. The plugin itself is registered here, once.
 *
 * Everything degrades to "unavailable" rather than throwing: an APK older than
 * the plugin, a non-Android platform, or a refused permission are all normal
 * states the callers must handle, not exceptions.
 */
import { registerPlugin, Capacitor } from '@capacitor/core';

/** The ~80-line native micro-plugin (SovereignFilesPlugin.java). */
export interface SovereignFilesPlugin {
    status(): Promise<{ hasAllFilesAccess: boolean; sdk: number }>;
    requestAccess(): Promise<void>;
    roots(): Promise<{ roots: { label: string; path: string }[] }>;
    canonicalize(options: { path: string }): Promise<{ path: string }>;
}

export const SovereignFiles = registerPlugin<SovereignFilesPlugin>('SovereignFiles');

/** Whether this APK actually carries the native plugin (OTA JS can be newer
 *  than the installed shell, so this is not implied by the platform). */
export function pluginAvailable(): boolean {
    return Capacitor.isPluginAvailable('SovereignFiles');
}

/** Folders the consent prompt offers. Fixed list, never free-typed: a list
 *  cannot be talked into an app-private path, and nobody wants to type
 *  /storage/emulated/0/… on a phone keyboard. */
export async function shareableRoots(): Promise<{ label: string; path: string }[]> {
    if (!pluginAvailable()) return [];
    try {
        return (await SovereignFiles.roots()).roots;
    } catch {
        return [];
    }
}

export async function allFilesAccessStatus(): Promise<{ hasAllFilesAccess: boolean; sdk: number } | null> {
    if (!pluginAvailable()) return null;
    try {
        return await SovereignFiles.status();
    } catch {
        return null;
    }
}

/**
 * Send the user to Android's MANAGE_EXTERNAL_STORAGE settings screen.
 *
 * Needed by the ordinary-attachment sink as well as the device file browser:
 * without the grant, `allFilesAccessStatus()` reports hasAllFilesAccess false
 * and large downloads fall back to the capped in-memory sink.
 */
export async function requestAllFilesAccess(): Promise<void> {
    if (!pluginAvailable()) return;
    await SovereignFiles.requestAccess();
}
