/**
 * EventSchedule v1 — what the sealed `schedule` column of a task holds, and
 * the snooze that rides beside it in the sealed `snooze` column. Pure; the
 * sealing lives in tasks.ts (sealTaskTiming / openTaskTiming) and never lets
 * a plaintext value through in either direction.
 *
 * ONE schema for three things: a calendar event (kind 'event'), a repeating
 * task (kind 'task' with an rrule) and a one-off dated task that wants
 * calendar fields (kind 'task'). The server stores it opaque and learns only
 * that it exists and its padded size bucket; due_at stays the only plaintext
 * timing and, for a scheduled item, means "the next reminder instant".
 *
 * Parser rules (the critic's, and each is tested):
 *  - STRICT: wrong types, over-long strings, too many exdates/alerts, an end
 *    before the start, a timed schedule without a valid zone → invalid.
 *  - Unknown keys are PRESERVED through parse → edit → serialize, so this
 *    build never strips a field a newer one added.
 *  - `v` above what this build knows, an invalid value, or a decrypt-failure
 *    marker → READ-ONLY ("Update Púca to edit this"): shown if possible,
 *    never rewritten.
 */
import { parseRRule, expandSeries, type RRule } from './recurrence';
import {
    type Wall, addDays, compareWall, daysBetween, formatWall, instantToWall, isValidZone, parseWall, viewerZone, wallToInstant,
} from '../utils/calendarMath';
import { isUndecryptable } from './decryptMarkers';
import { isReminderTime } from './reminderTimes';

export const SCHEDULE_VERSION = 1;
/** Plaintext size buckets. The largest is also the hard cap, well inside the
 *  server's sealed ceiling (task_timing.rs MAX_SCHEDULE_LEN). */
export const SCHEDULE_BUCKETS = [256, 1024, 4096, 8192] as const;
export const MAX_SCHEDULE_BYTES = 8192;
export const MAX_EXDATES = 200;
export const MAX_ALERTS = 5;
export const MAX_LOCATION = 500;
export const SNOOZE_BYTES = 128;

export type ScheduleKind = 'event' | 'task';

export interface EventSchedule {
    v: 1;
    kind: ScheduleKind;
    /** Stable across devices and the .ics round trip; random, never the host
     *  or a user id. */
    uid: string;
    allDay: boolean;
    /** 'YYYY-MM-DDTHH:mm' (in `tz`) or a floating 'YYYY-MM-DD' when allDay. */
    start: string;
    /** Exclusive, same form as start. */
    end?: string;
    /** IANA zone; required when timed, absent when all-day. */
    tz?: string;
    /** All-day only: the zone an all-day item's alerts are computed in (its
     *  creator's), so devices in different zones agree on one instant. */
    alertTz?: string;
    rrule?: string;
    /** Occurrence keys (formatWall of an occurrence start) to skip. */
    exdates?: string[];
    location?: string;
    /** Minutes BEFORE the occurrence start (negative = after; all-day starts
     *  at 00:00 in alertTz, so -540 is 09:00 on the day). */
    alerts?: number[];
    /** Keep due_at NULL: the server learns nothing about this item's time. */
    privateTiming?: boolean;
    /** Repeating TASK: the last occurrence ticked off (its key). */
    doneThrough?: string;
}

export type ScheduleState =
    | { state: 'none' }
    | { state: 'ok'; schedule: EventSchedule; raw: Record<string, unknown> }
    | { state: 'readonly'; reason: string; schedule?: EventSchedule };

const KNOWN = new Set(['v', 'kind', 'uid', 'allDay', 'start', 'end', 'tz', 'alertTz', 'rrule', 'exdates', 'location', 'alerts', 'privateTiming', 'doneThrough', '_pad']);

function str(v: unknown, max: number): v is string {
    return typeof v === 'string' && v.length <= max;
}

