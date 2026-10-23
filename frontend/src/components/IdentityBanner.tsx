/**
 * "Encryption keys unavailable" — shown when sign-in succeeded but the E2EE
 * identity could not be restored (GET /keys/wrap failed, or the seed did not
 * unwrap).
 *
 * login() deliberately keeps the session in that case: dropping it on a
 * flaky request would be worse. But until 0.9.2 it kept it SILENTLY — the
 * user found out when a send was refused, and channel views simply showed
 * nothing decryptable. This makes the state visible and gives it a way out:
 * retry with the password (the seed unwrap needs it), or sign in again.
 *
 * Driven by auth.ts's persisted marker, not by `getActiveIdentity() === null`:
 * the identity is set asynchronously during login, and a naive null check
 * would flash this on every normal sign-in for the seconds before the unwrap
 * completes.
 */
import { useEffect, useState } from 'react';
import {
    identityRestoreFailed,
    identityRestoreReason,
    onIdentityRestoreChange,
    retryIdentityRestore,
} from '../api/auth';
import { KeyIcon, CloseIcon } from './Icons';
import './IdentityBanner.css';

interface IdentityBannerProps {
    /** Full sign-out: the fallback when the password retry does not help. */
    onSignOut: () => void;
}

export function IdentityBanner({ onSignOut }: IdentityBannerProps) {
    const [failed, setFailed] = useState(identityRestoreFailed);
    const [reason, setReason] = useState(identityRestoreReason);
    const [dismissed, setDismissed] = useState(false);
    const [asking, setAsking] = useState(false);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => onIdentityRestoreChange(() => {
        setFailed(identityRestoreFailed());
        setReason(identityRestoreReason());
        setDismissed(false);
    }), []);

    if (!failed || dismissed) return null;

    const retry = async () => {
        if (!password || busy) return;
        setBusy(true);
        setError('');
        try {
            await retryIdentityRestore(password);
            setPassword('');
            setAsking(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not restore your keys.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="identity-banner" role="alert">
            <div className="identity-banner-main">
                <span className="identity-banner-icon"><KeyIcon /></span>
                {reason === 'key-mismatch' ? (
                    // The sign-in check (auth.ts checkPublishedOwnKey) refused
                    // the key: the server publishes a different one for this
                    // account, and that is what others encrypt to.
                    <div className="identity-banner-text">
                        <strong>Your encryption key is not the one this server publishes for you.</strong>
                        <span> Púca did not use it, so messages can't be sent or read here. People who start a conversation with you may be encrypting to a key that isn't yours: tell the server's owner.</span>
                    </div>
                ) : (
                    <div className="identity-banner-text">
                        <strong>Encryption keys unavailable.</strong>
                        <span> Messages can't be sent or read until they are restored.</span>
                    </div>
                )}
                <div className="identity-banner-actions">
                    {!asking && (
                        <button className="identity-banner-btn primary" onClick={() => setAsking(true)}>Retry</button>
                    )}
                    <button className="identity-banner-btn" onClick={onSignOut}>Sign in again</button>
                    <button className="identity-banner-dismiss" aria-label="Dismiss" onClick={() => setDismissed(true)}>
                        <CloseIcon size={16} />
                    </button>
                </div>
            </div>
            {asking && (
                <form
                    className="identity-banner-form"
                    onSubmit={e => { e.preventDefault(); void retry(); }}
                >
                    <input
                        type="password"
                        placeholder="Your password (needed to unlock the keys)"
                        value={password}
                        autoComplete="current-password"
                        onChange={e => setPassword(e.target.value)}
                        disabled={busy}
                    />
                    <button type="submit" className="identity-banner-btn primary" disabled={busy || !password}>
                        {busy ? 'Restoring…' : 'Restore keys'}
                    </button>
                    {error && <span className="identity-banner-error">{error}</span>}
                </form>
            )}
        </div>
    );
}
