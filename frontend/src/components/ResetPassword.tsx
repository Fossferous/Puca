import { useState, useEffect } from 'react';
import { validateResetToken, resetPassword } from '../api/email';
import { generateVerifierForReset } from '../api/auth';
import { CheckCircleIcon } from './Icons';
import './Login.css';

interface ResetPasswordProps {
    token: string;
    onSuccess: () => void;
    onBack: () => void;
}

export default function ResetPassword({ token, onSuccess, onBack }: ResetPasswordProps) {
    const [status, setStatus] = useState<'validating' | 'valid' | 'invalid' | 'loading' | 'success' | 'error'>('validating');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [message, setMessage] = useState('');

    useEffect(() => {
        if (!token) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- initial token validation on mount
            setStatus('invalid');
            setMessage('No reset token provided');
            return;
        }

        validateResetToken(token)
            .then((response) => {
                if (response.valid && response.username) {
                    setStatus('valid');
                    setUsername(response.username);
                } else {
                    setStatus('invalid');
                    setMessage(response.message || 'Invalid or expired token');
                }
            })
            .catch((err) => {
                setStatus('invalid');
                setMessage(err instanceof Error ? err.message : 'Failed to validate token');
            });
    }, [token]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (password !== confirmPassword) {
            setMessage('Passwords do not match');
            return;
        }

        if (password.length < 8) {
            setMessage('Password must be at least 8 characters');
            return;
        }

        setStatus('loading');
        setMessage('');

        try {
            // Generate new SRP credentials
            const { salt, verifier, srp_version } = await generateVerifierForReset(username, password);

            await resetPassword(token, username, salt, verifier, srp_version);
            setStatus('success');
            setMessage('Password reset successfully! You can now log in with your new password.');
        } catch (err) {
            setStatus('error');
            setMessage(err instanceof Error ? err.message : 'Failed to reset password');
        }
    };

    if (status === 'validating') {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Reset Password</h1>
                    <div className="loading-spinner">Validating reset link...</div>
                </div>
            </div>
        );
    }

    if (status === 'invalid') {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Invalid Link</h1>
                    <div className="error-message">{message}</div>
                    <button className="login-button" onClick={onBack}>
                        Back to Login
                    </button>
                </div>
            </div>
        );
    }

    if (status === 'success') {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Password Reset</h1>
                    <div className="success-message">
                        <div className="success-icon"><CheckCircleIcon size={48} /></div>
                        <p>{message}</p>
                        <button className="login-button" onClick={onSuccess}>
                            Go to Login
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="login-container">
            <div className="login-card">
                <h1 className="login-title">Reset Password</h1>
                <p className="login-subtitle">
                    Create a new password for <strong>{username}</strong>
                </p>

                <form onSubmit={handleSubmit} className="login-form">
                    <div className="form-group">
                        <label htmlFor="password">New Password</label>
                        <input
                            type="password"
                            id="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="Enter new password"
                            disabled={status === 'loading'}
                            minLength={8}
                            autoFocus
                        />
                    </div>

                    <div className="form-group">
                        <label htmlFor="confirmPassword">Confirm Password</label>
                        <input
                            type="password"
                            id="confirmPassword"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            placeholder="Confirm new password"
                            disabled={status === 'loading'}
                            minLength={8}
                        />
                    </div>

                    {(status === 'error' || message) && (
                        <div className="error-message">{message}</div>
                    )}

                    <button
                        type="submit"
                        className="login-button"
                        disabled={status === 'loading'}
                    >
                        {status === 'loading' ? 'Resetting...' : 'Reset Password'}
                    </button>

                    <button
                        type="button"
                        className="toggle-mode"
                        onClick={onBack}
                        disabled={status === 'loading'}
                    >
                        Cancel
                    </button>
                </form>
            </div>
        </div>
    );
}
