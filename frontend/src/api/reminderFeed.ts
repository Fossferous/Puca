/**
 * The reminder feed with timing: snoozes and scheduled items.
 *
 * GET /task-reminders (066+) hands each row its SEALED snooze and schedule.
 * This module opens them and turns the feed into the contract every reminder
 * engine shares — the web/desktop loop here and the native Notes alarm
 * engine alike:
 *
 *     { id, at, mark, due }
 *       at   = when to remind, ms epoch: the snooze's time while a snooze is
 *              in force for the current due_at, else due_at
 *       mark = changes whenever the item must fire again: due_at alone when
 *              nothing is snoozed (so fired-markers written before snoozes
 *              existed stay valid and nothing re-fires on upgrade), else
 *              `${due_at}|${until}`; for a REPEATING item, the canonical ISO
 *              of the reminder instant (see below)
 *       due  = the server's raw due_at the entry was derived from, so a
 *              native background refresh can tell "unchanged" from "moved
 *              on another device" (Púca Notes' ReminderMerge.java)
 *
 * A REPEATING item (a sealed rrule, time not private) also gets one entry per
 * upcoming reminder within OCCURRENCE_HORIZON_MS, same id, each with its own
 * mark = that instant's ISO string — exactly the string due_at will hold once
 * the item is advanced there, so an occurrence a phone fired while Notes was
 * closed does not fire again when the advance lands. The native engine can
 * then arm them with the app closed; it cannot open the sealed rule itself.
 * Several entries share an id, so a planner must fire only the LATEST past
 * entry per id (planEntries does).
 *
 * TWO ID NAMESPACES IN ONE FEED. A row whose id is NEGATIVE is a NOTE'S OWN
 * reminder (migration 068): `id = -list_id`, `list_id` names the note,
 * `channel_id` is null. Task ids are always positive, so `5` and `-5` are
 * different reminders and no per-id map here, in planEntries' fired markers,
 * or in Púca Notes' Java engine can confuse them. Everything in this file is
 * id-agnostic on purpose; the ONE place the difference matters is
 * applyAdvances, which must PATCH the list rather than a task that does not
 * exist.
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
import { type TaskReminder, isNoteReminderId, openReminderTiming, patchTaskTiming } from './tasks';
import { setTaskListTiming } from './listContent';
import { activeSnooze, nextReminderAfter, parseSchedule, snoozeMovedDue } from './taskSchedule';
import { parseServerTimestamp } from '../utils/serverTime';
import { ApiError } from './client';

/**
 * One reminder, as EVERY engine sees it — this loop, and Púca Notes' Android
 * alarms (NotesNative.syncReminders; ReminderPlan.Entry is its Java twin).
 * Ids and times only, never content.
 */
export interface ReminderEntry {
    id: number;
    /** When to remind, epoch ms (a snooze included). */
    at: number;
    /** Changes whenever the item must fire again. */
    mark: string;
    /** The server's raw due_at this entry came from: how a native background
     *  refresh tells "unchanged" (keep every entry of the id) from "moved on
     *  another device" (start over from the server's time). */
    due: string;
}

/** How far ahead a repeating item's later reminders are handed out. */
export const OCCURRENCE_HORIZON_MS = 14 * 86_400_000;
/** At most this many entries per item (an hourly rule would be 336). */
export const MAX_ENTRIES_PER_ITEM = 24;
/** Later occurrences are looked for from no earlier than this before now: an
 *  item not advanced for weeks must not spend its budget on the past. */
const OCCURRENCE_LOOKBACK_MS = 86_400_000;

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

/** The shared {id, at, mark, due} contract. */
export function toReminderEntries(rows: OpenedReminder[], nowMs: number = Date.now()): ReminderEntry[] {
    const out: ReminderEntry[] = [];
    for (const r of rows) {
        const due = parseServerTimestamp(r.due_at);
        if (!Number.isFinite(due)) continue;
        const s = activeSnooze(r.due_at, r.openSnooze);
        // MOVED form: due_at already IS the snooze instant (taskSchedule).
        const moved = snoozeMovedDue(r.due_at, s);
        const until = s && !moved ? Date.parse(s.until) : NaN;
        const parsed = parseSchedule(r.openSchedule);
        const series = parsed.state === 'ok' && parsed.schedule.rrule && !parsed.schedule.privateTiming ? parsed.schedule : null;
        const primary: ReminderEntry = Number.isFinite(until)
            ? { id: r.id, at: until, mark: reminderMark(r.due_at, s!.until), due: r.due_at }
            : { id: r.id, at: due, mark: series ? new Date(due).toISOString() : reminderMark(r.due_at, null), due: r.due_at };
        out.push(primary);
        if (!series) continue;
        // The series' later reminders, from the item's own time (a snooze
        // pushed one reminder back, not the series).
        const base = moved ? Date.parse(s!.forDue) : due;
        let t = Math.max(Number.isFinite(base) ? base : due, nowMs - OCCURRENCE_LOOKBACK_MS);
        for (let n = 1; n < MAX_ENTRIES_PER_ITEM; n++) {
            const next = nextReminderAfter(series, t);
            if (next === null || next > nowMs + OCCURRENCE_HORIZON_MS) break;
            if (next !== primary.at) out.push({ id: r.id, at: next, mark: new Date(next).toISOString(), due: r.due_at });
            t = next;
        }
    }
    return out;
}

export interface EntryPlan {
    toFire: ReminderEntry[];
    nextAt: number | null;
    prunedFired: Record<string, string>;
}

/** planReminders' rule over entries: fire what is due and not yet fired for
 *  this exact mark; prune markers of vanished items. An id may have several
 *  entries (a repeating item's occurrences): only its LATEST past one counts,
 *  or two past occurrences would take turns overwriting the one marker and
 *  fire again on every pass. */
export function planEntries(entries: ReminderEntry[], fired: Record<string, string>, now: number): EntryPlan {
    const latestPast = new Map<number, ReminderEntry>();
    let nextAt: number | null = null;
    for (const e of entries) {
        if (e.at <= now) {
            const cur = latestPast.get(e.id);
            if (!cur || e.at > cur.at) latestPast.set(e.id, e);
        } else if (nextAt === null || e.at < nextAt) {
            nextAt = e.at;
        }
    }
    const toFire: ReminderEntry[] = [];
    const prunedFired: Record<string, string> = {};
    for (const e of latestPast.values()) {
        const key = String(e.id);
        if (fired[key] !== e.mark) toFire.push(e);
        prunedFired[key] = e.mark;
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
 *  first — nothing to do.
 *
 *  A NOTE'S OWN event (a negative id) is advanced on the LIST, through the
 *  same compare-and-swap: `/tasks/-5` is not a route to a note, and a client
 *  that sent one would get a 404 on every cycle for ever. */
export async function applyAdvances(advances: Advance[]): Promise<number> {
    let done = 0;
    for (const a of advances) {
        try {
            if (isNoteReminderId(a.row.id)) {
                await setTaskListTiming(-a.row.id, { dueAt: a.nextDue, expectDueAt: a.row.due_at });
            } else {
                await patchTaskTiming(
                    { id: a.row.id, channel_id: a.row.channel_id, created_by: a.row.created_by ?? -1 },
                    { due_at: a.nextDue, expect_due_at: a.row.due_at },
                );
            }
            done++;
        } catch (err) {
            if (!(err instanceof ApiError && err.status === 409)) console.warn('[reminders] advance failed:', err);
        }
    }
    return done;
}
