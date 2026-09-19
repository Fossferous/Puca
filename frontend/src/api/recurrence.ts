/**
 * The repeat rules Púca understands: a tested SUBSET of RFC 5545 RRULE, with
 * no dependency. Anything outside it is REFUSED with a reason (an .ics import
 * shows that reason and brings the event in as a single occurrence) — never
 * approximated silently.
 *
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT | UNTIL, WKST
 *   BYDAY    — DAILY/WEEKLY: plain days (MO,WE,FR); MONTHLY and YEARLY with
 *              BYMONTH: plain or ordinal days (2TU, -1FR)
 *   BYMONTHDAY — MONTHLY, YEARLY (1..31, -1..-31)
 *   BYMONTH  — any FREQ, as a filter or (YEARLY) the months to use
 *
 * RFC semantics kept on purpose:
 *   - DTSTART is always the first occurrence and counts toward COUNT.
 *   - A date that does not exist is SKIPPED, not clamped (monthly on the 31st
 *     has no February occurrence; yearly on Feb 29 is every four years).
 *   - COUNT counts occurrences BEFORE EXDATE removes any (an excluded date
 *     still used up one of the COUNT).
 *   - UNTIL is inclusive.
 *
 * Expansion works on WALL dates (calendarMath.ts) and hands every occurrence
 * back with the series' own clock time; turning that into an instant — and
 * the DST rules that go with it — is the caller's job, per zone.
 */
import { type Wall, addDays, compareWall, daysInMonth, formatWall, parseWall, wallToInstant, weekdayOf } from '../utils/calendarMath';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface ByDay {
    /** 0 = every such weekday in the period; ±1..±5 = the nth (from the end when negative). */
    ord: number;
    /** 0 = Sunday … 6 = Saturday. */
    wd: number;
}

export interface RRule {
    freq: Freq;
    interval: number;
    byDay?: ByDay[];
    byMonthDay?: number[];
    byMonth?: number[];
    count?: number;
    /** Raw UNTIL value: YYYYMMDD or YYYYMMDDTHHMMSSZ (or floating YYYYMMDDTHHMMSS). */
    until?: string;
    wkst: number;
}

export type RRuleParse = { ok: true; rule: RRule } | { ok: false; reason: string };

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_INTERVAL = 999;
const MAX_COUNT = 1000;

function intList(v: string, lo: number, hi: number, noZero = true): number[] | null {
    const out: number[] = [];
    for (const part of v.split(',')) {
        if (!/^[+-]?\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n < lo || n > hi || (noZero && n === 0)) return null;
        out.push(n);
    }
    return out;
}

