/**
 * Shows a freshly-generated recovery phrase exactly once (after registration
 * or Settings' "Regenerate recovery code"). Acknowledge-gated: the only way to
 * close is to confirm you've saved it. Deliberately not persisted anywhere.
 *
 * Second job: if a phrase was generated on this device and the confirmation
 * never happened — the app reloaded first — say so, and point at where a
 * new one comes from. The phrase itself is gone by design; this is the
 * "second chance" that did not exist before 0.9.2.
 */
import { useEffect, useRef, useState } from 'react';
import {
    acknowledgeRecoveryCode,
    consumePendingRecoveryCode,
    recoveryCodeReminderDue,
    snoozeRecoveryCodeReminder,
} from '../api/recoveryPrompt';
import { KeyIcon, CheckIcon, CopyIcon } from './Icons';
import './RecoveryCodeModal.css';

export function RecoveryCodeModal() {
    const [code, setCode] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    const [confirmed, setConfirmed] = useState(false);
    const [reminder, setReminder] = useState(false);
    // The live value for the timer below: an effect closure would see the
    // initial null forever and arm the reminder underneath a code being shown.
    const codeRef = useRef<string | null>(null);

    useEffect(() => {
        // Poll briefly for a stashed code (register/migration set it during login).
        const pick = () => {
            const c = consumePendingRecoveryCode();
            if (c) { codeRef.current = c; setCode(c); setReminder(false); }
        };
        pick();
        // Give a just-registered session a moment to stash its code before
        // deciding the reminder is owed: the modal mounts before login's
        // async tail has run on a slow device.
        const due = setTimeout(() => {
            if (!codeRef.current && recoveryCodeReminderDue()) setReminder(true);
        }, 3000);
        const t = setInterval(pick, 1000);
        return () => { clearInterval(t); clearTimeout(due); };
    }, []);

    if (code) {
        const words = code.trim().split(/\s+/);
        return (
            <div className="recovery-modal-overlay">
                <div className="recovery-modal">
                    <h2><KeyIcon /> Save your recovery code</h2>
                    <p className="recovery-intro">
                        This is the <strong>only</strong> way to reset your password without losing your
                        encrypted messages. Write it down and keep it somewhere safe — it won't be shown again,
                        and no one (not even the server) can recover it for you. You can generate a new one
                        any time in Settings → My Account, which retires this one.
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
                        onClick={() => { acknowledgeRecoveryCode(); codeRef.current = null; setCode(null); setReminder(false); }}
                    >
                        Done
                    </button>
                </div>
            </div>
        );
    }

    if (reminder) {
        return (
            <div className="recovery-modal-overlay">
                <div className="recovery-modal">
                    <h2><KeyIcon /> Your recovery code was never saved</h2>
                    <p className="recovery-intro">
                        A recovery code was generated for this account, but the app closed before you
                        confirmed saving it — and it is not stored anywhere, so it cannot be shown again.
                        Without one, forgetting your password means losing your encrypted messages.
                        Generate a new code in <strong>Settings → My Account → Recovery code</strong>.
                    </p>
                    <div className="recovery-reminder-actions">
                        <button
                            className="recovery-copy-btn"
                            onClick={() => { snoozeRecoveryCodeReminder(); setReminder(false); }}
                        >
                            Later
                        </button>
                        <button
                            className="recovery-done-btn"
                            onClick={() => { acknowledgeRecoveryCode(); setReminder(false); }}
                        >
                            I already saved it
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return null;
}
