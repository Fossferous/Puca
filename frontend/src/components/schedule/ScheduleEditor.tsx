/**
 * The date & repeat editor for one item — an event (date, all-day, start/end,
 * repeat, place, reminder) or a to-do (due, repeat, reminder). A dialog
 * portaled to document.body: centred on desktop, a full-screen sheet on a
 * phone (Schedule.css), never inside a transformed panel (DESIGN_PHILOSOPHY
 * §6). Every input is a native date/time/select at 16px or more under a
 * coarse pointer.
 *
 * A row of one-tap times (Morning / Afternoon / Evening) sets the date and
 * the time together; what those mean is the person's own setting
 * (api/reminderTimes.ts), and "Keep the time private from the server" stays
 * right there on the same dialog, which is why a preset belongs here.
 *
 * The form ⇄ schedule logic is scheduleForm.ts (tested); this renders it.
 * A read-only schedule (newer version, unreadable) shows why and offers no
 * Save — it must never be rewritten by a build that cannot read it.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { type Task } from '../../api/tasks';
import { type ScheduleKind, deriveDueAt, parseSchedule, serializeSchedule } from '../../api/taskSchedule';
import {
    ALLDAY_ALERTS, TIMED_ALERTS, type ScheduleForm, dueAtAfterRemoving, formFromSchedule, isLastWeekdayOfMonth, newForm, nthOfMonth,
    removingRevealsPrivateTime, scheduleFromForm,
} from '../../api/scheduleForm';
import { formatDateKey } from '../../api/scheduleFormat';
import { DEFAULT_REMINDER_TIMES, REMINDER_PRESETS, presetInstant, type ReminderTimes } from '../../api/reminderTimes';
import { parseWall, viewerZone, isInGap } from '../../utils/calendarMath';
import { CalendarIcon, CloseIcon, EyeOffIcon, WarningIcon } from '../Icons';
import './Schedule.css';

export interface ScheduleEditorProps {
    task: Task;
    /** Save: the plaintext schedule (null = remove it) and the due_at to write
     *  with it (derived here, the one place an editor derives it). */
    onSave: (schedule: string | null, dueAt: string | null) => void;
    onClose: () => void;
    /** For a new schedule: what it is and where it starts. */
    defaultKind?: ScheduleKind;
    defaultDate?: string;
    now?: number;
    /** The person's Morning / Afternoon / Evening and the time a new
     *  reminder starts at; the defaults are what this always used. */
    times?: ReminderTimes;
}

const ORD = ['first', 'second', 'third', 'fourth', 'fifth'];

