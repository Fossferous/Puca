/**
 * Púca Notes — how an item's timing reads in the card chips, "Edited", search
 * and export. Pure; Notes' shared model files call in here with one-line
 * insertions so the timing rules live in one place.
 *
 * The Reminders-row rules (ReminderSlot / reminderSlotOf) moved to
 * frontend/src/api/reminderSlots.ts when Púca grew its own Reminders tab:
 * both front doors read them from there now.
 */
import { type Task } from '../../api/tasks';
import { parseSchedule } from '../../api/taskSchedule';
import { type ReminderSlot, reminderSlotOf } from '../../api/reminderSlots';
import { parseServerTimestamp } from '../../utils/serverTime';

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
