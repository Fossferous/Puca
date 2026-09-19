/**
 * What the calendar's gestures WRITE — pure, shared by Notes and Púca's tab.
 *
 *  - Move to another day keeps the item's clock time in ITS zone (a 15:00
 *    Dublin meeting moved a day is still 15:00 in Dublin). A plain item moves
 *    its due_at, keeping its local time here; an event moves start and end
 *    together and re-derives its next reminder. When the kept time does not
 *    exist on the new day (spring forward), `adjusted` says so and the RFC
 *    rule applies (it lands after the gap).
 *  - Skip adds the occurrence to the series' EXDATEs.
 *  - Tap-to-add builds the one POST's timing: a schedule (event) when the
 *    server stores schedules, else a plain due time.
 */
import { type CalendarEntry } from './taskCalendar';
import { type EventSchedule, type ScheduleKind, MAX_EXDATES, deriveDueAt, newUid, parseSchedule, serializeSchedule } from './taskSchedule';
import { type NewTaskTiming } from './tasks';
import { addDays, daysBetween, formatWall, instantToWall, isInGap, parseWall, viewerZone, wallToInstant } from '../utils/calendarMath';

export type MovePlan =
    | { kind: 'due'; dueAt: string; adjusted: boolean }
    | { kind: 'schedule'; schedule: string; dueAt: string | null; adjusted: boolean };

export function planMove(entry: CalendarEntry, dayKey: string, nowMs: number, tz: string = viewerZone()): MovePlan | null {
    const target = parseWall(dayKey);
    if (!target || !target.dateOnly || !entry.movable) return null;
    if (entry.kind === 'plain') {
        const w = instantToWall(entry.startMs, tz);
        const moved = { ...target.wall, hh: w.hh, mm: w.mm };
        return { kind: 'due', dueAt: new Date(wallToInstant(moved, tz)).toISOString(), adjusted: isInGap(moved, tz) };
    }
    const parsed = parseSchedule(entry.source.task.schedule);
    if (parsed.state !== 'ok' || parsed.schedule.rrule) return null;
    const s = parsed.schedule;
    const start = parseWall(s.start)!.wall;
    // The viewer dropped it on a VIEWER day; shift by whole days in the
    // event's own terms, from the viewer day it was shown on.
    const shownOn = parseWall(entry.dayKeys[0])!.wall;
    const delta = daysBetween(shownOn, target.wall);
    if (delta === 0) return null;
    const next: EventSchedule = { ...s, start: formatWall(addDays(start, delta), s.allDay) };
    if (s.end) next.end = formatWall(addDays(parseWall(s.end)!.wall, delta), s.allDay);
    const adjusted = !s.allDay && isInGap(parseWall(next.start)!.wall, s.tz!);
    return {
        kind: 'schedule',
        schedule: serializeSchedule(next, parsed.raw),
        dueAt: deriveDueAt(next, nowMs),
        adjusted,
    };
}

export function planSkip(entry: CalendarEntry, nowMs: number): { schedule: string; dueAt: string | null } | null {
    const parsed = parseSchedule(entry.source.task.schedule);
    if (parsed.state !== 'ok' || !parsed.schedule.rrule || !entry.occKey) return null;
    const ex = [...new Set([...(parsed.schedule.exdates ?? []), entry.occKey])];
    if (ex.length > MAX_EXDATES) return null;
    const next: EventSchedule = { ...parsed.schedule, exdates: ex };
    return { schedule: serializeSchedule(next, parsed.raw), dueAt: deriveDueAt(next, nowMs) };
}

export interface NewItemInput {
    dayKey: string;
    /** 'HH:mm'; ignored when allDay. */
    time: string;
    allDay: boolean;
    kind: ScheduleKind;
    /** Minutes before; undefined = the kind's default. */
    alerts?: number[];
}

/** The timing for a tap-to-add item — one POST carries it all. */
export function newItemTiming(input: NewItemInput, scheduleSupported: boolean, nowMs: number, tz: string = viewerZone()): NewTaskTiming {
    const day = parseWall(input.dayKey)!.wall;
    if (!scheduleSupported) {
        // Older server: a plain due time (all-day = 09:00 that day).
        const [hh, mm] = input.allDay ? [9, 0] : input.time.split(':').map(Number);
        return { dueAt: new Date(wallToInstant({ ...day, hh, mm }, tz)).toISOString() };
    }
    const s: EventSchedule = input.allDay
        ? { v: 1, kind: input.kind, uid: newUid(), allDay: true, start: input.dayKey, alertTz: tz, alerts: input.alerts ?? [-540] }
        : {
            v: 1, kind: input.kind, uid: newUid(), allDay: false, start: `${input.dayKey}T${input.time}`, tz,
            alerts: input.alerts ?? (input.kind === 'event' ? [10] : [0]),
        };
    if (!input.allDay && input.kind === 'event') {
        const [hh, mm] = input.time.split(':').map(Number);
        const end = new Date(Date.UTC(day.y, day.m - 1, day.d, hh + 1, mm));
        s.end = formatWall({ y: end.getUTCFullYear(), m: end.getUTCMonth() + 1, d: end.getUTCDate(), hh: end.getUTCHours(), mm: end.getUTCMinutes() }, false);
    }
    return { schedule: serializeSchedule(s), dueAt: deriveDueAt(s, nowMs) };
}