function todayKey(now: number): string {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function ScheduleEditor({ task, onSave, onClose, defaultKind = 'task', defaultDate, now: nowProp, times = DEFAULT_REMINDER_TIMES }: ScheduleEditorProps) {
    const [now] = useState(() => nowProp ?? Date.now());
    const parsed = useMemo(() => parseSchedule(task.schedule), [task.schedule]);
    const readOnly = parsed.state === 'readonly';
    const [form, setForm] = useState<ScheduleForm>(() => {
        if (parsed.state === 'ok') return formFromSchedule(parsed.schedule, times.default);
        // A plain task with a due time starts from that time.
        if (task.due_at) {
            const d = new Date(task.due_at);
            const key = todayKey(d.getTime());
            const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
            return newForm(defaultKind, key, now, time);
        }
        return newForm(defaultKind, defaultDate ?? todayKey(now), now, undefined, viewerZone(), times.default);
    });
    const [error, setError] = useState<string | null>(null);
    const set = (patch: Partial<ScheduleForm>) => { setForm(f => ({ ...f, ...patch })); setError(null); };

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

    const date = parseWall(form.date)?.wall;
    const weekday = date ? new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(date.y, date.m - 1, date.d)) : '';
    const dayOfMonth = date?.d ?? 1;
    const lastOfMonth = date ? isLastWeekdayOfMonth(date.y, date.m, date.d) : false;
    const eventZoneDiffers = !form.allDay && form.tz !== viewerZone();
    const gap = !form.allDay && date && /^\d{2}:\d{2}$/.test(form.startTime)
        ? isInGap({ ...date, hh: Number(form.startTime.slice(0, 2)), mm: Number(form.startTime.slice(3)) }, form.tz)
        : false;

    const save = () => {
        const built = scheduleFromForm(form, parsed.state === 'ok' ? parsed.schedule : undefined);
        if (typeof built === 'string') { setError(built); return; }
        let text: string;
        try {
            text = serializeSchedule(built, parsed.state === 'ok' ? parsed.raw : {});
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            return;
        }
        onSave(text, deriveDueAt(built, Date.now()));
    };

    const remove = () => {
        // The item keeps a plain due time at its next occurrence, so it does
        // not silently lose its date — but a PRIVATE time is only published
        // to the server on an explicit yes (scheduleForm.dueAtAfterRemoving).
        const reveal = removingRevealsPrivateTime(parsed)
            ? window.confirm('This item keeps its time private from the server. Keep a reminder at its next time? The server will then see that time. (Cancel removes the date without a reminder.)')
            : true;
        onSave(null, dueAtAfterRemoving(parsed, task.due_at, Date.now(), reveal));
    };

    const alerts = form.allDay ? ALLDAY_ALERTS : TIMED_ALERTS;

    return createPortal(
        <div className="sched-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="sched-dialog" role="dialog" aria-modal="true" aria-label="Date and repeat">
                <div className="sched-head">
                    <CalendarIcon />
                    <h3>{parsed.state === 'none' ? 'Add date & repeat' : 'Date & repeat'}</h3>
                    <button type="button" className="sched-iconbtn" aria-label="Close" title="Close" onClick={onClose}><CloseIcon size={18} /></button>
                </div>
                <div className="sched-body">
                    <p className="sched-task-title">{task.description}</p>
                    {readOnly ? (
                        <div className="sched-note warn" role="alert"><WarningIcon /> {parsed.reason}. This build won’t change it.</div>
                    ) : (
                        <>
                            <div className="sched-seg" role="radiogroup" aria-label="Kind">
                                {(['event', 'task'] as const).map(k => (
                                    <button key={k} type="button" role="radio" aria-checked={form.kind === k}
                                        className={form.kind === k ? 'on' : ''}
                                        onClick={() => set({ kind: k, alert: k === 'event' ? (form.allDay ? '-540' : '10') : (form.allDay ? '-540' : '0') })}>
                                        {k === 'event' ? 'Event' : 'To-do'}
                                    </button>
                                ))}
                            </div>
                            {/* One tap for the common case. The date the
                                preset lands on is today or tomorrow, whichever
                                that time is still ahead in. */}
                            <div className="sched-presets" role="group" aria-label="Remind">
                                {REMINDER_PRESETS.map(p => (
                                    <button key={p.value} type="button" className="sched-btn sched-preset"
                                        title={`${p.label} — ${times[p.value]}`}
                                        onClick={() => {
                                            const at = new Date(presetInstant(times[p.value], Date.now()));
                                            // Coming off all-day also drops the all-day alert offset
                                            // (-540), which has no option in the timed list.
                                            set({
                                                date: todayKey(at.getTime()), startTime: times[p.value], allDay: false,
                                                ...(form.allDay ? { alert: form.kind === 'event' ? '10' : '0' } : {}),
                                            });
                                        }}>
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <label className="sched-row">
                                <span>{form.kind === 'event' ? 'Date' : 'Due'}</span>
                                <input type="date" value={form.date} onChange={e => set({ date: e.target.value })} aria-label="Date" />
                            </label>
                            <label className="sched-row sched-check">
                                <input type="checkbox" checked={form.allDay} onChange={e => set({ allDay: e.target.checked, alert: e.target.checked ? '-540' : (form.kind === 'event' ? '10' : '0') })} />
                                <span>All day</span>
                            </label>
                            {!form.allDay ? (
                                <div className="sched-pair">
                                    <label className="sched-row">
                                        <span>{form.kind === 'event' ? 'Starts' : 'At'}</span>
                                        <input type="time" value={form.startTime} onChange={e => set({ startTime: e.target.value })} aria-label="Start time" />
                                    </label>
                                    {form.kind === 'event' && (
                                        <label className="sched-row">
                                            <span>Ends</span>
                                            <input type="time" value={form.endTime} onChange={e => set({ endTime: e.target.value })} aria-label="End time" />
                                        </label>
                                    )}
                                </div>
                            ) : form.kind === 'event' && (
                                <label className="sched-row">
                                    <span>Last day</span>
                                    <input type="date" value={form.endDate} min={form.date} onChange={e => set({ endDate: e.target.value })} aria-label="Last day" />
                                </label>
                            )}
                            {eventZoneDiffers && <div className="sched-note">Times are in {form.tz}, where this was made.</div>}
                            {gap && <div className="sched-note warn"><WarningIcon /> That time doesn’t exist on this day (the clocks go forward) — it will be the same time after the change.</div>}
                            <label className="sched-row">
                                <span>Repeat</span>
                                <select value={form.repeat} onChange={e => set({ repeat: e.target.value as ScheduleForm['repeat'] })} aria-label="Repeat">
                                    <option value="none">Does not repeat</option>
                                    <option value="daily">Every day</option>
                                    <option value="weekdays">Every weekday (Mon–Fri)</option>
                                    <option value="weekly">Every week on {weekday}</option>
                                    <option value="monthly-day">Every month on day {dayOfMonth}</option>
                                    {nthOfMonth(dayOfMonth) <= 4 && <option value="monthly-nth">Every month on the {ORD[nthOfMonth(dayOfMonth) - 1]} {weekday}</option>}
                                    {lastOfMonth && <option value="monthly-last">Every month on the last {weekday}</option>}
                                    <option value="yearly">Every year on {form.date ? formatDateKey(form.date, undefined, { month: 'long', day: 'numeric' }) : ''}</option>
                                    {form.repeat === 'custom' && <option value="custom">Custom (imported): {form.customRule}</option>}
                                </select>
                            </label>
                            {form.repeat !== 'none' && form.repeat !== 'custom' && (
                                <div className="sched-pair">
                                    <label className="sched-row">
                                        <span>Ends</span>
                                        <select value={form.ends} onChange={e => set({ ends: e.target.value as ScheduleForm['ends'] })} aria-label="Ends">
                                            <option value="never">Never</option>
                                            <option value="count">After…</option>
                                            <option value="until">On a date…</option>
                                        </select>
                                    </label>
                                    {form.ends === 'count' && (
                                        <label className="sched-row">
                                            <span>Times</span>
                                            <input type="number" min={1} max={1000} value={form.count} onChange={e => set({ count: Number(e.target.value) })} aria-label="Number of times" />
                                        </label>
                                    )}
                                    {form.ends === 'until' && (
                                        <label className="sched-row">
                                            <span>Last date</span>
                                            <input type="date" value={form.until} min={form.date} onChange={e => set({ until: e.target.value })} aria-label="Last date" />
                                        </label>
                                    )}
                                </div>
                            )}
                            {form.kind === 'event' && (
                                <label className="sched-row">
                                    <span>Place</span>
                                    <input type="text" value={form.location} maxLength={500} placeholder="Where (optional)" onChange={e => set({ location: e.target.value })} aria-label="Place" />
                                </label>
                            )}
                            <label className="sched-row">
                                <span>Remind</span>
                                <select value={form.alert} onChange={e => set({ alert: e.target.value })} aria-label="Reminder">
                                    {form.alert === 'keep' && <option value="keep">As imported</option>}
                                    {alerts.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                            </label>
                            <label className="sched-row sched-check">
                                <input type="checkbox" checked={form.privateTiming} onChange={e => set({ privateTiming: e.target.checked })} />
                                <span><EyeOffIcon /> Keep the time private from the server</span>
                            </label>
                            <div className="sched-note">
                                {form.privateTiming
                                    ? 'The server won’t see when this is. Reminders can’t fire for it until a device reminds from the sealed schedule itself — it still shows in the calendar.'
                                    : 'Off: the server sees the next reminder time (never what it is), so reminders reach your other devices.'}
                            </div>
                            {error && <div className="sched-note warn" role="alert"><WarningIcon /> {error}</div>}
                        </>
                    )}
                </div>
                <div className="sched-foot">
                    {parsed.state !== 'none' && !readOnly && (
                        <button type="button" className="sched-btn danger" onClick={remove}>Remove</button>
                    )}
                    <span className="sched-spacer" />
                    <button type="button" className="sched-btn" onClick={onClose}>Cancel</button>
                    {!readOnly && <button type="button" className="sched-btn primary" onClick={save}>Save</button>}
                </div>
            </div>
        </div>,
        document.body,
    );
}
