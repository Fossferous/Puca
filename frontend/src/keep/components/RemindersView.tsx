/**
 * Every open item with a due time, across every note: Overdue / Today /
 * Upcoming. Ticking one completes it (the same cascade as everywhere else);
 * clicking a row opens its note.
 */
import { formatDueShort } from '../../api/tasks';
import { BellIcon } from '../../components/Icons';
import { type DueItem, type NoteCard, type ReminderGroups } from '../model/keepModel';
import { type NoteActions } from '../model/notesQueries';

interface RemindersViewProps {
    groups: ReminderGroups;
    actions: NoteActions;
    now: number;
    onOpen: (card: NoteCard) => void;
    /** Whether the browser will show OS notifications for due items. */
    notificationsState: 'granted' | 'denied' | 'default' | 'unsupported';
    onEnableNotifications: () => void;
}

function Row({ item, actions, now, onOpen }: { item: DueItem; actions: NoteActions; now: number; onOpen: (c: NoteCard) => void }) {
    return (
        <div className="keep-reminder-row" role="button" tabIndex={0}
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
            <span className="keep-reminder-text">{item.task.description}</span>
            <span className="keep-reminder-note">{item.note.title}</span>
            <span className="keep-reminder-when" title={new Date(item.at).toLocaleString()}>{formatDueShort(item.task.due_at!, now)}</span>
        </div>
    );
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications }: RemindersViewProps) {
    const total = groups.overdue.length + groups.today.length + groups.upcoming.length;
    return (
        <div className="keep-reminders">
            {notificationsState === 'default' && (
                <div className="keep-status offline">
                    <BellIcon /> Get a notification when an item comes due while Keep is open.
                    <button type="button" onClick={onEnableNotifications}>Enable</button>
                </div>
            )}
            {notificationsState === 'denied' && (
                <div className="keep-status offline"><BellIcon /> Notifications are blocked for this site in the browser; due items still show here.</div>
            )}
            {total === 0 ? (
                <div className="keep-empty"><BellIcon size={48} /><p>No reminders. Give any item a due time from its clock button inside a note.</p></div>
            ) : (
                <>
                    {groups.overdue.length > 0 && (
                        <section className="keep-reminder-group overdue" aria-label="Overdue">
                            <h2 className="keep-section-title">Overdue</h2>
                            {groups.overdue.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} />)}
                        </section>
                    )}
                    {groups.today.length > 0 && (
                        <section className="keep-reminder-group" aria-label="Today">
                            <h2 className="keep-section-title">Today</h2>
                            {groups.today.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} />)}
                        </section>
                    )}
                    {groups.upcoming.length > 0 && (
                        <section className="keep-reminder-group" aria-label="Upcoming">
                            <h2 className="keep-section-title">Upcoming</h2>
                            {groups.upcoming.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} />)}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
