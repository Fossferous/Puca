/**
 * The reminder feed with timing: snoozes and scheduled items.
 *
 * GET /task-reminders (066+) hands each row its SEALED snooze and schedule.
 * This module opens them and turns the feed into the contract every reminder
 * engine shares — the web/desktop loop here and the native Notes alarm
 * engine alike:
 *
 *     { id, at, mark }
 *       at   = when to remind, ms epoch: the snooze's time while a snooze is
 *              in force for the current due_at, else due_at
 *       mark = changes whenever the item must fire again: due_at alone when
 *              nothing is snoozed (so fired-markers written before snoozes
 *              existed stay valid and nothing re-fires on upgrade), else
 *              `${due_at}|${until}`
 *
 * Opening FAILS OPEN: a snooze that cannot be read means "remind at due_at",
 * never "stay quiet".
 *
 * It also owns ADVANCING a scheduled event's due_at after its alert fired —
 * the one writer of a derived due_at besides an editor saving the schedule,
 * and never a passive one: only this firing path, only once the alert is
 * GRACE_MS old (so every other running device has polled and fired it
 * first; their loops poll every 5 minutes), and only through
 * expect_due_at so two devices advancing at once cannot both win.
 */
import { type TaskReminder, openReminderTiming, patchTaskTiming } from './tasks';
import { activeSnooze, nextReminderAfter, parseSchedule } from './taskSchedule';
import { parseServerTimestamp } from '../utils/serverTime';
import { ApiError } from './client';

export interface ReminderEntry {
    id: number;
    at: number;
    mark: string;
}

export interface OpenedReminder extends TaskReminder {
    /** Opened (plaintext) timing, when the server sent any. */
    openSchedule?: string | null;
    openSnooze?: string | null;
}

/** Long enough that every device polling every 5 minutes has fired it. */
export const ADVANCE_GRACE_MS = 15 * 60_000;

export function reminderMark(dueAt: string, snoozeUntil: string | null): string {
    return snoozeUntil ? `${dueAt}|${snoozeUntil}` : dueAt;
}

/** Open the sealed timing of every row; a row that fails to open keeps its
 *  plain due_at (fail open). */
export async function openReminderFeed(rows: TaskReminder[]): Promise<OpenedReminder[]> {
    return Promise.all(rows.map(async r => {
        if (r.schedule === undefined && r.snooze === undefined) return r;
        try {
            const o = await openReminderTiming(r);
            return { ...r, openSchedule: o.schedule, openSnooze: o.snooze };
        } catch {
            return r;
        }
    }));
}

/** The shared {id, at, mark} contract. */
export function toReminderEntries(rows: OpenedReminder[]): ReminderEntry[] {
    const out: ReminderEntry[] = [];
    for (const r of rows) {
        const due = parseServerTimestamp(r.due_at);
        if (!Number.isFinite(due)) continue;
        const s = activeSnooze(r.due_at, r.openSnooze);
        const until = s ? Date.parse(s.until) : NaN;
        out.push(Number.isFinite(until)
            ? { id: r.id, at: until, mark: reminderMark(r.due_at, s!.until) }
            : { id: r.id, at: due, mark: reminderMark(r.due_at, null) });
    }
    return out;
}

export interface EntryPlan {
    toFire: ReminderEntry[];
    nextAt: number | null;
    prunedFired: Record<string, string>;
}

/** planReminders' rule over entries: fire what is due and not yet fired for
 *  this exact mark; prune markers of vanished items. */
export function planEntries(entries: ReminderEntry[], fired: Record<string, string>, now: number): EntryPlan {
    const toFire: ReminderEntry[] = [];
    const prunedFired: Record<string, string> = {};
    let nextAt: number | null = null;
    for (const e of entries) {
        const key = String(e.id);
        if (e.at <= now) {
            if (fired[key] !== e.mark) toFire.push(e);
            prunedFired[key] = e.mark;
        } else if (nextAt === null || e.at < nextAt) {
            nextAt = e.at;
        }
    }
    return { toFire, nextAt, prunedFired };
}

export interface Advance {
    row: OpenedReminder;
    /** The next reminder instant, or null when the event has nothing left. */
    nextDue: string | null;
}

/**
 * Which scheduled EVENTS to move to their next reminder: fired (effective
 * time passed) at least GRACE ago. A repeating TASK is never advanced here —
 * it stays due until someone ticks it. Also returns when to look again for
 * the ones still inside the grace window.
 */
export function planAdvances(rows: OpenedReminder[], now: number, graceMs = ADVANCE_GRACE_MS): { advances: Advance[]; nextCheckAt: number | null } {
    const advances: Advance[] = [];
    let nextCheckAt: number | null = null;
    for (const r of rows) {
        const parsed = parseSchedule(r.openSchedule);
        if (parsed.state !== 'ok' || parsed.schedule.kind !== 'event' || parsed.schedule.privateTiming) continue;
        const due = parseServerTimestamp(r.due_at);
        if (!Number.isFinite(due)) continue;
        const s = activeSnooze(r.due_at, r.openSnooze);
        const effective = s ? Date.parse(s.until) : due;
        const ready = effective + graceMs;
        if (ready > now) {
            if (nextCheckAt === null || ready < nextCheckAt) nextCheckAt = ready;
            continue;
        }
        const next = nextReminderAfter(parsed.schedule, Math.max(now, due));
        advances.push({ row: r, nextDue: next === null ? null : new Date(next).toISOString() });
    }
    return { advances, nextCheckAt };
}

/** Send the advances. A 409 means another device advanced (or someone edited)
 *  first — nothing to do. */
export async function applyAdvances(advances: Advance[]): Promise<number> {
    let done = 0;
    for (const a of advances) {
        try {
            await patchTaskTiming(
                { id: a.row.id, channel_id: a.row.channel_id, created_by: a.row.created_by ?? -1 },
                { due_at: a.nextDue, expect_due_at: a.row.due_at },
            );
            done++;
        } catch (err) {
            if (!(err instanceof ApiError && err.status === 409)) console.warn('[reminders] advance failed:', err);
        }
    }
    return done;
}
