/**
 * The schedule editor's form ⇄ EventSchedule, pure and tested. The editor
 * component only renders this state; everything that decides what gets
 * sealed lives here.
 */
import { parseRRule, serializeRRule, type RRule } from './recurrence';
import { type EventSchedule, type ScheduleKind, type ScheduleState, newUid, nextOccurrence } from './taskSchedule';
import { DEFAULT_REMINDER_TIMES, isReminderTime } from './reminderTimes';
import { addDays, daysInMonth, instantToWall, parseWall, viewerZone, wallToInstant, weekdayOf, type Wall } from '../utils/calendarMath';

export type RepeatPreset = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly-day' | 'monthly-nth' | 'monthly-last' | 'yearly' | 'custom';
export type EndsMode = 'never' | 'count' | 'until';

export interface ScheduleForm {
    kind: ScheduleKind;
    date: string;           // YYYY-MM-DD
    allDay: boolean;
    startTime: string;      // HH:mm
    endTime: string;        // HH:mm or ''
    endDate: string;        // all-day: YYYY-MM-DD (inclusive, as people say it) or ''
    repeat: RepeatPreset;
    /** The rule kept verbatim when `repeat` is custom (an import). */
    customRule: string;
    ends: EndsMode;
    count: number;
    until: string;          // YYYY-MM-DD
    location: string;
    /** Alert minutes as a single choice; 'keep' = leave imported alerts. */
    alert: string;
    privateTiming: boolean;
    /** The zone a timed schedule is in (the event's own, or this device's
     *  for a new one). */
    tz: string;
}

const DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function nthOfMonth(d: number): number {
    return Math.ceil(d / 7);
}

export function isLastWeekdayOfMonth(y: number, m: number, d: number): boolean {
    return d + 7 > daysInMonth(y, m);
}

/** The rule a preset means for a given start date (no COUNT/UNTIL). */
export function presetRule(preset: RepeatPreset, date: string): string | null {
    const p = parseWall(date);
    if (!p) return null;
    const { y, m, d } = p.wall;
    const wd = DAY[weekdayOf(y, m, d)];
    switch (preset) {
        case 'none': case 'custom': return null;
        case 'daily': return 'FREQ=DAILY';
        case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
        case 'weekly': return `FREQ=WEEKLY;BYDAY=${wd}`;
        case 'monthly-day': return `FREQ=MONTHLY;BYMONTHDAY=${d}`;
        case 'monthly-nth': return `FREQ=MONTHLY;BYDAY=${nthOfMonth(d)}${wd}`;
        case 'monthly-last': return `FREQ=MONTHLY;BYDAY=-1${wd}`;
        case 'yearly': return 'FREQ=YEARLY';
    }
}

/** Which preset an existing rule is, for the start date (COUNT/UNTIL aside). */
export function detectPreset(rrule: string | undefined, date: string): { preset: RepeatPreset; ends: EndsMode; count: number; untilKey: string } {
    const none = { preset: 'none' as RepeatPreset, ends: 'never' as EndsMode, count: 10, untilKey: '' };
    if (!rrule) return none;
    const r = parseRRule(rrule);
    if (!r.ok) return { ...none, preset: 'custom' };
    const bare: RRule = { ...r.rule, count: undefined, until: undefined };
    const text = serializeRRule(bare);
    const ends: EndsMode = r.rule.count !== undefined ? 'count' : r.rule.until ? 'until' : 'never';
    const untilKey = r.rule.until ? `${r.rule.until.slice(0, 4)}-${r.rule.until.slice(4, 6)}-${r.rule.until.slice(6, 8)}` : '';
    for (const preset of ['daily', 'weekdays', 'weekly', 'monthly-day', 'monthly-nth', 'monthly-last', 'yearly'] as RepeatPreset[]) {
        if (presetRule(preset, date) === text) return { preset, ends, count: r.rule.count ?? 10, untilKey };
    }
    return { preset: 'custom', ends, count: r.rule.count ?? 10, untilKey };
}

export const TIMED_ALERTS: { value: string; label: string }[] = [
    { value: 'none', label: 'No reminder' },
    { value: '0', label: 'At the start' },
    { value: '10', label: '10 minutes before' },
    { value: '30', label: '30 minutes before' },
    { value: '60', label: '1 hour before' },
    { value: '1440', label: '1 day before' },
];
/** The all-day offsets are a CLOSED list on purpose: an item carrying an
 *  offset outside it would render a <select> with no matching <option>, and a
 *  Save would silently rewrite its alert. They stay at 09:00 even when the
 *  morning time is something else — changing them is its own piece of work. */
