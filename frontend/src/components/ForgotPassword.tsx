import { useState } from 'react';
import { forgotPassword } from '../api/email';
import { MailIcon } from './Icons';
import './Login.css';

interface ForgotPasswordProps {
    onBack: () => void;
}

export default function ForgotPassword({ onBack }: ForgotPasswordProps) {
    const [email, setEmail] = useState('');
    const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
    const [message, setMessage] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!email.trim()) {
            setStatus('error');
            setMessage('Please enter your email address');
            return;
        }

        setStatus('loading');
        setMessage('');

        try {
            const response = await forgotPassword(email);
            setStatus('success');
            setMessage(response.message);
        } catch (err) {
            setStatus('error');
            setMessage(err instanceof Error ? err.message : 'An error occurred');
        }
    };

    return (
        <div className="login-container">
            <div className="login-box">
                <h1 className="login-title">Reset Password</h1>
                <p className="login-subtitle">
                    Enter your email address and we'll send you a link to reset your password.
                </p>

                {status === 'success' ? (
                    <div className="success-message">
                        <div className="success-icon"><MailIcon size={48} /></div>
                        <p>{message}</p>
                        <button className="btn-primary" onClick={onBack}>
                            Back to Login
                        </button>
                    </div>
                ) : (
                    <form onSubmit={handleSubmit}>
                        <div className="form-group">
                            <label htmlFor="email">Email Address</label>
                            <input
                                type="email"
                                id="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Enter your email"
                                disabled={status === 'loading'}
                                autoFocus
                            />
                        </div>

                        {status === 'error' && (
                            <div className="error-message">{message}</div>
                        )}

                        <button
                            type="submit"
                            className="btn-primary"
                            disabled={status === 'loading'}
                        >
                            {status === 'loading' ? 'Sending...' : 'Send Reset Link'}
                        </button>

                        <button
                            type="button"
                            className="btn-secondary"
                            onClick={onBack}
                            disabled={status === 'loading'}
                        >
                            Back to Login
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
