/**
 * Desktop update prompt + in-place update (banner click, no reinstall step).
 *
 * Detection: the backend serves `GET /app-version` from a JSON file the
 * operator pushes alongside each release (no server rebuild needed). The app
 * compares that against its own version and shows the UpdateBanner when newer.
 *
 * Install: clicking the banner runs the Tauri updater plugin — it fetches
 * hygiene-lint:allow-placeholder-domain — illustrative prose; the real endpoint
 * is baked in from the untracked src-tauri/tauri.release.json at build time.
 * https://download.example.com/latest.json, verifies the installer's minisign
 * signature against the pubkey baked into the app, downloads it with progress,
 * runs it (passive mode), and the app relaunches updated. If any of that fails
 * (e.g. latest.json missing), the banner falls back to opening the download
 * page in the system browser like the pre-0.5.46 builds.
 *
 * Automatic (no-click) installation exists too, but ONLY behind the opt-in
 * `autoInstallUpdates` setting and ONLY in UpdateGate, before the app loads —
 * see components/UpdateGate.tsx. Nothing here installs on its own.
 */
import { API_BASE_URL } from './config';
import { isMobile, isTauri, RC_ENABLED } from './platform';
import { updateCheckBases } from './updateCheckBases';

/** Per-base bound on the /app-version fetch. The fallback-base loop below only
 *  advances on a THROW, so a HUNG primary (captive portal, stalled TLS) would
 *  otherwise mask the hardcoded production fallback forever — the same shape
 *  as the mobile 0.8.24/25 stranding UpdateGate documents. */
const CHECK_FETCH_TIMEOUT_MS = 8_000;

export interface AppVersionInfo {
    version: string;
    /** Where "Download" opens in the system browser. Point this at a landing
     *  hygiene-lint:allow-placeholder-domain — illustrative prose; the value
     *  comes from the operator's /app-version file, never from this repo.
     *  PAGE (e.g. https://download.example.com/), NOT a direct .exe URL — a raw
     *  installer link often just opens a blank browser tab and never downloads. */
    download_url: string;
    notes?: string;
}

/** True when `latest` is a strictly newer semver-ish version than `current`. */
export function isNewerVersion(latest: string, current: string): boolean {
    const parse = (v: string) => v.trim().replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const [l, c] = [parse(latest), parse(current)];
    for (let i = 0; i < Math.max(l.length, c.length); i++) {
        const a = l[i] ?? 0;
        const b = c[i] ?? 0;
        if (a !== b) return a > b;
    }
    return false;
}

/**
 * Returns update info when a newer version is published, else null.
 * Desktop-only; browsers always get the latest frontend from the server.
 */
export async function checkForNewVersion(): Promise<AppVersionInfo | null> {
    if (!isTauri()) return null;
    // Try the configured base, then the hardcoded production fallback: a
    // client built without .env.production points at localhost and would
    // otherwise never learn a fixed release exists (the 0.8.24/25 stranding).
    // Safe here because the installer itself is signature-verified.
    for (const base of updateCheckBases(API_BASE_URL)) {
        // AbortController rather than AbortSignal.timeout: the latter is missing
        // from some WebViews and from the test runtime.
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), CHECK_FETCH_TIMEOUT_MS);
        try {
            // no-store: never let a cached body hide a release published seconds ago.
            const res = await fetch(`${base}/app-version`, { cache: 'no-store', signal: ctrl.signal });
            // 404 (nothing published) and 204 are real answers from a server
            // that serves this route, and they are final. Any OTHER non-2xx
            // means whatever answered is not serving /app-version — a proxy's
            // 502, an origin lock's 403, or, in the mis-build this loop exists
            // for, whatever happens to be listening on localhost:3000 — and
            // must not end the search: advance to the next base as a throw
            // would.
            if (res.status === 404 || res.status === 204) return null;
            if (!res.ok) {
                console.warn(`[AppVersion] ${base}/app-version answered ${res.status} — trying the next base`);
                continue;
            }
            const info: AppVersionInfo = await res.json();
            if (!info?.version || !info?.download_url?.startsWith('https://')) return null;

            const { getVersion } = await import('@tauri-apps/api/app');
            const current = await getVersion();
            return isNewerVersion(info.version, current) ? info : null;
        } catch (err) {
            // warn, not debug: devtools hides debug at its default level, which
            // made silent check failures indistinguishable from "up to date".
            console.warn(`[AppVersion] Check via ${base} failed (offline?):`, err);
            // fall through to the next base
        } finally {
            clearTimeout(timer);
        }
    }
    return null;
}

/**
 * What version is THIS client actually running?
 *
 * Three platforms, three different answers, and asking the wrong one is why
 * mobile showed "Unknown" from the day it shipped: SettingsModal called
 * `getVersion()` from `@tauri-apps/api/app` unconditionally. There is no Tauri
 * on Capacitor, so the import rejected and the catch wrote "Unknown" — on every
 * phone, forever.
 *
 *  - DESKTOP: Tauri's own version, i.e. the installed app.
 *  - MOBILE: the OTA BUNDLE version, because that is the code actually
 *    executing and the only number that tells you whether an update landed. The
 *    plugin reports "builtin" while running the bundle baked into the APK, in
 *    which case the native version is the honest answer.
 *  - WEB: the build-time constant, since the server always serves the latest.
 */