export const ALLDAY_ALERTS: { value: string; label: string }[] = [
    { value: 'none', label: 'No reminder' },
    { value: '-540', label: 'On the day at 09:00' },
    { value: '900', label: 'The day before at 09:00' },
];

function pad(n: number): string {
    return String(n).padStart(2, '0');
}

/** A fresh form for a new schedule on `date`. Defaults: the account's "new
 *  reminders start at" time (09:00 unless it was changed — api/reminderTimes.ts),
 *  or the next full hour when the date is today. */
export function newForm(
    kind: ScheduleKind, date: string, nowMs: number, time?: string, tz: string = viewerZone(),
    defaultTime: string = DEFAULT_REMINDER_TIMES.default,
): ScheduleForm {
    const now = instantToWall(nowMs, tz);
    const today = `${now.y}-${pad(now.m)}-${pad(now.d)}`;
    const start = time ?? (date === today ? `${pad(Math.min(23, now.hh + 1))}:00` : (isReminderTime(defaultTime) ? defaultTime : DEFAULT_REMINDER_TIMES.default));
    const [hh, mm] = start.split(':').map(Number);
    const end = `${pad(Math.min(23, hh + 1))}:${pad(mm)}`;
    return {
        kind, date, allDay: false, startTime: start, endTime: kind === 'event' ? end : '', endDate: '',
        repeat: 'none', customRule: '', ends: 'never', count: 10, until: '', location: '',
        alert: kind === 'event' ? '10' : '0', privateTiming: false, tz,
    };
}

/** An existing schedule as a form. An ALL-DAY schedule has no time of its
 *  own, so the time row shows `defaultTime` for the moment the user unticks
 *  "All day" — it is never read back for an all-day save. */
export function formFromSchedule(s: EventSchedule, defaultTime: string = DEFAULT_REMINDER_TIMES.default): ScheduleForm {
    const start = parseWall(s.start)!;
    const date = s.start.slice(0, 10);
    const det = detectPreset(s.rrule, date);
    let endTime = '';
    let endDate = '';
    if (s.end) {
        const e = parseWall(s.end)!;
        if (s.allDay) endDate = formatKey(addDays(e.wall, -1));   // exclusive → inclusive
        else endTime = `${pad(e.wall.hh)}:${pad(e.wall.mm)}`;
    }
    const alerts = s.alerts ?? (s.kind === 'task' ? [0] : []);
    const alert = alerts.length === 0 ? 'none' : alerts.length === 1 ? String(alerts[0]) : 'keep';
    return {
        kind: s.kind, date, allDay: s.allDay,
        startTime: s.allDay ? (isReminderTime(defaultTime) ? defaultTime : DEFAULT_REMINDER_TIMES.default) : `${pad(start.wall.hh)}:${pad(start.wall.mm)}`,
        endTime, endDate,
        repeat: det.preset, customRule: det.preset === 'custom' ? (s.rrule ?? '') : '',
        ends: det.ends, count: det.count, until: det.untilKey,
        location: s.location ?? '', alert, privateTiming: s.privateTiming === true,
        tz: s.tz ?? viewerZone(),
    };
}

function formatKey(w: Pick<Wall, 'y' | 'm' | 'd'>): string {
    return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/**
 * Where an event's END lands when its START moves to `next`: the same length
 * of event, not the same end time. A one-tap preset (Morning / Afternoon /
 * Evening) moves only the start, and scheduleFromForm reads an end at or
 * before the start as running past midnight — so leaving a 09:00–10:00
 * standup's end alone while the start jumps to 21:45 silently turns it into a
 * 12h15 event, with no error, because that form is perfectly valid.
 *
 * An end equal to the start is a 24h event and stays one. Anything
 * unparseable is left exactly as it was, which is what the editor already did.
 */
export function endTimeAfterMovingStart(startTime: string, endTime: string, next: string): string {
    const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!hhmm.test(startTime) || !hhmm.test(endTime) || !hhmm.test(next)) return endTime;
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const span = ((mins(endTime) - mins(startTime)) % 1440 + 1440) % 1440;
    const at = (mins(next) + span) % 1440;
    return `${pad(Math.floor(at / 60))}:${pad(at % 60)}`;
}

