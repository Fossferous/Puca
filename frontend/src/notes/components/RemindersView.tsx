/**
 * Púca Notes' Reminders view: everything due, across every note — Overdue /
 * Today / Upcoming. Two kinds of row, and the difference matters —
 *
 *  - an ITEM inside a note: ticking it completes it (the same cascade as
 *    everywhere else), it can be snoozed, and it can be MOVED from the row;
 *  - the NOTE'S OWN reminder (migration 068): there is nothing to tick, so
 *    it has no checkbox and no Snooze (068 has no snooze column). Its action
 *    is "Clear reminder", which is the only thing a note reminder can do
 *    besides being moved.
 *
 * Clicking either opens the note.
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
 *
 * A THIN HOST since Púca's Tasks view grew the same view: the markup, the
 * rights checks and the "Reminds whoever set it" line are
 * components/reminders/RemindersList.tsx, exactly as the calendar is
 * components/calendar/Calendar.tsx. What stays here is what only Notes has —
 * the browser-notification banner, the Android status lines, place reminders
 * and the retime control — plus the mapping from note cards to the shared
 * source type.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { type Task, canCompleteTasks, canEditTask, dueToLocalInput, localInputToIso } from '../../api/tasks';
import { parseSchedule } from '../../api/taskSchedule';
import { type DueRow } from '../../api/reminderGroups';
import { type CalendarSource, noteAsCalendarItem } from '../../api/taskCalendar';
import { ScheduleEditor } from '../../components/schedule/ScheduleEditor';
import { useReminderTimes } from '../model/notesPrefs';
import { PlaceReminders } from '../native/PlaceReminders';
import { type PlaceItem } from '../native/useNotesPlaces';
import { BellIcon, ClockIcon } from '../../components/Icons';
import { RemindersEmpty, RemindersList } from '../../components/reminders/RemindersList';
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
    /** The one item a due notification came for: its row is scrolled to and
     *  flashed, so "an item is due" lands on WHICH item. An id only — the
     *  text is decrypted here, in the page, after the tap. */
    flashTaskId?: number | null;
    /** The server stores schedules (taskFeatures): without it the Date &
     *  repeat dialog is not offered, and only a plain due time can be moved. */
    canSchedule?: boolean;
    /** A modal opened from a row (the schedule dialog) — the shell turns its
     *  single-key shortcuts off while it is up: `isEditableTarget` says false
     *  for a <select>, and that dialog is full of them. */
    onModal?: (open: boolean) => void;
}

/** One reminder row as the shared list's source. An ITEM carries the note
 *  card's permission answers; the NOTE'S OWN reminder (068) is projected
 *  through api/taskCalendar.noteAsCalendarItem — the same negative-id
 *  projection the calendar uses — and marked `isNote`, which is what tells
 *  the shared row to drop the checkbox, the snooze and the note column and
 *  to offer Clear instead. Resolved here so the list never sees a NoteCard. */
function sourceOf(item: DueItem, me: number | undefined): CalendarSource {
    const note = item.note;
    if (item.kind === 'note') {
        return {
            task: noteAsCalendarItem({ id: note.ref.id, title: note.title, dueAt: note.dueAt, schedule: note.schedule }),
            noteKey: note.key,
            noteTitle: note.title,
            serverName: note.serverName,
            // A note's own reminder exists on personal notes only (a channel
            // checklist has no list row to hang a time on), so it is always
            // this user's to move — and there is nothing to complete.
            canEdit: true,
            canComplete: false,
            isNote: true,
        };
    }
    return {
        task: item.task,
        noteKey: note.key,
        noteTitle: note.title,
        serverName: note.serverName,
        canEdit: note.ref.kind === 'list' || canEditTask(item.task, me, note.myPerms),
        canComplete: note.ref.kind === 'list' || canCompleteTasks(note.myPerms),
    };
}

/** May this user change WHEN the item is due? The server's own rule
 *  (task_handlers.rs: due_at and schedule ride creator-or-MANAGE_TASKS), and
 *  the same predicate notesQueries.canEditTime uses. */
function mayRetime(source: CalendarSource): boolean {
    return source.canEdit && !source.isNote;
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
function RetimeControl({ task, note, actions, canSchedule, onModal }: {
    task: Task;
    note: NoteCard;
    actions: NoteActions;
    canSchedule: boolean;
    onModal?: (open: boolean) => void;
}) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const times = useReminderTimes();
    const scheduled = parseSchedule(task.schedule).state !== 'none';
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
        setDraft(dueToLocalInput(task.due_at));
        setEditing(true);
    };
    const commit = () => {
        const iso = localInputToIso(draft);
        close();
        if (iso === null && draft.trim() !== '') return;      // unparseable: leave it alone
        if (dueToLocalInput(task.due_at) === draft) return;   // unchanged
        void actions.setDue(note.ref, task, iso);
    };

    return (
        <span className={`notes-retime${editing && !scheduled ? ' open' : ''}`} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
            <button
                type="button"
                className="notes-iconbtn small"
                aria-label={`Change the time: ${task.description}`}
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
                    task={task}
                    times={times}
                    onClose={close}
                    onSave={(schedule, dueAt) => { close(); void actions.setSchedule(note.ref, task, schedule, dueAt); }}
                />
            )}
        </span>
    );
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications, nativeBanner, placeItems = [], canSnooze = false, flashTaskId = null, canSchedule = false, onModal }: RemindersViewProps) {
    const me = currentUserIdFromToken() ?? undefined;
    const times = useReminderTimes();
    // The note each row belongs to, so a click, a tick and a snooze can name
    // it again: the shared list only carries the note KEY.
    const cards = useMemo(() => {
        const m = new Map<string, NoteCard>();
        for (const g of [groups.overdue, groups.today, groups.upcoming]) for (const i of g) m.set(i.note.key, i.note);
        return m;
    }, [groups]);
    const rows = useMemo(() => {
        const map = (list: DueItem[]): DueRow[] => list.map(i => {
            const source = sourceOf(i, me);
            return { task: source.task, source, at: i.at, slot: i.slot };
        });
        return { overdue: map(groups.overdue), today: map(groups.today), upcoming: map(groups.upcoming) };
    }, [groups, me]);
    const noteOf = (row: DueRow): NoteCard | undefined => cards.get(row.source.noteKey);

    return (
        <RemindersList
            groups={rows}
            now={now}
            flashTaskId={flashTaskId}
            currentUserId={me}
            times={times}
            extraCount={placeItems.length}
            onOpen={row => { const c = noteOf(row); if (c) onOpen(c); }}
            onToggle={row => { const c = noteOf(row); if (c) void actions.toggleTask(c.ref, row.source.task, true); }}
            onSnooze={canSnooze ? ((row, until) => { const c = noteOf(row); if (c) void actions.snoozeTask(c.ref, row.source.task, until); }) : undefined}
            onClearNote={row => { const c = noteOf(row); if (c) void actions.setNoteTiming(c.ref, { dueAt: null, schedule: null }, 'clear the reminder on'); }}
            rowExtra={row => {
                const c = noteOf(row);
                if (!c || !mayRetime(row.source)) return null;
                return <RetimeControl task={row.source.task} note={c} actions={actions} canSchedule={canSchedule} onModal={onModal} />;
            }}
            header={(
                <>
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
                </>
            )}
            middle={<PlaceReminders items={placeItems} actions={actions} onOpen={onOpen} />}
            empty={<RemindersEmpty>No reminders. Give a note its own reminder from the clock in its footer, or any item a due time from its clock button.</RemindersEmpty>}
        />
    );
}
