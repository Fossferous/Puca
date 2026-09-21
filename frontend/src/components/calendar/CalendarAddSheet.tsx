/**
 * Tap-to-add on the calendar: a title, the day and time (or all day), what it
 * is (event / to-do), and which note it goes in — the note used last, or a
 * new one. ONE request creates the item with its timing (addTask's `timing`),
 * so nothing half-exists if the connection drops.
 *
 * Shared notes are marked with their server: content added there is visible
 * to that channel's members. A dialog on desktop, a full-screen sheet on a
 * phone (Schedule.css' classes, the same z band).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { type ScheduleKind } from '../../api/taskSchedule';
import { DEFAULT_REMINDER_TIMES } from '../../api/reminderTimes';
import { CalendarIcon, CloseIcon, MembersIcon } from '../Icons';
import '../schedule/Schedule.css';

export interface AddTarget {
    key: string;
    title: string;
    serverName?: string;
}

export interface AddSheetResult {
    title: string;
    dayKey: string;
    time: string;
    allDay: boolean;
    kind: ScheduleKind;
    /** A note key, or 'new' for a new note. */
    target: string;
}

export function CalendarAddSheet({ dayKey, time, defaultTime = DEFAULT_REMINDER_TIMES.default, targets, defaultTarget, scheduleSupported, onSubmit, onClose, allowNew = true }: {
    dayKey: string;
    time?: string;
    /** What a new reminder starts at when the tap named no time (the
     *  person's own setting — api/reminderTimes.ts). */
    defaultTime?: string;
    targets: AddTarget[];
    defaultTarget: string | null;
    /** The server stores schedules: offer event/to-do and all-day. */
    scheduleSupported: boolean;
    onSubmit: (r: AddSheetResult) => Promise<boolean>;
    onClose: () => void;
    /** Offer "New note…" (Notes); Púca makes lists from its tab bar. */
    allowNew?: boolean;
}) {
    const [title, setTitle] = useState('');
    const [day, setDay] = useState(dayKey);
    const [at, setAt] = useState(time ?? defaultTime);
    const [allDay, setAllDay] = useState(!time && scheduleSupported);
    const [kind, setKind] = useState<ScheduleKind>('event');
    const [target, setTarget] = useState(defaultTarget && targets.some(t => t.key === defaultTarget) ? defaultTarget : (targets[0]?.key ?? (allowNew ? 'new' : '')));
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            onClose();
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [onClose]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const t = title.trim();
        if (!t || busy) return;
        setBusy(true);
        const ok = await onSubmit({ title: t, dayKey: day, time: at, allDay, kind, target });
        setBusy(false);
        if (ok) onClose();
    };

    const shared = targets.find(x => x.key === target)?.serverName;
    return createPortal(
        <div className="sched-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <form className="sched-dialog cal-add" role="dialog" aria-modal="true" aria-label="Add to the calendar" onSubmit={submit}>
                <div className="sched-head">
                    <CalendarIcon />
                    <h3>Add to the calendar</h3>
                    <button type="button" className="sched-iconbtn" aria-label="Close" title="Close" onClick={onClose}><CloseIcon size={18} /></button>
                </div>
                <div className="sched-body">
                    <label className="sched-row">
                        <span>What</span>
                        <input type="text" value={title} maxLength={500} autoFocus placeholder="Title" aria-label="Title" onChange={e => setTitle(e.target.value)} />
                    </label>
                    {scheduleSupported && (
                        <div className="sched-seg" role="radiogroup" aria-label="Kind">
                            {(['event', 'task'] as const).map(k => (
                                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
                                    {k === 'event' ? 'Event' : 'To-do'}
                                </button>
                            ))}
                        </div>
                    )}
                    <label className="sched-row">
                        <span>Date</span>
                        <input type="date" value={day} onChange={e => setDay(e.target.value)} aria-label="Date" required />
                    </label>
                    {scheduleSupported && (
                        <label className="sched-row sched-check">
                            <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} />
                            <span>All day</span>
                        </label>
                    )}
                    {!allDay && (
                        <label className="sched-row">
                            <span>Time</span>
                            <input type="time" value={at} onChange={e => setAt(e.target.value)} aria-label="Time" required />
                        </label>
                    )}
                    <label className="sched-row">
                        <span>In</span>
                        <select value={target} onChange={e => setTarget(e.target.value)} aria-label="Note">
                            {targets.map(t => <option key={t.key} value={t.key}>{t.title}{t.serverName ? ` — shared in ${t.serverName}` : ''}</option>)}
                            {allowNew && <option value="new">New note…</option>}
                        </select>
                    </label>
                    {shared && <div className="sched-note"><MembersIcon /> Everyone in this checklist on {shared} will see it.</div>}
                    {!scheduleSupported && <div className="sched-note">This server stores a due time only: the item reminds you then; all-day, repeats and places need the server updated.</div>}
                    {/* All-day items alert at the fixed 09:00 offset the
                        schedule carries (scheduleForm.ALLDAY_ALERTS), which is
                        NOT the person's morning time — so say 09:00, not a
                        setting that does not apply here. */}
                    <div className="sched-note">It reminds you {allDay ? 'at 09:00 on the day' : kind === 'event' ? '10 minutes before' : 'at that time'} — change that from its menu.</div>
                </div>
                <div className="sched-foot">
                    <span className="sched-spacer" />
                    <button type="button" className="sched-btn" onClick={onClose}>Cancel</button>
                    <button type="submit" className="sched-btn primary" disabled={!title.trim() || busy}>{busy ? 'Adding…' : 'Add'}</button>
                </div>
            </form>
        </div>,
        document.body,
    );
}
