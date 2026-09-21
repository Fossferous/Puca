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
import { COMPOSE_TARGETS, type ComposeMode } from '../model/composeIntent';
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

/** What a tap carried beyond its target: the one item a due notification
 *  came for, and where "open the composer" lands (a composer is state in the
 *  shell, not a route, so it cannot be expressed as a navigate). */
export interface NativeRouteExtra {
    item?: number | null;
    compose?: (mode: ComposeMode) => void;
}

/** Reminders, naming the one item that came due when a notification did.
 *  Pure, so the route string is testable without React. */
export function reminderRoute(item: number | null): string {
    return item && item > 0 ? `/reminders?item=${item}` : '/reminders';
}

/**
 * The browser and desktop half of the same tap. There is no plugin there:
 * clicking the due-task notification dispatches an event carrying the ids it
 * already held (api/desktopNotify.ts), and exactly one due item opens that
 * item's note, as on the phone.
 *
 * MERGE NOTE: work/notes-f-puca-views renames this dispatch to
 * 'sovereign:open-reminders' for Púca's own Tasks view. Whichever name
 * survives the merge into work/notes-merge, it must keep carrying `ids` and
 * both listeners must move together — drop the detail and a one-item tap
 * silently goes back to opening the plain Reminders list, with every gate
 * still green.
 */
export const OPEN_TASKS_EVENT = 'sovereign:open-tasks';

/** Pure: where that event lands. One id names the item; several (or none)
 *  land on Reminders, exactly as before there was a detail at all. */
export function openTasksRoute(detail: unknown): string {
    const ids = (detail as { ids?: unknown } | null | undefined)?.ids;
    const one = Array.isArray(ids) && ids.length === 1 ? Number(ids[0]) : NaN;
    return reminderRoute(Number.isFinite(one) ? one : null);
}

/** Subscribe to it. Returns the unsubscribe, so the shell's effect is one
 *  line and this wiring can be tested without rendering the shell. */
export function onOpenTasks(navigate: (to: string) => void): () => void {
    const h = (ev: Event) => navigate(openTasksRoute((ev as CustomEvent).detail));
    window.addEventListener(OPEN_TASKS_EVENT, h);
    return () => window.removeEventListener(OPEN_TASKS_EVENT, h);
}

/**
 * Where a notification tap lands. 'reminders' opens Reminders (on the one
 * item that came due, when it named one). A compose- target opens the
 * composer. 'signin' comes
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
    extra: NativeRouteExtra = {},
): Promise<void> {
    const compose = target === null ? undefined : COMPOSE_TARGETS[target];
    if (compose) {
        // A shortcut, the tile or the widget. No probe: this is a user
        // gesture, not a session signal, and probing would put a network
        // round trip in front of a cold start.
        extra.compose?.(compose);
    } else if (target === 'reminders') {
        navigate(reminderRoute(extra.item ?? null));
    } else if (target === 'signin') {
        const r = await deps.probe();
        if (r === 'rejected') {
            deps.expired();
        } else {
            deps.repush();
            navigate(reminderRoute(extra.item ?? null));
        }
    }
}

/** Mount once in the signed-in shell. `navigate` receives '/reminders' when
 *  the app was opened (or brought forward) by a reminder notification. */
export function useNotesReminderLoop(navigate: (to: string) => void, compose?: (mode: ComposeMode) => void): void {
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
    // Read through a ref for the same reason as navigate: the shell rebuilds
    // this callback every render and a re-subscribe per render would drop
    // events between the unsubscribe and the next listener.
    const composeRef = useRef(compose);
    useEffect(() => { composeRef.current = compose; }, [compose]);
    useEffect(() => {
        if (!notesNativeAvailable()) return;
        let live = true;
        const go = (nav: { target: string | null; item: number | null }) => {
            if (!live) return;
            void routeNativeTarget(nav.target, to => { if (live) navRef.current(to); }, undefined, {
                item: nav.item,
                compose: mode => { if (live) composeRef.current?.(mode); },
            });
        };
        void consumeNativeLaunchNav().then(go);
        // The native side also keeps an event's target as the pending launch
        // target (for a page that was not listening yet); take it here too, or
        // the next mount of this shell — say, after signing out and back in —
        // would replay a tap from long ago.
        const off = onNativeNavigate(nav => { go(nav); void consumeNativeLaunchNav(); });
        return () => { live = false; off(); };
    }, []);
}
