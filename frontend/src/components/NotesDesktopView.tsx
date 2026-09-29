/**
 * Púca Notes inside the Púca desktop app. On desktop the rail's "Tasks &
 * notes" button opens the whole of Notes here — grid, composer, search,
 * labels, reminders, calendar, trash, selection, copy — for the account the
 * app is signed in to, with no second sign-in.
 *
 * THE SAME COMPONENT TREE as Notes' own page (notes/NotesApp.tsx: NotesShell
 * and everything under it), so every Notes feature reaches the desktop in the
 * same commit. Only the hosting differs:
 *
 *  - ITS OWN REACT ROOT, created into this view's element, under a
 *    MemoryRouter. A Router cannot be nested inside the app's BrowserRouter,
 *    and Notes' routes must never become the app's address.
 *  - A QUERY CLIENT PER MOUNT, never at module scope as on Notes' own page
 *    (notes/main.tsx, where the page IS the session). Chat unmounts on
 *    sign-out and on expiry, and this view with it, so the decrypted cache
 *    ends with the session instead of outliving it into the next account.
 *    The sealed on-device cache is read into it once this account's identity
 *    is in hand (whenIdentityReady).
 *  - KEPT MOUNTED ONCE OPENED, hidden while the person is elsewhere in the
 *    app. Queued offline edits keep replaying, live updates keep arriving,
 *    and a delete inside its six-second Undo is not committed by a click on a
 *    channel — unmounting would commit it (NotesShell commits what is pending
 *    as it unmounts). Hidden means `inert` and `visibility: hidden`, not
 *    `display: none`: nothing inside can be focused, clicked or typed into,
 *    yet the pager's scroll position and the open note survive the trip, and
 *    Notes' dialogs and bars — portaled into this view's own layer
 *    (components/portalTarget.ts), not the body — hide with it. It takes no
 *    shortcut then either (NotesShell's `embedded`), a recording stops as it
 *    would off the screen, and a voice note that was playing pauses.
 *  - NO SOCKET. Nothing under src/notes may reach the WebSocket
 *    (tests/notesNoSocket.test.ts). This file lives outside src/notes so that
 *    what Notes needs from the app — its sign-out — arrives as a callback.
 *
 * Lazy-loaded by Chat and only under Tauri, so the web app and the phone apps
 * never fetch this chunk, Notes' tree or its stylesheet.
 */
import { StrictMode, useCallback, useLayoutEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { PortalTargetContext } from './portalTarget';
import { notesOwnsKey, whenIdentityReady } from './notesDesktopView.utils';
import { NotesShell } from '../notes/components/NotesShell';
import { NotesOnScreenContext } from '../notes/components/notesOnScreen';
import { makeNotesQueryClient, notesKeys } from '../notes/model/notesQueries';
import { hydrateNotesCache } from '../notes/model/notesCache';
import notesCss from '../notes/notes.css?inline';
import './NotesDesktopView.css';

/**
 * notes.css goes in FIRST, ahead of every stylesheet the app already has, not
 * after them as a lazily loaded chunk's CSS would. On Notes' own page it is
 * the page-level sheet: it loads before every component's CSS and before
 * mobile.css (notes/main.tsx), and rules of equal weight are written for
 * that order. Loaded last, it would win every such tie instead — a
 * NotesDialog's primary button, for one, would take notes.css's brand fill
 * under NotesDialog.css's brand-coloured text, in Púca's own Tasks view as
 * much as in Notes. Once per document; the app's CSP allows inline styles.
 */
function installNotesCss(): void {
    if (document.head.querySelector('style[data-notes-desktop]')) return;
    const style = document.createElement('style');
    style.setAttribute('data-notes-desktop', '');
    style.textContent = notesCss;
    document.head.prepend(style);
}

interface NotesDesktopViewProps {
    /** The view is the one on screen. */
    active: boolean;
    /** The app's own sign-out (App.tsx's handleLogout, through Chat). */
    onSignOut: () => void;
}

interface Mounted {
    root: Root;
    /** Where Notes' dialogs, pickers and bars are portaled. */
    layer: HTMLElement;
    qc: QueryClient;
}

export function NotesDesktopView({ active, onSignOut }: NotesDesktopViewProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    const mounted = useRef<Mounted | null>(null);
    const signOutRef = useRef(onSignOut);
    useLayoutEffect(() => { signOutRef.current = onSignOut; });
    const signOut = useCallback(() => signOutRef.current(), []);
    const ownsKey = useCallback((e: KeyboardEvent) => notesOwnsKey(e, hostRef.current), []);

    useLayoutEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        installNotesCss();
        const mount = document.createElement('div');
        mount.className = 'notes-desktop-root';
        const layer = document.createElement('div');
        layer.className = 'notes-desktop-layer';
        host.append(mount, layer);
        const qc = makeNotesQueryClient();
        const root = createRoot(mount);
        mounted.current = { root, layer, qc };
        const stopWaiting = whenIdentityReady(late => {
            void hydrateNotesCache(qc).then(() => {
                // Fetched while the keys were missing: read it all again.
                if (late) void qc.invalidateQueries({ queryKey: notesKeys.all });
            });
        });
        return () => {
            stopWaiting();
            mounted.current = null;
            // After this commit rather than inside it: React will not unmount
            // one root synchronously while it is committing another.
            queueMicrotask(() => {
                root.unmount();
                qc.clear();
                mount.remove();
                layer.remove();
            });
        };
    }, []);

    useLayoutEffect(() => {
        const m = mounted.current;
        if (!m) return;
        m.root.render(
            <StrictMode>
                <ErrorBoundary>
                    <QueryClientProvider client={m.qc}>
                        <PortalTargetContext.Provider value={m.layer}>
                            <NotesOnScreenContext.Provider value={active}>
                                <MemoryRouter>
                                    <Routes>
                                        <Route path="/*" element={<NotesShell onSignOut={signOut} embedded={{ active, ownsKey }} />} />
                                    </Routes>
                                </MemoryRouter>
                            </NotesOnScreenContext.Provider>
                        </PortalTargetContext.Provider>
                    </QueryClientProvider>
                </ErrorBoundary>
            </StrictMode>,
        );
    }, [active, signOut, ownsKey]);

    // Switched away from: a voice note someone was listening to stops with
    // the view rather than playing on with no control on screen to stop it.
    useLayoutEffect(() => {
        if (active) return;
        for (const el of hostRef.current?.querySelectorAll('audio, video') ?? []) (el as HTMLMediaElement).pause();
    }, [active]);

    return <div ref={hostRef} className="notes-desktop-view" inert={!active} />;
}
