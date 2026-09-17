/**
 * Púca Keep — the router and the session gate.
 *
 * HashRouter, deliberately: the page is served by a static file server whose
 * SPA fallback (`try_files {path} /index.html`) answers any unknown path with
 * Púca's OWN index. `/keep/#/reminders` never reaches the server, so deep
 * links work on every deployment the moment dist/keep/ is there — no
 * operator-side vhost change.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { HashRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { getToken, isAuthenticated, isTokenExpired, logout, softExpireSession } from '../api/auth';
import { resetAuthExpiredFlag } from '../api/client';
import { clearSharedSessionCaches, installSessionSync, seedPresent } from '../api/sessionSync';
import { KeepLogin } from './components/KeepLogin';
import { KeepShell } from './components/KeepShell';
import { invalidateKeepPrefs } from './model/keepPrefs';
import { keepKeys } from './model/notesQueries';

export function KeepApp() {
    return (
        <HashRouter>
            <SessionGate />
        </HashRouter>
    );
}

function SessionGate() {
    const navigate = useNavigate();
    const qc = useQueryClient();
    const [signedIn, setSignedIn] = useState(isAuthenticated());

    /** Land on the login screen without touching the keys (App.tsx's rule:
     *  a re-authentication must never risk the E2EE identity). */
    const expire = useCallback((expired: boolean) => {
        softExpireSession();
        qc.clear();
        setSignedIn(false);
        navigate('/login', { state: { expired }, replace: true });
    }, [navigate, qc]);

    // The API client fires this ONCE per session when an authenticated
    // request 401s (the token is dead) — same contract as App.tsx.
    useEffect(() => {
        const h = () => expire(true);
        window.addEventListener('auth-expired', h);
        return () => window.removeEventListener('auth-expired', h);
    }, [expire]);

    // A token we can SEE has expired will never work; go straight to sign-in.
    useEffect(() => {
        const t = getToken();
        if (signedIn && t && isTokenExpired(t)) expire(true);
        // Mount-time check only.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // The Púca tab (or another Keep tab) signed out, soft-expired, switched
    // accounts, or signed in. Shared caches are cleared inside sessionSync.
    //
    // A sign-in elsewhere arrives in two storage events: the token first, the
    // E2EE seed only after that tab's /keys/wrap round trip. Entering the
    // shell on the token alone would fetch every note with no identity and
    // cache "locked" markers for 30 s. So: enter on the token only if the
    // seed is already there, otherwise wait for it; and when a seed lands
    // while the shell is up, re-read everything.
    const signedInRef = useRef(signedIn);
    useEffect(() => { signedInRef.current = signedIn; }, [signedIn]);
    const awaitingSeed = useRef(false);
    useEffect(() => installSessionSync({
        onSignedOut: () => {
            awaitingSeed.current = false;
            qc.clear();
            invalidateKeepPrefs();
            setSignedIn(false);
            navigate('/login', { state: { expired: false }, replace: true });
        },
        onAccountChanged: () => window.location.reload(),
        onSignedIn: () => {
            invalidateKeepPrefs();
            if (!seedPresent()) { awaitingSeed.current = true; return; }
            qc.clear();
            setSignedIn(true);
            navigate('/', { replace: true });
        },
        onSeedChanged: (present) => {
            if (!present) return;
            if (awaitingSeed.current) {
                awaitingSeed.current = false;
                qc.clear();
                setSignedIn(true);
                navigate('/', { replace: true });
            } else if (signedInRef.current) {
                void qc.invalidateQueries({ queryKey: keepKeys.all });
            }
        },
    }), [navigate, qc]);

    const signOut = useCallback(() => {
        // logout() clears the token, the seed, the DM/channel/blob caches and
        // scrubs the per-account device-local stores (Keep's included). Note
        // for a shared machine: this browser's DEVICE enrolment is not revoked
        // from here — that needs the attested id only the Púca tab holds — so
        // the next Púca sign-in re-attests as the same device (the same
        // outcome as signing out of Púca before its socket attested).
        logout();
        clearSharedSessionCaches();
        qc.clear();
        invalidateKeepPrefs();
        setSignedIn(false);
        navigate('/login', { replace: true });
    }, [navigate, qc]);

    const onLoginSuccess = useCallback(() => {
        resetAuthExpiredFlag();   // a later expiry must signal again
        invalidateKeepPrefs();    // the account may differ from the last one
        setSignedIn(true);
        navigate('/', { replace: true });
    }, [navigate]);

    return (
        <Routes>
            <Route
                path="/login"
                element={signedIn ? <Navigate to="/" replace /> : <KeepLogin onSuccess={onLoginSuccess} />}
            />
            <Route
                path="/*"
                element={signedIn ? <KeepShell onSignOut={signOut} /> : <Navigate to="/login" replace />}
            />
        </Routes>
    );
}
