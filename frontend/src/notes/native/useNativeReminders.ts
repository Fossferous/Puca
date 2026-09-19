/**
 * Púca Notes' reminder loop, with the Android app's native alarms when the
 * APK has them.
 *
 * In the browser (and in an older Notes APK without NotesNative) this is
 * exactly what the shell always did: Púca's own loop, which polls
 * GET /task-reminders and fires a content-free notification for newly due
 * items while the page is open.
 *
 * In the Android app the loop still polls — it is how the page learns the
 * feed — but it posts nothing itself (`notify: false`). Every successful
 * fetch is handed to the native alarm engine instead, which owns firing
 * whether the app is open or closed, so one due item is one notification.
 * Each tick also refreshes the background job's copy of the session token
 * (and every renewal does, via `authTokenRenewed`), so the ~hourly refresh
 * while closed talks to the server with a token as fresh as the page's.
 */
import { useEffect, useRef } from 'react';
import { currentUserIdFromToken, getToken } from '../../api/auth';
import { probeSession, signalAuthExpired } from '../../api/client';
import { API_BASE_URL } from '../../api/config';
import { startTaskReminders } from '../../api/taskReminders';
import {
    consumeNativeLaunchNav, notesNativeAvailable, onNativeNavigate,
    setNativeBackgroundRefresh, syncNativeReminders,
} from './notesNative';

function account(): string | null {
    const id = currentUserIdFromToken();
    return id === null ? null : String(id);
}

/** Push the current session to the background refresh (no-op when signed out). */
export function pushNativeCredentials(): void {
    const token = getToken();
    const acc = account();
    if (!token || !acc) return;
    void setNativeBackgroundRefresh({ apiBase: API_BASE_URL, token, account: acc });
}

/**
 * Where a notification tap lands. 'reminders' opens Reminders. 'signin' comes
 * from the "sign in again" notice (the background job got a 401): the page
 * checks its OWN session first — dead, and the ordinary expiry path takes it
 * to sign-in (after trying the job's renewed token, nativeSessionRescue);
 * still good (the page holds a newer token than the job saw), and it re-arms
 * the job with it and shows Reminders.
 */
export async function routeNativeTarget(
    target: string | null,
    navigate: (to: string) => void,
    deps: { probe: typeof probeSession; expired: () => void; repush: () => void } =
        { probe: probeSession, expired: signalAuthExpired, repush: pushNativeCredentials },
): Promise<void> {
    if (target === 'reminders') {
        navigate('/reminders');
    } else if (target === 'signin') {
        const r = await deps.probe();
        if (r === 'rejected') {
            deps.expired();
        } else {
            deps.repush();
            navigate('/reminders');
        }
    }
}

/** Mount once in the signed-in shell. `navigate` receives '/reminders' when
 *  the app was opened (or brought forward) by a reminder notification. */
export function useNotesReminderLoop(navigate: (to: string) => void): void {
    useEffect(() => {
        if (!notesNativeAvailable()) return startTaskReminders();
        const stop = startTaskReminders({
            notify: false,
            onFeed: entries => {
                const acc = account();
                if (!acc) return;
                void syncNativeReminders(acc, entries);
                pushNativeCredentials();
            },
        });
        window.addEventListener('authTokenRenewed', pushNativeCredentials);
        return () => {
            stop();
            window.removeEventListener('authTokenRenewed', pushNativeCredentials);
        };
    }, []);

    const navRef = useRef(navigate);
    useEffect(() => { navRef.current = navigate; }, [navigate]);
    useEffect(() => {
        if (!notesNativeAvailable()) return;
        let live = true;
        const go = (target: string | null) => {
            if (live) void routeNativeTarget(target, to => { if (live) navRef.current(to); });
        };
        void consumeNativeLaunchNav().then(go);
        // The native side also keeps an event's target as the pending launch
        // target (for a page that was not listening yet); take it here too, or
        // the next mount of this shell — say, after signing out and back in —
        // would replay a tap from long ago.
        const off = onNativeNavigate(target => { go(target); void consumeNativeLaunchNav(); });
        return () => { live = false; off(); };
    }, []);
}
