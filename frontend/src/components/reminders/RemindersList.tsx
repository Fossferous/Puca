/**
 * The Reminders list — Overdue / Today / Upcoming — shared by BOTH front
 * doors, exactly as components/calendar/Calendar.tsx is.
 *
 * DATA-AGNOSTIC: it knows about tasks and CalendarSources, never about Púca
 * Notes' note cards or Púca's tabs. Púca Notes' RemindersView and Púca's
 * Reminders tab each build the sources and hand in the three callbacks; the
 * markup, the class names, the rights checks and the "Reminds whoever set it"
 * line live here once.
 *
 * Nothing here puts item text anywhere but the DOM: no URL, no toast, no
 * notification body, no log (docs/NOTES.md's rule — the server learns when,
 * never what).
 */
import { useEffect, useRef, type ReactNode } from 'react';
import './Reminders.css';
import { formatDueShort } from '../../api/tasks';
import { type DueRow, type ReminderRowGroups, mayChangeSnooze, remindsSomeoneElse } from '../../api/reminderGroups';
import { BellIcon, CloseIcon } from '../Icons';
import { ReminderTimingMarks, SnoozeControl } from './SnoozeControl';

export interface RemindersListProps {
    groups: ReminderRowGroups;
    now: number;
    /** Who is looking, for "Reminds whoever set it". */
    currentUserId?: number;
    onOpen: (row: DueRow) => void;
    /** Tick it (the same completion cascade as everywhere else). */
    onToggle: (row: DueRow) => void;
    /** Snooze until an instant, or null to unsnooze. Omitted where the server
     *  has no snooze (api/taskFeatures) — then no row offers one. */
    onSnooze?: (row: DueRow, until: number | null) => void;
    /** The host's own banners, above the groups. */
    header?: ReactNode;
    /** The host's own section between Today and Upcoming (Notes puts its
     *  place reminders there). */
    middle?: ReactNode;
    /** Rows the host renders itself in `middle`, counted so a list that holds
     *  only those does not read as empty. */
    extraCount?: number;
    /** Shown when there is nothing at all. */
    empty: ReactNode;
    /** Clear a NOTE'S OWN reminder (source.isNote): the only thing such a row
     *  can do besides being moved, so it replaces the snooze. Omitted where
     *  the host has no note reminders — then no note row offers one. */
    onClearNote?: (row: DueRow) => void;
    /** The one item a due notification came for: its row is scrolled to and
     *  flashed, so "an item is due" lands on WHICH item. An id only — the
     *  text is decrypted in the page, after the tap, and never travels. */
    flashTaskId?: number | null;
}

function Row({ row, now, currentUserId, onOpen, onToggle, onSnooze, onClearNote, flash = false }: {
    row: DueRow;
    now: number;
    currentUserId?: number;
    onOpen: (row: DueRow) => void;
    onToggle: (row: DueRow) => void;
    onSnooze?: (row: DueRow, until: number | null) => void;
    onClearNote?: (row: DueRow) => void;
    flash?: boolean;
}) {
    const task = row.source.task;
    // A NOTE'S OWN reminder (Púca Notes, migration 068): nothing to tick and
    // no snooze column behind it, and its text IS the note's title — so the
    // checkbox becomes a mark and the trailing note column would repeat it.
    const isNote = row.source.isNote === true;
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (flash) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, [flash]);
    return (
        <div ref={ref} id={`notes-reminder-${task.id}`} className={`notes-reminder-row${isNote ? ' note' : ''}${flash ? ' flash' : ''}`} role="button" tabIndex={0}
            onClick={() => onOpen(row)}
            onKeyDown={e => { if (e.key === 'Enter') onOpen(row); }}
        >
            {isNote ? (
                <span className="notes-reminder-mark" aria-hidden="true"><BellIcon /></span>
            ) : (
                <input
                    type="checkbox"
                    checked={false}
                    aria-label={`Complete: ${task.description}`}
                    onClick={e => e.stopPropagation()}
                    onChange={() => onToggle(row)}
                />
            )}
            <span className="notes-reminder-text">
                {task.description}
                {/* A second line under the item, not a third column: the row
                    keeps its shape at 390 px and on desktop. */}
                {remindsSomeoneElse(row.source, currentUserId) && <span className="notes-reminder-sub">Reminds whoever set it</span>}
                {isNote && <span className="notes-reminder-sub">This note itself</span>}
            </span>
            <ReminderTimingMarks slot={row.slot} />
            {!isNote && <span className="notes-reminder-note">{row.source.noteTitle}</span>}
            <span className="notes-reminder-when" title={new Date(row.at).toLocaleString()}>{formatDueShort(new Date(row.at).toISOString(), now)}</span>
            {onSnooze && mayChangeSnooze(row.source) && (
                <SnoozeControl task={task} snoozed={row.slot?.snoozed === true} now={now} onSnooze={until => onSnooze(row, until)} />
            )}
            {isNote && onClearNote && (
                <button
                    type="button"
                    className="notes-iconbtn small notes-reminder-clear"
                    aria-label={`Clear the reminder on ${row.source.noteTitle}`}
                    title="Clear this note's reminder"
                    onClick={e => { e.stopPropagation(); onClearNote(row); }}
                >
                    <CloseIcon size={16} />
                </button>
            )}
        </div>
    );
}

export function RemindersList({ groups, now, currentUserId, onOpen, onToggle, onSnooze, onClearNote, header, middle, extraCount = 0, empty, flashTaskId = null }: RemindersListProps) {
    const total = groups.overdue.length + groups.today.length + groups.upcoming.length + extraCount;
    const rows = (list: DueRow[]) => list.map(row => (
        <Row key={`${row.source.noteKey}/${row.source.task.id}`} row={row} now={now} currentUserId={currentUserId}
            onOpen={onOpen} onToggle={onToggle} onSnooze={onSnooze} onClearNote={onClearNote} flash={row.source.task.id === flashTaskId} />
    ));
    return (
        <div className="notes-reminders">
            {header}
            {total === 0 ? (
                empty
            ) : (
                <>
                    {groups.overdue.length > 0 && (
                        <section className="notes-reminder-group overdue" aria-label="Overdue">
                            <h2 className="notes-section-title">Overdue</h2>
                            {rows(groups.overdue)}
                        </section>
                    )}
                    {groups.today.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Today">
                            <h2 className="notes-section-title">Today</h2>
                            {rows(groups.today)}
                        </section>
                    )}
                    {middle}
                    {groups.upcoming.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Upcoming">
                            <h2 className="notes-section-title">Upcoming</h2>
                            {rows(groups.upcoming)}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}

/** The empty state both hosts show, with the host's own sentence. */
export function RemindersEmpty({ children }: { children: ReactNode }) {
    return <div className="notes-empty"><BellIcon size={48} /><p>{children}</p></div>;
}
