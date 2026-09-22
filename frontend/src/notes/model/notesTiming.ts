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

/** Searchable text a schedule adds (its place). */
export function scheduleSearchText(task: Task): string {
    const p = parseSchedule(task.schedule);
    return p.state === 'ok' ? p.schedule.location ?? '' : '';
}

/** The schedule as export data: parsed when readable, else why not. */
export function scheduleForExport(task: Task): unknown {
    const p = parseSchedule(task.schedule);
    if (p.state === 'none') return null;
    if (p.state === 'readonly') return { unreadable: p.reason };
    return { ...p.raw, ...p.schedule };
}
