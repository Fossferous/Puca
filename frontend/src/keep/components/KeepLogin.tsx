/**
 * Keep's sign-in — the same SRP login and E2EE identity restore as Púca's
 * (api/auth.ts login()), in a card that reuses Login.css.
 *
 * Its own form rather than Púca's <Login>, for one reason: that component
 * opens the WebSocket on success, and Keep must never open one (a bare socket
 * consumes parked file offers meant for the chat app — see
 * model/notesQueries.ts). Everything that is NOT plain sign-in — registration,
 * password reset, account recovery, invite codes — stays in Púca, which the
 * card links to. Keep shares the sign-in; it does not duplicate the account
 * flows.
 */
import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { login, RetiredKeyFormatError } from '../../api/auth';
import { isNetworkError } from '../../api/client';
import '../../components/Login.css';

interface KeepLoginProps {
    onSuccess: () => void;
}

export function KeepLogin({ onSuccess }: KeepLoginProps) {
    const location = useLocation();
    const expired = !!(location.state as { expired?: boolean } | null)?.expired;
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);

    const submit = async (e: FormEvent) => {
        e.preventDefault();
        if (busy) return;
        setError('');
        setBusy(true);
        try {
            await login(username.trim(), password);
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
                <h1 className="login-title">Púca Keep</h1>
                <p className="login-subtitle">Notes and checklists from your Púca account</p>
                {expired && (
                    <p className="login-message">Your session expired. Sign in again to continue — your notes and keys are safe on this device.</p>
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
                    {error && <div className="error-message" role="alert">{error}</div>}
                    <button type="submit" className="login-button" disabled={busy || !username.trim() || !password}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>
                <p className="keep-login-note">
                    Keep uses your Púca sign-in. Need an account, forgot your password, or have a recovery
                    code? Do that in <a href="/">Púca</a>, then come back here.
                </p>
            </div>
        </div>
    );
}
