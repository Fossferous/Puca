/**
 * Snooze for a reminder row (Reminders view, the calendar's day list):
 * 10 minutes, an hour, or tomorrow at 09:00 — sealed on the device, the
 * server stores only that a snooze exists (task_timing.rs). Only an item
 * whose reminder has a time on the server (due_at) can be snoozed: a
 * private-timing item has nothing to push back.
 *
 * Also the small marks a row carries: repeats, is an event, is snoozed.
 */
import { useState } from 'react';
import '../timing.css';
import { type SnoozePreset, snoozeUntil } from '../../api/taskSchedule';
import { CalendarIcon, RepeatIcon, SnoozeIcon } from '../../components/Icons';
import { type DueItem } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';
import { type ReminderSlot } from '../model/notesTiming';

const PRESETS: { value: SnoozePreset; label: string }[] = [
    { value: '10m', label: '10 min' },
    { value: '1h', label: '1 hour' },
    { value: 'tomorrow', label: 'Tomorrow' },
];

export function SnoozeControl({ item, actions, now }: { item: DueItem; actions: NoteActions; now: number }) {
    const [open, setOpen] = useState(false);
    if (!item.task.due_at) return null;
    const snoozed = item.slot?.snoozed === true;
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
                            onClick={() => { setOpen(false); void actions.snoozeTask(item.note.ref, item.task, snoozeUntil(p.value, now)); }}>
                            {p.label}
                        </button>
                    ))}
                    {snoozed && (
                        <button type="button" className="notes-textbtn" onClick={() => { setOpen(false); void actions.snoozeTask(item.note.ref, item.task, null); }}>
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