export function parseRRule(input: string): RRuleParse {
    const s = input.trim().replace(/^RRULE:/i, '');
    if (!s) return { ok: false, reason: 'empty rule' };
    const fields = new Map<string, string>();
    for (const kv of s.split(';')) {
        if (!kv) continue;
        const i = kv.indexOf('=');
        if (i <= 0) return { ok: false, reason: `malformed part "${kv}"` };
        const k = kv.slice(0, i).toUpperCase();
        if (fields.has(k)) return { ok: false, reason: `${k} given twice` };
        fields.set(k, kv.slice(i + 1).toUpperCase());
    }
    const freq = fields.get('FREQ');
    if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
        return { ok: false, reason: freq ? `repeats ${freq.toLowerCase()} (not supported)` : 'no FREQ' };
    }
    const rule: RRule = { freq, interval: 1, wkst: 1 };
    for (const [k, v] of fields) {
        switch (k) {
            case 'FREQ': break;
            case 'INTERVAL': {
                if (!/^\d{1,4}$/.test(v) || +v < 1 || +v > MAX_INTERVAL) return { ok: false, reason: `INTERVAL ${v}` };
                rule.interval = +v;
                break;
            }
            case 'COUNT': {
                if (!/^\d{1,5}$/.test(v) || +v < 1 || +v > MAX_COUNT) return { ok: false, reason: `COUNT ${v}` };
                rule.count = +v;
                break;
            }
            case 'UNTIL': {
                if (!/^\d{8}(T\d{6}Z?)?$/.test(v)) return { ok: false, reason: `UNTIL ${v}` };
                rule.until = v;
                break;
            }
            case 'WKST': {
                const d = DAYS.indexOf(v);
                if (d < 0) return { ok: false, reason: `WKST ${v}` };
                rule.wkst = d;
                break;
            }
            case 'BYDAY': {
                const out: ByDay[] = [];
                for (const part of v.split(',')) {
                    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part);
                    if (!m) return { ok: false, reason: `BYDAY ${part}` };
                    const ord = m[1] ? Number(m[1]) : 0;
                    if (ord !== 0 && (Math.abs(ord) > 5)) return { ok: false, reason: `BYDAY ${part} (outside a month)` };
                    out.push({ ord, wd: DAYS.indexOf(m[2]) });
                }
                rule.byDay = out;
                break;
            }
            case 'BYMONTHDAY': {
                const l = intList(v, -31, 31);
                if (!l) return { ok: false, reason: `BYMONTHDAY ${v}` };
                rule.byMonthDay = l;
                break;
            }
            case 'BYMONTH': {
                const l = intList(v, 1, 12);
                if (!l) return { ok: false, reason: `BYMONTH ${v}` };
                rule.byMonth = l;
                break;
            }
            default:
                return { ok: false, reason: `${k} is not supported` };
        }
    }
    if (rule.count !== undefined && rule.until !== undefined) return { ok: false, reason: 'COUNT and UNTIL together' };
    const ordinal = rule.byDay?.some(b => b.ord !== 0) ?? false;
    if (ordinal && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY')) {
        return { ok: false, reason: 'numbered weekdays outside a monthly or yearly rule' };
    }
    if (rule.freq === 'YEARLY' && rule.byDay && !rule.byMonth) {
        return { ok: false, reason: 'yearly weekdays without a month (week numbers are not supported)' };
    }
    if (rule.byMonthDay && (rule.freq === 'WEEKLY')) {
        return { ok: false, reason: 'BYMONTHDAY in a weekly rule' };
    }
    return { ok: true, rule };
}

