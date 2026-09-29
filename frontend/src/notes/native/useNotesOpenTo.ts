/**
 * "Open Púca Notes to" — the Android app opening on a new note or a new list,
 * ready to type in, instead of on the notes (the account menu's setting;
 * model/notesPrefs' `openTo`, kept on THIS device only).
 *
 * WHEN, exactly — the owner's contract:
 *
 *  1. The app STARTS with the person signed in (a cold launch: the page
 *     loading with the session already there — not a shell mounted later by
 *     a sign-in). The composer opens once the shell is ready: the launch's
 *     own request has been read, and the server's answer about what a note
 *     may hold is in (or SHARE_ASK_MS went by without one — a share waits
 *     exactly as long, then goes on what the page believes). A launch that
 *     CARRIED a request — a launcher shortcut, the quick tile, the widget, a
 *     share, a reminder tap — is that request's, and this stands down.
 *  2. The person comes BACK after OPEN_TO_AWAY_MS or more in the background
 *     (visibility hidden → visible). Android keeps a backgrounded app alive,
 *     so tapping the icon usually RESUMES it: without this, the setting
 *     would almost never apply. Only when nothing is open — no note, no
 *     composer, no dialog, menu or sheet, no search typed, not on Trash,
 *     Reminders or the Calendar — and only when the return did not come with
 *     a shortcut, share or reminder tap of its own. A quick switch away and
 *     back never opens it.
 *
 * Never on the web page, never in the desktop app's embedded Notes (the
 * shell passes `enabled` false for both).
 *
 * THE SHORTCUT'S OWN DOOR. Each choice IS a launcher shortcut's word
 * (COMPOSE_TARGETS), opened through the shell's onNativeCompose — the same
 * seq/intent path, the same sheet-or-inline choice, the same focus, and the
 * same composeModeFor fallback (a server that keeps no note text opens a
 * checklist). Nothing is saved here: an empty composer closed untouched
 * creates nothing (QuickAdd's close), which is what makes opening one
 * unasked harmless.
 *
 * Web-only on purpose: page visibility and the plugin's existing events. No
 * plugin, permission or native method is added (notes-app/native-min.json).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { COMPOSE_TARGETS, SHARE_ASK_MS, type ComposeMode } from '../model/composeIntent';
import { type NotesOpenTo } from '../model/notesPrefs';
import { notesNativeAvailable, onNativeNavigate, onNativeShare } from './notesNative';

/** How long away counts as "coming back" rather than a quick switch. */
export const OPEN_TO_AWAY_MS = 5 * 60_000;

/**
 * How long a return waits before it opens anything. A shortcut, share or
 * reminder tap that RESUMED the app reaches the page as a plugin event at
 * about the moment the page turns visible, in either order; the wait lets
 * it land first, so it is never opened over. Short enough to read as part
 * of the app coming up.
 */
export const OPEN_TO_SETTLE_MS = 400;

/** The launcher shortcut each choice stands for: the setting opens exactly
 *  what that shortcut opens. */
const TARGET: Record<Exclude<NotesOpenTo, 'notes'>, string> = {
    note: 'compose-note',
    list: 'compose-list',
};

/** The composer a choice opens, or null for "Your notes". */
export function openToMode(openTo: NotesOpenTo): ComposeMode | null {
    return openTo === 'notes' ? null : COMPOSE_TARGETS[TARGET[openTo]] ?? null;
}

/**
 * Something open that the shell does not hold in its own state: the inline
 * composer, the update gate, a drawing, a recorder, a popover. Every one of
 * them is a `role="dialog"`; the card menu is `.context-menu`.
 */
export function somethingOpenOnPage(doc: Document = document): boolean {
    return doc.querySelector('[role="dialog"], .context-menu') !== null;
}

/**
 * The shell this page STARTED with — true only while the session the page
 * loaded with lasts. Signed out once, it is over: a shell mounted by the next
 * sign-in is not an app start.
 */
export function useStartedSignedIn(signedIn: boolean): boolean {
    const [started, setStarted] = useState(signedIn);
    if (started && !signedIn) setStarted(false);
    return started && signedIn;
}

