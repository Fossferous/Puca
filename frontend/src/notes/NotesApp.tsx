/**
 * Púca Notes — the router and the session gate.
 *
 * HashRouter, deliberately: the page is served by a static file server whose
 * SPA fallback (`try_files {path} /index.html`) answers any unknown path with
 * Púca's OWN index. `/notes/#/reminders` never reaches the server, so deep
 * links work on every deployment the moment dist/notes/ is there — no
 * operator-side vhost change.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getToken, isAuthenticated, isTokenExpired, logout, softExpireSession } from '../api/auth';
import { resetAuthExpiredFlag } from '../api/client';
import { clearSharedSessionCaches, installSessionSync } from '../api/sessionSync';
import { seedMatchesCurrentAccount } from '../api/e2ee';
import { NotesLogin } from './components/NotesLogin';
import { NotesShell } from './components/NotesShell';
import { invalidateNotesPrefs } from './model/notesPrefs';
import { notesKeys } from './model/notesQueries';
import { NativeTokenGate } from './native/NativeTokenGate';
import { adoptFromNative, adoptOnResume, rescueOrExpire, rescueWhenOnline } from './native/nativeSessionRescue';
import { useNotesNativeSession } from './native/useNotesNativeSession';
import { pendingOutboxCount } from './model/notesOutbox';
import { flushNotesPrefs, prefsUnsynced } from './model/notesPrefsSync';
import { settlePendingDeviceRevoke } from '../api/deviceIdentity/pendingRevoke';
import { deleteNotesCaches, notesCacheDbName, notesSignOutWarning } from '../api/notesCacheScrub';
import { currentUserIdFromToken } from '../api/auth';

export function NotesApp() {
    return (
        <HashRouter>
            <NativeTokenGate>
                <SessionGate />
            </NativeTokenGate>
        </HashRouter>
    );
}

function SessionGate() {
    const navigate = useNavigate();
    const qc = useQueryClient();
    const [signedIn, setSignedIn] = useState(isAuthenticated());
    // Android app: every way out of the session clears the native side too.
    useNotesNativeSession(signedIn);
    // The token ran out while OFFLINE: signing in is impossible right now, so
    // keep the cached notes on screen (and queue edits) instead of a sign-in
    // screen that cannot work; the real expiry runs once the network is back.
    const [expiredOffline, setExpiredOffline] = useState(false);

    /** Land on the login screen without touching the keys (App.tsx's rule:
     *  a re-authentication must never risk the E2EE identity). */
    const expire = useCallback((expired: boolean) => {
        softExpireSession();
        qc.clear();
        setSignedIn(false);
        navigate('/login', { state: { expired }, replace: true });
    }, [navigate, qc]);

    // The Android app's job may have renewed the token while the page slept
    // (native/nativeSessionRescue.ts): adopting it continues the session, so
    // the expiry signal is re-armed and whatever failed on the old token is
    // fetched again. In the browser adoption is always false.
    const onAdopted = useCallback(() => {
        resetAuthExpiredFlag();
        void qc.invalidateQueries();
    }, [qc]);

    // The API client fires this ONCE per session when an authenticated
    // request 401s (the token is dead) — same contract as App.tsx. The Android
    // app first tries the job's renewed token; only with none does it expire.
    useEffect(() => {
        const h = () => { void rescueOrExpire({ adopt: adoptFromNative, onAdopted, expire: () => expire(true) }); };
        window.addEventListener('auth-expired', h);
        return () => window.removeEventListener('auth-expired', h);
    }, [expire, onAdopted]);

    // Back into view after a long background stay: adopt before the next
    // poll can 401 on a token that expired meanwhile.
    useEffect(() => adoptOnResume(adoptFromNative, onAdopted), [onAdopted]);

    // A token we can SEE has expired will never work; go straight to sign-in
    // (after the same rescue).
    useEffect(() => {
        const t = getToken();
        if (signedIn && t && isTokenExpired(t)) {
            // The Android app first tries the job's renewed token. With none:
            // OFFLINE, signing in is impossible right now, so the cached
            // notes stay on screen (edits queue) until the network is back.
            void rescueOrExpire({
                adopt: adoptFromNative,
                onAdopted,
                expire: () => { if (navigator.onLine === false) setExpiredOffline(true); else expire(true); },
            });
        }
        // Mount-time check only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Back online: the job may have renewed the session while we were
    // offline, so rescue before expiring (nativeSessionRescue.ts).
    useEffect(() => {
        if (!expiredOffline) return;
        return rescueWhenOnline({
            adopt: adoptFromNative,
            onAdopted: () => { setExpiredOffline(false); onAdopted(); },
            expire: () => { setExpiredOffline(false); expire(true); },
        });
    }, [expiredOffline, expire, onAdopted]);

    // The Púca tab (or another Notes tab) signed out, soft-expired, switched
    // accounts, or signed in. Shared caches are cleared inside sessionSync.
    //
    // A sign-in elsewhere arrives in two storage events: the token first, the
    // E2EE seed only after that tab's /keys/wrap round trip. Entering the
    // shell on the token alone would fetch every note with no identity and
    // cache "locked" markers for 30 s. So: enter on the token only if the
    // seed is already there AND is this account's, otherwise wait for it; and
    // when a seed lands while the shell is up, re-read everything. "Is this
    // account's" matters because a soft expiry keeps the PREVIOUS account's
    // seed in storage: entering on "a seed is present" sealed the new
    // account's notes to the old identity (api/e2ee.ts SEED_OWNER_KEY).
    const signedInRef = useRef(signedIn);
    useEffect(() => { signedInRef.current = signedIn; }, [signedIn]);
    const awaitingSeed = useRef(false);
    useEffect(() => installSessionSync({
        onSignedOut: () => {
            awaitingSeed.current = false;
            qc.clear();
            invalidateNotesPrefs();
            setSignedIn(false);
            navigate('/login', { state: { expired: false }, replace: true });
        },
        onAccountChanged: () => window.location.reload(),
        onSignedIn: () => {
            invalidateNotesPrefs();
            if (!seedMatchesCurrentAccount()) { awaitingSeed.current = true; return; }
            qc.clear();
            setSignedIn(true);
            navigate('/', { replace: true });
        },
        onSeedChanged: (present) => {
            if (!present) return;
            if (awaitingSeed.current) {
                // login() writes the seed and THEN its owner stamp; between the
                // two this still says no, and the stamp's own event follows.
                if (!seedMatchesCurrentAccount()) return;
                awaitingSeed.current = false;
                qc.clear();
                setSignedIn(true);
                navigate('/', { replace: true });
            } else if (signedInRef.current) {
                void qc.invalidateQueries({ queryKey: notesKeys.all });
            }
        },
    }), [navigate, qc]);

    // A web sign-out whose device revoke was never confirmed is finished with
    // this session (api/deviceIdentity/pendingRevoke.ts). Notes never enrols
    // a device, so there is no enrolment for the revoke to race.
    useEffect(() => {
        if (signedIn) void settlePendingDeviceRevoke(getToken(), currentUserIdFromToken());
    }, [signedIn]);

    const signOut = useCallback(async () => {
        // Sign-out deletes this browser's copy of everything Notes keeps, so
        // nothing that has not reached the server may go without a question.
        // Colours and labels get one last push first (bounded).
        const prefsLeft = prefsUnsynced() ? await flushNotesPrefs() : false;
        const warning = notesSignOutWarning({ ops: pendingOutboxCount(), prefs: prefsLeft });
        if (warning !== null && !window.confirm(warning)) return;
        // logout() clears the token, the seed, the DM/channel/blob caches and
        // scrubs the per-account device-local stores (Notes' included). It
        // also revokes this browser's DEVICE enrolment: the id is derived from
        // the web key, so no socket is needed, and the key is dropped only
        // once the server confirms (api/auth.ts revokeWebDeviceAndScrubKey).
        // The revoke runs on after this page moves on (keepalive fetch).
        logout();
        clearSharedSessionCaches();
        qc.clear();
        invalidateNotesPrefs();
        setSignedIn(false);
        navigate('/login', { replace: true });
    }, [navigate, qc]);

    const onLoginSuccess = useCallback(() => {
        resetAuthExpiredFlag();   // a later expiry must signal again
        // Another account's on-device copy (sealed under a seed this browser
        // no longer holds) is dead weight: drop it. This account's is kept,
        // with any edits it queued while signed out.
        const sub = currentUserIdFromToken();
        deleteNotesCaches(sub === null ? undefined : notesCacheDbName(sub));
        invalidateNotesPrefs();    // the account may differ from the last one
        setSignedIn(true);
        navigate('/', { replace: true });
    }, [navigate]);

    return (
        <Routes>
            <Route
                path="/login"
                element={signedIn ? <Navigate to="/" replace /> : <NotesLogin onSuccess={onLoginSuccess} />}
            />
            <Route
                path="/*"
                element={signedIn ? <NotesShell onSignOut={signOut} expiredOffline={expiredOffline} /> : <Navigate to="/login" replace />}
            />
        </Routes>
    );
}