/** Validate a candidate schedule; null when it is valid, else why not. */
export function validateSchedule(o: Record<string, unknown>): string | null {
    if (o.kind !== 'event' && o.kind !== 'task') return 'kind';
    if (!str(o.uid, 200) || o.uid.length < 1 || /\s/.test(o.uid)) return 'uid';
    if (typeof o.allDay !== 'boolean') return 'allDay';
    if (!str(o.start, 16)) return 'start';
    const start = parseWall(o.start);
    if (!start || start.dateOnly !== o.allDay) return 'start';
    if (o.end !== undefined) {
        if (!str(o.end, 16)) return 'end';
        const end = parseWall(o.end);
        if (!end || end.dateOnly !== o.allDay) return 'end';
        if (compareWall(end.wall, start.wall) <= 0) return 'end before start';
    }
    if (o.allDay) {
        if (o.tz !== undefined) return 'tz on an all-day item';
        if (o.alertTz !== undefined && !isValidZone(o.alertTz)) return 'alertTz';
    } else {
        if (!isValidZone(o.tz)) return 'tz';
        if (o.alertTz !== undefined) return 'alertTz on a timed item';
    }
    if (o.rrule !== undefined) {
        if (!str(o.rrule, 300)) return 'rrule';
        const r = parseRRule(o.rrule);
        if (!r.ok) return `rrule: ${r.reason}`;
    }
    if (o.exdates !== undefined) {
        if (!Array.isArray(o.exdates) || o.exdates.length > MAX_EXDATES) return 'exdates';
        for (const x of o.exdates) {
            if (!str(x, 16)) return 'exdates';
            const p = parseWall(x);
            if (!p || p.dateOnly !== o.allDay) return 'exdates';
        }
    }
    if (o.location !== undefined && !str(o.location, MAX_LOCATION)) return 'location';
    if (o.alerts !== undefined) {
        if (!Array.isArray(o.alerts) || o.alerts.length > MAX_ALERTS) return 'alerts';
        for (const a of o.alerts) if (!Number.isInteger(a) || Math.abs(a) > 60 * 24 * 28) return 'alerts';
    }
    if (o.privateTiming !== undefined && typeof o.privateTiming !== 'boolean') return 'privateTiming';
    if (o.doneThrough !== undefined) {
        if (!str(o.doneThrough, 16)) return 'doneThrough';
        const p = parseWall(o.doneThrough);
        if (!p || p.dateOnly !== o.allDay) return 'doneThrough';
    }
    if (o._pad !== undefined && (typeof o._pad !== 'string' || !/^ *$/.test(o._pad))) return '_pad';
    return null;
}

/**
 * Parse an OPENED schedule (the plaintext tasks.ts hands back), or null.
 * A decrypt-failure marker or anything invalid is READ-ONLY, never "none":
 * treating it as absent would let the next edit overwrite a real schedule.
 */
