/**
 * Every open item with a due time, across every note: Overdue / Today /
 * Upcoming. Ticking one completes it (the same cascade as everywhere else);
 * clicking a row opens its note.
 *
 * MOVING one is the commonest thing to do with a reminder, so the row does it
 * without opening the note: a clock button that is a plain due-time field for
 * a plain dated item, and the calendar's own Date & repeat dialog for an item
 * that repeats or is an event. Both write through the same NoteActions the
 * note tree uses (optimistic, through the outbox, poking the reminder feed),
 * and neither sends `expect_due_at` — a retime is last-writer-wins here
 * exactly as it already is from the calendar and from inside a note.
 *
 * It is offered only to someone who may edit the item's TIME (its creator, a
 * task manager, any personal note), which is what the server enforces — NOT
 * the snooze right, which is a different permission on a different field.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { canCompleteTasks, canEditTask, dueToLocalInput, formatDueShort, localInputToIso } from '../../api/tasks';
import { parseSchedule, snoozeLocked } from '../../api/taskSchedule';
import { ScheduleEditor } from '../../components/schedule/ScheduleEditor';
import { useReminderTimes } from '../model/notesPrefs';
import { PlaceReminders } from '../native/PlaceReminders';
import { type PlaceItem } from '../native/useNotesPlaces';
import { BellIcon, ClockIcon } from '../../components/Icons';
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
    /** The Android app's own status lines (notes/native/); renders nothing elsewhere. */
    nativeBanner?: ReactNode;
    /** Open items with a place saved on this phone (Android app only). */
    placeItems?: PlaceItem[];
    /** The server stores snoozes (taskFeatures). */
    canSnooze?: boolean;
    /** The server stores schedules (taskFeatures): without it the Date &
     *  repeat dialog is not offered, and only a plain due time can be moved. */
    canSchedule?: boolean;
    /** A modal opened from a row (the schedule dialog) — the shell turns its
     *  single-key shortcuts off while it is up: `isEditableTarget` says false
     *  for a <select>, and that dialog is full of them. */
    onModal?: (open: boolean) => void;
}

/** A due item in a SHARED note that someone else created: GET /task-reminders
 *  covers only the channel tasks the caller created, so it reminds whoever
 *  set it — never this user. Said on the row rather than implied. */
function remindsSomeoneElse(item: DueItem, me: number | null): boolean {
    return item.note.ref.kind === 'channel' && me !== null && item.task.created_by !== me;
}

/** Snooze rides the completion right; an editor's MOVED snooze is further
 *  off-limits to a member who may not edit the item's time
 *  (taskSchedule.snoozeLocked). A personal note is always yours. */
function mayChangeSnooze(item: DueItem): boolean {
    if (item.note.ref.kind === 'list') return true;
    if (!canCompleteTasks(item.note.myPerms)) return false;
    return !snoozeLocked(item.task, canEditTask(item.task, currentUserIdFromToken() ?? undefined, item.note.myPerms));
}

/** May this user change WHEN the item is due? The server's own rule
 *  (task_handlers.rs: due_at and schedule ride creator-or-MANAGE_TASKS), and
 *  the same predicate notesQueries.canEditTime uses. */
function mayRetime(item: DueItem): boolean {
    if (item.note.ref.kind === 'list') return true;
    return canEditTask(item.task, currentUserIdFromToken() ?? undefined, item.note.myPerms);
}

/**
 * Retime from the row. A plain dated item gets the same due-time field the
 * note tree has (no feature gate — a server without schedules still stores a
 * due_at); an item that carries a schedule opens the editor the calendar
 * uses, because rewriting a repeat as a bare due time would destroy it.
 *
 * Nothing clears the snooze: it lapses by itself once due_at matches neither
 * `forDue` nor `until` (taskSchedule.activeSnooze), and sending a snooze
 * field would drag in the COMPLETE_TASKS right that a channel-task creator
 * may not have — a retime they are otherwise allowed would 403.
 */
