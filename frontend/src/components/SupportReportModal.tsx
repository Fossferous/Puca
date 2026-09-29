import { useMemo, useState } from 'react';
import type { Server } from '../api/servers';
import { ownerChoices, sendSupportReport } from '../api/supportReport';
import { isTauri } from '../api/platform';
import { CloseIcon } from './Icons';
import './ForwardModal.css';
import './SupportReportModal.css';

interface SupportReportModalProps {
    servers: Server[];
    currentUserId: number;
    /** The server whose owner is picked first: the voice call's, else the one
     *  on screen. */
    preferredServerId?: string | null;
    onClose: () => void;
}

/**
 * "Send diagnostics": pick which server's owner gets the report, optionally
 * say what went wrong, send. Everything else is api/supportReport.ts.
 */
export function SupportReportModal({ servers, currentUserId, preferredServerId, onClose }: SupportReportModalProps) {
    const choices = useMemo(
        () => ownerChoices(servers, currentUserId, preferredServerId),
        [servers, currentUserId, preferredServerId],
    );
    // null = the first choice: the server list can arrive after this opens.
    const [picked, setPicked] = useState<number | null>(null);
    const [note, setNote] = useState('');
    const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [message, setMessage] = useState('');
    const [error, setError] = useState<string | null>(null);
    const target = choices.find(c => c.ownerId === picked) ?? choices[0] ?? null;
    const sending = state === 'sending';

    const send = async () => {
        if (!target || sending) return;
        setState('sending');
        setError(null);
        try {
            const bytes = await sendSupportReport(target.ownerId, note);
            const size = bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
            setMessage(target.isSelf
                ? `Sent to your own messages (${size}).`
                : `Sent to the owner of ${target.serverName} (${size}). They'll find it in your direct messages.`);
            setState('sent');
        } catch (e) {
            console.error('[SupportReport] send failed:', e);
            setError(`Could not send the report: ${e instanceof Error ? e.message : String(e)}`);
            setState('idle');
        }
    };

    return (
        <div className="forward-modal-overlay" onClick={sending ? undefined : onClose}>
            <div className="forward-modal support-report-modal" role="dialog" aria-label="Send diagnostics" onClick={e => e.stopPropagation()}>
                <button className="forward-modal-close" onClick={onClose} disabled={sending} title="Close"><CloseIcon size={18} /></button>
                <h2>Send diagnostics</h2>
                {state === 'sent' ? (
                    <>
                        <p className="support-report-text">{message}</p>
                        <div className="support-report-actions">
                            <button className="support-report-send" onClick={onClose}>Done</button>
                        </div>
                    </>
                ) : choices.length === 0 ? (
                    <p className="support-report-text">
                        You are not in any server, so there is no owner to send a report to.
                        Copy diagnostics (Settings → Advanced) still works.
                    </p>
                ) : (
                    <>
                        <p className="support-report-text">
                            Sends a report to a server owner as an encrypted direct message:
                            measurements of your call right now
                            {isTauri() ? ', plus this app\'s log (call and stream quality over the last hours, and the names of programs whose audio you shared)' : ''}.
                            No messages, passwords or addresses are included. Send it while the
                            problem is happening, or soon after.
                        </p>
                        {error && <div className="forward-error">{error}</div>}
                        <div className="forward-section-label">Send to</div>
                        <div className="forward-target-list support-report-owners" role="radiogroup">
                            {choices.map(c => (
                                <button
                                    key={c.ownerId}
                                    role="radio"
                                    aria-checked={target?.ownerId === c.ownerId}
                                    className={`forward-target${target?.ownerId === c.ownerId ? ' is-picked' : ''}`}
                                    disabled={sending}
                                    onClick={() => setPicked(c.ownerId)}
                                >
                                    <span className="ft-avatar">{c.serverName[0]?.toUpperCase() ?? '?'}</span>
                                    <span className="ft-name">
                                        {c.isSelf ? `You (owner of ${c.serverName})` : `The owner of ${c.serverName}`}
                                    </span>
                                </button>
                            ))}
                        </div>
                        <textarea
                            className="forward-filter support-report-note"
                            placeholder="What went wrong? (optional)"
                            maxLength={500}
                            rows={3}
                            value={note}
                            disabled={sending}
                            onChange={e => setNote(e.target.value)}
                        />
                        <div className="support-report-actions">
                            <button className="support-report-send" onClick={send} disabled={!target || sending}>
                                {sending ? 'Measuring and sending…' : 'Send report'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
