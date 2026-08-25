import { useState, useEffect } from 'react';
import { getActiveIdentity, computeSafetyNumber } from '../api/e2ee';
import { getCachedPublicKey } from '../api/dms';
import { getVerificationState, markVerified, clearVerified, type VerificationState } from '../api/keyVerification';
import { ShieldCheckIcon, CheckIcon, CloseIcon, WarningIcon } from './Icons';
import './SafetyNumberModal.css';

interface SafetyNumberModalProps {
    userId: number;
    username: string;
    onClose: () => void;
}

/**
 * Out-of-band identity verification. Shows a safety number both people can read
 * to each other over a trusted channel (voice call, in person). Matching numbers
 * prove no server-in-the-middle swapped either identity key.
 */
export function SafetyNumberModal({ userId, username, onClose }: SafetyNumberModalProps) {
    const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
    const [theirKey, setTheirKey] = useState<string | null>(null);
    const [state, setState] = useState<VerificationState>('unverified');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const me = getActiveIdentity();
            const their = await getCachedPublicKey(userId);
            if (cancelled) return;
            if (!me || !their) {
                setError(!me ? 'Your encryption identity is unavailable — sign in again.'
                    : `${username} has no encryption key yet.`);
                setLoading(false);
                return;
            }
            setTheirKey(their);
            setSafetyNumber(computeSafetyNumber(me.publicKeyEncoded, their));
            setState(getVerificationState(userId, their));
            setLoading(false);
        })();
        return () => { cancelled = true; };
    }, [userId, username]);

    const handleVerify = () => {
        if (!theirKey) return;
        markVerified(userId, theirKey);
        setState('verified');
    };
    const handleUnverify = () => {
        clearVerified(userId);
        setState('unverified');
    };

    return (
        <div className="safety-overlay" onClick={onClose}>
            <div className="safety-modal" onClick={(e) => e.stopPropagation()}>
                <div className="safety-header">
                    <h3><ShieldCheckIcon /> Verify {username}</h3>
                    <button className="safety-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                </div>

                {loading ? (
                    <div className="safety-body"><p>Loading…</p></div>
                ) : error ? (
                    <div className="safety-body"><p className="safety-error">{error}</p></div>
                ) : (
                    <div className="safety-body">
                        {state === 'verified' && (
                            <div className="safety-badge verified"><CheckIcon /> Verified — this key matches what you confirmed.</div>
                        )}
                        {state === 'changed' && (
                            <div className="safety-badge changed">
                                <WarningIcon /> This key has CHANGED since you verified it. Only re-verify if {username} reset their
                                account — otherwise it may be an impostor.
                            </div>
                        )}

                        <p className="safety-intro">
                            Compare this number with {username} over a channel you trust (say it aloud on a call, or
                            check in person). If both of you see the <strong>same</strong> number, no one is
                            intercepting your encrypted messages or screen control.
                        </p>

                        <div className="safety-number">
                            {safetyNumber
                                ? safetyNumber.split(' ').map((g, i) => <span key={i} className="safety-group">{g}</span>)
                                : <span className="safety-error">Could not compute — a key is invalid.</span>}
                        </div>

                        <div className="safety-actions">
                            {state === 'verified' ? (
                                <button className="safety-btn ghost" onClick={handleUnverify}>Remove verification</button>
                            ) : (
                                <button className="safety-btn primary" onClick={handleVerify} disabled={!safetyNumber}>
                                    They match — mark verified
                                </button>
                            )}
                            <button className="safety-btn ghost" onClick={onClose}>Close</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
