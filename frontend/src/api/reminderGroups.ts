/**
 * Overdue / Today / Upcoming — the bucketing both Reminders views use.
 *
 * Pure and host-agnostic, like api/taskCalendar.ts beside it: Púca's Reminders
 * tab hands it the same CalendarSource[] it hands the Calendar, and Púca
 * Notes' model hands it the rows it already builds from its note cards. One
 * implementation, so the two front doors cannot disagree about what is
 * overdue.
 */
import { type Task, isTaskOverdue } from './tasks';
import { type ReminderSlot, reminderSlotOf } from './reminderSlots';
import { maySnooze } from './taskSchedule';
import { type CalendarSource } from './taskCalendar';

/** The least a row needs to be sorted and bucketed. */
export interface DueLike {
    task: Task;
    /** Epoch ms the row sorts and reads by (slot.at). */
    at: number;
    slot?: ReminderSlot;
}

export interface Grouped<T> {
    overdue: T[];
    today: T[];
    upcoming: T[];
}

/** One due item in a Reminders list, with where it lives. `slot` is optional
 *  only because a host may hand in a row it worked out itself;
 *  groupReminderSources always fills it. */
export interface DueRow extends DueLike {
    source: CalendarSource;
}

export type ReminderRowGroups = Grouped<DueRow>;

function sameLocalDay(a: number, b: number): boolean {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Sort soonest-first (id breaks a tie so the order is stable) and bucket.
 * A row whose caller supplied no slot is judged by the plain due_at rule
 * (api/tasks.isTaskOverdue) — the behaviour Notes had before the slot rules
 * existed, kept so a hand-built group reads the same.
 */
export function bucketDue<T extends DueLike>(items: T[], now: number): Grouped<T> {
    const sorted = [...items].sort((a, b) => a.at - b.at || a.task.id - b.task.id);
    const groups: Grouped<T> = { overdue: [], today: [], upcoming: [] };
    for (const it of sorted) {
        if (it.slot ? it.slot.overdue : isTaskOverdue(it.task, now)) groups.overdue.push(it);
        else if (sameLocalDay(it.at, now)) groups.today.push(it);
        else groups.upcoming.push(it);
    }
    return groups;
}

/**
 * Every open item with a due time across the given sources (an archived note's
 * included — archiving does not cancel a reminder, which is also what the
 * reminder loop fires for), grouped for display.
 */
export function groupReminderSources(sources: CalendarSource[], now: number): ReminderRowGroups {
    const rows: DueRow[] = [];
    for (const source of sources) {
        // Snoozes, repeats and events (reminderSlots.reminderSlotOf): an
        // event is never overdue, a snoozed item sorts by its snooze.
        const slot = reminderSlotOf(source.task, now);
        if (!slot) continue;
        rows.push({ task: source.task, source, at: slot.at, slot });
    }
    return bucketDue(rows, now);
}

/** How many reminders deserve a badge: overdue + due today. */
export function reminderBadgeCount(groups: Grouped<unknown>): number {
    return groups.overdue.length + groups.today.length;
}

/** A due item in a SHARED checklist that someone else created: GET
 *  /task-reminders covers only the channel tasks the caller created, so it
 *  reminds whoever set it — never this user. Said on the row rather than
 *  implied, and it matters most in Púca, whose sources carry every member's
 *  items rather than only the caller's. */
export function remindsSomeoneElse(source: CalendarSource, me: number | undefined): boolean {
    return source.noteKey.startsWith('channel:') && me !== undefined && source.task.created_by !== me;
}

/** Snooze rides the completion right; an editor's MOVED snooze is further
 *  off-limits to a member who may not edit the item's time
 *  (taskSchedule.snoozeLocked). A personal list (canComplete omitted) is
 *  always yours. */
export function mayChangeSnooze(source: CalendarSource): boolean {
    return maySnooze(source.task, source.canComplete !== false, source.canEdit);
}