export function parseSchedule(plain: string | null | undefined): ScheduleState {
    if (plain === null || plain === undefined) return { state: 'none' };
    if (isUndecryptable(plain)) return { state: 'readonly', reason: plain };
    let parsed: unknown;
    try {
        parsed = JSON.parse(plain);
    } catch {
        return { state: 'readonly', reason: 'This item’s schedule is unreadable' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { state: 'readonly', reason: 'This item’s schedule is unreadable' };
    }
    const o = parsed as Record<string, unknown>;
    if (typeof o.v !== 'number' || !Number.isInteger(o.v) || o.v < 1) {
        return { state: 'readonly', reason: 'This item’s schedule is unreadable' };
    }
    if (o.v > SCHEDULE_VERSION) {
        return { state: 'readonly', reason: 'Update Púca to edit this item’s schedule' };
    }
    const why = validateSchedule(o);
    if (why) return { state: 'readonly', reason: `This item’s schedule is invalid (${why})` };
    const schedule: EventSchedule = {
        v: 1,
        kind: o.kind as ScheduleKind,
        uid: o.uid as string,
        allDay: o.allDay as boolean,
        start: o.start as string,
    };
    for (const k of ['end', 'tz', 'alertTz', 'rrule', 'exdates', 'location', 'alerts', 'privateTiming', 'doneThrough'] as const) {
        if (o[k] !== undefined) (schedule as unknown as Record<string, unknown>)[k] = o[k];
    }
    const raw: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (!KNOWN.has(k)) raw[k] = v;
    return { state: 'ok', schedule, raw };
}

function utf8Len(s: string): number {
    return new TextEncoder().encode(s).length;
}

/** Pad JSON with a `_pad` of spaces so its UTF-8 length is exactly a bucket. */
export function padToBucket(obj: Record<string, unknown>, buckets: readonly number[] = SCHEDULE_BUCKETS): string {
    const bare = JSON.stringify({ ...obj, _pad: '' });
    const len = utf8Len(bare);
    const bucket = buckets.find(b => b >= len);
    if (bucket === undefined) throw new Error('This schedule is too large to save (too many skipped dates or too long a location)');
    return JSON.stringify({ ...obj, _pad: ' '.repeat(bucket - len) });
}

/**
 * Serialize for sealing: known fields from `schedule`, unknown keys from
 * `raw` (a schedule parsed earlier) carried through untouched, padded to a
 * bucket. Throws on an invalid schedule rather than seal one.
 */
export function serializeSchedule(schedule: EventSchedule, raw: Record<string, unknown> = {}): string {
    const obj: Record<string, unknown> = { ...raw };
    for (const [k, v] of Object.entries(schedule)) if (v !== undefined) obj[k] = v;
    delete obj._pad;
    const why = validateSchedule(obj);
    if (why) throw new Error(`Refusing to save an invalid schedule (${why})`);
    return padToBucket(obj);
}

export function newUid(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// --- Occurrences as instants ---------------------------------------------------------

export interface Occurrence {
    /** EXDATE / doneThrough key: the occurrence start as stored. */
    key: string;
    startMs: number;
    endMs: number;
    allDay: boolean;
    /** All-day: the floating date keys it covers (end exclusive). */
    dayKeys?: string[];
}

function durationOf(s: EventSchedule): { days: number; ms: number } {
    const a = parseWall(s.start)!;
    if (!s.end) return s.allDay ? { days: 1, ms: 0 } : { days: 0, ms: 0 };
    const b = parseWall(s.end)!;
    if (s.allDay) return { days: Math.max(1, daysBetween(a.wall, b.wall)), ms: 0 };
    return { days: 0, ms: Date.UTC(b.wall.y, b.wall.m - 1, b.wall.d, b.wall.hh, b.wall.mm) - Date.UTC(a.wall.y, a.wall.m - 1, a.wall.d, a.wall.hh, a.wall.mm) };
}

/** Where an all-day item's day starts, for alerts and ordering. */
function allDayZone(s: EventSchedule): string {
    return s.alertTz ?? viewerZone();
}

function toOccurrence(s: EventSchedule, wall: Wall, key: string): Occurrence {
    const dur = durationOf(s);
    if (s.allDay) {
        const tz = allDayZone(s);
        const startMs = wallToInstant({ ...wall, hh: 0, mm: 0 }, tz);
        const endWall = addDays({ ...wall, hh: 0, mm: 0 }, dur.days);
        const dayKeys: string[] = [];
        for (let i = 0; i < dur.days && i < 366; i++) dayKeys.push(formatWall(addDays(wall, i), true));
        return { key, startMs, endMs: wallToInstant(endWall, tz), allDay: true, dayKeys };
    }
    // The END keeps its wall-clock DURATION from the start wall, then maps
    // through the zone on its own, so a 09:00–17:00 event stays 09:00–17:00
    // on a DST day (8 wall hours, 7 or 9 real ones).
    const startMs = wallToInstant(wall, s.tz!);
    const endWallUtc = Date.UTC(wall.y, wall.m - 1, wall.d, wall.hh, wall.mm) + dur.ms;
    const e = new Date(endWallUtc);
    const endMs = wallToInstant({ y: e.getUTCFullYear(), m: e.getUTCMonth() + 1, d: e.getUTCDate(), hh: e.getUTCHours(), mm: e.getUTCMinutes() }, s.tz!);
    return { key, startMs, endMs: Math.max(endMs, startMs), allDay: false };
}

function ruleOf(s: EventSchedule): RRule | null {
    if (!s.rrule) return null;
    const r = parseRRule(s.rrule);
    return r.ok ? r.rule : null;
}

/**
 * Occurrences overlapping [fromMs, toMs), in order, at most `cap` of them.
 * A one-off schedule yields its single occurrence if it overlaps.
 */
export function occurrencesBetween(s: EventSchedule, fromMs: number, toMs: number, cap = 500): Occurrence[] {
    const out: Occurrence[] = [];
    const rule = ruleOf(s);
    const exdates = new Set(s.exdates ?? []);
    const dur = durationOf(s);
    // Walk from a wall a little before the window (a long event that started
    // earlier still overlaps it), in the series' zone.
    const zone = s.allDay ? allDayZone(s) : s.tz!;
    const back = s.allDay ? dur.days + 1 : Math.ceil(dur.ms / 86_400_000) + 1;
    const fromWall = addDays(instantToWall(fromMs, zone), -back);
    const untilWall = addDays(instantToWall(toMs, zone), 1);
    const iter = rule
        ? expandSeries(rule, s.start, { tz: s.allDay ? undefined : s.tz, exdates, from: fromWall, until: untilWall })
        : (function* () {
            const p = parseWall(s.start)!;
            if (!exdates.has(s.start)) yield { wall: p.wall, key: s.start };
        })();
    for (const { wall, key } of iter) {
        const o = toOccurrence(s, wall, key);
        if (o.startMs >= toMs) break;
        if (o.endMs > fromMs || (o.endMs === o.startMs && o.startMs >= fromMs)) out.push(o);
        if (out.length >= cap) break;
    }
    return out;
}

/** The alerts a schedule actually fires, in minutes before the start. */
export function effectiveAlerts(s: EventSchedule): number[] {
    if (s.alerts) return s.alerts;
    return s.kind === 'task' ? [0] : [];
}

/**
 * The first reminder instant strictly after `afterMs`, or null when there is
 * none (private timing, no alerts, series over). For a repeating TASK,
 * occurrences up to doneThrough are skipped.
 */
export function nextReminderAfter(s: EventSchedule, afterMs: number): number | null {
    const alerts = effectiveAlerts(s);
    if (alerts.length === 0) return null;
    const maxBefore = Math.max(0, ...alerts) * 60_000;
    const minBefore = Math.min(0, ...alerts) * 60_000;
    const rule = ruleOf(s);
    const exdates = new Set(s.exdates ?? []);
    const zone = s.allDay ? allDayZone(s) : s.tz!;
    const done = s.kind === 'task' && s.doneThrough ? parseWall(s.doneThrough)?.wall ?? null : null;
    // Occurrences whose START is at or after (afterMs - largest lead-after)
    // may still have an alert in the future.
    const fromWall = addDays(instantToWall(afterMs + minBefore, zone), -1);
    const iter = rule
        ? expandSeries(rule, s.start, { tz: s.allDay ? undefined : s.tz, exdates, from: fromWall })
        : (function* () {
            const p = parseWall(s.start)!;
            if (!exdates.has(s.start)) yield { wall: p.wall, key: s.start };
        })();
    let best: number | null = null;
    let seen = 0;
    for (const { wall, key } of iter) {
        if (++seen > 2000) break;
        if (done && compareWall(wall, done) <= 0) continue;
        const o = toOccurrence(s, wall, key);
        if (best !== null && o.startMs - maxBefore > best) break;
        for (const a of alerts) {
            const t = o.startMs - a * 60_000;
            if (t > afterMs && (best === null || t < best)) best = t;
        }
    }
    return best;
}

/**
 * The due_at an EDITOR writes with a schedule: the next reminder after now,
 * or null when the item keeps its time private or has nothing to remind of.
 */
export function deriveDueAt(s: EventSchedule, nowMs: number): string | null {
    if (s.privateTiming) return null;
    const t = nextReminderAfter(s, nowMs);
    return t === null ? null : new Date(t).toISOString();
}

/** The occurrence a key names (an EXDATE / doneThrough key). */
export function occurrenceOf(s: EventSchedule, key: string): Occurrence | null {
    const p = parseWall(key);
    return p ? toOccurrence(s, p.wall, key) : null;
}

/** A schedule's FIRST occurrence (DTSTART), whatever the time now. */
export function firstOccurrence(s: EventSchedule): Occurrence {
    return toOccurrence(s, parseWall(s.start)!.wall, s.start);
}

/** The first occurrence starting at or after `fromMs` (the "next time" to
 *  show), skipping done ones for a repeating task. */
export function nextOccurrence(s: EventSchedule, fromMs: number): Occurrence | null {
    const done = s.kind === 'task' && s.doneThrough ? parseWall(s.doneThrough)?.wall ?? null : null;
    for (const o of occurrencesBetween(s, fromMs, fromMs + 400 * 86_400_000, 50)) {
        if (done && compareWall(parseWall(o.key)!.wall, done) <= 0) continue;
        if (o.startMs >= fromMs || (o.allDay && o.endMs > fromMs)) return o;
    }
    return null;
}

// --- Completing a repeating task ----------------------------------------------------------

export type CompletionPlan =
    | { kind: 'plain' }
    /** Tick = move to the next occurrence: the item stays open. */
    | { kind: 'advance'; schedule: EventSchedule; dueAt: string | null; occurrence: string }
    /** Tick ends the item for good (a one-off, or the last occurrence). */
    | { kind: 'complete' };

/** The occurrence a repeating task is currently on: the first one after
 *  doneThrough. */
export function currentOccurrenceKey(s: EventSchedule): string | null {
    const rule = ruleOf(s);
    if (!rule) return s.start;
    const done = s.doneThrough ? parseWall(s.doneThrough)?.wall ?? null : null;
    const exdates = new Set(s.exdates ?? []);
    let n = 0;
    for (const { wall, key } of expandSeries(rule, s.start, { tz: s.allDay ? undefined : s.tz, exdates, from: done ?? undefined })) {
        if (++n > 5000) break;
        if (done && compareWall(wall, done) <= 0) continue;
        return key;
    }
    return null;
}

/**
 * What ticking an item does. Only a repeating TASK advances; an event is a
 * thing that happens, and ticking one (or a one-off task) completes it.
 */
export function planCompletion(schedule: EventSchedule | null, completed: boolean, nowMs: number): CompletionPlan {
    if (!completed || !schedule || schedule.kind !== 'task' || !schedule.rrule) {
        return schedule ? { kind: 'complete' } : { kind: 'plain' };
    }
    const cur = currentOccurrenceKey(schedule);
    if (cur === null) return { kind: 'complete' };
    // Ticking catches up: every occurrence that has already started is done
    // with this tick (a daily task missed for three days does not come back
    // overdue three more times), and ticking early does just the current one.
    let through = cur;
    const rule = ruleOf(schedule)!;
    const curWall = parseWall(cur)!.wall;
    let n = 0;
    for (const { wall, key } of expandSeries(rule, schedule.start, {
        tz: schedule.allDay ? undefined : schedule.tz, exdates: new Set(schedule.exdates ?? []), from: curWall,
    })) {
        if (++n > 5000) break;
        if (compareWall(wall, curWall) <= 0) continue;
        if (toOccurrence(schedule, wall, key).startMs > nowMs) break;
        through = key;
    }
    const next: EventSchedule = { ...schedule, doneThrough: through };
    if (currentOccurrenceKey(next) === null) return { kind: 'complete' };
    // The next reminder belongs to the first occurrence after `through`
    // (done ones are skipped by doneThrough); the lower bound only has to
    // sit before any alert of it — alerts reach back at most 28 days.
    const throughStart = toOccurrence(schedule, parseWall(through)!.wall, through).startMs;
    const due = next.privateTiming ? null : nextReminderAfter(next, throughStart - 29 * 86_400_000);
    const dueAt = due === null ? null : new Date(due).toISOString();
    return { kind: 'advance', schedule: next, dueAt, occurrence: through };
}

// --- Snooze -----------------------------------------------------------------------------------

export interface Snooze {
    k: 'snooze/1';
    /** The due_at this snooze was taken against (ISO): the item's own time
     *  before the snooze. */
    forDue: string;
    /** When to remind instead (ISO). */
    until: string;
}

export function parseSnooze(plain: string | null | undefined): Snooze | null {
    if (!plain || isUndecryptable(plain)) return null;
    try {
        const o = JSON.parse(plain) as Record<string, unknown>;
        if (o.k !== 'snooze/1' || typeof o.forDue !== 'string' || typeof o.until !== 'string') return null;
        if (!Number.isFinite(Date.parse(o.forDue)) || !Number.isFinite(Date.parse(o.until))) return null;
        return { k: 'snooze/1', forDue: o.forDue, until: o.until };
    } catch {
        return null;
    }
}

export function serializeSnooze(s: Omit<Snooze, 'k'>): string {
    return padToBucket({ k: 'snooze/1', forDue: s.forDue, until: s.until }, [SNOOZE_BYTES]);
}

/**
 * A snooze still in force for this due_at (compared as instants). Two forms:
 *
 *  - MOVED (what a snooze writes when the snoozer may edit the item): the
 *    plaintext due_at itself is moved to `until`, so the server — and a
 *    phone's reminder engine running while the app is closed, which cannot
 *    open the sealed snooze — sees the next reminder instant (the owner's
 *    rule for timing). The sealed snooze keeps what the UI needs: that it is
 *    a snooze, and the time it pushed back (`forDue`).
 *  - SEALED-ONLY (a member who may complete but not edit): due_at stays, and
 *    the snooze applies while due_at is still `forDue`.
 *
 * Either way an edit or an advance of due_at voids it.
 */
export function activeSnooze(dueAt: string | null, snoozePlain: string | null | undefined): Snooze | null {
    const s = parseSnooze(snoozePlain);
    if (!s || !dueAt) return null;
    const d = Date.parse(dueAt);
    return Date.parse(s.forDue) === d || Date.parse(s.until) === d ? s : null;
}

/** Is this active snooze the MOVED form (due_at already carries `until`)? */
export function snoozeMovedDue(dueAt: string | null, s: Snooze | null): boolean {
    return !!s && !!dueAt && Date.parse(s.until) === Date.parse(dueAt) && Date.parse(s.forDue) !== Date.parse(dueAt);
}

/**
 * May this user change the snooze at all? Not when an editor's snooze has
 * MOVED due_at and this user may not edit the item's time (a member with the
 * completion right only). Unsnoozing that needs due_at put back, which the
 * server gives to editors alone — a sealed-only `{snooze: null}` would leave
 * due_at at the snooze instant and lose the item's real time for good. A
 * re-snooze has no form that works either: sealed against the old time it
 * would not match due_at (inert), sealed against the current one it would
 * overwrite the pushed-back time an editor's Unsnooze restores. So the
 * control is hidden (Reminders, both calendar menus) and snoozePatch refuses.
 */
export function snoozeLocked(task: { due_at: string | null; snooze?: string | null }, canMoveDue: boolean): boolean {
    if (canMoveDue || !task.due_at) return false;
    return snoozeMovedDue(task.due_at, activeSnooze(task.due_at, task.snooze));
}

/**
 * The PATCH a snooze (untilMs) or an unsnooze (null) sends. With `canMoveDue`
 * (the snoozer may edit the item's time: its creator, a task manager, any
 * personal list) the plaintext due_at moves to the snooze instant — and back
 * to the pushed-back time on an unsnooze — guarded by expect_due_at so a
 * snooze racing another device's edit loses cleanly (409). Without it only
 * the sealed snooze changes (the server gives due_at to editors alone).
 * Null when there is nothing to snooze (no due_at: a private-timing item), or
 * when this user may not touch an editor's moved snooze (snoozeLocked).
 */
export function snoozePatch(
    task: { due_at: string | null; snooze?: string | null }, untilMs: number | null, canMoveDue: boolean,
): { snooze: string | null; due_at?: string; expect_due_at?: string } | null {
    if (!task.due_at || snoozeLocked(task, canMoveDue)) return null;
    const cur = activeSnooze(task.due_at, task.snooze);
    const base = cur && snoozeMovedDue(task.due_at, cur) ? cur.forDue : task.due_at;
    if (untilMs === null) {
        if (cur && snoozeMovedDue(task.due_at, cur) && canMoveDue) {
            return { snooze: null, due_at: base, expect_due_at: task.due_at };
        }
        return { snooze: null };
    }
    const until = new Date(untilMs).toISOString();
    const snooze = serializeSnooze({ forDue: base, until });
    return canMoveDue ? { snooze, due_at: until, expect_due_at: task.due_at } : { snooze };
}

/** When the item actually reminds: the snooze's time if one is in force,
 *  else due_at. NaN when there is no due_at. */
export function effectiveReminderMs(dueAt: string | null, snoozePlain: string | null | undefined): number {
    if (!dueAt) return NaN;
    const s = activeSnooze(dueAt, snoozePlain);
    return s ? Date.parse(s.until) : Date.parse(dueAt);
}

export type SnoozePreset = '10m' | '1h' | 'tomorrow';

/** The instant a snooze preset names. `tomorrowAt` is the user's morning
 *  time (api/reminderTimes.ts); it defaults to 09:00, which is what this
 *  always was, so a caller that has no setting to hand is unchanged. */
export function snoozeUntil(preset: SnoozePreset, nowMs: number, tz: string = viewerZone(), tomorrowAt = '09:00'): number {
    if (preset === '10m') return nowMs + 10 * 60_000;
    if (preset === '1h') return nowMs + 60 * 60_000;
    const w = addDays(instantToWall(nowMs, tz), 1);
    const at = isReminderTime(tomorrowAt) ? tomorrowAt : '09:00';
    return wallToInstant({ ...w, hh: Number(at.slice(0, 2)), mm: Number(at.slice(3)) }, tz);
}
