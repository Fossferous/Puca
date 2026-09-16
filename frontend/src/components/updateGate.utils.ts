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
        const norm = (h: string) => h.toLowerCase().replace(/\.$/, '');
        const host = norm(u.hostname);
        const api = norm(apiHost);
        if (host === api) return true;
        // The API host's PARENT, not "the last two labels": chat.example.com
        // trusts *.example.com, chat.puca.co.uk trusts *.puca.co.uk. The old
        // rule made co.uk (and com.au, and every such suffix) the shared
        // "site", so every host under it passed. An API host at an apex has no
        // parent worth trusting, so it is exact-host only. Not a public-suffix
        // list: chat.github.io still trusts *.github.io, which only an operator
        // who runs their API there can change (an explicit bundle host would
        // be the complete fix). Found by the 2026-09-16 adversarial campaign.
        const parent = api.split('.').slice(1).join('.');
        if (!parent.includes('.')) return false;
        return host === parent || host.endsWith('.' + parent);
    } catch {
        return false;
    }
}

/**
 * May a build with `rcEnabled` apply a bundle advertising `manifestVariant`?
 *
 * The OTA pushes a JS BUNDLE into an already-installed APK, so this is what
 * stops a lite install — one whose whole promise is that it contains no
 * remote-control code — from being handed the full frontend over the air. No
 * artifact check can catch that: it happens after shipping.
 *
 * FAILS CLOSED, and the asymmetry matters. An ABSENT variant means "full",
 * because every manifest published before the lite build existed omits the
 * field and every one of those is a full bundle. Reading absent as "matches
 * anything" would defeat the entire control on exactly the servers that have
 * not been updated yet — which is the case it exists for, since a server that
 * ignores `?variant=lite` answers with the ordinary manifest.
 */
export function bundleVariantMatches(
    manifestVariant: string | undefined | null,
    rcEnabled: boolean,
): boolean {
    return (manifestVariant ?? 'full') === (rcEnabled ? 'full' : 'lite');
}

/** Parsed-tuple equality — never string equality, so 'v0.9.811', a trailing
 *  space or a 4-part label compare by what they mean. Unparseable is unequal. */
export function sameVersion(a: string, b: string): boolean {
    const x = parseVersion(a), y = parseVersion(b);
    return x[0] >= 0 && y[0] >= 0 && x.every((v, i) => v === y[i]);
}

/**
 * Should a manifest advertising `manifestVersion` be applied when the RUNNING
 * BYTES were built as `bytesVersion`?
 *
 * The comparison is against the version compiled into the running bundle
 * (`__APP_VERSION__`), never against the label the manifest gave it
 * (`bundle.version` from the plugin). That label is UNSIGNED: the OTA
 * signature covers bundle bytes only, so a manifest can attach any number to
 * any legitimately signed bundle — and once a client had recorded that number
 * as "what I am running", every genuine later release read as "<= current"
 * until an APK reinstall. A hand-typed version in dual-ship.sh does the same
 * by accident (0.9.810 audit, C-04).
 *
 * What this does and does not buy: a bundle carrying THIS code compares
 * against its own true version, so a mislabelled bundle cannot lock it out of
 * future releases. It cannot stop the first replay — the running code cannot
 * learn a bundle's true version before running it — and a replayed bundle
 * from BEFORE this change runs its own, older gate. Refusing to publish a
 * mislabelled manifest in the first place is dual-ship.sh's job (the
 * `<bundle>.version` sidecar check).
 *
 * A device running the APK's BUILTIN bundle accepts a manifest at the SAME
 * version, not only a newer one: a fresh install has always pulled the
 * same-numbered published bundle, which also self-corrects an APK whose
 * embedded assets drifted from the published web build. Anything OLDER than
 * the builtin bytes is refused — the previous `'builtin'` placeholder parsed
 * as the oldest possible version, so a fresh install had no anti-rollback.
 */
export function shouldApplyOtaVersion(
    manifestVersion: string,
    bytesVersion: string,
    runningBuiltin: boolean,
): boolean {
    if (isNewerVersion(manifestVersion, bytesVersion)) return true;
    return runningBuiltin && sameVersion(manifestVersion, bytesVersion);
}

/** True when the plugin's recorded label for the running OTA bundle names a
 *  different version than the bytes were built as — a mislabelled manifest,
 *  replayed or mistyped. An unparseable label on either side is "unknown",
 *  never a lie, and the builtin placeholder is not a label at all. */
export function bundleLabelDisagrees(label: string | null | undefined, bytesVersion: string): boolean {
    if (!label || label === 'builtin') return false;
    if (parseVersion(label)[0] < 0 || parseVersion(bytesVersion)[0] < 0) return false;
    return !sameVersion(label, bytesVersion);
}
