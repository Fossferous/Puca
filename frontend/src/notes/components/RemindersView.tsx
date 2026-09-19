/**
 * Every open item with a due time, across every note: Overdue / Today /
 * Upcoming. Ticking one completes it (the same cascade as everywhere else);
 * clicking a row opens its note.
 */
import { canCompleteTasks, formatDueShort } from '../../api/tasks';
import { BellIcon } from '../../components/Icons';
import { ReminderTimingMarks, SnoozeControl } from './SnoozeControl';
import { type DueItem, type NoteCard, type ReminderGroups } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';

interface RemindersViewProps {
    groups: ReminderGroups;
    actions: NoteActions;
    now: number;
    onOpen: (card: NoteCard) => void;
    /** Whether the browser will show OS notifications for due items. */
    notificationsState: 'granted' | 'denied' | 'default' | 'unsupported';
    onEnableNotifications: () => void;
    /** The server stores snoozes (taskFeatures). */
    canSnooze?: boolean;
}

function Row({ item, actions, now, onOpen, canSnooze = false }: { item: DueItem; actions: NoteActions; now: number; onOpen: (c: NoteCard) => void; canSnooze?: boolean }) {
    return (
        <div className="notes-reminder-row" role="button" tabIndex={0}
            onClick={() => onOpen(item.note)}
            onKeyDown={e => { if (e.key === 'Enter') onOpen(item.note); }}
        >
            <input
                type="checkbox"
                checked={false}
                aria-label={`Complete: ${item.task.description}`}
                onClick={e => e.stopPropagation()}
                onChange={() => void actions.toggleTask(item.note.ref, item.task, true)}
            />
            <span className="notes-reminder-text">{item.task.description}</span>
            <ReminderTimingMarks slot={item.slot} />
            <span className="notes-reminder-note">{item.note.title}</span>
            <span className="notes-reminder-when" title={new Date(item.at).toLocaleString()}>{formatDueShort(new Date(item.at).toISOString(), now)}</span>
            {canSnooze && (item.note.ref.kind === 'list' || canCompleteTasks(item.note.myPerms)) && <SnoozeControl item={item} actions={actions} now={now} />}
        </div>
    );
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications, canSnooze = false }: RemindersViewProps) {
    const total = groups.overdue.length + groups.today.length + groups.upcoming.length;
    return (
        <div className="notes-reminders">
            {notificationsState === 'default' && (
                <div className="notes-status offline">
                    <BellIcon /> Get a notification when an item comes due while Notes is open.
                    <button type="button" onClick={onEnableNotifications}>Enable</button>
                </div>
            )}
            {notificationsState === 'denied' && (
                <div className="notes-status offline"><BellIcon /> Notifications are blocked for this site in the browser; due items still show here.</div>
            )}
            {total === 0 ? (
                <div className="notes-empty"><BellIcon size={48} /><p>No reminders. Give any item a due time from its clock button inside a note.</p></div>
            ) : (
                <>
                    {groups.overdue.length > 0 && (
                        <section className="notes-reminder-group overdue" aria-label="Overdue">
                            <h2 className="notes-section-title">Overdue</h2>
                            {groups.overdue.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} />)}
                        </section>
                    )}
                    {groups.today.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Today">
                            <h2 className="notes-section-title">Today</h2>
                            {groups.today.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} />)}
                        </section>
                    )}
                    {groups.upcoming.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Upcoming">
                            <h2 className="notes-section-title">Upcoming</h2>
                            {groups.upcoming.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} />)}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
