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
import { type ReactNode } from 'react';
import './Reminders.css';
import { formatDueShort } from '../../api/tasks';
import { type DueRow, type ReminderRowGroups, mayChangeSnooze, remindsSomeoneElse } from '../../api/reminderGroups';
import { BellIcon } from '../Icons';
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
}

function Row({ row, now, currentUserId, onOpen, onToggle, onSnooze }: {
    row: DueRow;
    now: number;
    currentUserId?: number;
    onOpen: (row: DueRow) => void;
    onToggle: (row: DueRow) => void;
    onSnooze?: (row: DueRow, until: number | null) => void;
}) {
    const task = row.source.task;
    return (
        <div className="notes-reminder-row" role="button" tabIndex={0}
            onClick={() => onOpen(row)}
            onKeyDown={e => { if (e.key === 'Enter') onOpen(row); }}
        >
            <input
                type="checkbox"
                checked={false}
                aria-label={`Complete: ${task.description}`}
                onClick={e => e.stopPropagation()}
                onChange={() => onToggle(row)}
            />
            <span className="notes-reminder-text">
                {task.description}
                {/* A second line under the item, not a third column: the row
                    keeps its shape at 390 px and on desktop. */}
                {remindsSomeoneElse(row.source, currentUserId) && <span className="notes-reminder-sub">Reminds whoever set it</span>}
            </span>
            <ReminderTimingMarks slot={row.slot} />
            <span className="notes-reminder-note">{row.source.noteTitle}</span>
            <span className="notes-reminder-when" title={new Date(row.at).toLocaleString()}>{formatDueShort(new Date(row.at).toISOString(), now)}</span>
            {onSnooze && mayChangeSnooze(row.source) && (
                <SnoozeControl task={task} snoozed={row.slot?.snoozed === true} now={now} onSnooze={until => onSnooze(row, until)} />
            )}
        </div>
    );
}

export function RemindersList({ groups, now, currentUserId, onOpen, onToggle, onSnooze, header, middle, extraCount = 0, empty }: RemindersListProps) {
    const total = groups.overdue.length + groups.today.length + groups.upcoming.length + extraCount;
    const rows = (list: DueRow[]) => list.map(row => (
        <Row key={`${row.source.noteKey}/${row.source.task.id}`} row={row} now={now} currentUserId={currentUserId}
            onOpen={onOpen} onToggle={onToggle} onSnooze={onSnooze} />
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
