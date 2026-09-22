/**
 * How an item's timing reads on a reminders row — the one place the rules
 * live, for BOTH front doors: Púca Notes' Reminders view and Púca's own
 * Reminders tab (components/reminders/). Pure: no network, no DOM.
 *
 * Reminders rules:
 *  - a plain dated item is due at due_at, or at its snooze while one is in
 *    force; past = Overdue (it is a to-do nobody ticked);
 *  - a repeating TO-DO is due at its current (first unticked) occurrence;
 *  - an EVENT is never "overdue" — it happened. It is listed by its next
 *    occurrence (an event that started within the last hour still shows as
 *    today's), and a finished one-off leaves the list, so a calendar full of
 *    past appointments cannot flood Overdue or the badge.
 *
 * This file was frontend/src/notes/model/notesTiming.ts until Púca grew its
 * own Reminders tab; it moved verbatim because Púca's bundle must never
 * import from notes/ (the native shells strip that tree).
 */
import { type Task } from './tasks';
import {
    activeSnooze, currentOccurrenceKey, nextOccurrence, occurrenceOf, parseSchedule,
} from './taskSchedule';
import { parseServerTimestamp } from '../utils/serverTime';

export interface ReminderSlot {
    /** Epoch ms the row sorts and reads by. */
    at: number;
    overdue: boolean;
    kind: 'plain' | 'task' | 'event';
    repeats: boolean;
    snoozed: boolean;
}

const RECENT_EVENT_MS = 60 * 60_000;

export function reminderSlotOf(task: Task, now: number): ReminderSlot | null {
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
