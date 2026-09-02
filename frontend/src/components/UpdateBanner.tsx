/**
 * Update Banner — shows when a newer release is published (see api/appVersion).
 * "Update" performs a familiar in-place update: download with progress →
 * silent install → relaunch. If the signed-update path fails for any reason it
 * falls back to opening the download page. "Later" hides the banner for this
 * session (it reappears on next launch while outdated).
 *
 * THIS BANNER ONLY PROMPTS. It never installs on its own — not at launch, not
 * on the poll, not on the focus recheck. It used to auto-install on its first
 * check, 8 s after mount, on the theory that "launch" is the least disruptive
 * moment. But this component mounts inside /chat, under RequireAuth, and only
 * after App's `!wsConnected` short-circuit clears — so "8 s after launch"
 * really meant "8 s after you were signed in, connected and looking at the
 * chat", which is plenty of time to open a channel or join voice, and then be
 * relaunched out of it. Automatic installation now lives in UpdateGate,
 * BEFORE the app loads, and only when the user has opted in
 * (Settings → Advanced → Desktop App → "Install updates automatically").
 *
 * Relaunching out from under someone who is typing or in voice because a
 * release happened to land is exactly the behaviour people hate in other apps.
 */

import { useState, useEffect, useCallback } from 'react';
import {
    checkForNewVersion,
    openDownloadPage,
    installUpdateInPlace,
    type AppVersionInfo,
    type UpdateProgress,
} from '../api/appVersion';
import { ArrowUpCircleIcon } from './Icons';
import { isSelfInVoice, subscribeSelfInVoice } from './voiceState';
import './UpdateBanner.css';

// Poll every 10 min while the app stays continuously focused (a release
// published just after launch shouldn't sit unseen for long). The /app-version
// fetch is a few hundred bytes and Cloudflare passes it straight through, so
// this is cheap. The MAIN way a release surfaces is the focus recheck below:
// tab back to Púca and it rechecks near-instantly (a small 30 s gap just
// stops rapid alt-tab flicker from hammering it). Together: fronting the app
// after any absence shows a new build within a second; even if you keep it
// focused on a second screen, worst case is 10 min.
const RECHECK_MS = 10 * 60 * 1000;
const FOCUS_RECHECK_MIN_GAP_MS = 30 * 1000;
const DISMISS_KEY = 'sovereign_update_dismissed'; // sessionStorage, per-version

function progressLabel(p: UpdateProgress): string {
    switch (p.phase) {
        case 'checking': return 'Checking…';
        case 'downloading': return p.percent === null ? 'Downloading…' : `Downloading ${p.percent}%`;
        case 'installing': return 'Installing…';
        case 'restarting': return 'Restarting…';
    }
}

