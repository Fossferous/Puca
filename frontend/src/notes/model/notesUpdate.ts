/**
 * Púca Notes' Android app and its updates — the decisions, kept pure so they
 * are testable without a phone. NotesUpdateGate (components/) is the view.
 *
 * The web bundle updates over the air (api/mobileOta.ts, channel 'notes').
 * The APK itself cannot: a new native plugin, permission or manifest entry
 * needs a new install from the download page. The notes manifest says which
 * APKs a bundle needs in an optional, UNSIGNED `native` block:
 *
 *   "native": { "min": "0.9.816", "version": "0.9.816", "download_url": "https://…" }
 *
 *  - `min`: the oldest APK this bundle can run on. An older APK must NOT
 *    apply the bundle (it would call a plugin that is not there), and says
 *    so: "install the new app from the download page".
 *  - `version`: the newest APK on the download page. Only a nudge.
 *
 * Unsigned is acceptable: a hostile manifest host can raise `min` to withhold
 * updates or nag — which it could do anyway by withholding the manifest — but
 * it cannot deliver an APK. Android refuses an APK for com.sovereign.notes
 * signed with any other key, and `download_url` is only followed when it is
 * HTTPS on the same site as the server that answered.
 */
import { isNewerVersion, isTrustedBundleUrl } from '../../components/updateGate.utils';
import type { OtaManifest, OtaOutcome } from '../../api/mobileOta';

export type NativePrompt =
    | { kind: 'required'; need: string; have: string | null; downloadUrl: string | null }
    | { kind: 'available'; version: string; have: string; downloadUrl: string | null };

/**
 * What, if anything, to tell the user about the APK, given a manifest that
 * already passed the 'notes' channel check.
 *
 * `have` is the installed APK's versionName as the updater plugin reports it.
 * When it is unknown and the bundle names a minimum, the answer is
 * "required": a capability that cannot be proved is not assumed.
 */
export function nativePromptFor(
    native: OtaManifest['native'],
    have: string | null,
    answeringBase: string,
): NativePrompt | null {
    if (!native || typeof native !== 'object') return null;
    const url = typeof native.download_url === 'string' && isTrustedBundleUrl(native.download_url, answeringBase)
        ? native.download_url
        : null;
    const min = typeof native.min === 'string' ? native.min : '';
    if (min && (have === null || isNewerVersion(min, have))) {
        return { kind: 'required', need: min, have, downloadUrl: url };
    }
    const latest = typeof native.version === 'string' ? native.version : '';
    if (latest && have !== null && isNewerVersion(latest, have)) {
        return { kind: 'available', version: latest, have, downloadUrl: url };
    }
    return null;
}

/** Remembers that the "a new app is available" strip was dismissed for ONE
 *  version, so it does not return every launch; a newer APK nags once more. */
const DISMISS_KEY = 'pucaNotesNativeNudgeDismissed';

/** The version whose nudge was dismissed, or null. */
export function readNudgeDismissal(): string | null {
    try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

export function dismissNudgeFor(version: string): void {
    try { localStorage.setItem(DISMISS_KEY, version); } catch { /* private window: it simply returns next launch */ }
}

export function clearNudgeDismissal(): void {
    try { localStorage.removeItem(DISMISS_KEY); } catch { /* nothing to clear */ }
}

/** What "Check for updates" reports when no new bundle applies. */
export function describeOutcome(outcome: OtaOutcome | 'unavailable'): string {
    switch (outcome) {
        case 'nothing': return 'Púca Notes is up to date.';
        case 'unreachable': return 'Could not reach the server to check.';
        case 'deadline': return 'The server took too long to answer. Try again later.';
        case 'refused': return 'The server offered an update this app will not install.';
        case 'held': return 'The latest update needs a new app install.';
        case 'failed': return 'The update could not be installed.';
        case 'applying': return 'Restarting with the update…';
        case 'unavailable': return 'Updates are not available in this app.';
    }
}

// --- the menu's line to the gate ------------------------------------------
//
// The account menu and the gate are far apart in the tree (the gate wraps
// the whole app), so the gate registers its runner here while it is mounted.

type Runner = () => Promise<OtaOutcome>;
let runner: Runner | null = null;

export function registerNotesUpdateRunner(r: Runner | null): void {
    runner = r;
}

/** Run the update check again, now. 'unavailable' when no gate is mounted
 *  (the browser page, or a test). */
export function checkNotesForUpdates(): Promise<OtaOutcome | 'unavailable'> {
    return runner ? runner() : Promise.resolve('unavailable');
}

// --- the APK prompt, shared by the gate (which sets it) and the menu -------

let currentPrompt: NativePrompt | null = null;
const promptListeners = new Set<() => void>();

export function setNativePrompt(p: NativePrompt | null): void {
    currentPrompt = p;
    promptListeners.forEach(l => l());
}

export function getNativePrompt(): NativePrompt | null {
    return currentPrompt;
}

export function subscribeNativePrompt(listener: () => void): () => void {
    promptListeners.add(listener);
    return () => { promptListeners.delete(listener); };
}

/**
 * Open the download page. A top-level navigation to another host: the
 * Capacitor bridge hands it to the system browser (ACTION_VIEW) and the app
 * stays where it is — as long as notes-app/capacitor.config.ts lists no
 * `allowNavigation` (scripts/check-lite-identity.mjs asserts it does not).
 * An object so tests can replace it; jsdom's location cannot be stubbed.
 */
export const downloadPage = {
    open(url: string): void {
        window.location.assign(url);
    },
};
