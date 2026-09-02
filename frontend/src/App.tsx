import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { Login } from './components/Login';
import { Chat } from './components/Chat';
import ResetPassword from './components/ResetPassword';
import VerifyEmail from './components/VerifyEmail';
import { isAuthenticated, logout, getToken, softExpireSession, isTokenExpired } from './api/auth';
import { resetAuthExpiredFlag, probeSession } from './api/client';
import { wsClient } from './api/websocket';
import { clearBlockedUsers } from './components/blockStore';
import { clearFileCache } from './api/authedMedia';
import { loadSettings } from './components/settingsStore';
import { mobileBatteryStatus, requestIgnoreBatteryOptimizations, setNotifyKeepAlive } from './api/mobileApp';
import { setPlacesAuthed } from './api/taskPlaces';
import { resetReconnectCatchup } from './api/reconnectCatchup';
import { initPushRegistration, teardownPushRegistration } from './api/pushRegistration';

// Module-level: the battery ask spans an async gap, and StrictMode runs the
// effect twice — a ref would be per-mount, and two mounts must still yield
// at most one dialog.
let batteryAskInFlight = false;
import { UpdateBanner } from './components/UpdateBanner';
// Every always-mounted remote-control global, behind one specifier so a
// lite build can alias the lot away — see components/RcGlobals.tsx.
import { RcGlobals } from './components/RcGlobals';
import { RecoveryCodeModal } from './components/RecoveryCodeModal';
import { IdentityBanner } from './components/IdentityBanner';
import { HotkeyBlockedBanner } from './components/HotkeyBlockedBanner';
import { InviteLanding } from './components/InviteLanding';
import { discardSeal, onArmedChange as onClipArmedChange, wireSystemSuspendHook } from './api/clips/replayBuffer';
import { cancelClip, getClipProposalState, setClipDiscardHandler, wireClipProposals } from './api/clips/clipProposals';
import { API_BASE_URL } from './api/config';
import { ClipApprovalPrompt } from './components/ClipApprovalPrompt';
import './App.css';

const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

/** What actually went wrong, so the screen can say so (and offer the action
 *  that helps). A dead SESSION is deliberately not in here: that never reaches
 *  the error screen — it re-authenticates instead. */