export function UpdateBanner() {
    const [update, setUpdate] = useState<AppVersionInfo | null>(null);
    const [dismissed, setDismissed] = useState(false);
    const [progress, setProgress] = useState<UpdateProgress | null>(null);
    /** Set when an update FAILED and this process is still alive to say so. */
    const [failure, setFailure] = useState<string | null>(null);
    /** A banner popping up mid-call is the annoyance the pre-load gate was
     *  built to end — hide it while in voice (it returns when the call does
     *  end; the update is not going anywhere). */
    const [inVoice, setInVoice] = useState(isSelfInVoice);
    useEffect(() => subscribeSelfInVoice(setInVoice), []);

    /** Download → install → relaunch. Driven by the Update button (and by
     *  "Try again" after a failure) — never by a timer. */
    const runInstall = useCallback(async (info: AppVersionInfo) => {
        let phase: UpdateProgress['phase'] = 'checking';
        try {
            await installUpdateInPlace(p => {
                phase = p.phase;
                setProgress(p);
            });
            // The installer has taken over; the app exits/relaunches on its own.
        } catch (err) {
            console.error('[UpdateBanner] In-place update failed:', err);
            setProgress(null);
            // Fall back to the BROWSER only when the update never reached the
            // install step. Once the installer is running, this process is being
            // torn down — a late throw is teardown noise, and opening the
            // download page over a succeeding update was the "clicking Update
            // dumps me on the download site" bug.
            if (phase === 'checking' || phase === 'downloading') {
                openDownloadPage(info.download_url).catch(e =>
                    console.error('[UpdateBanner] Failed to open download page:', e));
                return;
            }
            // But a failure at the INSTALL step used to do nothing at all: no
            // browser, no message, just the banner reappearing. A user reported
            // exactly that — stuck on 0.7.8, clicks Update, banner returns —
            // and there was no way for them or for us to tell a failed install
            // from one still in progress.
            //
            // Showing it costs nothing when the installer really did take over,
            // because this process will not be around to render it. When it
            // does render, the install genuinely failed, and the usual cause on
            // Windows is that the silent NSIS install could not replace a
            // per-machine install without elevation.
            setFailure(
                err instanceof Error && err.message
                    ? err.message
                    : 'The update could not be installed.',
            );
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        // Start the focus-gap clock at mount so an early focus event can't
        // fire a check before the deliberate 8s startup delay.
        let lastCheck = Date.now();
        // PROMPT-only: show the banner when a newer release exists. Nothing in
        // this effect installs anything (see the file header).
        const check = async () => {
            lastCheck = Date.now();
            const info = await checkForNewVersion();
            if (cancelled || !info) return;
            setUpdate(info);
            const wasDismissed = sessionStorage.getItem(DISMISS_KEY) === info.version;
            setDismissed(wasDismissed);
        };
        const onFocus = () => {
            if (Date.now() - lastCheck >= FOCUS_RECHECK_MIN_GAP_MS) {
                check();
            }
        };
        // Delay the first check so the prompt never competes with app startup.
        const initial = setTimeout(() => check(), 8000);
        const interval = setInterval(() => check(), RECHECK_MS);
        window.addEventListener('focus', onFocus);
        return () => {
            cancelled = true;
            clearTimeout(initial);
            clearInterval(interval);
            window.removeEventListener('focus', onFocus);
        };
    }, []);

    const busy = progress !== null;

    // `busy` overrides the in-voice hide: a call started mid-install must not
    // hide an active installer's progress. `failure` too — the failure path
    // sets progress null before failure, and hiding the "install failed, run
    // it yourself" explanation behind the call recreates the exact silent-
    // failed-install symptom that message was added to fix.
    if (!update || dismissed || (inVoice && !busy && !failure)) {
        return null;
    }

    const handleUpdate = () => {
        // Race guard: a call can start between render and click. Updating
        // relaunches the app, which drops the call — say so first.
        if (isSelfInVoice()
            && !window.confirm('You are in a voice call — updating restarts Púca and disconnects you. Update now?')) {
            return;
        }
        runInstall(update);
    };

    return (
        <div className="update-banner">
            <div className="update-banner-content">
                <span className="update-icon"><ArrowUpCircleIcon /></span>
                <div className="update-text">
                    <strong>Update available!</strong>
                    <span>
                        Púca v{update.version} is out.
                        {update.notes && (
                            <span className="update-notes"> — {update.notes.substring(0, 100)}{update.notes.length > 100 ? '…' : ''}</span>
                        )}
                    </span>
                </div>
            </div>

            {failure && (
                <div className="update-failure" role="alert">
                    <span>
                        {/* Per-user installer (NSIS currentUser: %LOCALAPPDATA% +
                            HKCU), so "run as administrator" is not the remedy —
                            elevating into another admin account installs a
                            second copy under that profile. The running process
                            (kept alive by the tray) is what blocks the swap. */}
                        {failure} This usually means Púca could not replace itself
                        while it was still running. Close Púca completely — including
                        the tray icon — and run the installer again; administrator
                        rights are not needed.
                    </span>
                    <button
                        className="update-later-btn"
                        onClick={() => {
                            void openDownloadPage(update.download_url).catch(e =>
                                console.error('[UpdateBanner] Failed to open download page:', e));
                        }}
                    >
                        Download it
                    </button>
                </div>
            )}

            <div className="update-actions">
                {!busy && (
                    <button
                        className="update-later-btn"
                        onClick={() => {
                            sessionStorage.setItem(DISMISS_KEY, update.version);
                            setDismissed(true);
                        }}
                    >
                        Later
                    </button>
                )}

                <button className="update-now-btn" onClick={handleUpdate} disabled={busy}>
                    {busy ? progressLabel(progress) : failure ? 'Try again' : 'Update'}
                </button>
            </div>
        </div>
    );
}
