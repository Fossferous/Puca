/** Pure helpers for UpdateGate's update decisions — the mobile-OTA safety
 *  checks and the desktop auto-install rule (kept out of the component file so
 *  fast-refresh stays happy and they're unit-testable). */

/**
 * localStorage key, per-version. Records that a launch already tried to
 * auto-install THIS version. If we come back up still not running it, the
 * attempt did not take — and retrying every launch would be an install/relaunch
 * loop the user cannot break out of, because it starts before they can click
 * anything. One automatic attempt per version; after that the banner waits for
 * a click. Survives the relaunch on purpose, which is why it is localStorage.
 * The string is load-bearing: it must match what earlier builds wrote so a
 * user mid-way through a failed attempt keeps their loop protection.
 */
export const AUTO_ATTEMPT_KEY = 'sovereign_update_auto_attempted';

/**
 * Should the pre-load gate install `candidateVersion` right now, without a
 * click? Pure — the caller reads/writes localStorage around it.
 *  - `optedIn`: the user's "Install updates automatically" setting (default
 *    OFF: automatic installation is opt-in, and it only ever happens here,
 *    before the app loads — never mid-session).
 *  - `attemptedVersion`: what AUTO_ATTEMPT_KEY currently holds (loop guard).
 *  - `isNewer`: the candidate is strictly newer than what is running
 *    (/app-version is an operator-pushed file; the minisign signature covers
 *    the installer bytes, not the advertised number, so never trust it blindly).
 */
export function shouldAutoInstallOnLaunch(
    optedIn: boolean,
    attemptedVersion: string | null,
    candidateVersion: string | null,
    isNewer: boolean,
): boolean {
    if (!optedIn) return false;
    if (!candidateVersion) return false;
    if (!isNewer) return false;
    return attemptedVersion !== candidateVersion;
}

/** Parse an "X.Y.Z" version into a comparable tuple; non-numeric parts (e.g.
 *  the plugin's "builtin" placeholder) sort as oldest. */
export function parseVersion(v: string): [number, number, number] {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v || '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

/** True iff `candidate` is strictly newer than `current` (semver order). Used
 *  for OTA anti-rollback: the bundle signature authenticates bytes, not the
 *  advertised version, so we refuse to apply a version <= the running one. */
export function isNewerVersion(candidate: string, current: string): boolean {
    const a = parseVersion(candidate), b = parseVersion(current);
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

/** Only follow a bundle URL that is HTTPS and on the same registrable site as
 *  our API endpoint — never an arbitrary or plaintext host. */
export function isTrustedBundleUrl(url: string, apiBase: string): boolean {
    try {
        const u = new URL(url);
        if (u.protocol !== 'https:') return false;
        const apiHost = apiBase ? new URL(apiBase).hostname : '';
        // FAIL CLOSED when the API base is unknown. This previously returned
        // true (scheme check only), so a build with VITE_API_URL unset would
        // trust ANY https host as an OTA bundle source — the exact same-site
        // check that keeps a malicious manifest from pointing the updater at an
        // attacker host. Real mobile builds always set VITE_API_URL; if it is
        // missing we would rather refuse the update than fetch a bundle from an
        // unverifiable origin.
        if (!apiHost) return false;
        const site = (h: string) => h.split('.').slice(-2).join('.');
        return site(u.hostname) === site(apiHost);
    } catch {
        return false;
    }
}