function RetimeControl({ item, actions, canSchedule, onModal }: { item: DueItem; actions: NoteActions; canSchedule: boolean; onModal?: (open: boolean) => void }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const times = useReminderTimes();
    const scheduled = parseSchedule(item.task.schedule).state !== 'none';
    // The shell's flag is driven from the state, not from the two call sites:
    // a row can UNMOUNT with the dialog still up — the item crosses
    // Today/Overdue on the half-minute tick, another device completes or
    // retimes it, a refresh re-groups the feed — and a close() that never
    // runs would leave `c`, `r`, `?` and `/` dead for the rest of the
    // session. The cleanup runs on unmount as well as on close.
    useEffect(() => {
        if (!(editing && scheduled)) return;
        onModal?.(true);
        return () => onModal?.(false);
    }, [editing, scheduled, onModal]);
    if (scheduled && !canSchedule) return null;

    const close = () => setEditing(false);
    const openIt = () => {
        if (editing) { close(); return; }
        setDraft(dueToLocalInput(item.task.due_at));
        setEditing(true);
    };
    const commit = () => {
        const iso = localInputToIso(draft);
        close();
        if (iso === null && draft.trim() !== '') return;          // unparseable: leave it alone
        if (dueToLocalInput(item.task.due_at) === draft) return;  // unchanged
        void actions.setDue(item.note.ref, item.task, iso);
    };

    return (
        <span className={`notes-retime${editing && !scheduled ? ' open' : ''}`} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <button
                type="button"
                className="notes-iconbtn small"
                aria-label={`Change the time: ${item.task.description}`}
                aria-expanded={editing}
                title="Change the time"
                onClick={openIt}
            >
                <ClockIcon />
            </button>
            {editing && !scheduled && (
                <span className="notes-retime-edit">
                    <input
                        type="datetime-local"
                        value={draft}
                        autoFocus
                        aria-label="New time"
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') commit();
                            if (e.key === 'Escape') { e.preventDefault(); close(); }
                        }}
                    />
                    <button type="button" className="notes-textbtn" onClick={commit}>Set</button>
                </span>
            )}
            {editing && scheduled && (
                <ScheduleEditor
                    task={item.task}
                    times={times}
                    onClose={close}
                    onSave={(schedule, dueAt) => { close(); void actions.setSchedule(item.note.ref, item.task, schedule, dueAt); }}
                />
            )}
        </span>
    );
}

function Row({ item, actions, now, onOpen, canSnooze = false, canSchedule = false, onModal }: { item: DueItem; actions: NoteActions; now: number; onOpen: (c: NoteCard) => void; canSnooze?: boolean; canSchedule?: boolean; onModal?: (open: boolean) => void }) {
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
            <span className="notes-reminder-text">
                {item.task.description}
                {/* A second line under the item, not a third column: the row
                    keeps its shape at 390 px and on desktop. */}
                {remindsSomeoneElse(item, currentUserIdFromToken()) && <span className="notes-reminder-sub">Reminds whoever set it</span>}
            </span>
            <ReminderTimingMarks slot={item.slot} />
            <span className="notes-reminder-note">{item.note.title}</span>
            <span className="notes-reminder-when" title={new Date(item.at).toLocaleString()}>{formatDueShort(new Date(item.at).toISOString(), now)}</span>
            {mayRetime(item) && <RetimeControl item={item} actions={actions} canSchedule={canSchedule} onModal={onModal} />}
            {canSnooze && mayChangeSnooze(item) && <SnoozeControl item={item} actions={actions} now={now} />}
        </div>
    );
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications, nativeBanner, placeItems = [], canSnooze = false, canSchedule = false, onModal }: RemindersViewProps) {
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
                            {groups.overdue.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} canSchedule={canSchedule} onModal={onModal} />)}
                        </section>
                    )}
                    {groups.today.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Today">
                            <h2 className="notes-section-title">Today</h2>
                            {groups.today.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} canSchedule={canSchedule} onModal={onModal} />)}
                        </section>
                    )}
                    <PlaceReminders items={placeItems} actions={actions} onOpen={onOpen} />
                    {groups.upcoming.length > 0 && (
                        <section className="notes-reminder-group" aria-label="Upcoming">
                            <h2 className="notes-section-title">Upcoming</h2>
                            {groups.upcoming.map(i => <Row key={i.task.id} item={i} actions={actions} now={now} onOpen={onOpen} canSnooze={canSnooze} canSchedule={canSchedule} onModal={onModal} />)}
                        </section>
                    )}
                </>
            )}
        </div>
    );
}