/**
 * The schedule a form describes, merged over `base` (an existing schedule:
 * its uid, exdates, doneThrough and any fields this build does not edit are
 * kept). Returns an error string for a form that cannot be saved.
 */
export function scheduleFromForm(f: ScheduleForm, base?: EventSchedule): EventSchedule | string {
    const date = parseWall(f.date);
    if (!date || !date.dateOnly) return 'Pick a date';
    const out: EventSchedule = {
        ...(base ?? {}),
        v: 1, kind: f.kind, uid: base?.uid ?? newUid(), allDay: f.allDay,
        start: f.allDay ? f.date : `${f.date}T${f.startTime}`,
    } as EventSchedule;
    delete out.end; delete out.tz; delete out.alertTz; delete out.rrule; delete out.location; delete out.alerts; delete out.privateTiming;
    if (!f.allDay) {
        if (!/^\d{2}:\d{2}$/.test(f.startTime)) return 'Pick a start time';
        out.tz = f.tz;
        if (f.endTime) {
            if (!/^\d{2}:\d{2}$/.test(f.endTime)) return 'Pick an end time';
            // An end at or before the start runs past midnight (23:00–01:00).
            const endDay = f.endTime <= f.startTime ? formatKey(addDays(date.wall, 1)) : f.date;
            out.end = `${endDay}T${f.endTime}`;
        }
    } else {
        out.alertTz = base?.alertTz ?? f.tz;
        if (f.endDate) {
            const e = parseWall(f.endDate);
            if (!e) return 'Pick an end date';
            if (e.wall.y * 10000 + e.wall.m * 100 + e.wall.d < date.wall.y * 10000 + date.wall.m * 100 + date.wall.d) return 'The end date is before the start';
            if (f.endDate !== f.date) out.end = formatKey(addDays(e.wall, 1));   // inclusive → exclusive
        }
    }
    let rule: string | null = f.repeat === 'custom' ? f.customRule || null : presetRule(f.repeat, f.date);
    if (rule && f.repeat !== 'custom') {
        if (f.ends === 'count') {
            if (!Number.isInteger(f.count) || f.count < 1 || f.count > 1000) return 'Repeat between 1 and 1000 times';
            rule += `;COUNT=${f.count}`;
        } else if (f.ends === 'until') {
            const u = parseWall(f.until);
            if (!u) return 'Pick the last date';
            if (f.allDay) rule += `;UNTIL=${f.until.replace(/-/g, '')}`;
            else {
                // Through the end of that day in the event's zone, as UTC.
                const endOfDay = wallToInstant({ ...u.wall, hh: 23, mm: 59 }, f.tz);
                rule += `;UNTIL=${new Date(endOfDay).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
            }
        }
    }
    if (rule) out.rrule = rule;
    if (!rule) { delete out.exdates; delete out.doneThrough; }
    if (f.kind === 'event' && f.location.trim()) out.location = f.location.trim().slice(0, 500);
    if (f.alert === 'keep' && base?.alerts) out.alerts = base.alerts;
    else if (f.alert === 'none') out.alerts = [];
    else if (f.alert !== 'keep') out.alerts = [Number(f.alert)];
    if (f.privateTiming) out.privateTiming = true;
    if (f.kind !== 'task') delete out.doneThrough;
    return out;
}

/**
 * The due_at to write when the date & repeat is REMOVED. The item keeps a
 * plain due time at its next occurrence, so it does not silently lose its
 * date — except where the schedule kept its time PRIVATE from the server:
 * there due_at is null by design, and writing the next occurrence would
 * publish the very time the user hid. That needs the user's explicit yes
 * (`reveal`); without it the item stays dateless on the server (null).
 */
export function dueAtAfterRemoving(parsed: ScheduleState, taskDueAt: string | null, nowMs: number, reveal: boolean): string | null {
    if (parsed.state !== 'ok') return taskDueAt;
    if (parsed.schedule.privateTiming && !reveal) return null;
    const next = nextOccurrence(parsed.schedule, nowMs);
    return next ? new Date(next.startMs).toISOString() : taskDueAt;
}

/** Does removing this schedule need to ask before it reveals a time? */
export function removingRevealsPrivateTime(parsed: ScheduleState): boolean {
    return parsed.state === 'ok' && parsed.schedule.privateTiming === true;
}
