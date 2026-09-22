/**
 * Notes' sign-in — the same SRP login and E2EE identity restore as Púca's
 * (api/auth.ts login()), in a card that reuses Login.css.
 *
 * Its own form rather than Púca's <Login>, for one reason: that component
 * opens the WebSocket on success, and Notes must never open one (a bare socket
 * consumes parked file offers meant for the chat app — see
 * model/notesQueries.ts). Everything that is NOT plain sign-in — registration,
 * password reset, account recovery, invite codes — stays in Púca, which the
 * card links to. Notes shares the sign-in; it does not duplicate the account
 * flows.
 */
import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { login, RetiredKeyFormatError, STAY_SIGNED_IN_KEY } from '../../api/auth';
import { isNetworkError } from '../../api/client';
import { isMobile } from '../../api/platform';
import '../../components/Login.css';

/** In the Notes Android shell, "Púca" is the separate Púca app, not a link. */
const NATIVE = isMobile();

interface NotesLoginProps {
    onSuccess: () => void;
}

/** This device's answer to "stay signed in". Absent means yes: the box is
 *  ticked by default, and only an explicit 'false' turns it off. Storage can
 *  throw (a locked-down profile), and a checkbox is not worth a blank screen —
 *  fall back to the default. */
function readStaySignedIn(): boolean {
    try {
        return localStorage.getItem(STAY_SIGNED_IN_KEY) !== 'false';
    } catch {
        return true;
    }
}

export function NotesLogin({ onSuccess }: NotesLoginProps) {
    const location = useLocation();
    const expired = !!(location.state as { expired?: boolean } | null)?.expired;
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [stay, setStay] = useState(readStaySignedIn);

    /** Remember the choice on the DEVICE, as soon as it is made — not on a
     *  successful sign-in. Someone who unticks the box and then mistypes their
     *  password should not have to untick it again. */
    const chooseStay = (next: boolean) => {
        setStay(next);
        try {
            localStorage.setItem(STAY_SIGNED_IN_KEY, next ? 'true' : 'false');
        } catch { /* a profile that refuses storage still gets the session it asked for */ }
    };

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setError('');
        setBusy(true);
        try {
            await login(username.trim(), password, { staySignedIn: stay });
            setPassword('');
            onSuccess();
        } catch (err) {
            if (err instanceof RetiredKeyFormatError) {
                setError(err.message);
            } else if (isNetworkError(err)) {
                setError("Can't reach the server. Check your connection and try again.");
            } else {
                const status = (err as { status?: number } | null)?.status;
                if (status === 401) setError('Invalid username or password.');
                else if (status === 403) setError('This account needs a password update first — sign in to Púca to do that.');
                else setError(err instanceof Error && err.message ? err.message : 'Sign-in failed.');
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="login-container">
            <div className="login-card">
                <h1 className="login-title">Púca Notes</h1>
                <p className="login-subtitle">Notes and checklists from your Púca account</p>
                {expired && (
                    <p className="login-message">Your session expired. Sign in again to continue — your notes and keys are safe on this device. Tick Stay signed in to avoid this.</p>
                )}
                <form className="login-form" onSubmit={submit}>
                    <div className="form-group">
                        <label htmlFor="username">Username</label>
                        <input
                            id="username"
                            type="text"
                            autoComplete="username"
                            autoCapitalize="none"
                            autoCorrect="off"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            required
                            disabled={busy}
                        />
                    </div>
                    <div className="form-group">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            required
                            disabled={busy}
                        />
                    </div>
                    <div className="form-group notes-stay">
                        <label className="checkbox-label notes-stay-row" htmlFor="stay-signed-in">
                            <input
                                id="stay-signed-in"
                                type="checkbox"
                                checked={stay}
                                onChange={e => chooseStay(e.target.checked)}
                                disabled={busy}
                                aria-describedby="stay-signed-in-hint"
                            />
                            <span className="checkbox-text">Stay signed in on this device</span>
                        </label>
                        <p className="notes-stay-hint" id="stay-signed-in-hint">
                            Your session on this device then lasts up to a year without a check-in, instead of a
                            day. Sign out to end it early.
                        </p>
                    </div>
                    {error && <div className="error-message" role="alert">{error}</div>}
                    <button type="submit" className="login-button" disabled={busy || !username.trim() || !password}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>
                <p className="notes-login-note">
                    Notes uses your Púca sign-in. Need an account, forgot your password, or have a recovery
                    code? Do that in {NATIVE ? 'the Púca app' : <a href="/">Púca</a>}, then come back here.
                </p>
            </div>
        </div>
    );
}
