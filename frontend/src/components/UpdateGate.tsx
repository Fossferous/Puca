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
import { isNewerVersion, shouldAutoInstallOnLaunch, AUTO_ATTEMPT_KEY } from './updateGate.utils';
import { runCapacitorOta, CHECKING_DEADLINE_MS, DOWNLOAD_STALL_MS, type OtaUiState } from '../api/mobileOta';
import { checkForNewVersion, currentAppVersion, installUpdateInPlace, UpdateAbandonedError } from '../api/appVersion';
import { loadSettings } from './settingsStore';
import { CrownIcon, DownloadIcon, CheckCircleIcon, WarningIcon } from './Icons';
import './UpdateGate.css';

interface UpdateGateProps {
    children: ReactNode;
}

// CHECKING_DEADLINE_MS and DOWNLOAD_STALL_MS (and the per-fetch bound the
// mobile check uses) live in api/mobileOta.ts beside the engine they bound;
// the desktop branch below applies the same two.

/** Desktop only. The NSIS installer normally kills this process and relaunches
 *  the app; if it ever resolves and we are still alive, the "Restarting…"
 *  screen must not become a permanent hold. */
const RESTART_GRACE_MS = 30_000;

/** The screen's state — the same shape the shared mobile engine drives. */
type UpdateState = OtaUiState;

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
        // The engine lives in api/mobileOta.ts, shared with Púca Notes' own
        // gate; this component stays Púca's view of it. The channel decides
        // the query string (?variant=lite for lite) and which manifest tag is
        // accepted — absent means full, as it always has.
        await runCapacitorOta({
            channel: RC_ENABLED ? 'full' : 'lite',
            setState,
            // Name the real cause. "Reinstall to get the latest signed
            // version" was the previous advice, and it cannot help: the
            // public key is baked into the APK, so reinstalling the SAME
            // APK reinstalls the same key. Only an APK built for this
            // server (whose key matches what it publishes) updates again.
            verifyFailedMessage: 'This update could not be verified or installed. Púca only applies updates signed with the key built into this app, so this usually means the server is publishing bundles signed with a different key — or the download was corrupted. Retry once; if it keeps happening, an APK built for this server (from its download page) will update again, while reinstalling this same APK will not.',
        });
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
