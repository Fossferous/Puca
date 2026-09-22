/**
 * The NOTE's own reminder (migration 068) — the control, and the chip that
 * shows it. Shared by Púca Notes' editor and card and by Púca's Tasks view,
 * so the two front doors cannot disagree about what setting a note's
 * reminder does (docs/NOTES.md).
 *
 * A note is not an item: there is nothing to tick, so there is no completion
 * checkbox here and no snooze (068 adds no snooze column — see
 * docs/NOTES.md, "Not built"). What it does have is exactly what an item
 * has: a plain time (the clock), and a full date & repeat through the SAME
 * ScheduleEditor items use, which is what carries "Keep the time private
 * from the server" onto a note — the time lives inside the sealed schedule
 * and due_at stays NULL.
 *
 * ScheduleEditor only ever reads `description`, `due_at` and `schedule` off
 * what it is given, so the note is handed to it as that shape rather than
 * being made into a fake Task.
 */
import { useState } from 'react';
import { dueToLocalInput, formatDueShort, localInputToIso } from '../../api/tasks';
import { parseSchedule } from '../../api/taskSchedule';
import { BellIcon, CalendarIcon, ClockIcon } from '../Icons';
import { ScheduleEditor } from './ScheduleEditor';
import { ScheduleChip } from './ScheduleChip';
import './NoteReminderControl.css';

export interface NoteTiming {
    /** The note's title, shown as the editor's headline. */
    title: string;
    dueAt?: string | null;
    /** The OPENED schedule (api/listSeal.ts), never the envelope. */
    schedule?: string | null;
}

export interface NoteReminderControlProps {
    note: NoteTiming;
    /** Three-state, like every other timing write: a field left out is kept. */
    onSave: (patch: { dueAt?: string | null; schedule?: string | null }) => void;
    /** The server stores a note's sealed schedule (066 for the sealing rules,
     *  068 for the column). Without it only the plain clock is offered. */
    canSchedule?: boolean;
    /** Rendered inside a footer of icon buttons; the class the host uses. */
    buttonClass?: string;
}

/** The note's own reminder, as a row of buttons plus whichever editor is
 *  open. Renders nothing at all when the server has no columns for it — the
 *  caller decides that with `noteReminders` and simply does not mount this. */
export function NoteReminderControl({ note, onSave, canSchedule = false, buttonClass = 'notes-iconbtn' }: NoteReminderControlProps) {
    const [open, setOpen] = useState<'due' | 'schedule' | null>(null);
    const [draft, setDraft] = useState('');
    const hasSchedule = parseSchedule(note.schedule).state !== 'none';

    const commitDue = () => {
        setOpen(null);
        const iso = localInputToIso(draft);
        if (iso === null && draft.trim() !== '') return;      // unparseable: keep as it was
        if (dueToLocalInput(note.dueAt ?? null) === draft) return;    // unchanged
        onSave({ dueAt: iso });
    };

    return (
        <>
            {/* The plain clock, hidden once the note carries a schedule —
                the same rule TaskTree applies to an item, so the two cannot
                be edited into disagreeing. */}
            {!hasSchedule && (
                <button
                    type="button"
                    className={buttonClass}
                    aria-label={note.dueAt ? 'Edit this note’s reminder' : 'Remind me'}
                    aria-expanded={open === 'due'}
                    title={note.dueAt ? 'Edit this note’s reminder' : 'Remind me about this note'}
                    onClick={() => {
                        if (open === 'due') { setOpen(null); return; }
                        setDraft(dueToLocalInput(note.dueAt ?? null));
                        setOpen('due');
                    }}
                >
                    <ClockIcon />
                </button>
            )}
            {canSchedule && (
                <button
                    type="button"
                    className={buttonClass}
                    aria-label={hasSchedule ? 'Edit date & repeat' : 'Add date & repeat'}
                    aria-expanded={open === 'schedule'}
                    title={hasSchedule ? 'Edit date & repeat' : 'Add date & repeat'}
                    onClick={() => setOpen(open === 'schedule' ? null : 'schedule')}
                >
                    <CalendarIcon />
                </button>
            )}
            {open === 'due' && (
                <span className="note-due-edit" onClick={e => e.stopPropagation()}>
                    <input
                        type="datetime-local"
                        value={draft}
                        autoFocus
                        aria-label="Remind me at"
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') commitDue();
                            if (e.key === 'Escape') {
                                // Never let a window-level Escape close the
                                // note out from under this editor.
                                e.preventDefault();
                                e.stopPropagation();
                                setOpen(null);
                            }
                        }}
                    />
                    <button type="button" className="tt-btn tt-due-set" onClick={commitDue}>Set</button>
                    {note.dueAt && (
                        <button type="button" className="tt-btn tt-delete" onClick={() => { setOpen(null); onSave({ dueAt: null }); }}>Clear</button>
                    )}
                </span>
            )}
            {open === 'schedule' && (
                <ScheduleEditor
                    task={{ description: note.title, due_at: note.dueAt ?? null, schedule: note.schedule ?? null }}
                    onClose={() => setOpen(null)}
                    onSave={(schedule, dueAt) => { setOpen(null); onSave({ schedule, dueAt }); }}
                />
            )}
        </>
    );
}

/** The note's own reminder as a chip: the schedule's when it has one, else
 *  the plain time. Deliberately distinct from the `nearestDue` chip, which
 *  is about the note's ITEMS — the two must not read as one thing, and on a
 *  card that has both they sit side by side. The BELL says "this note", the
 *  clock beside it says "something in it"; the outline (NoteReminderControl.css)
 *  keeps them apart even where the icon style is `classic`. */
export function NoteDueChip({ note, now }: { note: NoteTiming; now: number }) {
    const parsed = parseSchedule(note.schedule);
    if (parsed.state !== 'none') {
        return (
            <span className="note-due-chip" title="This note's own reminder">
                <BellIcon />
                <ScheduleChip task={{ schedule: note.schedule ?? null, is_completed: false }} now={now} />
            </span>
        );
    }
    if (!note.dueAt) return null;
    const overdue = Date.parse(note.dueAt) <= now;
    return (
        <span className={`note-due-chip ${overdue ? 'overdue' : ''}`} title={`This note reminds you at ${new Date(note.dueAt).toLocaleString()}`}>
            <BellIcon /> {formatDueShort(note.dueAt, now)}
        </span>
    );
}
