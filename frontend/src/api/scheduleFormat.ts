/**
 * How schedules read in the UI — always in the VIEWER's zone and locale
 * (hour cycle included), whatever zone the event was made in.
 */
import { describeRRule, parseRRule } from './recurrence';
import { type EventSchedule, type Occurrence, currentOccurrenceKey, firstOccurrence, nextOccurrence, occurrenceOf } from './taskSchedule';
import { localDayKey, viewerZone } from '../utils/calendarMath';

const cache = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
    const key = `${locale ?? ''}|${JSON.stringify(opts)}`;
    let f = cache.get(key);
    if (!f) {
        f = new Intl.DateTimeFormat(locale, { calendar: 'gregory', ...opts });
        cache.set(key, f);
    }
    return f;
}

export function formatTime(ms: number, locale?: string, tz: string = viewerZone()): string {
    return dtf(locale, { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(ms);
}

export function formatDayShort(ms: number, locale?: string, tz: string = viewerZone()): string {
    return dtf(locale, { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz }).format(ms);
}

/** A floating all-day date ('YYYY-MM-DD'), read as that date anywhere. */
export function formatDateKey(key: string, locale?: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }): string {
    const [y, m, d] = key.split('-').map(Number);
    return dtf(locale, { ...opts, timeZone: 'UTC' }).format(Date.UTC(y, m - 1, d, 12));
}

/** "Tue, Oct 6, 15:00–16:00" / "Oct 5–7 · all day", relative to today. */
export function formatOccurrence(s: EventSchedule, o: Occurrence, nowMs: number, locale?: string): string {
    const tz = viewerZone();
    if (o.allDay) {
        const days = o.dayKeys ?? [];
        const first = days[0] ?? localDayKey(o.startMs, tz);
        const label = days.length > 1
            ? `${formatDateKey(first, locale)} – ${formatDateKey(days[days.length - 1], locale)}`
            : formatDateKey(first, locale);
        return `${label} · all day`;
    }
    const sameDay = localDayKey(o.startMs, tz) === localDayKey(nowMs, tz);
    const day = sameDay ? 'Today' : formatDayShort(o.startMs, locale, tz);
    const start = formatTime(o.startMs, locale, tz);
    if (!s.end || o.endMs <= o.startMs) return `${day} ${start}`;
    const endDaySame = localDayKey(o.endMs, tz) === localDayKey(o.startMs, tz);
    return `${day} ${start}–${endDaySame ? '' : formatDayShort(o.endMs, locale, tz) + ' '}${formatTime(o.endMs, locale, tz)}`;
}

/** The chip text for a schedule: next time · repeat · place. */
export function describeSchedule(s: EventSchedule, nowMs: number, locale?: string): { when: string; repeat: string | null; ended: boolean } {
    // A to-do is ON its current (first undone) occurrence, even when that is
    // overdue; an event shows its next one.
    const curKey = s.kind === 'task' ? currentOccurrenceKey(s) : null;
    const next = s.kind === 'task'
        ? (curKey ? occurrenceOf(s, curKey) : null)
        : nextOccurrence(s, nowMs - (s.allDay ? 0 : 60 * 60_000));
    const rule = s.rrule ? parseRRule(s.rrule) : null;
    const repeat = rule && rule.ok ? describeRRule(rule.rule, locale) : s.rrule ? 'repeats' : null;
    if (!next) return { when: s.rrule ? 'Series ended' : formatOccurrence(s, firstOccurrence(s), nowMs, locale), repeat, ended: true };
    return { when: formatOccurrence(s, next, nowMs, locale), repeat, ended: false };
}