type ConnectionFailure =
    | 'unreachable' // no answer from the server at all: offline, DNS, or it's down
    | 'socket';     // server up + token accepted over HTTP, but the socket won't open

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  if (isAuthenticated()) {
    return <Navigate to="/chat" replace />;
  }
  return <>{children}</>;
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loggedIn, setLoggedIn] = useState(isAuthenticated());
  const [wsConnected, setWsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<ConnectionFailure | null>(null);
  const retryCount = useRef(0);

  // Helper to get token from URL for reset/verify
  const urlToken = new URLSearchParams(location.search).get('token') || '';

  // Stable logout handler
  const handleLogout = () => {
    // FIRST, before logout() drops the JWT: unregistering the push token needs
    // it. Fire-and-forget — the synchronous prefix captures the token, and the
    // server's FCM UNREGISTERED pruning is the backstop if the request loses.
    void teardownPushRegistration();
    // Deliberately LOCAL only. /auth/logout bumps users.token_version, which is
    // a per-USER counter — there is no per-session claim — so calling it here
    // would sign the user out on every other device too. Signing out of the
    // phone must not kick the desktop mid-call. Account-wide revocation (for a
    // leaked token) is a password change or recovery reset, both of which bump
    // that counter; see the note on renew_if_stale in src/auth.rs.
    logout();
    wsClient.disconnect();
    // Module-level caches keyed to the SIGNED-IN user must be dropped here:
    // logout is local-only and never reloads the page, so anything left behind
    // bleeds into the next account signed in on this same running app.
    clearBlockedUsers();
    clearFileCache();   // object URLs stay readable to anything holding them
    // The reconnect catch-up's baselines are also per-account (its deliberate-
    // close listener covers this too — belt and braces, per the contract above).
    resetReconnectCatchup();
    setLoggedIn(false);
    setWsConnected(false);
    setConnectionError(null);
    retryCount.current = 0;
    navigate('/login');
  };

  // Session expiry (fixed-exp JWT, no refresh). Soft-expire: drop only the
  // token (NOT logout() — that wipes the E2EE identity; a mere
  // re-authentication must never risk the user's keys) and land on the login
  // screen with an explanation instead of silently-empty screens. Remember-me
  // usually signs straight back in without any typing.
  const expireSession = useCallback(() => {
    softExpireSession();
    wsClient.disconnect();
    setLoggedIn(false);
    setWsConnected(false);
    setConnectionError(null);
    retryCount.current = 0;
    // `replace`: re-expiring must not stack /login entries, or Back from the
    // login screen just lands on another login screen.
    navigate('/login', { state: { expired: true }, replace: true });
  }, [navigate]);

  // The API client dispatches 'auth-expired' ONCE when an authenticated
  // request 401s. Callers that detect expiry themselves call expireSession
  // directly rather than through this event — the signal is one-shot per
  // session, so a second expiry detected another way must not be swallowed.
  useEffect(() => {
    window.addEventListener('auth-expired', expireSession);
    return () => window.removeEventListener('auth-expired', expireSession);
  }, [expireSession]);

  // Desktop suspend / session-lock feed for the clip replay buffer: the buffer
  // must not survive a hibernation (RAM → hiberfil.sys). No-op off Tauri.
  useEffect(() => { void wireSystemSuspendHook(); }, []);

  // Clip consent protocol (docs/CLIPS.md): subscribe to the doorbell frames
  // once, and hand the protocol module a wiper so a declined / expired /
  // cancelled proposal drops the sealed clip from the worker exactly once
  // (with the token, so parts a partial upload already landed are DELETEd
  // too). The two modules never import each other (hostConsent.ts pattern).
  // And the reverse edge: EVERY disarm — leave voice, channel switch, system
  // suspend/lock, Chromium "Stop sharing", a fatal worker error — wipes the
  // sealed clip, so a request still waiting for votes (or approved but not yet
  // uploaded) must be withdrawn, or the approvers keep being asked about
  // footage that no longer exists.
  useEffect(() => {
    wireClipProposals();
    const unDiscard = setClipDiscardHandler(() => {
      const token = getToken();
      discardSeal(token ? { token, baseUrl: API_BASE_URL } : undefined);
    });
    const unArmed = onClipArmedChange((armed) => {
      if (armed) return;
      const out = getClipProposalState().outgoing;
      if (out && (out.status === 'pending' || out.status === 'approved')) {
        void cancelClip(out.clipId).catch(() => { /* the server-side TTL is the backstop */ });
      }
    });
    return () => { unDiscard(); unArmed(); };
  }, []);

  // Android background delivery follows the AUTH state, not just the setting:
  // signed out there is no socket, so the keep-alive service would pin the
  // process behind a "Connected" notification that is a lie. This effect owns
  // the boot-time push too (main.tsx only reconciles later toggle changes).
  useEffect(() => {
    const s = loadSettings();
    setNotifyKeepAlive(loggedIn && s.mobileBackgroundDelivery && s.mobileNotifications);
    // Location-reminder fences follow the auth state the same way: a signed-
    // out app must not keep a location watch running behind a notification
    // the user can no longer explain. This also owns the boot-time push of
    // the fence set into the native engine (deduped inside).
    setPlacesAuthed(loggedIn);
    // Push registration: bind the account + mirror the gates natively, then
    // register this device's FCM token with the server. Idempotent; degrades
    // to a no-op on old APKs, builds without Firebase, and non-Android.
    if (loggedIn) void initPushRegistration();
    // One-time battery-exemption ask, once signed in with delivery wanted:
    // Doze pauses a non-exempt app's network regardless of the foreground
    // service, so without this exemption screen-off delivery mostly fails —
    // the headline "notifications don't work" cause. The system dialog is
    // self-explanatory and has no denial lockout; asked once here, always
    // recoverable from Settings → Notifications (the health row). Skipped
    // when hidden: firing a permission dialog under a backgrounded app is
    // how permission asks get reflex-denied.
    let live = true;
    if (loggedIn && s.mobileBackgroundDelivery && s.mobileNotifications
        && document.visibilityState === 'visible'
        && !batteryAskInFlight
        && localStorage.getItem('batteryExemptAsked_v1') !== '1') {
      batteryAskInFlight = true;
      void mobileBatteryStatus()
        .then(b => {
          if (b === null || b.ignoring) return false;   // old APK, or already exempt
          // Re-validate at RESOLUTION time: the session may have soft-expired
          // (this effect fires on a stale stored token before expireSession
          // lands) and the app may have been backgrounded during the bridge
          // round-trip — a system dialog popping over the login screen or
          // under a backgrounded app is exactly the reflex-denial setup the
          // POST_NOTIFICATIONS boot ask taught us to avoid.
          if (!live || !getToken() || document.visibilityState !== 'visible') return false;
          if (localStorage.getItem('batteryExemptAsked_v1') === '1') return false;
          return requestIgnoreBatteryOptimizations();
        })
        .then(shown => {
          // The marker burns only once the dialog actually LAUNCHED — a ROM
          // that rejects the intent (or an old APK) keeps the ask for a day
          // when it can succeed, e.g. after the user updates the APK.
          if (shown) localStorage.setItem('batteryExemptAsked_v1', '1');
        })
        .finally(() => { batteryAskInFlight = false; });
    }
    return () => { live = false; };
  }, [loggedIn]);

  // Connect WebSocket on page load if already authenticated
  useEffect(() => {
    if (!loggedIn || wsConnected || connectionError) return;

    const token = getToken();
    if (!token) {
      // React state says signed in but the stored token is gone (cleared in
      // another tab, or storage wiped) — resync to the external source.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing to localStorage, not deriving state
      setLoggedIn(false);
      navigate('/login');
      return;
    }

    // A token we can SEE has expired will never open a socket, so don't burn
    // three attempts and strand the user on an error screen whose Retry is
    // equally doomed — go straight to re-authentication.
    if (isTokenExpired(token)) {
      console.warn('Stored session has expired — re-authenticating');
      expireSession();
      return;
    }

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const attemptConnection = async () => {
      if (cancelled) return;
      console.log(`Attempting WebSocket connection (attempt ${retryCount.current + 1}/${MAX_AUTO_RETRIES})...`);
      try {
        await wsClient.connect(token);
        if (cancelled) return;
        console.log('WebSocket connected successfully');
        setWsConnected(true);
        retryCount.current = 0;
      } catch (err) {
        if (cancelled) return;
        // NOTE: `err` is a bare DOM Event (logs as `{isTrusted:true}`). The
        // WebSocket API hides the HTTP status of a refused upgrade, so this
        // carries NO cause — a revoked token and a dead server look identical
        // here. Never report a reason based on it.
        console.error('Failed to connect WebSocket:', err);
        retryCount.current++;

        if (retryCount.current < MAX_AUTO_RETRIES) {
          console.log(`Retrying in ${RETRY_DELAY_MS}ms...`);
          retryTimer = setTimeout(attemptConnection, RETRY_DELAY_MS);
          return;
        }

        // Out of attempts: ask over HTTP what's actually wrong, because that
        // DOES expose the status code.
        const probe = await probeSession();
        if (cancelled) return;
        if (probe === 'rejected') {
          // The server is up and refused our token (expired, or revoked by a
          // password change / sign-out elsewhere). Retrying can never fix it.
          console.warn('Server rejected the stored session — re-authenticating');
          expireSession();
          return;
        }
        console.error(`Max retries reached (${probe}), showing error dialog`);
        setConnectionError(probe === 'ok' ? 'socket' : 'unreachable');
      }
    };

    attemptConnection();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [loggedIn, wsConnected, connectionError, navigate, expireSession]);

  const handleLoginSuccess = () => {
    resetAuthExpiredFlag(); // a later expiry must signal again
    setLoggedIn(true);
    setWsConnected(true);
    setConnectionError(null);
    retryCount.current = 0;
    navigate('/chat');
  };

  const handleRetry = () => {
    retryCount.current = 0;
    setConnectionError(null);
    setWsConnected(false);
  };

  const handleBackToLogin = () => {
    navigate('/login');
  };

  if (connectionError) {
    const unreachable = connectionError === 'unreachable';
    return (
      <div className="app loading">
        <div className="connection-error">
          <h2>{unreachable ? "Can't reach the server" : 'Live connection failed'}</h2>
          <p>
            {unreachable
              ? "Púca couldn't reach the server. Check your internet connection — if that's fine, the server may be restarting."
              : 'Your session is valid and the server is responding, but the live connection could not be opened. This usually clears by itself.'}
          </p>
          <p className="connection-error-hint">
            {unreachable
              ? 'Your messages and encryption keys are safe on this device.'
              : 'If it keeps happening, a firewall or proxy may be blocking WebSocket connections.'}
          </p>
          <div className="error-buttons">
            <button className="primary" onClick={handleRetry}>Try again</button>
            <button onClick={handleLogout}>Sign out</button>
          </div>
        </div>
      </div>
    );
  }

  // Show loading while WebSocket is connecting (only for chat route)
  if (loggedIn && !wsConnected && location.pathname === '/chat') {
    return (
      <div className="app loading">
        <div className="loading-spinner">Connecting...</div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={
        <PublicOnly>
          <Login onLoginSuccess={handleLoginSuccess} />
        </PublicOnly>
      } />

      <Route path="/reset-password" element={
        // Token is handled via prop, but URL param extraction is done above
        // Better to have ResetPassword read from useSearchParams internally, but keeping prop for now to minimize component changes
        <PublicOnly>
          <ResetPassword
            token={urlToken}
            onSuccess={handleBackToLogin}
            onBack={handleBackToLogin}
          />
        </PublicOnly>
      } />

      <Route path="/verify-email" element={
        <VerifyEmail
          token={urlToken}
          onSuccess={handleBackToLogin}
        />
      } />

      {/* Where an invite link lands. Stashes the code and sends the visitor
          to sign in or straight into the join flow (InviteLanding). */}
      <Route path="/invite/:code" element={<InviteLanding />} />

      <Route path="/chat" element={
        <RequireAuth>
          <div className="app">
            <UpdateBanner />
            <IdentityBanner onSignOut={handleLogout} />
            <HotkeyBlockedBanner />
            <RecoveryCodeModal />
            <ClipApprovalPrompt />
            <RcGlobals />
            <Chat onLogout={handleLogout} />
          </div>
        </RequireAuth>
      } />

      {/* Redirects */}
      <Route path="/" element={<Navigate to={isAuthenticated() ? "/chat" : "/login"} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
