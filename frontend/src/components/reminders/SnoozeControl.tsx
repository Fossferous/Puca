/**
 * Snooze for a reminder row (both Reminders views): 10 minutes, an hour, or
 * tomorrow at 09:00. The snooze record is sealed on the device; an editor's
 * snooze also moves the plaintext due_at to the snooze instant
 * (taskSchedule.snoozePatch, docs/SECURITY_MODEL.md §2). Only an item whose
 * reminder has a time on the server (due_at) can be snoozed: a private-timing
 * item has nothing to push back.
 *
 * Also the small marks a row carries: repeats, is an event, is snoozed.
 *
 * Host-agnostic: it reports the instant it wants, and the host sends it (a
 * NoteAction in Púca Notes, patchTaskTiming in Púca's Tasks view). The same
 * control serves a Reminders row and an item row inside a list (TaskTree), so
 * there is one snooze menu in the app, not one per surface.
 *
 * It closes on Escape (consuming the key, so a surface above it does not
 * close too) and on a press outside it, the way ContextMenu does. On
 * an item row the menu is absolutely positioned OVER the next row
 * (Reminders.css), so one left open by moving the pointer away would swallow
 * that row's clicks until the snooze button was pressed again.
 */
import { useEffect, useRef, useState } from 'react';
import './Reminders.css';
import { type SnoozePreset, snoozeUntil } from '../../api/taskSchedule';
import { type ReminderSlot } from '../../api/reminderSlots';
import { type Task } from '../../api/tasks';
import { CalendarIcon, RepeatIcon, SnoozeIcon } from '../Icons';

const PRESETS: { value: SnoozePreset; label: string }[] = [
    { value: '10m', label: '10 min' },
    { value: '1h', label: '1 hour' },
    { value: 'tomorrow', label: 'Tomorrow' },
];

export function SnoozeControl({ task, snoozed = false, now, onSnooze, className = '', buttonClass = 'notes-iconbtn small' }: {
    task: Task;
    /** A snooze is in force (the menu then offers Unsnooze). */
    snoozed?: boolean;
    now: number;
    onSnooze: (until: number | null) => void;
    /** Extra class on the wrapper — an item row positions its menu. */
    className?: string;
    buttonClass?: string;
}) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
        };
        // Escape belongs to the open menu, and to nothing above it. Púca
        // Notes' editor closes on a bubble-phase document Escape of its own
        // (NoteEditor.tsx) which bails only on `defaultPrevented`, so a menu
        // that merely closed would take the whole note with it — TaskTree's
        // due editor consumes the key for the same reason. ContextMenu gets
        // away with not consuming it because NotesShell sets escapeBlocked
        // for that layer; this control has no such cover.
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
        };
        document.addEventListener('pointerdown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);
    if (!task.due_at) return null;
    return (
        <span ref={wrapRef} className={`notes-snooze ${className}`.trim()} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <button
                type="button"
                className={buttonClass}
                aria-label={snoozed ? 'Snoozed — change or clear' : 'Snooze'}
                aria-expanded={open}
                title="Snooze"
                onClick={() => setOpen(o => !o)}
            >
                <SnoozeIcon />
            </button>
            {open && (
                <span className="notes-snooze-menu" role="group" aria-label="Snooze for">
                    {PRESETS.map(p => (
                        <button key={p.value} type="button" className="notes-textbtn"
                            onClick={() => { setOpen(false); onSnooze(snoozeUntil(p.value, now)); }}>
                            {p.label}
                        </button>
                    ))}
                    {snoozed && (
                        <button type="button" className="notes-textbtn" onClick={() => { setOpen(false); onSnooze(null); }}>
                            Unsnooze
                        </button>
                    )}
                </span>
            )}
        </span>
    );
}

export function ReminderTimingMarks({ slot }: { slot?: ReminderSlot }) {
    if (!slot) return null;
    return (
        <span className="notes-reminder-marks">
            {slot.kind === 'event' && <span title="Event" aria-label="event"><CalendarIcon /></span>}
            {slot.repeats && <span title="Repeats" aria-label="repeats"><RepeatIcon /></span>}
            {slot.snoozed && <span title="Snoozed" aria-label="snoozed"><SnoozeIcon /></span>}
        </span>
    );
}
