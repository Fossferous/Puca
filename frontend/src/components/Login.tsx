import { useState, useEffect, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { login, register, resetPasswordMigration, REMEMBER_ME_KEY } from '../api/auth';
import { wsClient } from '../api/websocket';
import { isTauri, isMobile } from '../api/platform';
import { fetchPublicConfig } from '../api/publicConfig';
import { peekPendingInvite } from '../api/pendingInvite';
import './Login.css';

interface LoginProps {
    onLoginSuccess: () => void;
}

// NOTE: "remember me" no longer stores the password. It used to base64 the
// account password into localStorage — which is not obfuscation against the
// real threat (any XSS, or an Android cloud/adb backup, could read it back),
// and that password DERIVES the E2EE identity, so a leak was catastrophic. The
// auth token already persists in localStorage and slides for up to 30 days
// (see auth.ts), so the session survives restarts WITHOUT re-holding the
// password. On mount we also proactively DELETE any password blob a prior
// version left behind. Single source of truth for the key lives in api/auth.ts
// so logout() clears the same one.
const CREDENTIALS_KEY = REMEMBER_ME_KEY;

export function Login({ onLoginSuccess }: LoginProps) {
    // Set when App soft-expired the session (expired JWT) — explains WHY the
    // user is suddenly looking at the login screen. Auto-login (remember-me)
    // still runs and usually renews the session without any typing.
    const location = useLocation();
    const sessionExpired = !!(location.state as { expired?: boolean } | null)?.expired;
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [isRegistering, setIsRegistering] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const [autoLoginAttempted, setAutoLoginAttempted] = useState(false);
    // Does THIS server gate sign-up behind an invite code? From GET /config.
    // null = not known yet, or the probe failed (an older server): then the
    // field is SHOWN — a wrongly hidden field makes registration impossible,
    // a wrongly shown one is only noise. Until 0.9.2 it was always shown,
    // labelled "Required to sign up", on every open-registration server.
    const [inviteRequired, setInviteRequired] = useState<boolean | null>(null);
    // An invite link brought the visitor here: say so, and carry it through.
    const pendingInvite = peekPendingInvite();

    // Password reset state
    const [showResetForm, setShowResetForm] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [successMessage, setSuccessMessage] = useState('');

    // Recovery-code reset state
    const [showRecoveryForm, setShowRecoveryForm] = useState(false);
    const [recoveryCodeInput, setRecoveryCodeInput] = useState('');

    const handleRecoverySubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        if (newPassword !== confirmPassword) { setError('Passwords do not match'); return; }
        if (newPassword.length < 8) { setError('Password must be at least 8 characters'); return; }
        setLoading(true);
        try {
            const { recoverWithCode } = await import('../api/auth');
            await recoverWithCode(username.trim(), recoveryCodeInput.trim(), newPassword);
            setSuccessMessage('Password reset — your message history is intact. Log in with your new password.');
            setShowRecoveryForm(false);
            setRecoveryCodeInput('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Recovery failed. Check the username and recovery code.');
        } finally {
            setLoading(false);
        }
    };

    // On mount, migrate away from the old insecure "remember me": delete any
    // password blob a prior version stored. Session persistence is now carried
    // entirely by the sliding auth token (App decides logged-in state from it),
    // so there is no password to read back and auto-login with — and nothing
    // sensitive is left sitting in localStorage / device backups.
    useEffect(() => {
        try {
            localStorage.removeItem(CREDENTIALS_KEY);
        } catch {
            /* storage unavailable — nothing to clean up */
        }
        setAutoLoginAttempted(true);
    }, []);

    useEffect(() => {
        if (!isRegistering) return;
        let live = true;
        void fetchPublicConfig().then(c => { if (live) setInviteRequired(c.registrationInviteRequired); });
        return () => { live = false; };
    }, [isRegistering]);

    const handleResetPassword = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');

        if (newPassword !== confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (newPassword.length < 8) {
            setError('Password must be at least 8 characters');
            return;
        }

        setLoading(true);
        try {
            await resetPasswordMigration(username, newPassword);
            setSuccessMessage('Password reset successful! Please login with your new password.');
            setShowResetForm(false);
            setPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch (err) {
            if (err instanceof Error) {
                setError(err.message || 'Password reset failed');
            } else {
                setError('Password reset failed');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');
        setSuccessMessage('');
        setLoading(true);

        try {
            if (isRegistering) {
                // Register new user (invite code required only when the server
                // has closed registration).
                await register(username, password, inviteCode);
                setError('');
                setIsRegistering(false);
                // Auto-login after registration
                const token = await login(username, password);
                // Session persistence rides on the sliding auth token now — no
                // password is ever written to storage (see the note above).
                await wsClient.connect(token);
                onLoginSuccess();
            } else {
                // Login existing user
                const token = await login(username, password);
                // No password is written to storage; the sliding auth token
                // carries the session. Clear any legacy blob defensively.
                localStorage.removeItem(CREDENTIALS_KEY);
                await wsClient.connect(token);
                onLoginSuccess();
            }
        } catch (err) {
            if (err instanceof Error) {
                // Check for status property (set by auth.ts for fetch errors)
                const fetchError = err as Error & { status?: number };

                if (fetchError.status === 403) {
                    // Password reset required (case-insensitive login migration)
                    setShowResetForm(true);
                    setError('Security Update: Please set a new password for your account.');
                } else if (fetchError.status === 401) {
                    setError('Invalid username or password');
                } else {
                    setError(err.message || 'Login failed');
                }
            } else {
                setError(isRegistering ? 'Registration failed' : 'Login failed');
            }
        } finally {
            setLoading(false);
        }
    };

    // Show loading state during auto-login attempt
    if (!autoLoginAttempted && loading && !showResetForm) {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Púca</h1>
                    <p className="login-subtitle">Logging in...</p>
                    <div className="auto-login-spinner"></div>
                </div>
            </div>
        );
    }

    if (showRecoveryForm) {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Recover Account</h1>
                    <p className="login-subtitle">Reset with your recovery code</p>
                    <p className="login-message">
                        Enter your username, the 12-word recovery code you saved when you signed up, and a
                        new password. Your encrypted message history stays intact.
                    </p>

                    <form onSubmit={handleRecoverySubmit} className="login-form">
                        <div className="form-group">
                            <label htmlFor="rec-username">Username</label>
                            <input id="rec-username" type="text" value={username}
                                onChange={(e) => setUsername(e.target.value)} placeholder="Your username"
                                required disabled={loading} autoComplete="username" />
                        </div>
                        <div className="form-group">
                            <label htmlFor="rec-code">Recovery code (12 words)</label>
                            <textarea id="rec-code" value={recoveryCodeInput}
                                onChange={(e) => setRecoveryCodeInput(e.target.value)}
                                placeholder="word1 word2 word3 …" rows={3} required disabled={loading}
                                style={{ resize: 'vertical', fontFamily: 'ui-monospace, monospace' }} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="rec-new">New Password</label>
                            <input id="rec-new" type="password" value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                placeholder="New password (min 8 chars)" required minLength={8} disabled={loading} />
                        </div>
                        <div className="form-group">
                            <label htmlFor="rec-confirm">Confirm Password</label>
                            <input id="rec-confirm" type="password" value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="Confirm new password" required minLength={8} disabled={loading} />
                        </div>

                        {error && <div className="error-message">{error}</div>}
                        {successMessage && <div className="success-message">{successMessage}</div>}

                        <button type="submit" className="login-button" disabled={loading}>
                            {loading ? 'Recovering…' : 'Reset Password'}
                        </button>
                        <button type="button" className="cancel-button"
                            onClick={() => { setShowRecoveryForm(false); setError(''); }}
                            disabled={loading}
                            style={{ background: 'transparent', border: 'none', color: '#b9bbbe', marginTop: '10px', cursor: 'pointer', textDecoration: 'underline' }}>
                            Back to login
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    if (showResetForm) {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Reset Password</h1>
                    <p className="login-subtitle">Security Update Required</p>
                    <p className="login-message">
                        Due to a security update for username handling, your account <strong>{username}</strong> requires a password reset.
                        Please verify your identity by setting a new password.
                    </p>

                    <form onSubmit={handleResetPassword} className="login-form">
                        <div className="form-group">
                            <label htmlFor="new-password">New Password</label>
                            <input
                                id="new-password"
                                type="password"
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                placeholder="Enter new password (min 8 chars)"
                                required
                                minLength={8}
                                disabled={loading}
                            />
                        </div>

                        <div className="form-group">
                            <label htmlFor="confirm-password">Confirm Password</label>
                            <input
                                id="confirm-password"
                                type="password"
                                value={confirmPassword}
                                onChange={(e) => setConfirmPassword(e.target.value)}
                                placeholder="Confirm new password"
                                required
                                minLength={8}
                                disabled={loading}
                            />
                        </div>

                        {error && <div className="error-message">{error}</div>}

                        <button type="submit" className="login-button" disabled={loading}>
                            {loading ? 'Resetting...' : 'Set New Password'}
                        </button>

                        <button
                            type="button"
                            className="cancel-button"
                            onClick={() => setShowResetForm(false)}
                            disabled={loading}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#b9bbbe',
                                marginTop: '10px',
                                cursor: 'pointer',
                                textDecoration: 'underline'
                            }}
                        >
                            Cancel
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    return (
        <div className="login-container">
            <div className="login-card">
                <h1 className="login-title">Púca</h1>
                <p className="login-subtitle">Self-Hosted Communication</p>

                {pendingInvite && (
                    <p className="login-message login-invite-note">
                        You've been invited to a server. {isRegistering ? 'Create an account' : 'Sign in'} and
                        you'll be taken straight to it.
                    </p>
                )}

                {/*
                  * Browser only, and shown BEFORE the password field.
                  *
                  * In a browser the operator of this server also serves the
                  * JavaScript that performs the encryption, on every page load.
                  * That makes end-to-end encryption a promise about the operator
                  * rather than a property of the maths: they could serve one
                  * person a modified bundle and take their seed, and nothing —
                  * not the browser, not this app, not a checksum — would show it.
                  * Subresource Integrity cannot fix it, because the hash would be
                  * served by the same host as the script.
                  *
                  * docs/SECURITY_MODEL.md has said this plainly for a long time.
                  * The problem was placement: the person it concerns arrives via
                  * an invite link and never reads a repository. The desktop app
                  * loads its own bundled code and is not affected, which is why
                  * the notice says so rather than just warning.
                  */}
                {!isTauri() && !isMobile() && (
                    <p className="login-trust-note">
                        You are using Púca in a browser, so this server sends your browser the code
                        that encrypts your messages — every time you open it. That means its operator
                        <em> could</em> read what you send here if they chose to. The desktop app
                        ships its own code and is not affected.{' '}
                        <a
                            href="https://github.com/Fossferous/Puca/blob/main/docs/SECURITY_MODEL.md"
                            target="_blank"
                            rel="noopener noreferrer"
                        >
                            What this does and does not protect
                        </a>
                    </p>
                )}

                {successMessage && <div className="success-message" style={{ color: '#43b581', marginBottom: '15px', padding: '10px', background: 'rgba(67, 181, 129, 0.1)', borderRadius: '4px' }}>{successMessage}</div>}

                <form onSubmit={handleSubmit} className="login-form">
                    <div className="form-group">
                        <label htmlFor="username">Username</label>
                        <input
                            id="username"
                            type="text"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            placeholder="Enter username"
                            required
                            disabled={loading}
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter password"
                            required
                            disabled={loading}
                        />
                    </div>

                    {isRegistering && inviteRequired !== false && (
                        <div className="form-group">
                            <label htmlFor="inviteCode">
                                {inviteRequired ? 'Invite code' : 'Invite code (only if this server requires one)'}
                            </label>
                            <input
                                id="inviteCode"
                                type="text"
                                value={inviteCode}
                                onChange={(e) => setInviteCode(e.target.value)}
                                placeholder={inviteRequired ? 'From your server admin' : 'Leave blank unless you were given one'}
                                autoComplete="off"
                                required={inviteRequired === true}
                                disabled={loading}
                            />
                        </div>
                    )}

                    {sessionExpired && !error && (
                        <div className="error-message">Your session expired — please sign in again.</div>
                    )}
                    {error && <div className="error-message">{error}</div>}

                    <button type="submit" className="login-button" disabled={loading}>
                        {loading ? 'Please wait...' : isRegistering ? 'Create Account' : 'Login'}
                    </button>
                </form>

                <div className="login-footer">
                    <button
                        type="button"
                        className="toggle-mode"
                        onClick={() => {
                            setIsRegistering(!isRegistering);
                            setError('');
                            setSuccessMessage('');
                        }}
                        disabled={loading}
                    >
                        {isRegistering ? 'Already have an account? Login' : "Don't have an account? Register"}
                    </button>
                    {!isRegistering && (
                        <button
                            type="button"
                            className="forgot-password-link"
                            style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                            onClick={() => { setShowRecoveryForm(true); setError(''); setSuccessMessage(''); }}
                        >
                            Forgot your password? Use your recovery code
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
