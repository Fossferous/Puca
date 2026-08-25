/**
 * Shows a freshly-generated recovery phrase exactly once (after registration or
 * the v2→v3 login migration). Acknowledge-gated: the only way to close is to
 * confirm you've saved it. Deliberately not persisted anywhere.
 */
import { useEffect, useState } from 'react';
import { consumePendingRecoveryCode } from '../api/recoveryPrompt';
import { KeyIcon, CheckIcon, CopyIcon } from './Icons';
import './RecoveryCodeModal.css';

export function RecoveryCodeModal() {
    const [code, setCode] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirmed, setConfirmed] = useState(false);

    useEffect(() => {
        // Poll briefly for a stashed code (register/migration set it during login).
        const pick = () => {
            const c = consumePendingRecoveryCode();
            if (c) setCode(c);
        };
        pick();
        const t = setInterval(pick, 1000);
        return () => clearInterval(t);
    }, []);

    if (!code) return null;

    const words = code.trim().split(/\s+/);

    return (
        <div className="recovery-modal-overlay">
            <div className="recovery-modal">
                <h2><KeyIcon /> Save your recovery code</h2>
                <p className="recovery-intro">
                    This is the <strong>only</strong> way to reset your password without losing your
                    encrypted messages. Write it down and keep it somewhere safe — it won't be shown again,
                    and no one (not even the server) can recover it for you.
                </p>

                <div className="recovery-words">
                    {words.map((w, i) => (
                        <span className="recovery-word" key={i}>
                            <span className="recovery-word-num">{i + 1}</span>{w}
                        </span>
                    ))}
                </div>

                <button
                    className="recovery-copy-btn"
                    onClick={async () => {
                        try {
                            await navigator.clipboard.writeText(code);
                            setCopied(true);
                            setTimeout(() => setCopied(false), 2000);
                        } catch { /* clipboard blocked; user can transcribe */ }
                    }}
                >
                    {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy to clipboard</>}
                </button>

                <label className="recovery-confirm">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    I've written down or saved my recovery code.
                </label>

                <button
                    className="recovery-done-btn"
                    disabled={!confirmed}
                    onClick={() => setCode(null)}
                >
                    Done
                </button>
            </div>
        </div>
    );
}
