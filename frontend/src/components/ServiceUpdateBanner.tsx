/**
 * "Your sign-in-screen service is out of date" — at the top of the app, on
 * the desktop that runs it, the moment that becomes true.
 *
 * WHY A BANNER AND NOT (ONLY) THE CARD. The app auto-updates and the Windows
 * service does not: only `provision` and `update` ever touch it, and `update`
 * is a button. That button lived on the Devices → This device tab, below five
 * long cards, on the DESKTOP — while the person who would notice the breakage
 * is on their PHONE, where the symptom is that unlocking a PC does not hand
 * the session over any more (0.8.85 taught the service to send the handover;
 * an older service just drops the socket, and the phone freezes for a minute
 * then needs a manual reconnect). Real case, 2026-08-17: the installed
 * service was one build behind the app (checked by hash), and nothing on the
 * screen the user was looking at said so.
 *
 * So the mismatch is announced where the app is: a banner in the same slot
 * as the app-update banner, with the same one-click fix, on every launch
 * while it is true. "Later" hides it for this session only — the condition
 * has not gone away, and the next launch says so again.
 *
 * Desktop only, and only when the service is installed: everywhere else there
 * is nothing to update.
 */
import { useCallback, useEffect, useState } from 'react';
import {
    lockScreenSupported,
    lockScreenState,
    unattendedAccessState,
    bundledServiceFingerprint,
    serviceUpdateBannerDue,
    updateLockScreenService,
} from '../api/devices/lockScreen';
import { ArrowUpCircleIcon } from './Icons';
import './UpdateBanner.css';

/** Wait for startup to settle, and let the app-update banner's own 8 s check
 *  land first so the two banners do not appear in the same frame. (That check
 *  only PROMPTS now — an opted-in auto-install already happened in UpdateGate
 *  before the app loaded — so this is purely about not doing two round-trips
 *  at once.) */
const FIRST_CHECK_DELAY_MS = 12_000;
/** Re-check on focus, but not on every alt-tab. */
const FOCUS_RECHECK_MIN_GAP_MS = 60_000;
/** sessionStorage — keyed by the bundled hash so "Later" on one build's
 *  update does not silence the next build's. */
const DISMISS_KEY = 'sovereign_service_update_dismissed';

export function ServiceUpdateBanner() {
    /** The bundled hash the banner is currently offering, or null = hidden. */
    const [bundled, setBundled] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [dismissed, setDismissed] = useState(false);

    const check = useCallback(async () => {
        if (!lockScreenSupported()) return;
        const state = await lockScreenState();
        if (!state.installed) {
            setBundled(null);
            return;
        }
        const [ua, fp] = await Promise.all([unattendedAccessState(), bundledServiceFingerprint()]);
        if (serviceUpdateBannerDue(state.installed, ua.binsHash, fp.hash)) {
            setBundled(fp.hash);
            setDismissed(sessionStorage.getItem(DISMISS_KEY) === fp.hash);
        } else {
            setBundled(null);
        }
    }, []);

    useEffect(() => {
        if (!lockScreenSupported()) return;
        let cancelled = false;
        let lastCheck = Date.now();
        const run = () => {
            lastCheck = Date.now();
            void check().catch(() => { /* a failed check shows nothing */ });
        };
        const initial = setTimeout(() => { if (!cancelled) run(); }, FIRST_CHECK_DELAY_MS);
        const onFocus = () => {
            if (Date.now() - lastCheck >= FOCUS_RECHECK_MIN_GAP_MS) run();
        };
        window.addEventListener('focus', onFocus);
        return () => {
            cancelled = true;
            clearTimeout(initial);
            window.removeEventListener('focus', onFocus);
        };
    }, [check]);

    const doUpdate = async () => {
        setBusy(true);
        setFailure(null);
        const err = await updateLockScreenService();
        if (err) setFailure(err);
        // Re-read from the machine: the restarted service reports its NEW
        // fingerprint, which is what clears this — not our return value.
        await check().catch(() => undefined);
        setBusy(false);
    };

    if (!bundled || dismissed) return null;

    return (
        <div className="update-banner service-update-banner" role="status">
            <div className="update-banner-content">
                <span className="update-icon"><ArrowUpCircleIcon /></span>
                <div className="update-text">
                    <strong>Sign-in-screen service is out of date</strong>
                    <span>
                        Update it, or unlocking this PC from another device won&rsquo;t hand off
                        to the desktop. One Windows prompt.
                    </span>
                </div>
            </div>

            {failure && (
                <div className="update-failure" role="alert">
                    <span>{failure}</span>
                </div>
            )}

            <div className="update-actions">
                {!busy && (
                    <button
                        className="update-later-btn"
                        onClick={() => {
                            sessionStorage.setItem(DISMISS_KEY, bundled);
                            setDismissed(true);
                        }}
                    >
                        Later
                    </button>
                )}
                <button className="update-now-btn" onClick={() => void doUpdate()} disabled={busy}>
                    {busy ? 'Updating…' : failure ? 'Try again' : 'Update the service'}
                </button>
            </div>
        </div>
    );
}
