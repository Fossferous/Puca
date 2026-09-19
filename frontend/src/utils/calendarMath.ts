/**
 * Calendar date and time-zone arithmetic — pure, no dependencies beyond Intl.
 *
 * Two kinds of time live in a calendar and they must not be mixed:
 *
 *  - WALL time: "15:00 on 2026-10-04 in Europe/Dublin" — what an event's
 *    schedule stores (start/end + an IANA zone), and a FLOATING date for an
 *    all-day event ("2026-10-04", the same date wherever you are).
 *  - INSTANTS: epoch milliseconds — what due_at, the reminder loop and the
 *    server deal in.
 *
 * wallToInstant follows RFC 5545 §3.3.5 (and Temporal's "compatible"
 * disambiguation, which Google and Apple calendars also follow): a wall time
 * that does not exist because the clocks jumped forward takes the offset in
 * force BEFORE the jump (02:30 on a spring-forward night becomes 03:30), and
 * a wall time that happens twice because the clocks went back is the EARLIER
 * of the two. Day arithmetic is done on UTC dates, where every day has 24
 * hours, so adding a day never lands on a different wall time.
 *
 * Rendering is always in the VIEWER's zone (an instant computed from the
 * event's own zone, then shown where the reader is); the editor shows the
 * event's zone.
 */

export interface Wall {
    y: number;
    /** 1–12 */
    m: number;
    d: number;
    hh: number;
    mm: number;
}

const DAY_MS = 86_400_000;
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** 'YYYY-MM-DD' (all-day, floating) or 'YYYY-MM-DDTHH:mm'. */
export function parseWall(s: string): { wall: Wall; dateOnly: boolean } | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(s);
    if (!m) return null;
    const wall: Wall = { y: +m[1], m: +m[2], d: +m[3], hh: m[4] ? +m[4] : 0, mm: m[5] ? +m[5] : 0 };
    if (wall.m < 1 || wall.m > 12 || wall.d < 1 || wall.d > daysInMonth(wall.y, wall.m)) return null;
    if (wall.hh > 23 || wall.mm > 59) return null;
    return { wall, dateOnly: !m[4] };
}

