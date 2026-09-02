/**
 * UpdateGate - Blocking update check before app loads
 *
 * Runs at main.tsx, outside routing and outside RequireAuth — i.e. before the
 * sign-in screen, before any session, channel, call or draft exists. Two
 * branches:
 *  - MOBILE (Capacitor): the signed OTA is checked and applied here, always.
 *    Forced, because the OTA is the only way a broken bundle ever gets fixed
 *    and every surface must run the same version.
 *  - DESKTOP (Tauri): OPT-IN. Only when `autoInstallUpdates` is on does the
 *    gate check /app-version and run the signed in-place installer here; off
 *    (the default) it does nothing and the UpdateBanner merely PROMPTS once
 *    the app is up. This is the ONLY place a desktop update installs without
 *    a click — the banner used to do it 8 s after the chat UI appeared, which
 *    is mid-channel, mid-call.
 *
 * The gate's one invariant, both branches: it may DELAY the app, it may never
 * HOLD it. Every phase is bounded and every failure surfaces a control.
 */

import { useState, useEffect, useRef, type ReactNode } from 'react';
import { isTauri, RC_ENABLED } from '../api/platform';
import { isNewerVersion, isTrustedBundleUrl, bundleVariantMatches, shouldAutoInstallOnLaunch, AUTO_ATTEMPT_KEY } from './updateGate.utils';
import { updateCheckBases } from '../api/updateCheckBases';
import { checkForNewVersion, currentAppVersion, installUpdateInPlace, UpdateAbandonedError } from '../api/appVersion';
import { loadSettings } from './settingsStore';
import { CrownIcon, DownloadIcon, CheckCircleIcon, WarningIcon } from './Icons';
import './UpdateGate.css';

interface UpdateGateProps {
    children: ReactNode;
}

/** Per-base bound on the update-check fetch. Without one, a HUNG connection
 *  (stalled TLS, captive portal, mid-handover radio — normal phone states)
 *  held the gate forever, and worse: the fallback-base loop only advances on
 *  a THROW, so a hung PRIMARY meant the hardcoded production fallback — the
 *  whole 0.8.24/25 self-healing mechanism — was never even tried. */
const CHECK_FETCH_TIMEOUT_MS = 8_000;
/** Hard deadline on the whole CHECK phase. The gate's one invariant: it may
 *  delay the app, it may never hold it — past this, we continue on the
 *  bundle we already have and let the next launch try again. */
const CHECKING_DEADLINE_MS = 15_000;
/** A download whose progress hasn't ADVANCED for this long is stalled. Real
 *  downloads on slow links can legitimately take minutes — bounding total
 *  time would break them; bounding silence doesn't. */
const DOWNLOAD_STALL_MS = 45_000;
/** Desktop only. The NSIS installer normally kills this process and relaunches
 *  the app; if it ever resolves and we are still alive, the "Restarting…"
 *  screen must not become a permanent hold. */
const RESTART_GRACE_MS = 30_000;

/** fetch bounded by an AbortController (AbortSignal.timeout is missing from
 *  some WebViews and from the test runtime). */
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
        return await fetch(url, { signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
    }
}

type UpdateStatus = 'checking' | 'downloading' | 'ready' | 'error' | 'upToDate';

interface UpdateState {
    status: UpdateStatus;
    progress: number;
    version: string | null;
    error: string | null;
}

