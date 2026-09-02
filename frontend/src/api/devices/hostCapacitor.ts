/**
 * The PHONE as a host — files only, never the screen.
 *
 * A Capacitor device has no getDisplayMedia, no input injection, and no
 * unattended arming; what it does have is a filesystem people constantly want
 * to reach from their desk. So this backend reports `capture: false` with a
 * reason and `files: true` when the phone can actually serve them, which
 * needs THREE things, each probed rather than assumed:
 *
 *  1. Android (iOS shipping is untested; fail closed there),
 *  2. the SovereignFiles micro-plugin — i.e. an APK new enough to carry it;
 *     older APKs run this very code via OTA and must degrade to an honest
 *     "update the app on this phone" rather than a dead feature, and
 *  3. API 30+, where the all-files-access model this uses exists at all.
 *
 * Whether all-files access is GRANTED is deliberately not part of `files`:
 * the consent prompt reports that precisely ("enable file sharing in
 * Settings"), which beats a generic early refusal the user cannot act on.
 *
 * The granted scope lives here, keyed by session, canonicalised AT GRANT
 * TIME (a root that is itself a moved link must not drift), and read per
 * request by the file server — so revocation is instant and teardown's
 * `setFileAccess(id, null)` works unchanged.
 */
import {
    SovereignFiles,
    pluginAvailable,
    shareableRoots,
    allFilesAccessStatus,
    requestAllFilesAccess,
} from '../androidStorage';
import { Capacitor } from '@capacitor/core';
import type { HostBackend, FileScopeRequest, MonitorInfo } from './hostBackend';
import type { GrantedRoot } from './hostFsServer';
import type { FsProvider } from './fsJail';

/**
 * WHY file sharing is unavailable, in the app's own words.
 *
 * The card used to collapse every cause into "update the app on this phone",
 * which is a guess: a missing plugin, a phone that never installed the new
 * APK, a call that threw, and an Android version below the floor are four
 * different problems with one message, and the only one the user can act on
 * is the one it happens to name. Diagnosing this from a desk is impossible —
 * the failing step is on the handset — so the handset reports it.
 */
export interface FilesDiagnostics {
    platform: string;
    /** The native half is registered and visible to JS (Capacitor PluginHeaders). */
    pluginVisible: boolean;
    /** Android API level, or null when the plugin could not be asked. */
    sdk: number | null;
    hasAllFilesAccess: boolean | null;
    /** Set when the plugin is visible but the call failed. */
    error: string | null;
}

export async function filesDiagnostics(): Promise<FilesDiagnostics> {
    const platform = Capacitor.getPlatform();
    const pluginVisible = pluginAvailable();
    if (!pluginVisible) {
        return { platform, pluginVisible, sdk: null, hasAllFilesAccess: null, error: null };
    }
    try {
        const st = await SovereignFiles.status();
        return {
            platform,
            pluginVisible,
            sdk: st.sdk,
            hasAllFilesAccess: st.hasAllFilesAccess,
            error: null,
        };
    } catch (e) {
        return {
            platform,
            pluginVisible,
            sdk: null,
            hasAllFilesAccess: null,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/** Fire the system "All files access" Settings screen for this app. There is
 *  no runtime dialog for MANAGE_EXTERNAL_STORAGE — it is a Settings toggle —
 *  so callers re-check status on visibilitychange when the user comes back. */

/** Per-session granted scope; the file server reads it per request. */
const grantedRoots = new Map<string, GrantedRoot>();

export function getGrantedRoot(sessionId: string): GrantedRoot | null {
    return grantedRoots.get(sessionId) ?? null;
}

/** The provider the file server runs against — @capacitor/filesystem for
 *  I/O (its native base64 IS the wire format, and readFile{offset,length}
 *  does random access without whole-file residency) + the micro-plugin's
 *  canonicalize as the jail's second gate. */
export function capacitorFsProvider(): FsProvider {
    return {
        async stat(path) {
            const { Filesystem } = await import('@capacitor/filesystem');
            try {
                const st = await Filesystem.stat({ path });
                return { exists: true, is_dir: st.type === 'directory', size: st.size };
            } catch {
                return { exists: false, is_dir: false, size: 0 };
            }
        },
        async readdir(path) {
            const { Filesystem } = await import('@capacitor/filesystem');
            const res = await Filesystem.readdir({ path });
            return res.files.map(f => ({
                name: f.name,
                is_dir: f.type === 'directory',
                size: f.size,
            }));
        },
        async read(path, offset, length) {
            const { Filesystem } = await import('@capacitor/filesystem');
            const res = await Filesystem.readFile({ path, offset, length } as never);
            // Native reads return base64 when no encoding is given.
            return typeof res.data === 'string' ? res.data : '';
        },
        async writeReplace(path, dataB64) {
            const { Filesystem } = await import('@capacitor/filesystem');
            await Filesystem.writeFile({ path, data: dataB64 });
        },
        async append(path, dataB64) {
            const { Filesystem } = await import('@capacitor/filesystem');
            await Filesystem.appendFile({ path, data: dataB64 });
        },
        async canonicalize(path) {
            return (await SovereignFiles.canonicalize({ path })).path;
        },
    };
}

export function capacitorHostBackend(): HostBackend {
    const filesPossible = Capacitor.getPlatform() === 'android' && pluginAvailable();

    return {
        kind: 'capacitor',

        async capabilities() {
            let files = filesPossible;
            let limitation = files
                ? 'This phone can share its files, but not its screen.'
                : Capacitor.getPlatform() === 'android'
                    ? 'Update the Púca app on this phone to share its files.'
                    : 'This device can control others, but cannot be controlled itself.';
            if (files) {
                const status = await allFilesAccessStatus();
                if (!status || status.sdk < 30) {
                    files = false;
                    limitation = 'Sharing files needs Android 11 or newer.';
                }
            }
            return {
                capture: false, unattended: false, input: false, elevated: false,
                clipboard: false, files, monitors: [] as MonitorInfo[], limitation,
            };
        },

        async startSession() {
            // Nothing to capture and nothing to start: session.ts builds the
            // pc, publishes no tracks, and answers data-only.
            return { kind: 'data-pc' };
        },

        async stopSession(sessionId: string) {
            // Belt to teardown's braces — the scope must not outlive the
            // session whatever order the teardown steps run in.
            grantedRoots.delete(sessionId);
        },

        async injectEvent() {
            throw new Error('this phone does not accept remote input');
        },

        async listMonitors() { return []; },
        async setMonitor() { throw new Error('this phone has no screen to switch'); },
        async updateStream() { throw new Error('this phone does not stream'); },

        async setFileAccess(sessionId: string, scope: FileScopeRequest | null) {
            if (scope === null) {
                grantedRoots.delete(sessionId);
                return;
            }
            if (scope.kind !== 'folder') {
                // A phone is never armed; the policy scope reaching here is
                // the impossible case, and impossible cases fail CLOSED.
                throw new Error('a phone only grants a chosen folder');
            }
            const canonRoot = (await SovereignFiles.canonicalize({ path: scope.root })).path;
            grantedRoots.set(sessionId, { root: scope.root, canonRoot });
        },
    };
}

// Re-exported for the remote-control file browser, which imported these
// from this module before they moved to api/androidStorage.ts (shared with
// the ordinary attachment sink).
export { shareableRoots, allFilesAccessStatus, requestAllFilesAccess };
