/**
 * Púca Notes' Reminders view: every open item with a due time, across every
 * note — Overdue / Today / Upcoming. Ticking one completes it (the same
 * cascade as everywhere else); clicking a row opens its note.
 *
 * A THIN HOST since Púca's Tasks view grew the same view: the markup, the
 * rights checks and the "Reminds whoever set it" line are
 * components/reminders/RemindersList.tsx, exactly as the calendar is
 * components/calendar/Calendar.tsx. What stays here is what only Notes has —
 * the browser-notification banner, the Android status lines and place
 * reminders — plus the mapping from note cards to the shared source type.
 */
import { useMemo, type ReactNode } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { canCompleteTasks, canEditTask } from '../../api/tasks';
import { type DueRow } from '../../api/reminderGroups';
import { type CalendarSource } from '../../api/taskCalendar';
import { PlaceReminders } from '../native/PlaceReminders';
import { type PlaceItem } from '../native/useNotesPlaces';
import { BellIcon } from '../../components/Icons';
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
}

/** One note's item as the shared list's source. The permission answers are
 *  the note card's, resolved here so the list never sees a NoteCard. */
function sourceOf(item: DueItem, me: number | undefined): CalendarSource {
    const note = item.note;
    return {
        task: item.task,
        noteKey: note.key,
        noteTitle: note.title,
        serverName: note.serverName,
        canEdit: note.ref.kind === 'list' || canEditTask(item.task, me, note.myPerms),
        canComplete: note.ref.kind === 'list' || canCompleteTasks(note.myPerms),
    };
}

export function RemindersView({ groups, actions, now, onOpen, notificationsState, onEnableNotifications, nativeBanner, placeItems = [], canSnooze = false, flashTaskId = null }: RemindersViewProps) {
    const me = currentUserIdFromToken() ?? undefined;
    // The note each row belongs to, so a click, a tick and a snooze can name
    // it again: the shared list only carries the note KEY.
    const cards = useMemo(() => {
        const m = new Map<string, NoteCard>();
        for (const g of [groups.overdue, groups.today, groups.upcoming]) for (const i of g) m.set(i.note.key, i.note);
        return m;
    }, [groups]);
    const rows = useMemo(() => {
        const map = (list: DueItem[]): DueRow[] => list.map(i => ({ task: i.task, source: sourceOf(i, me), at: i.at, slot: i.slot }));
        return { overdue: map(groups.overdue), today: map(groups.today), upcoming: map(groups.upcoming) };
    }, [groups, me]);
    const noteOf = (row: DueRow): NoteCard | undefined => cards.get(row.source.noteKey);

    return (
        <RemindersList
            groups={rows}
            now={now}
            flashTaskId={flashTaskId}
            currentUserId={me}
            extraCount={placeItems.length}
            onOpen={row => { const c = noteOf(row); if (c) onOpen(c); }}
            onToggle={row => { const c = noteOf(row); if (c) void actions.toggleTask(c.ref, row.source.task, true); }}
            onSnooze={canSnooze ? ((row, until) => { const c = noteOf(row); if (c) void actions.snoozeTask(c.ref, row.source.task, until); }) : undefined}
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
            empty={<RemindersEmpty>No reminders. Give any item a due time from its clock button inside a note.</RemindersEmpty>}
        />
    );
}
