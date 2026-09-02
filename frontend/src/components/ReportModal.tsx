/**
 * Report a message or a member to the server's moderators.
 *
 * The server side (POST /servers/:id/reports, moderation_handlers.rs) had
 * existed, hardened and routed, with no caller in any client — so the
 * Reports queue an owner opens in Server Settings could only ever be empty,
 * and a member being harassed had nothing but a personal block. This is the
 * missing half. The four types and the 1000-character bound mirror the
 * server's allow-list and limit exactly, so the client never offers what the
 * server refuses.
 */
import { useEffect, useRef, useState } from 'react';
import { createReport, REPORT_REASON_MAX, REPORT_TYPES, type ReportType } from '../api/servers';
import { statusOf } from '../api/client';
import { CloseIcon, FlagIcon } from './Icons';
import './ReportModal.css';

export interface ReportTarget {
    serverId: string;
    /** The member being reported (a message report names its author too). */
    userId?: number;
    username?: string;
    messageId?: string;
}

interface ReportModalProps {
    target: ReportTarget;
    onClose: () => void;
}

export function ReportModal({ target, onClose }: ReportModalProps) {
    const [type, setType] = useState<ReportType>('harassment');
    const [reason, setReason] = useState('');
    const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
    const [error, setError] = useState('');
    const reasonRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => { reasonRef.current?.focus(); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    const what = target.messageId
        ? `a message${target.username ? ` from ${target.username}` : ''}`
        : (target.username ?? 'this member');

    const submit = async () => {
        const text = reason.trim();
        if (!text || state === 'sending') return;
        setState('sending');
        setError('');
        try {
            await createReport(target.serverId, {
                report_type: type,
                reason: text.slice(0, REPORT_REASON_MAX),
                reported_user_id: target.userId,
                reported_message_id: target.messageId,
            });
            setState('sent');
        } catch (err) {
            const status = statusOf(err);
            setError(
                status === 429 ? 'You have reported a lot recently — try again later.'
                : status === 403 ? 'Only members of this server can report here.'
                : 'The report could not be sent. Check your connection and try again.',
            );
            setState('error');
        }
    };

    return (
        <div className="report-modal-overlay" onClick={onClose}>
            <div className="report-modal" role="dialog" aria-labelledby="report-title" onClick={e => e.stopPropagation()}>
                <button className="report-modal-close" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                <h2 id="report-title"><FlagIcon /> Report {what}</h2>

                {state === 'sent' ? (
                    <>
                        <p className="report-sent">
                            Sent to this server's moderators. Only they can see it — the person you
                            reported is not told.
                        </p>
                        <div className="report-actions">
                            <button className="report-primary" onClick={onClose}>Done</button>
                        </div>
                    </>
                ) : (
                    <>
                        <p className="report-intro">
                            Reports go to this server's moderators, not to the person you are reporting.
                            To stop seeing someone entirely, block them instead.
                        </p>
                        <div className="report-types" role="radiogroup" aria-label="Reason">
                            {REPORT_TYPES.map(t => (
                                <label key={t.id} className={`report-type${type === t.id ? ' selected' : ''}`}>
                                    <input
                                        type="radio"
                                        name="report-type"
                                        value={t.id}
                                        checked={type === t.id}
                                        onChange={() => setType(t.id)}
                                    />
                                    <span className="report-type-label">{t.label}</span>
                                    <span className="report-type-hint">{t.hint}</span>
                                </label>
                            ))}
                        </div>
                        <label className="report-reason-label" htmlFor="report-reason">What happened?</label>
                        <textarea
                            id="report-reason"
                            ref={reasonRef}
                            className="report-reason"
                            value={reason}
                            maxLength={REPORT_REASON_MAX}
                            rows={4}
                            placeholder="A sentence or two is enough. Moderators can see the message you reported."
                            onChange={e => setReason(e.target.value)}
                        />
                        <div className="report-count">{reason.length}/{REPORT_REASON_MAX}</div>
                        {state === 'error' && error && <div className="report-error" role="alert">{error}</div>}
                        <div className="report-actions">
                            <button className="report-secondary" onClick={onClose}>Cancel</button>
                            <button
                                className="report-primary"
                                disabled={!reason.trim() || state === 'sending'}
                                onClick={submit}
                            >
                                {state === 'sending' ? 'Sending…' : 'Send report'}
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