export interface NotesOpenToOptions {
    /** The Android app, on its own page. False does nothing at all. */
    enabled: boolean;
    /** This shell is the one the app started with (useStartedSignedIn). */
    coldStart: boolean;
    openTo: NotesOpenTo;
    /** Nothing is open, as far as the shell's own state knows (a note, the
     *  composer, a popup or menu, the drawer, a search, a page it must not
     *  open over). The page is checked as well (somethingOpenOnPage). */
    idle: boolean;
    /** What a note may hold is the server's answer, not the stand-in. */
    contentKnown: boolean;
    /** The shell's onNativeCompose: the shortcut's own way in. */
    open: (mode: ComposeMode) => void;
}

/** Handed to the two one-shot launch drains, which report what they found. */
export interface LaunchReports {
    /** The reminder loop's launch target (a shortcut, tile, widget or
     *  notification tap). */
    nav: (carried: boolean) => void;
    /** The share intake's launch payload. */
    share: (carried: boolean) => void;
}

export function useNotesOpenTo({ enabled, coldStart, openTo, idle, contentKnown, open }: NotesOpenToOptions): LaunchReports {
    const latest = useRef({ openTo, idle, open });
    useEffect(() => { latest.current = { openTo, idle, open }; });

    /** Open it now, if it is wanted and nothing is in the way. */
    const tryOpen = useCallback(() => {
        const { openTo: choice, idle: free, open: go } = latest.current;
        const mode = openToMode(choice);
        if (!mode || !free || somethingOpenOnPage()) return;
        go(mode);
    }, []);

    // --- 1. The cold start ---------------------------------------------------------
    // null = not heard yet. Without the plugin (an older APK) nothing can
    // carry a request and nothing will report, so the launch is clear.
    const [launch, setLaunch] = useState<{ nav: boolean | null; share: boolean | null }>({ nav: null, share: null });
    const nav = useCallback((carried: boolean) => setLaunch(l => (l.nav === null ? { ...l, nav: carried } : l)), []);
    const share = useCallback((carried: boolean) => setLaunch(l => (l.share === null ? { ...l, share: carried } : l)), []);
    const native = enabled && notesNativeAvailable();
    const carried = native && (launch.nav === true || launch.share === true);
    const heard = !native || (launch.nav !== null && launch.share !== null);
    const waiting = enabled && coldStart && heard && !carried;
    const [askExpired, setAskExpired] = useState(false);
    const coldDone = useRef(false);
    useEffect(() => {
        if (!waiting || coldDone.current) return;
        const t = setTimeout(() => setAskExpired(true), SHARE_ASK_MS);
        return () => clearTimeout(t);
    }, [waiting]);
    useEffect(() => {
        if (!enabled || !coldStart || coldDone.current) return;
        if (carried) { coldDone.current = true; return; }
        if (!heard || !(contentKnown || askExpired)) return;
        // Decided once, whatever the outcome: something open at this moment
        // (a note in the address, say) must not have the composer pop up
        // over it a minute later when it closes.
        coldDone.current = true;
        tryOpen();
    }, [enabled, coldStart, carried, heard, contentKnown, askExpired, tryOpen]);

    // --- 2. Coming back ------------------------------------------------------------
    useEffect(() => {
        if (!enabled) return;
        // A shortcut, share or reminder tap counts whenever it lands — while
        // the page is still hidden too, which is when Android delivers one
        // that resumes the app (onNewIntent comes before onResume).
        let requests = 0;
        const offNav = onNativeNavigate(() => { requests += 1; });
        const offShare = onNativeShare(() => { requests += 1; });
        let away: { at: number; requests: number } | null =
            document.visibilityState === 'hidden' ? { at: Date.now(), requests } : null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onVisibility = () => {
            if (document.visibilityState === 'hidden') {
                clearTimeout(timer);
                away = { at: Date.now(), requests };
                return;
            }
            const was = away;
            away = null;
            if (!was || Date.now() - was.at < OPEN_TO_AWAY_MS) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
                // It came back FOR something: that request is the one to honour.
                if (requests !== was.requests) return;
                tryOpen();
            }, OPEN_TO_SETTLE_MS);
        };
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', onVisibility);
            offNav();
            offShare();
        };
    }, [enabled, tryOpen]);

    return { nav, share };
}