export async function currentAppVersion(): Promise<string> {
    if (isTauri()) {
        try {
            const { getVersion } = await import('@tauri-apps/api/app');
            return await getVersion();
        } catch {
            return __APP_VERSION__;
        }
    }

    if (isMobile()) {
        try {
            const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
            const cur = await CapacitorUpdater.current();
            const bundle = cur?.bundle?.version;
            if (bundle && bundle !== 'builtin') return bundle;
            // Running the APK's built-in bundle: report the native version, and
            // say so, because "the OTA has not applied" is the useful fact here.
            const native = (cur as { native?: string } | undefined)?.native;
            return native ? `${native} (built-in)` : `${__APP_VERSION__} (built-in)`;
        } catch (err) {
            // The plugin is missing or failed to load — which ALSO means OTA
            // updates cannot apply, so this is worth saying out loud rather than
            // rendering a shrug.
            console.warn('[AppVersion] Capacitor updater unavailable:', err);
            return `${__APP_VERSION__} (updates unavailable)`;
        }
    }

    return __APP_VERSION__;
}

/**
 * Open the release download page in the system browser.
 *
 * VARIANT-AWARE. The `download_url` comes from the server's `/app-version`,
 * which serves one file to every client and knows nothing about lite vs full.
 * Sending a lite user there unqualified lands them on the FULL installer — the
 * one that reintroduces remote control on the exact machine whose owner chose
 * the build without it. So a lite build appends `?variant=lite` (preserving any
 * existing query), which a lite-aware download site can honour to serve the
 * lite installer. If the site ignores it the user is no worse off than before
 * this existed; if it honours it, the fallback stays on the lite channel.
 */
export async function openDownloadPage(url: string): Promise<void> {
    let target = url;
    if (!RC_ENABLED) {
        try {
            const u = new URL(url);
            u.searchParams.set('variant', 'lite');
            target = u.toString();
        } catch {
            // Not a parseable absolute URL — leave it untouched rather than
            // mangle it. openDownloadPage's callers already validated it starts
            // with https://, so this is defensive only.
            target = url;
        }
    }
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('open_external', { url: target });
}

export type UpdateProgress =
    | { phase: 'checking' }
    | { phase: 'downloading'; percent: number | null }
    | { phase: 'installing' }
    | { phase: 'restarting' };

/** Thrown by installUpdateInPlace when the caller's `proceedToInstall` gate
 *  said no after the download finished: the bytes are on disk, nothing ran,
 *  this process is NOT being replaced. */
export class UpdateAbandonedError extends Error {
    constructor() { super('Update abandoned before install'); this.name = 'UpdateAbandonedError'; }
}

/**
 * In-place update: verify + download the signed installer named in
 * latest.json, run it, and relaunch. Throws when no signed update is
 * available or anything fails — the caller falls back to openDownloadPage.
 *
 * `proceedToInstall` is consulted ONCE, between the download finishing and
 * the installer running — the last moment this process can still decide not
 * to be replaced. The Tauri download itself is not cancellable, so a caller
 * that has given up on a stalled download (UpdateGate) uses this gate to make
 * sure a download that limps home later cannot run the installer under a
 * live session. Returning false throws UpdateAbandonedError.
 */
export async function installUpdateInPlace(
    onProgress: (p: UpdateProgress) => void,
    opts: { proceedToInstall?: () => boolean } = {},
): Promise<void> {
    const { check } = await import('@tauri-apps/plugin-updater');
    onProgress({ phase: 'checking' });
    const update = await check();
    if (!update) throw new Error('Updater endpoint reports no newer signed build');

    let total: number | null = null;
    let received = 0;
    await update.download((event) => {
        switch (event.event) {
            case 'Started':
                total = event.data.contentLength ?? null;
                onProgress({ phase: 'downloading', percent: total ? 0 : null });
                break;
            case 'Progress':
                received += event.data.chunkLength;
                onProgress({
                    phase: 'downloading',
                    percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
                });
                break;
            case 'Finished':
                break;
        }
    });

    if (opts.proceedToInstall && !opts.proceedToInstall()) {
        await update.close().catch(() => { /* best effort */ });
        throw new UpdateAbandonedError();
    }
    onProgress({ phase: 'installing' });
    await update.install();

    onProgress({ phase: 'restarting' });
    // Windows: the NSIS updater kills this process and relaunches the app
    // itself — calling relaunch() here races it (it can restart the OLD
    // binary before files are swapped, leaving a half-updated install) and
    // its throw during teardown used to trip the caller's browser fallback.
    // The explicit relaunch is only for macOS/Linux, where the installer
    // does not restart the app.
    if (!navigator.userAgent.includes('Windows')) {
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
    }
}
