/**
 * Púca Notes — how an item's timing reads in the Reminders view, the card
 * chips, "Edited", search and export. Pure; Notes' shared model files call in
 * here with one-line insertions so the timing rules live in one place.
 *
 * Reminders rules:
 *  - a plain dated item is due at due_at, or at its snooze while one is in
 *    force; past = Overdue (it is a to-do nobody ticked);
 *  - a repeating TO-DO is due at its current (first unticked) occurrence;
 *  - an EVENT is never "overdue" — it happened. It is listed by its next
 *    occurrence (an event that started within the last hour still shows as
 *    today's), and a finished one-off leaves the list, so a calendar full of
 *    past appointments cannot flood Overdue or the badge.
 */
import { type Task } from '../../api/tasks';
import {
    activeSnooze, currentOccurrenceKey, nextOccurrence, occurrenceOf, parseSchedule,
} from '../../api/taskSchedule';
import { parseServerTimestamp } from '../../utils/serverTime';

/** Everything reminderSlotOf needs. A task has all four; a NOTE's own
 *  reminder (migration 068) has a due_at and a schedule, is never
 *  "completed", and has no snooze column yet — so it passes the same rule
 *  through this shape rather than a second copy of it. */
export type TimingLike = Pick<Task, 'is_completed' | 'due_at' | 'schedule' | 'snooze'>;

export interface ReminderSlot {
    /** Epoch ms the row sorts and reads by. */
    at: number;
    overdue: boolean;
    kind: 'plain' | 'task' | 'event';
    repeats: boolean;
    snoozed: boolean;
}

const RECENT_EVENT_MS = 60 * 60_000;

export function reminderSlotOf(task: TimingLike, now: number): ReminderSlot | null {
    if (task.is_completed) return null;
    const parsed = parseSchedule(task.schedule);
    const snooze = activeSnooze(task.due_at, task.snooze);
    const snoozedUntil = snooze ? Date.parse(snooze.until) : NaN;
    const snoozedAhead = Number.isFinite(snoozedUntil) && snoozedUntil > now;
    if (parsed.state === 'ok') {
        const s = parsed.schedule;
        if (s.kind === 'event') {
            const next = nextOccurrence(s, now - RECENT_EVENT_MS);
            if (!next) return null;
            return { at: next.startMs, overdue: false, kind: 'event', repeats: !!s.rrule, snoozed: snoozedAhead };
        }
        const key = currentOccurrenceKey(s);
        const cur = key ? occurrenceOf(s, key) : null;
        if (!cur) return null;
        if (snoozedAhead) return { at: snoozedUntil, overdue: false, kind: 'task', repeats: !!s.rrule, snoozed: true };
        const due = cur.allDay ? cur.endMs : cur.startMs;
        return { at: cur.startMs, overdue: due <= now, kind: 'task', repeats: !!s.rrule, snoozed: false };
    }
    if (parsed.state === 'readonly') {
        // Unreadable schedule: fall back to the plaintext reminder time, the
        // one thing we do know, rather than hide the item.
        if (!task.due_at) return null;
    }
    if (!task.due_at) return null;
    const due = parseServerTimestamp(task.due_at);
    if (!Number.isFinite(due)) return null;
    if (snoozedAhead) return { at: snoozedUntil, overdue: false, kind: 'plain', repeats: false, snoozed: true };
    return { at: due, overdue: due <= now, kind: 'plain', repeats: false, snoozed: false };
}

/** A note's "edited" time: the newest of the list's own stamp and its items'
 *  (a shared note has no list row, so its items are all there is — a deleted
 *  item there does not count, which docs/NOTES.md says). */
export function noteUpdatedAt(listUpdatedAt: string | undefined, tasks: Task[] | null): string | undefined {
    let best = listUpdatedAt ? parseServerTimestamp(listUpdatedAt) : NaN;
    for (const t of tasks ?? []) {
        const u = t.updated_at ? parseServerTimestamp(t.updated_at) : NaN;
        if (Number.isFinite(u) && !(u <= best)) best = u;
    }
    return Number.isFinite(best) ? new Date(best).toISOString() : listUpdatedAt;
}

/** The same rule for a NOTE's own reminder: never completed, no snooze. */
export function noteReminderSlotOf(
    note: { dueAt?: string | null; schedule?: string | null },
    now: number,
): ReminderSlot | null {
    if (!note.dueAt && !note.schedule) return null;
    return reminderSlotOf({ is_completed: false, due_at: note.dueAt ?? null, schedule: note.schedule ?? null, snooze: null }, now);
}

/** Searchable text a schedule adds (its place). */
export function scheduleSearchText(task: Task): string {
    const p = parseSchedule(task.schedule);
    return p.state === 'ok' ? p.schedule.location ?? '' : '';
}

/** Searchable text the NOTE's own schedule adds (its place). */
export function noteScheduleSearchText(note: { schedule?: string | null }): string {
    const p = parseSchedule(note.schedule);
    return p.state === 'ok' ? p.schedule.location ?? '' : '';
}

/** The schedule as export data: parsed when readable, else why not. Takes
 *  only the field it reads, so a NOTE's own schedule (migration 068) goes
 *  through the SAME rule rather than a second copy of it. */
export function scheduleForExport(task: Pick<Task, 'schedule'>): unknown {
    const p = parseSchedule(task.schedule);
    if (p.state === 'none') return null;
    if (p.state === 'readonly') return { unreadable: p.reason };
    return { ...p.raw, ...p.schedule };
}

/** The NOTE's own schedule as export data, beside noteScheduleSearchText.
 *  An export that carried every item's time but not the note's would lose
 *  the reminder on a note that has no items at all — which is exactly the
 *  note 068 exists for. */
export function noteScheduleForExport(note: { schedule?: string | null }): unknown {
    return scheduleForExport({ schedule: note.schedule ?? null });
}
