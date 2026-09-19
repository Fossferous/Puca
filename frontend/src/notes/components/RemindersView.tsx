/**
 * Every open item with a due time, across every note: Overdue / Today /
 * Upcoming. Ticking one completes it (the same cascade as everywhere else);
 * clicking a row opens its note.
 */
import { type ReactNode } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { formatDueShort } from '../../api/tasks';
import { PlaceReminders } from '../native/PlaceReminders';
import { type PlaceItem } from '../native/useNotesPlaces';
import { BellIcon } from '../../components/Icons';
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
    /** The Android app's own status lines (notes/native/); renders nothing elsewhere. */
    nativeBanner?: ReactNode;
    /** Open items with a place saved on this phone (Android app only). */
    placeItems?: PlaceItem[];
}

/** A due item in a SHARED note that someone else created: GET /task-reminders
 *  covers only the channel tasks the caller created, so it reminds whoever
 *  set it — never this user. Said on the row rather than implied. */
function remindsSomeoneElse(item: DueItem, me: number | null): boolean {
    return item.note.ref.kind === 'channel' && me !== null && item.task.created_by !== me;
}

function Row({ item, actions, now, onOpen }: { item: DueItem; actions: NoteActions; now: number; onOpen: (c: NoteCard) => void }) {
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
            <span className="notes-reminder-note">{item.note.title}</span>
            {remindsSomeoneElse(item, currentUserIdFromToken()) && <span className="notes-reminder-note">Reminds whoever set it</span>}
            <span className="notes-reminder-when" title={new Date(item.at).toLocaleString()}>{formatDueShort(item.task.due_at!, now)}</span>
        </div>
    );
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications, nativeBanner, placeItems = [] }: RemindersViewProps) {
    const total = groups.overdue.length + groups.today.length + groups.upcoming.length + placeItems.length;
    return (
        <div className="notes-reminders">
            {nativeBanner}
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
                            {groups.overdue.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} />)}
                        </section>
                    )}
                    {groups.today.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Today">
                            <h2 className="notes-section-title">Today</h2>
                            {groups.today.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} />)}
                        </section>
                    )}
                    <PlaceReminders items={placeItems} actions={actions} onOpen={onOpen} />
                    {groups.upcoming.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Upcoming">
                            <h2 className="notes-section-title">Upcoming</h2>
                            {groups.upcoming.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} />)}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
