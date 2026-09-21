/**
 * Everything due, across every note: Overdue / Today / Upcoming. Two kinds
 * of row, and the difference matters —
 *
 *  - an ITEM inside a note: ticking it completes it (the same cascade as
 *    everywhere else), and it can be snoozed;
 *  - the NOTE'S OWN reminder (migration 068): there is nothing to tick, so
 *    it has no checkbox and no Snooze (068 has no snooze column). Its action
 *    is "Clear reminder", which is the only thing a note reminder can do
 *    besides being moved.
 *
 * Clicking either opens the note.
 */
import { type ReactNode } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { canCompleteTasks, canEditTask, formatDueShort } from '../../api/tasks';
import { snoozeLocked } from '../../api/taskSchedule';
import { PlaceReminders } from '../native/PlaceReminders';
import { type PlaceItem } from '../native/useNotesPlaces';
import { BellIcon, CloseIcon } from '../../components/Icons';
import { ReminderTimingMarks, SnoozeControl } from './SnoozeControl';
import { type DueItem, type NoteCard, type ReminderGroups, dueItemKey } from '../model/notesModel';
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
    /** The server stores snoozes (taskFeatures). */
    canSnooze?: boolean;
}

/** A due item in a SHARED note that someone else created: GET /task-reminders
 *  covers only the channel tasks the caller created, so it reminds whoever
 *  set it — never this user. Said on the row rather than implied. */
function remindsSomeoneElse(item: DueItem, me: number | null): boolean {
    return item.kind === 'task' && item.note.ref.kind === 'channel' && me !== null && item.task.created_by !== me;
}

/** Snooze rides the completion right; an editor's MOVED snooze is further
 *  off-limits to a member who may not edit the item's time
 *  (taskSchedule.snoozeLocked). A personal note is always yours. */
function mayChangeSnooze(item: DueItem): boolean {
    // A note's own reminder has no snooze at all (SnoozeControl returns null
    // for it too); this keeps the control from being mounted in the first
    // place, so the row has no empty slot where a button would be.
    if (item.kind === 'note') return false;
    if (item.note.ref.kind === 'list') return true;
    if (!canCompleteTasks(item.note.myPerms)) return false;
    return !snoozeLocked(item.task, canEditTask(item.task, currentUserIdFromToken() ?? undefined, item.note.myPerms));
}

function Row({ item, actions, now, onOpen, canSnooze = false }: { item: DueItem; actions: NoteActions; now: number; onOpen: (c: NoteCard) => void; canSnooze?: boolean }) {
    const isNote = item.kind === 'note';
    return (
        <div className={`notes-reminder-row ${isNote ? 'note' : ''}`} role="button" tabIndex={0}
            onClick={() => onOpen(item.note)}
            onKeyDown={e => { if (e.key === 'Enter') onOpen(item.note); }}
        >
            {item.kind === 'task' ? (
                <input
                    type="checkbox"
                    checked={false}
                    aria-label={`Complete: ${item.task.description}`}
                    onClick={e => e.stopPropagation()}
                    onChange={() => void actions.toggleTask(item.note.ref, item.task, true)}
                />
            ) : (
                <span className="notes-reminder-mark" aria-hidden="true"><BellIcon /></span>
            )}
            <span className="notes-reminder-text">
                {item.kind === 'task' ? item.task.description : item.note.title}
                {/* A second line under the item, not a third column: the row
                    keeps its shape at 390 px and on desktop. */}
                {remindsSomeoneElse(item, currentUserIdFromToken()) && <span className="notes-reminder-sub">Reminds whoever set it</span>}
                {isNote && <span className="notes-reminder-sub">This note itself</span>}
            </span>
            <ReminderTimingMarks slot={item.slot} />
            {!isNote && <span className="notes-reminder-note">{item.note.title}</span>}
            <span className="notes-reminder-when" title={new Date(item.at).toLocaleString()}>{formatDueShort(new Date(item.at).toISOString(), now)}</span>
            {canSnooze && mayChangeSnooze(item) && <SnoozeControl item={item} actions={actions} now={now} />}
            {isNote && (
                <button
                    type="button"
                    className="notes-iconbtn small notes-reminder-clear"
                    aria-label={`Clear the reminder on ${item.note.title}`}
                    title="Clear this note's reminder"
                    onClick={e => { e.stopPropagation(); void actions.setNoteTiming(item.note.ref, { dueAt: null, schedule: null }, 'clear the reminder on'); }}
                >
                    <CloseIcon size={16} />
                </button>
            )}
        </div>
    );
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications, nativeBanner, placeItems = [], canSnooze = false }: RemindersViewProps) {
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
                <div className="notes-empty"><BellIcon size={48} /><p>No reminders. Give a note its own reminder from the clock in its footer, or any item a due time from its clock button.</p></div>
            ) : (
                <>
                    {groups.overdue.length > 0 && (
                        <section className="notes-reminder-group overdue" aria-label="Overdue">
                            <h2 className="notes-section-title">Overdue</h2>
                            {groups.overdue.map(i => <Row key={dueItemKey(i)} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} />)}
                        </section>
                    )}
                    {groups.today.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Today">
                            <h2 className="notes-section-title">Today</h2>
                            {groups.today.map(i => <Row key={dueItemKey(i)} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} />)}
                        </section>
                    )}
                    <PlaceReminders items={placeItems} actions={actions} onOpen={onOpen} />
                    {groups.upcoming.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Upcoming">
                            <h2 className="notes-section-title">Upcoming</h2>
                            {groups.upcoming.map(i => <Row key={dueItemKey(i)} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} />)}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
