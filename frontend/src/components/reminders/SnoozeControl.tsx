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
 * NoteAction in Púca Notes, patchTaskTiming in Púca's Tasks view).
 */
import { useState } from 'react';
import './Reminders.css';
import { type SnoozePreset, snoozeUntil } from '../../api/taskSchedule';
import { type DueRow } from '../../api/reminderGroups';
import { type ReminderSlot } from '../../api/reminderSlots';
import { CalendarIcon, RepeatIcon, SnoozeIcon } from '../Icons';

const PRESETS: { value: SnoozePreset; label: string }[] = [
    { value: '10m', label: '10 min' },
    { value: '1h', label: '1 hour' },
    { value: 'tomorrow', label: 'Tomorrow' },
];

export function SnoozeControl({ row, now, onSnooze }: { row: DueRow; now: number; onSnooze: (row: DueRow, until: number | null) => void }) {
    const [open, setOpen] = useState(false);
    if (!row.source.task.due_at) return null;
    const snoozed = row.slot?.snoozed === true;
    return (
        <span className="notes-snooze" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <button
                type="button"
                className="notes-iconbtn small"
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
                            onClick={() => { setOpen(false); onSnooze(row, snoozeUntil(p.value, now)); }}>
                            {p.label}
                        </button>
                    ))}
                    {snoozed && (
                        <button type="button" className="notes-textbtn" onClick={() => { setOpen(false); onSnooze(row, null); }}>
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
