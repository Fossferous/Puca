import { useState, useEffect } from 'react';
import { verifyEmail } from '../api/email';
import { CheckCircleIcon } from './Icons';
import './Login.css';

interface VerifyEmailProps {
    token: string;
    onSuccess: () => void;
}

export default function VerifyEmail({ token, onSuccess }: VerifyEmailProps) {
    const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
    const [message, setMessage] = useState('');

    useEffect(() => {
        if (!token) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- initial token validation on mount
            setStatus('error');
            setMessage('No verification token provided');
            return;
        }

        verifyEmail(token)
            .then((response) => {
                setStatus('success');
                setMessage(response.message);
            })
            .catch((err) => {
                setStatus('error');
                setMessage(err instanceof Error ? err.message : 'Failed to verify email');
            });
    }, [token]);

    if (status === 'verifying') {
        return (
            <div className="login-container">
                <div className="login-card">
                    <h1 className="login-title">Verifying Email</h1>
                    <div className="loading-spinner">Please wait...</div>
                </div>
            </div>
        );
    }

    return (
        <div className="login-container">
            <div className="login-card">
                <h1 className="login-title">
                    {status === 'success' ? 'Email Verified!' : 'Verification Failed'}
                </h1>

                <div className={status === 'success' ? 'success-message' : 'error-message'}>
                    {status === 'success' && <div className="success-icon"><CheckCircleIcon size={48} /></div>}
                    <p>{message}</p>
                </div>

                <button className="login-button" onClick={onSuccess}>
                    {status === 'success' ? 'Continue to App' : 'Back to Login'}
                </button>
            </div>
        </div>
    );
}