export function serializeRRule(r: RRule): string {
    const parts = [`FREQ=${r.freq}`];
    if (r.interval !== 1) parts.push(`INTERVAL=${r.interval}`);
    if (r.byDay?.length) parts.push(`BYDAY=${r.byDay.map(b => `${b.ord === 0 ? '' : b.ord}${DAYS[b.wd]}`).join(',')}`);
    if (r.byMonthDay?.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(',')}`);
    if (r.byMonth?.length) parts.push(`BYMONTH=${r.byMonth.join(',')}`);
    if (r.wkst !== 1) parts.push(`WKST=${DAYS[r.wkst]}`);
    if (r.count !== undefined) parts.push(`COUNT=${r.count}`);
    if (r.until !== undefined) parts.push(`UNTIL=${r.until}`);
    return parts.join(';');
}

// --- Expansion -------------------------------------------------------------------

/** Days of a month matching a BYDAY list. */
function monthDaysByDay(y: number, m: number, byDay: ByDay[]): number[] {
    const n = daysInMonth(y, m);
    const out = new Set<number>();
    for (const b of byDay) {
        const all: number[] = [];
        for (let d = 1; d <= n; d++) if (weekdayOf(y, m, d) === b.wd) all.push(d);
        if (b.ord === 0) all.forEach(d => out.add(d));
        else {
            const pick = b.ord > 0 ? all[b.ord - 1] : all[all.length + b.ord];
            if (pick !== undefined) out.add(pick);
        }
    }
    return [...out];
}

function monthDaysByMonthDay(y: number, m: number, list: number[]): number[] {
    const n = daysInMonth(y, m);
    const out = new Set<number>();
    for (const v of list) {
        const d = v > 0 ? v : n + 1 + v;
        if (d >= 1 && d <= n) out.add(d);   // a day the month lacks is skipped (RFC)
    }
    return [...out];
}

/** Candidate dates (as walls with the series' time) for one period. */
function periodCandidates(rule: RRule, start: Wall, k: number): Wall[] {
    const at = (y: number, m: number, d: number): Wall => ({ y, m, d, hh: start.hh, mm: start.mm });
    const monthFilter = (w: Wall) => !rule.byMonth || rule.byMonth.includes(w.m);
    switch (rule.freq) {
        case 'DAILY': {
            const w = addDays(start, k * rule.interval);
            if (!monthFilter(w)) return [];
            if (rule.byDay && !rule.byDay.some(b => b.wd === weekdayOf(w.y, w.m, w.d))) return [];
            if (rule.byMonthDay && monthDaysByMonthDay(w.y, w.m, rule.byMonthDay).indexOf(w.d) < 0) return [];
            return [w];
        }
        case 'WEEKLY': {
            const lead = (weekdayOf(start.y, start.m, start.d) - rule.wkst + 7) % 7;
            const weekStart = addDays(start, -lead + k * 7 * rule.interval);
            const days = rule.byDay ? rule.byDay.map(b => b.wd) : [weekdayOf(start.y, start.m, start.d)];
            const out: Wall[] = [];
            for (let i = 0; i < 7; i++) {
                const w = addDays(weekStart, i);
                if (days.includes(weekdayOf(w.y, w.m, w.d)) && monthFilter(w)) out.push(w);
            }
            return out;
        }
        case 'MONTHLY': {
            const idx = (start.y * 12 + (start.m - 1)) + k * rule.interval;
            const y = Math.floor(idx / 12);
            const m = (idx % 12) + 1;
            if (rule.byMonth && !rule.byMonth.includes(m)) return [];
            let days: number[];
            if (rule.byMonthDay) {
                days = monthDaysByMonthDay(y, m, rule.byMonthDay);
                if (rule.byDay) {
                    const allowed = new Set(monthDaysByDay(y, m, rule.byDay));
                    days = days.filter(d => allowed.has(d));
                }
            } else if (rule.byDay) {
                days = monthDaysByDay(y, m, rule.byDay);
            } else {
                days = start.d <= daysInMonth(y, m) ? [start.d] : [];
            }
            return days.sort((a, b) => a - b).map(d => at(y, m, d));
        }
        case 'YEARLY': {
            const y = start.y + k * rule.interval;
            const months = rule.byMonth ? [...rule.byMonth].sort((a, b) => a - b) : [start.m];
            const out: Wall[] = [];
            for (const m of months) {
                let days: number[];
                if (rule.byMonthDay) days = monthDaysByMonthDay(y, m, rule.byMonthDay);
                else if (rule.byDay) days = monthDaysByDay(y, m, rule.byDay);
                else days = start.d <= daysInMonth(y, m) ? [start.d] : [];
                for (const d of days.sort((a, b) => a - b)) out.push(at(y, m, d));
            }
            return out;
        }
    }
}

export interface ExpandOptions {
    /** The series' zone for a timed series (UNTIL is an instant); undefined
     *  for an all-day series (UNTIL compares by date). */
    tz?: string;
    /** Occurrence keys (formatWall of the start) to leave out — EXDATE. */
    exdates?: ReadonlySet<string>;
    /** Stop after yielding this many (after exclusions). */
    limit?: number;
    /** Stop once an occurrence is later than this wall time (inclusive bound). */
    until?: Wall;
    /** Occurrences before this wall time are not wanted: a rule without COUNT
     *  jumps straight to the period containing it instead of walking every
     *  period since DTSTART. (With COUNT every period must be walked — the
     *  count runs from DTSTART.) Occurrences before it MAY still be yielded. */
    from?: Wall;
}

/** Which period (0 = DTSTART's) a wall time falls in. */
function periodIndex(rule: RRule, start: Wall, w: Wall): number {
    const days = Math.round((Date.UTC(w.y, w.m - 1, w.d) - Date.UTC(start.y, start.m - 1, start.d)) / 86_400_000);
    switch (rule.freq) {
        case 'DAILY': return Math.floor(days / rule.interval);
        case 'WEEKLY': return Math.floor(days / 7 / rule.interval);
        case 'MONTHLY': return Math.floor(((w.y - start.y) * 12 + (w.m - start.m)) / rule.interval);
        case 'YEARLY': return Math.floor((w.y - start.y) / rule.interval);
    }
}

/** How far any expansion may walk, whatever the rule: a rule that never
 *  matches (BYMONTH=2;BYMONTHDAY=30) must end, not spin. */
const MAX_PERIODS = 20_000;

function untilBound(rule: RRule, dateOnly: boolean, tz: string | undefined): ((w: Wall) => boolean) | null {
    if (!rule.until) return null;
    const u = rule.until;
    const y = +u.slice(0, 4), m = +u.slice(4, 6), d = +u.slice(6, 8);
    if (u.length === 8) {
        return w => compareWall({ ...w, hh: 0, mm: 0 }, { y, m, d, hh: 0, mm: 0 }) <= 0;
    }
    const hh = +u.slice(9, 11), mm = +u.slice(11, 13), ss = +u.slice(13, 15);
    if (u.endsWith('Z') && tz && !dateOnly) {
        const limit = Date.UTC(y, m - 1, d, hh, mm, ss);
        return w => wallToInstant(w, tz) <= limit;
    }
    // Floating UNTIL, or an all-day series given a date-time: compare walls.
    return w => compareWall(w, { y, m, d, hh: dateOnly ? 23 : hh, mm: dateOnly ? 59 : mm }) <= 0;
}

/**
 * Occurrence starts of a series in order, from DTSTART. Each item carries the
 * wall start and its key (what EXDATE stores).
 */
export function* expandSeries(
    rule: RRule, dtstart: string, opts: ExpandOptions = {},
): Generator<{ wall: Wall; key: string }> {
    const p = parseWall(dtstart);
    if (!p) return;
    const start = p.wall;
    const dateOnly = p.dateOnly;
    const within = untilBound(rule, dateOnly, opts.tz);
    const limit = opts.limit ?? Infinity;
    let yielded = 0;
    let counted = 0;
    const emit = function* (w: Wall) {
        counted++;
        const key = formatWall(w, dateOnly);
        if (opts.exdates?.has(key)) return;
        yielded++;
        yield { wall: w, key };
    };
    // DTSTART is the first occurrence, whether or not the pattern matches it.
    if (within && !within(start)) return;
    if (opts.until && compareWall(start, opts.until) > 0) return;
    let k0 = 0;
    if (opts.from && rule.count === undefined && compareWall(opts.from, start) > 0) {
        k0 = Math.max(0, periodIndex(rule, start, opts.from) - 1);
    }
    if (k0 === 0) {
        yield* emit(start);
        if (yielded >= limit || (rule.count !== undefined && counted >= rule.count)) return;
    }
    for (let k = k0; k < k0 + MAX_PERIODS; k++) {
        for (const w of periodCandidates(rule, start, k)) {
            if (compareWall(w, start) <= 0) continue;
            if (within && !within(w)) return;
            if (opts.until && compareWall(w, opts.until) > 0) return;
            yield* emit(w);
            if (yielded >= limit) return;
            if (rule.count !== undefined && counted >= rule.count) return;
        }
    }
}

/** Short English description for chips ("weekly", "every 2 weeks on Mon, Wed"). */
export function describeRRule(r: RRule, locale?: string): string {
    const dayName = (wd: number) => new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
        .format(new Date(Date.UTC(2026, 0, 4 + wd)));
    const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
    const base = r.interval === 1
        ? { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[r.freq]
        : `every ${r.interval} ${unit}s`;
    const isWeekdays = r.byDay && r.byDay.length === 5 && [1, 2, 3, 4, 5].every(d => r.byDay!.some(b => b.wd === d && b.ord === 0));
    let on = '';
    if (isWeekdays && r.freq !== 'MONTHLY' && r.freq !== 'YEARLY') return r.interval === 1 ? 'weekdays' : `${base} on weekdays`;
    if (r.byDay?.length) {
        on = ' on ' + r.byDay.map(b => {
            if (b.ord === 0) return dayName(b.wd);
            const n = b.ord === -1 ? 'last' : b.ord > 0 ? ['1st', '2nd', '3rd', '4th', '5th'][b.ord - 1] : `${-b.ord}th-last`;
            return `${n} ${dayName(b.wd)}`;
        }).join(', ');
    } else if (r.byMonthDay?.length) {
        on = ' on day ' + r.byMonthDay.map(d => (d === -1 ? 'last' : String(d))).join(', ');
    }
    const end = r.count !== undefined ? `, ${r.count} times` : r.until ? ', until ' + r.until.slice(0, 4) + '-' + r.until.slice(4, 6) + '-' + r.until.slice(6, 8) : '';
    return `${base}${on}${end}`;
}