export function UpdateGate({ children }: UpdateGateProps) {
    const [state, setState] = useState<UpdateState>({
        status: 'checking',
        progress: 0,
        version: null,
        error: null,
    });

    /**
     * The desktop install run that is currently in flight, if any. The Tauri
     * download cannot be cancelled, so once started it runs to completion in
     * the background whatever the screen shows. This record is how the screen
     * and the run stay honest with each other:
     *  - `stalled`: the silence watchdog fired; the error screen is up. Retry
     *    RESUMES this run (clears the flag) rather than starting a second one.
     *  - `abandoned`: the user chose "Continue Anyway" — the app is up. When
     *    the download eventually finishes, the install gate refuses, so a
     *    download that limps home later can never run the installer under a
     *    live session (the exact mid-session relaunch this gate exists to
     *    remove).
     *  - `committed`: the download finished and the installer is running —
     *    the point of no return; the watchdog is disarmed there.
     */
    const desktopRunRef = useRef<{ version: string; percent: number; lastAdvanceAt: number; stalled: boolean; abandoned: boolean; committed: boolean } | null>(null);

    useEffect(() => {
        checkAndApplyUpdates();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- run the update check once on mount
    }, []);

    /** `force` = the user pressed Retry: bypasses ONLY the once-per-version
     *  loop guard (an explicit click is a human decision, not the launch loop),
     *  never the opt-in or the version comparison. Mobile ignores it. */
    async function checkAndApplyUpdates(force = false) {
        // Check platform and use appropriate updater
        if (isTauri()) {
            // Desktop auto-install is opt-in and, when on, happens HERE — before
            // the app loads. Off (default): no network, no screen, the
            // UpdateBanner prompts later.
            await checkDesktopUpdate(force);
        } else if (isCapacitor()) {
            await checkCapacitorUpdates();
        } else {
            // Web browser - no updates needed
            setState(s => ({ ...s, status: 'upToDate' }));
        }
    }

    async function checkDesktopUpdate(force: boolean) {
        // Synchronous, before any await: an opted-out startup is byte-for-byte
        // as fast as before this branch existed.
        if (!loadSettings().autoInstallUpdates) {
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }

        // Retry with a run still in flight: the download never stopped, so do
        // NOT start a second one on top of it — just stop calling it stalled
        // and go back to watching its progress.
        const inFlight = desktopRunRef.current;
        if (inFlight && !inFlight.abandoned && !inFlight.committed) {
            inFlight.stalled = false;
            // Restart the silence clock too, or the watchdog re-declares the
            // same stall within one tick of the user asking to keep waiting.
            inFlight.lastAdvanceAt = Date.now();
            setState(s => ({ ...s, status: 'downloading', version: inFlight.version, progress: inFlight.percent, error: null }));
            return;
        }

        // Phase 1 — the CHECK, under the same deadline as mobile. A late answer
        // is a no-op: installing UNDER a running app is precisely the mid-
        // session relaunch this branch exists to remove.
        const gaveUp = { value: false };
        const checkingDeadline = setTimeout(() => {
            gaveUp.value = true;
            console.warn('[UpdateGate] desktop check exceeded its deadline — continuing on the installed build');
            setState(s => (s.status === 'checking' ? { ...s, status: 'upToDate' } : s));
        }, CHECKING_DEADLINE_MS);

        let info: Awaited<ReturnType<typeof checkForNewVersion>>;
        let current: string;
        try {
            info = await checkForNewVersion();
            current = await currentAppVersion();
        } catch (error) {
            console.warn('[UpdateGate] desktop update check failed (continuing on the installed build):', error);
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        } finally {
            clearTimeout(checkingDeadline);
        }
        if (gaveUp.value) return;

        // checkForNewVersion already filters to strictly-newer, but the gate
        // states its own anti-rollback rule rather than trusting a caller's:
        // /app-version is an operator-pushed file and the minisign signature
        // covers the installer bytes, not the advertised number.
        const wanted = shouldAutoInstallOnLaunch(
            loadSettings().autoInstallUpdates,
            force ? null : localStorage.getItem(AUTO_ATTEMPT_KEY),
            info?.version ?? null,
            info ? isNewerVersion(info.version, current) : false,
        );
        if (!wanted || !info) {
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }
        const target = info;
        // Recorded BEFORE the attempt so a relaunch that comes back on the
        // old build does not try again (StrictMode's dev double-mount is
        // covered by the same write: the second run sees it and declines).
        localStorage.setItem(AUTO_ATTEMPT_KEY, target.version);

        // Phase 2 — the INSTALL. Silence detector, not a total-time cap (a slow
        // link is fine as long as progress keeps arriving). The run record is
        // what keeps a stall/abandon honest — see desktopRunRef.
        const run = { version: target.version, percent: 0, lastAdvanceAt: Date.now(), stalled: false, abandoned: false, committed: false };
        desktopRunRef.current = run;
        const stallWatchdog = setInterval(() => {
            if (run.committed || run.abandoned) { clearInterval(stallWatchdog); return; }
            if (run.stalled || Date.now() - run.lastAdvanceAt < DOWNLOAD_STALL_MS) return;
            run.stalled = true;
            console.error('[UpdateGate] desktop update download stalled — surfacing instead of holding the gate');
            setState(s => ({
                ...s,
                status: 'error',
                error: 'The update download has gone quiet. Retry to keep waiting for it, or continue on the current version — the download is then abandoned (it will not install under you) and the update is offered again next launch.',
            }));
        }, 5_000);
        try {
            console.log('[UpdateGate] auto-installing desktop update', current, '->', target.version);
            setState(s => ({ ...s, status: 'downloading', version: target.version, progress: 0 }));
            await installUpdateInPlace(p => {
                run.lastAdvanceAt = Date.now();
                if (run.abandoned) return; // the app is up; say nothing more
                if (p.phase === 'downloading') {
                    if (p.percent !== null) run.percent = p.percent;
                    // Progress after a stall verdict, without a Retry: leave the
                    // error screen up — the user was handed control and keeps it.
                    if (!run.stalled) setState(s => ({ ...s, progress: p.percent ?? s.progress }));
                } else if (p.phase === 'installing' || p.phase === 'restarting') {
                    // Point of no return: the installer is running and this
                    // process is about to be replaced. A silence watchdog past
                    // here could only lie ("stalled" while restarting).
                    run.committed = true;
                    clearInterval(stallWatchdog);
                    setState(s => ({ ...s, status: 'ready', error: null }));
                }
            }, {
                // Consulted between download and install. Abandoned (Continue
                // Anyway) means never install under the running app; a stall
                // verdict that the user has NOT acted on lets the run through —
                // they were told Retry keeps waiting, and the screen still
                // holds the app.
                proceedToInstall: () => !run.abandoned,
            });
            if (run.abandoned) return;
            // The installer is replacing us; stay on "Restarting…". If this
            // process is somehow still here after the grace, wave the app
            // through rather than hold it.
            setState(s => ({ ...s, status: 'ready', error: null }));
            setTimeout(() => setState(s => (s.status === 'ready' ? { ...s, status: 'upToDate' } : s)), RESTART_GRACE_MS);
        } catch (error) {
            if (run.abandoned) {
                // Either our own gate (UpdateAbandonedError) or a late network
                // failure of a download nobody is waiting for. The app is up.
                if (!(error instanceof UpdateAbandonedError)) console.warn('[UpdateGate] abandoned desktop download ended:', error);
                return;
            }
            console.error('[UpdateGate] desktop auto-install failed:', error);
            setState(s => ({
                ...s,
                status: 'error',
                // The installer is per-user (NSIS currentUser mode: it writes
                // under %LOCALAPPDATA% and HKCU), so administrator rights are
                // NOT what it needs — and elevating into a DIFFERENT admin
                // account would install a second, parallel copy under that
                // profile. What actually stops it is the running process:
                // NSIS aborts when Puca.exe cannot be closed, and the tray
                // keeps the process alive after the window is gone.
                error: 'This update could not be installed. On Windows this usually means Púca could not replace itself while it was still running. Close Púca completely — including the tray icon — and run the installer again; administrator rights are not needed. You can also continue on the current version.',
            }));
        } finally {
            clearInterval(stallWatchdog);
            if (desktopRunRef.current === run) desktopRunRef.current = null;
        }
    }

    /** "Continue Anyway": render the app. If a desktop download is still in
     *  flight, mark it abandoned so the install gate refuses when it finishes. */
    function continueOnCurrentVersion() {
        const run = desktopRunRef.current;
        // Past the point of no return the installer IS running and this
        // process is being replaced — rendering the app now would put a live
        // session under it. Hold the "Restarting…" screen instead.
        if (run?.committed) { setState(s => ({ ...s, status: 'ready', error: null })); return; }
        if (run) run.abandoned = true;
        setState(s => ({ ...s, status: 'upToDate' }));
    }

    async function checkCapacitorUpdates() {
        const { CapacitorUpdater } = await import('@capgo/capacitor-updater');

        // The gate's invariant: it may DELAY the app, it may never HOLD it.
        // Whatever phase 1 is stuck in when this fires — a native call that
        // never answers, a fetch a stalled connection keeps open — the app
        // proceeds on the bundle it already has. `gaveUp` makes the stuck
        // work a no-op if it ever does finish.
        const gaveUp = { value: false };
        const checkingDeadline = setTimeout(() => {
            gaveUp.value = true;
            console.warn('[UpdateGate] check exceeded its deadline — continuing on the current bundle');
            setState(s => (s.status === 'checking' ? { ...s, status: 'upToDate' } : s));
        }, CHECKING_DEADLINE_MS);

        // Phase 1 — the CHECK. Any failure here (offline, server down, bad
        // response) is non-fatal: keep the current bundle and load the app.
        let updateInfo: {
            version?: string; url?: string; checksum?: string; sessionKey?: string;
            /** Which build this bundle is for. Absent means the full build,
             *  because every manifest published before lite existed omits it. */
            variant?: string;
        };
        let currentVersion: string;
        /** The update-check base that actually answered — the only base the
         *  bundle URL may be trusted against. '' until one answers. */
        let answeringBase = '';
        try {
            // Blessed at the entry point too (main.tsx — see the comment
            // there: the native appReadyTimeout rollback must not wait for
            // this component). Idempotent, kept for the retry path.
            await CapacitorUpdater.notifyAppReady();
            const currentBundle = await CapacitorUpdater.current();
            currentVersion = currentBundle?.bundle?.version || 'builtin';
            console.log('[UpdateGate] Current bundle version:', currentVersion);

            // Configured base first, then the hardcoded production fallback: a
            // bundle built without .env.production points at localhost and
            // would otherwise NEVER see the fixed OTA (the 0.8.24/25
            // stranding — notifyAppReady above already blessed the broken
            // bundle, so Capgo won't roll back either). Safe here because the
            // bundle is RSA-verified against the key baked into the APK.
            // Each attempt is TIME-BOUND: an abort advances the loop exactly
            // like a refusal, so a hung base can no longer mask the fallback.
            const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
            let checkResponse: Response | null = null;
            for (const base of updateCheckBases(API_BASE)) {
                try {
                    // The OTA pushes a JS BUNDLE into an installed APK, so a
                    // lite install served the full manifest would receive the
                    // whole remote-control frontend over the air and the
                    // guarantee would evaporate after shipping. Ask for this
                    // build's channel; the refusal below is what enforces it,
                    // since an older server ignores the parameter.
                    const checkUrl = `${base}/api/mobile-updates/check`
                        + (RC_ENABLED ? '' : '?variant=lite');
                    const res = await fetchWithTimeout(checkUrl, CHECK_FETCH_TIMEOUT_MS);
                    // A 404 (nothing published) or 204 is a real answer from a
                    // server that serves this route, and it is final. Any OTHER
                    // non-2xx means whatever answered is not serving manifests
                    // — a proxy's 502, an origin lock's 403, or, in the exact
                    // mis-build this loop exists for, whatever happens to be
                    // listening on localhost:3000 — so it must not end the
                    // search: treat it like an unreachable base and move on.
                    if (!res.ok && res.status !== 404 && res.status !== 204) {
                        console.warn(`[UpdateGate] check via ${base} answered ${res.status} — trying the next base`);
                        continue;
                    }
                    checkResponse = res;
                    // The base that ANSWERED is the one the bundle URL is held
                    // against below. Holding it against the configured base
                    // instead refused every manifest the fallback ever fetched:
                    // the fallback only runs when the configured base is wrong
                    // or absent, and an absent base fails the trust check
                    // closed — so the recovery path could fetch a manifest and
                    // then never apply it.
                    answeringBase = base;
                    break;
                } catch (err) {
                    console.warn(`[UpdateGate] check via ${base} unreachable:`, err);
                }
            }
            if (!checkResponse || !checkResponse.ok) {
                setState(s => ({ ...s, status: 'upToDate' }));
                return;
            }
            updateInfo = await checkResponse.json();
        } catch (error) {
            console.warn('[UpdateGate] Update check failed (continuing on current bundle):', error);
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        } finally {
            clearTimeout(checkingDeadline);
        }

        // The deadline already waved the app through — applying an update
        // UNDER the running app now would yank a live session through a
        // reload. The next launch gets a fresh, faster attempt.
        if (gaveUp.value) return;

        if (!updateInfo || !updateInfo.url || !updateInfo.version) {
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }

        // VARIANT MUST MATCH, and this is checked CLIENT-SIDE on purpose.
        //
        // Requesting ?variant=lite protects nothing by itself: a server that
        // predates lite ignores the parameter and answers with the ordinary
        // manifest, which would install the full remote-control bundle into a
        // lite app. So the client refuses anything that is not its own variant.
        //
        // Absent means FULL — every manifest published before lite existed has
        // no variant field, and those are full bundles. That asymmetry is why
        // the comparison is written against the expected value rather than by
        // testing for the string 'lite'.
        if (!bundleVariantMatches(updateInfo.variant, RC_ENABLED)) {
            console.warn(
                `[UpdateGate] Refusing a "${updateInfo.variant ?? 'full'}" bundle: this is the `
                + `"${RC_ENABLED ? 'full' : 'lite'}" build. Publish a matching manifest for this channel.`,
            );
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }

        // Anti-rollback: only apply a STRICTLY NEWER version. The Capgo signature
        // authenticates the bundle bytes but NOT the advertised version, so a
        // string-equality gate would let a manifest replay an older (still
        // validly signed) bundle — reintroducing fixed bugs. Monotonic ordering
        // blocks a downgrade to any lower version number.
        if (!isNewerVersion(updateInfo.version, currentVersion)) {
            console.log('[UpdateGate] Manifest version', updateInfo.version, '<= current', currentVersion, '- not applying');
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }

        // The bundle URL must be HTTPS and on the same site as the base that
        // answered the check — never follow a manifest that points the download
        // at an arbitrary/plaintext host. The same-site rule still means
        // something with the fallback: that base is operator-set build-time
        // config, not something the manifest chose. Only the answering base
        // is passed, never a default: an unknown base fails closed in
        // isTrustedBundleUrl, and that branch is right for a base nobody
        // configured.
        if (!isTrustedBundleUrl(updateInfo.url, answeringBase)) {
            console.error(`[UpdateGate] Refusing untrusted bundle URL ${updateInfo.url} (manifest came from ${answeringBase || 'an unknown base'})`);
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }

        // SIGNATURE IS MANDATORY. Our capacitor.config ships an updater
        // publicKey, so every legitimate bundle is AES-encrypted with an
        // RSA-wrapped session key AND carries an RSA-signed SHA-256. The Capgo
        // plugin only RUNS the RSA checksum verification inside its `sessionKey`
        // branch (CapgoUpdater.download): a manifest that supplies a plain
        // checksum and OMITS sessionKey is installed with NO signature check at
        // all. A compromised/malicious manifest server could exploit that to
        // ship an UNSIGNED bundle — remote code execution on every client. So
        // refuse to download unless BOTH the RSA-wrapped session key and the
        // signed checksum are present, and forward them UNCONDITIONALLY below so
        // the plugin can only ever take its verifying path. Our release pipeline
        // (dual-ship.sh) always emits both; a manifest lacking either is not one
        // we produced.
        if (!updateInfo.sessionKey || !updateInfo.checksum) {
            console.error('[UpdateGate] Refusing UNSIGNED OTA bundle — missing sessionKey/checksum');
            setState(s => ({ ...s, status: 'upToDate' }));
            return;
        }

        // Phase 2 — the APPLY. A failure here means an update WAS advertised but
        // couldn't be downloaded/verified/installed. Unlike a check failure this
        // is surfaced (not silently swallowed): most commonly it's an old APK
        // that lacks the signing key and can't consume signed bundles — which
        // only a reinstall fixes. The app still loads via "Continue Anyway".
        let dlListener: { remove: () => Promise<void> } | undefined;
        // Silence detector, not a total-time cap: a slow link may legitimately
        // take minutes, but its progress events keep arriving. A transfer
        // whose LAST advance is DOWNLOAD_STALL_MS ago is wedged, and without
        // this it pinned the gate at N% forever with no control on screen.
        let lastAdvanceAt = Date.now();
        let lastPct = -1;
        let stalled = false;
        const stallWatchdog = setInterval(() => {
            if (Date.now() - lastAdvanceAt < DOWNLOAD_STALL_MS) return;
            stalled = true;
            clearInterval(stallWatchdog);
            console.error('[UpdateGate] download stalled — surfacing instead of holding the gate');
            setState(s => ({
                ...s,
                status: 'error',
                error: 'The update download stalled. Check your connection and retry, or continue on the current version — the update will be offered again next launch.',
            }));
        }, 5_000);
        try {
            console.log('[UpdateGate] Updating from', currentVersion, 'to', updateInfo.version);
            setState(s => ({ ...s, status: 'downloading', version: updateInfo.version!, progress: 0 }));

            // Reflect real download progress on the screen — without a listener the
            // bar sits at 0% for the whole download.
            dlListener = await CapacitorUpdater.addListener('download', (info: { percent?: number }) => {
                if (typeof info.percent === 'number') {
                    const pct = Math.min(100, Math.max(0, Math.round(info.percent)));
                    if (pct > lastPct) {
                        lastPct = pct;
                        lastAdvanceAt = Date.now();
                    }
                    setState(s => ({ ...s, progress: pct }));
                }
            });

            // Authenticated OTA: with an embedded public key (capacitor.config),
            // bundles are AES-encrypted and the SHA-256 is RSA-signed off-server.
            // `sessionKey` carries the (RSA-wrapped) AES key + IV so the plugin
            // decrypts; `checksum` is the RSA-signed hash it verifies against the
            // decrypted zip. Both are guaranteed present by the mandatory-signature
            // gate above and are forwarded UNCONDITIONALLY, so the plugin always
            // takes its verifying path — a forged/tampered/unsigned bundle fails
            // → throws here → surfaced below.
            const result = await CapacitorUpdater.download({
                url: updateInfo.url,
                version: updateInfo.version,
                checksum: updateInfo.checksum,
                sessionKey: updateInfo.sessionKey,
            });

            // The watchdog already handed control to the user — a completion
            // arriving AFTER that must not yank whatever they chose into a
            // surprise reload. The bundle is on disk; the next launch's check
            // applies it in a fraction of the time.
            if (stalled) return;

            if (result && result.version) {
                // Visible truth while the native side swaps bundles: without
                // this the bar just froze at 100% until the reload landed.
                setState(s => ({ ...s, status: 'ready' }));
                await CapacitorUpdater.set(result); // reloads into the new bundle
            } else {
                setState(s => ({ ...s, status: 'upToDate' }));
            }
        } catch (error) {
            if (stalled) return; // the stall UI is already up; keep its message
            console.error('[UpdateGate] Update download/verify/apply failed:', error);
            setState(s => ({
                ...s,
                status: 'error',
                // Name the real cause. "Reinstall to get the latest signed
                // version" was the previous advice, and it cannot help: the
                // public key is baked into the APK, so reinstalling the SAME
                // APK reinstalls the same key. Only an APK built for this
                // server (whose key matches what it publishes) updates again.
                error: 'This update could not be verified or installed. Púca only applies updates signed with the key built into this app, so this usually means the server is publishing bundles signed with a different key — or the download was corrupted. Retry once; if it keeps happening, an APK built for this server (from its download page) will update again, while reinstalling this same APK will not.',
            }));
        } finally {
            clearInterval(stallWatchdog);
            await dlListener?.remove();
        }
    }

    function retry() {
        setState({
            status: 'checking',
            progress: 0,
            version: null,
            error: null,
        });
        checkAndApplyUpdates(true);
    }

    // Show loading/update screen while checking
    if (state.status === 'checking') {
        return (
            <div className="update-gate">
                <div className="update-gate-content">
                    <div className="update-logo"><CrownIcon size={64} /></div>
                    <h2>Púca</h2>
                    <div className="update-spinner" />
                    <p>Checking for updates...</p>
                </div>
            </div>
        );
    }

    if (state.status === 'downloading') {
        return (
            <div className="update-gate">
                <div className="update-gate-content">
                    <div className="update-logo"><DownloadIcon size={64} /></div>
                    <h2>Updating to v{state.version}</h2>
                    <div className="update-progress-container">
                        <div
                            className="update-progress-bar"
                            style={{ width: `${state.progress}%` }}
                        />
                    </div>
                    <p>{state.progress}% downloaded</p>
                </div>
            </div>
        );
    }

    if (state.status === 'ready') {
        return (
            <div className="update-gate">
                <div className="update-gate-content">
                    <div className="update-logo"><CheckCircleIcon size={64} /></div>
                    <h2>Update Ready</h2>
                    <p>Restarting with v{state.version}...</p>
                    <div className="update-spinner" />
                </div>
            </div>
        );
    }

    if (state.status === 'error') {
        return (
            <div className="update-gate">
                <div className="update-gate-content">
                    <div className="update-logo"><WarningIcon size={64} /></div>
                    <h2>Update Check Failed</h2>
                    <p className="update-error">{state.error}</p>
                    <div className="update-actions">
                        <button className="update-btn retry" onClick={retry}>
                            Retry
                        </button>
                        <button
                            className="update-btn skip"
                            onClick={continueOnCurrentVersion}
                        >
                            Continue Anyway
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // Up to date - render the app
    return <>{children}</>;
}

function isCapacitor(): boolean {
    return typeof window !== 'undefined' && 'Capacitor' in window &&
        !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}