export function formatWall(w: Wall, dateOnly: boolean): string {
    const date = `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
    return dateOnly ? date : `${date}T${pad(w.hh)}:${pad(w.mm)}`;
}

export function dayKeyOf(w: Pick<Wall, 'y' | 'm' | 'd'>): string {
    return `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}`;
}

export function daysInMonth(y: number, m: number): number {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(y: number, m: number, d: number): number {
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDays(w: Wall, n: number): Wall {
    const t = new Date(Date.UTC(w.y, w.m - 1, w.d + n));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: w.hh, mm: w.mm };
}

export function addDaysToKey(key: string, n: number): string {
    const p = parseWall(key);
    if (!p) return key;
    return dayKeyOf(addDays(p.wall, n));
}

/** Whole days from a to b (date parts only). */
export function daysBetween(a: Pick<Wall, 'y' | 'm' | 'd'>, b: Pick<Wall, 'y' | 'm' | 'd'>): number {
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
}

export function compareWall(a: Wall, b: Wall): number {
    return Date.UTC(a.y, a.m - 1, a.d, a.hh, a.mm) - Date.UTC(b.y, b.m - 1, b.d, b.hh, b.mm);
}

// --- Zones ----------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
    let f = formatters.get(tz);
    if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23',
            year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
        });
        formatters.set(tz, f);
    }
    return f;
}

export function isValidZone(tz: unknown): tz is string {
    if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
    try {
        fmt(tz);
        return true;
    } catch {
        return false;
    }
}

/** The zone this device renders in. */
export function viewerZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

function parts(t: number, tz: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number } {
    const out: Record<string, number> = {};
    for (const p of fmt(tz).formatToParts(new Date(t))) {
        if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    return { y: out.year, m: out.month, d: out.day, hh: out.hour === 24 ? 0 : out.hour, mm: out.minute, ss: out.second };
}

/** UTC offset of `tz` at instant `t`, in ms (east positive). */
export function zoneOffsetMs(tz: string, t: number): number {
    const p = parts(t, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
    // Drop the sub-second remainder the instant carries.
    return asUtc - (t - (((t % 1000) + 1000) % 1000));
}

export function instantToWall(t: number, tz: string): Wall {
    const p = parts(t, tz);
    return { y: p.y, m: p.m, d: p.d, hh: p.hh, mm: p.mm };
}

/**
 * The instant a wall time names in a zone (RFC 5545 §3.3.5): a nonexistent
 * time takes the pre-gap offset (so it lands after the gap by the gap's
 * length), an ambiguous one is the earlier instant.
 */
export function wallToInstant(w: Wall, tz: string): number {
    const W = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm);
    const before = zoneOffsetMs(tz, W - DAY_MS);
    const after = zoneOffsetMs(tz, W + DAY_MS);
    const valid: number[] = [];
    for (const off of before === after ? [before] : [before, after]) {
        const t = W - off;
        if (zoneOffsetMs(tz, t) === off) valid.push(t);
    }
    if (valid.length > 0) return Math.min(...valid);
    return W - before;   // in the gap: the offset in force before it
}

/** True when a wall time does not exist in the zone (a spring-forward gap). */
export function isInGap(w: Wall, tz: string): boolean {
    const t = wallToInstant(w, tz);
    return compareWall(instantToWall(t, tz), w) !== 0;
}

/** The viewer-zone day key of an instant. */
export function localDayKey(t: number, tz: string = viewerZone()): string {
    return dayKeyOf(instantToWall(t, tz));
}

/** Minutes since local midnight by WALL clock (never ms since midnight, which
 *  is off by an hour on a DST day). */
export function minutesIntoDay(t: number, tz: string = viewerZone()): number {
    const w = instantToWall(t, tz);
    return w.hh * 60 + w.mm;
}

// --- Grids ----------------------------------------------------------------------

/** 0 = Sunday … 6 = Saturday. */
export type WeekStart = 0 | 1 | 6;

/** Regions whose week starts on Sunday / Saturday (CLDR), for engines
 *  without Intl.Locale week info. Everything else starts on Monday. */
const SUNDAY_REGIONS = new Set([
    'AG', 'AS', 'BD', 'BR', 'BS', 'BT', 'BW', 'BZ', 'CA', 'CN', 'CO', 'DM', 'DO', 'ET', 'GT', 'GU', 'HK', 'HN', 'ID',
    'IL', 'IN', 'JM', 'JP', 'KE', 'KH', 'KR', 'LA', 'MH', 'MM', 'MO', 'MT', 'MX', 'MZ', 'NI', 'NP', 'PA', 'PE', 'PH',
    'PK', 'PR', 'PT', 'PY', 'SA', 'SG', 'SV', 'TH', 'TT', 'TW', 'UM', 'US', 'VE', 'VI', 'WS', 'YE', 'ZA', 'ZW',
]);
const SATURDAY_REGIONS = new Set(['AE', 'AF', 'BH', 'DJ', 'DZ', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SD', 'SY']);

export function weekStartFor(locale: string): WeekStart {
    try {
        const loc = new Intl.Locale(locale) as Intl.Locale & {
            getWeekInfo?: () => { firstDay: number };
            weekInfo?: { firstDay: number };
        };
        const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
        if (info && typeof info.firstDay === 'number') {
            const d = info.firstDay % 7;   // ISO: 7 = Sunday
            if (d === 0 || d === 1 || d === 6) return d;
        }
        const region = (loc.maximize().region ?? '').toUpperCase();
        if (SUNDAY_REGIONS.has(region)) return 0;
        if (SATURDAY_REGIONS.has(region)) return 6;
    } catch { /* fall through */ }
    return 1;
}

/** Six weeks of day keys covering a month, starting on `weekStart`. */
export function monthMatrix(y: number, m: number, weekStart: WeekStart): string[][] {
    const first = weekdayOf(y, m, 1);
    const lead = (first - weekStart + 7) % 7;
    let cur: Wall = addDays({ y, m, d: 1, hh: 0, mm: 0 }, -lead);
    const weeks: string[][] = [];
    for (let w = 0; w < 6; w++) {
        const row: string[] = [];
        for (let i = 0; i < 7; i++) {
            row.push(dayKeyOf(cur));
            cur = addDays(cur, 1);
        }
        weeks.push(row);
    }
    return weeks;
}

/** The seven day keys of the week containing `key`. */
export function weekOf(key: string, weekStart: WeekStart): string[] {
    const p = parseWall(key);
    if (!p) return [];
    const wd = weekdayOf(p.wall.y, p.wall.m, p.wall.d);
    const lead = (wd - weekStart + 7) % 7;
    const out: string[] = [];
    for (let i = 0; i < 7; i++) out.push(dayKeyOf(addDays(p.wall, i - lead)));
    return out;
}

/** Midnight at the start of a viewer-zone day, as an instant. */
export function dayStartMs(key: string, tz: string = viewerZone()): number {
    const p = parseWall(key);
    if (!p) return NaN;
    return wallToInstant({ ...p.wall, hh: 0, mm: 0 }, tz);
}

/**
 * Move a wall time to another day, keeping its clock time. When the kept time
 * does not exist on the new day (a spring-forward gap), `adjusted` says so and
 * `instant` is the RFC-adjusted one, for the caller to tell the user.
 */
export function moveToDay(w: Wall, newDayKey: string, tz: string): { wall: Wall; instant: number; adjusted: boolean } {
    const p = parseWall(newDayKey);
    if (!p) throw new Error(`not a day: ${newDayKey}`);
    const wall: Wall = { ...p.wall, hh: w.hh, mm: w.mm };
    return { wall, instant: wallToInstant(wall, tz), adjusted: isInGap(wall, tz) };
}
