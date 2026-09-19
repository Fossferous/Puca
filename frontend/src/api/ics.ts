/**
 * iCalendar (.ics, RFC 5545) — write and read, entirely on the device. No
 * webcal, no CalDAV, nothing hosted, and the reader NEVER fetches an ATTACH
 * or URL value (it does not look at them at all).
 *
 * Writing: VCALENDAR with VERSION:2.0, PRODID and CALSCALE; one VEVENT per
 * item with UID, DTSTAMP, SUMMARY, DTSTART/DTEND (a TZID with its VTIMEZONE,
 * a VALUE=DATE for all-day, UTC for a plain dated item), RRULE, EXDATE,
 * LOCATION and a VALARM per alert; TEXT escaped, lines folded at 75 octets,
 * CRLF line ends. UIDs are deterministic (the schedule's own uid, or an HMAC
 * of the task id for a plain item — icsUid.ts), so exporting twice, or from
 * two devices, updates the same events in the receiving calendar instead of
 * duplicating them.
 *
 * Reading: unfolding, TEXT unescaping, VEVENT and VTODO, DTSTART/DTEND/
 * DURATION as UTC, floating, TZID (an IANA name, or a Windows zone name via
 * the table below) or VALUE=DATE, the RRULE subset (recurrence.ts), EXDATE,
 * RECURRENCE-ID overrides (the series gets an EXDATE and the changed
 * occurrence becomes its own one-off event), LOCATION, VALARM relative
 * triggers, DESCRIPTION (kept for a subtask). Everything it cannot represent
 * is listed in `notes` for the import preview — nothing is dropped silently.
 */
import { parseRRule } from './recurrence';
import { type EventSchedule, SCHEDULE_VERSION, validateSchedule } from './taskSchedule';
import {
    type Wall, addDays, formatWall, instantToWall, isValidZone, parseWall, viewerZone, wallToInstant, zoneOffsetMs,
} from '../utils/calendarMath';

// --- Writing ---------------------------------------------------------------------------------

export interface IcsItem {
    uid: string;
    summary: string;
    /** A scheduled item … */
    schedule?: EventSchedule;
    /** … or a plain dated one (an instant). */
    at?: number;
    description?: string;
}

export const PRODID = '-//Puca//Puca Notes Calendar//EN';

/** RFC 5545 TEXT escaping. */
export function escapeText(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold a content line at 75 octets (UTF-8), never inside a character. */
export function foldLine(line: string): string {
    const enc = new TextEncoder();
    const out: string[] = [];
    let cur = '';
    let curLen = 0;
    for (const ch of line) {
        const n = enc.encode(ch).length;
        const limit = out.length === 0 ? 75 : 74;   // continuation lines start with a space
        if (curLen + n > limit) {
            out.push(cur);
            cur = '';
            curLen = 0;
        }
        cur += ch;
        curLen += n;
    }
    out.push(cur);
    return out.join('\r\n ');
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
function icsDate(w: Pick<Wall, 'y' | 'm' | 'd'>): string {
    return `${pad(w.y, 4)}${pad(w.m)}${pad(w.d)}`;
}
function icsLocal(w: Wall): string {
    return `${icsDate(w)}T${pad(w.hh)}${pad(w.mm)}00`;
}
function icsUtc(ms: number): string {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function icsOffset(ms: number): string {
    const sign = ms < 0 ? '-' : '+';
    const a = Math.abs(ms) / 60_000;
    return `${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}
function icsDuration(minutes: number): string {
    const neg = minutes < 0;
    let m = Math.abs(minutes);
    const d = Math.floor(m / 1440);
    m -= d * 1440;
    const h = Math.floor(m / 60);
    m -= h * 60;
    let s = `${neg ? '-' : ''}P`;
    if (d) s += `${d}D`;
    if (h || m || !d) s += `T${h ? `${h}H` : ''}${m || (!h && !d) ? `${m}M` : ''}`;
    return s;
}

/** Offset transitions of a zone between two years, found with Intl. */
export function zoneTransitions(tz: string, fromYear: number, toYear: number): { at: number; from: number; to: number }[] {
    const out: { at: number; from: number; to: number }[] = [];
    let t = Date.UTC(fromYear, 0, 1);
    const end = Date.UTC(toYear + 1, 0, 1);
    let off = zoneOffsetMs(tz, t);
    const STEP = 86_400_000;
    while (t < end) {
        const next = t + STEP;
        const o2 = zoneOffsetMs(tz, next);
        if (o2 !== off) {
            let lo = t, hi = next;   // offset(lo) = off, offset(hi) = o2
            while (hi - lo > 60_000) {
                const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
                if (zoneOffsetMs(tz, mid) === off) lo = mid; else hi = mid;
            }
            out.push({ at: hi, from: off, to: o2 });
            off = o2;
        }
        t = next;
    }
    return out;
}

/** A VTIMEZONE that lists this zone's real transitions over the years the
 *  export needs (RDATEs, no guessed rules). */
export function vtimezone(tz: string, fromYear: number, toYear: number): string[] {
    const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
    const trans = zoneTransitions(tz, fromYear, toYear);
    if (trans.length === 0) {
        const off = icsOffset(zoneOffsetMs(tz, Date.UTC(fromYear, 0, 1)));
        lines.push('BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'END:STANDARD');
    } else {
        for (const kind of ['DAYLIGHT', 'STANDARD'] as const) {
            const mine = trans.filter(x => (x.to > x.from) === (kind === 'DAYLIGHT'));
            const groups = new Map<string, typeof mine>();
            for (const x of mine) {
                const k = `${x.from}|${x.to}`;
                groups.set(k, [...(groups.get(k) ?? []), x]);
            }
            for (const g of groups.values()) {
                const local = (x: typeof g[number]) => icsLocal(instantToWallFixed(x.at, x.from));
                lines.push(`BEGIN:${kind}`, `DTSTART:${local(g[0])}`);
                if (g.length > 1) lines.push(`RDATE:${g.slice(1).map(local).join(',')}`);
                lines.push(`TZOFFSETFROM:${icsOffset(g[0].from)}`, `TZOFFSETTO:${icsOffset(g[0].to)}`, `END:${kind}`);
            }
        }
    }
    lines.push('END:VTIMEZONE');
    return lines;
}

function instantToWallFixed(t: number, offset: number): Wall {
    const d = new Date(t + offset);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes() };
}

/** Build a whole .ics document. */
export function buildIcs(items: IcsItem[], opts: { nowMs: number; calName?: string }): string {
    const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    if (opts.calName) lines.push(`X-WR-CALNAME:${escapeText(opts.calName)}`);
    // One VTIMEZONE per zone used, covering the years in play (+10 for series).
    const zones = new Map<string, [number, number]>();
    for (const it of items) {
        const s = it.schedule;
        if (!s || s.allDay || !s.tz || s.tz === 'UTC') continue;
        const y = Number(s.start.slice(0, 4));
        const [a, b] = zones.get(s.tz) ?? [y, y];
        zones.set(s.tz, [Math.min(a, y - 1), Math.max(b, y + (s.rrule ? 10 : 1))]);
    }
    for (const [tz, [a, b]] of zones) lines.push(...vtimezone(tz, a, b));
    const stamp = icsUtc(opts.nowMs);
    for (const it of items) {
        lines.push('BEGIN:VEVENT', `UID:${it.uid}`, `DTSTAMP:${stamp}`, `SUMMARY:${escapeText(it.summary)}`);
        const s = it.schedule;
        if (s) {
            const start = parseWall(s.start)!.wall;
            const dt = (key: string, prop: string) => {
                const w = parseWall(key)!.wall;
                if (s.allDay) return `${prop};VALUE=DATE:${icsDate(w)}`;
                if (s.tz === 'UTC') return `${prop}:${icsUtc(wallToInstant(w, 'UTC'))}`;
                return `${prop};TZID=${s.tz}:${icsLocal(w)}`;
            };
            lines.push(dt(s.start, 'DTSTART'));
            if (s.end) lines.push(dt(s.end, 'DTEND'));
            else if (s.allDay) lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(start, 1))}`);
            if (s.rrule) lines.push(`RRULE:${s.rrule}`);
            for (const x of s.exdates ?? []) lines.push(dt(x, 'EXDATE'));
            if (s.location) lines.push(`LOCATION:${escapeText(s.location)}`);
            if (s.kind === 'task') lines.push('CATEGORIES:TO-DO');
            for (const a of s.alerts ?? (s.kind === 'task' ? [0] : [])) {
                lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', `TRIGGER:${icsDuration(-a)}`, 'END:VALARM');
            }
        } else if (it.at !== undefined) {
            lines.push(`DTSTART:${icsUtc(it.at)}`);
        }
        if (it.description) lines.push(`DESCRIPTION:${escapeText(it.description)}`);
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.map(foldLine).join('\r\n') + '\r\n';
}

// --- Reading ---------------------------------------------------------------------------------

export interface ContentLine {
    name: string;
    params: Record<string, string>;
    value: string;
}

export function unfold(text: string): string[] {
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r\n|\n|\r/).filter(l => l.length > 0);
}

export function parseContentLine(line: string): ContentLine | null {
    // name *(";" param) ":" value — a param value may be quoted and contain ":".
    let i = 0;
    const nameEnd = line.search(/[;:]/);
    if (nameEnd <= 0) return null;
    const name = line.slice(0, nameEnd).toUpperCase();
    i = nameEnd;
    const params: Record<string, string> = {};
    while (line[i] === ';') {
        i++;
        const eq = line.indexOf('=', i);
        if (eq < 0) return null;
        const pname = line.slice(i, eq).toUpperCase();
        i = eq + 1;
        let pval = '';
        if (line[i] === '"') {
            const close = line.indexOf('"', i + 1);
            if (close < 0) return null;
            pval = line.slice(i + 1, close);
            i = close + 1;
        } else {
            const stop = line.slice(i).search(/[;:]/);
            if (stop < 0) return null;
            pval = line.slice(i, i + stop);
            i += stop;
        }
        params[pname] = pval;
    }
    if (line[i] !== ':') return null;
    return { name, params, value: line.slice(i + 1) };
}

export function unescapeText(s: string): string {
    return s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Windows zone names Outlook writes as TZID, to IANA (CLDR's primary zone). */
export const WINDOWS_ZONES: Record<string, string> = {
    'GMT Standard Time': 'Europe/London',
    'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'W. Europe Standard Time': 'Europe/Berlin',
    'Romance Standard Time': 'Europe/Paris',
    'Central Europe Standard Time': 'Europe/Budapest',
    'Central European Standard Time': 'Europe/Warsaw',
    'E. Europe Standard Time': 'Europe/Chisinau',
    'FLE Standard Time': 'Europe/Kiev',
    'GTB Standard Time': 'Europe/Bucharest',
    'Russian Standard Time': 'Europe/Moscow',
    'Eastern Standard Time': 'America/New_York',
    'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver',
    'US Mountain Standard Time': 'America/Phoenix',
    'Pacific Standard Time': 'America/Los_Angeles',
    'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu',
    'Atlantic Standard Time': 'America/Halifax',
    'Newfoundland Standard Time': 'America/St_Johns',
    'SA Pacific Standard Time': 'America/Bogota',
    'E. South America Standard Time': 'America/Sao_Paulo',
    'Pacific SA Standard Time': 'America/Santiago',
    'Argentina Standard Time': 'America/Buenos_Aires',
    'Mexico Standard Time': 'America/Mexico_City',
    'Central Standard Time (Mexico)': 'America/Mexico_City',
    'India Standard Time': 'Asia/Kolkata',
    'China Standard Time': 'Asia/Shanghai',
    'Tokyo Standard Time': 'Asia/Tokyo',
    'Korea Standard Time': 'Asia/Seoul',
    'Singapore Standard Time': 'Asia/Singapore',
    'Arabian Standard Time': 'Asia/Dubai',
    'Arab Standard Time': 'Asia/Riyadh',
    'Israel Standard Time': 'Asia/Jerusalem',
    'Turkey Standard Time': 'Europe/Istanbul',
    'Egypt Standard Time': 'Africa/Cairo',
    'South Africa Standard Time': 'Africa/Johannesburg',
    'AUS Eastern Standard Time': 'Australia/Sydney',
    'E. Australia Standard Time': 'Australia/Brisbane',
    'Cen. Australia Standard Time': 'Australia/Adelaide',
    'W. Australia Standard Time': 'Australia/Perth',
    'Lord Howe Standard Time': 'Australia/Lord_Howe',
    'New Zealand Standard Time': 'Pacific/Auckland',
    'Samoa Standard Time': 'Pacific/Apia',
    'UTC': 'UTC',
    'Coordinated Universal Time': 'UTC',
};

export interface IcsImportItem {
    kind: 'event' | 'task';
    uid: string;
    summary: string;
    schedule: EventSchedule;
    description?: string;
    /** What could not be represented, for the preview. */
    notes: string[];
}

export interface IcsParseResult {
    calName?: string;
    items: IcsImportItem[];
    /** File-level notes (skipped components, unknown zones …). */
    notes: string[];
}

export const MAX_IMPORT_ITEMS = 5000;

interface RawComponent {
    type: string;
    lines: ContentLine[];
    children: RawComponent[];
}

function components(lines: ContentLine[]): RawComponent[] {
    const root: RawComponent = { type: 'ROOT', lines: [], children: [] };
    const stack: RawComponent[] = [root];
    for (const l of lines) {
        const top = stack[stack.length - 1];
        if (l.name === 'BEGIN') {
            const c: RawComponent = { type: l.value.toUpperCase(), lines: [], children: [] };
            top.children.push(c);
            stack.push(c);
        } else if (l.name === 'END') {
            if (stack.length > 1) stack.pop();
        } else {
            top.lines.push(l);
        }
    }
    return root.children;
}

function prop(c: RawComponent, name: string): ContentLine | undefined {
    return c.lines.find(l => l.name === name);
}

interface ParsedTime {
    wall: Wall;
    dateOnly: boolean;
    /** The zone the wall is in ('UTC' for a Z time, the viewer's for floating). */
    tz: string;
    note?: string;
}

function resolveZone(tzid: string | undefined, fallback: string | undefined): { tz: string; note?: string } {
    if (!tzid) return { tz: fallback ?? viewerZone() };
    const clean = tzid.replace(/^\/+/, '');
    if (isValidZone(clean)) return { tz: clean };
    const win = WINDOWS_ZONES[clean];
    if (win) return { tz: win };
    return { tz: fallback ?? viewerZone(), note: `time zone “${clean}” unknown — shown in your zone` };
}

function parseTime(l: ContentLine | undefined, calTz: string | undefined): ParsedTime | null {
    if (!l) return null;
    const v = l.value.trim();
    const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (date || l.params.VALUE === 'DATE') {
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(v);
        if (!m) return null;
        const p = parseWall(`${m[1]}-${m[2]}-${m[3]}`);
        return p ? { wall: p.wall, dateOnly: true, tz: '' } : null;
    }
    const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
    if (!dt) return null;
    const wall: Wall = { y: +dt[1], m: +dt[2], d: +dt[3], hh: +dt[4], mm: +dt[5] };
    if (!parseWall(formatWall(wall, false))) return null;
    if (dt[7] === 'Z') return { wall, dateOnly: false, tz: 'UTC' };
    const z = resolveZone(l.params.TZID, calTz);
    return { wall, dateOnly: false, tz: z.tz, note: z.note ?? (l.params.TZID ? undefined : calTz ? undefined : 'floating time — shown in your zone') };
}

/** ISO 8601 duration (P1DT2H30M, -PT15M) in minutes; null if unsupported. */
export function parseDuration(v: string): number | null {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
    if (!m || v.trim() === 'P' || v.trim().endsWith('T')) return null;
    const mins = (+(m[2] ?? 0)) * 7 * 1440 + (+(m[3] ?? 0)) * 1440 + (+(m[4] ?? 0)) * 60 + (+(m[5] ?? 0)) + Math.round((+(m[6] ?? 0)) / 60);
    return m[1] === '-' ? -mins : mins;
}

function toKey(t: ParsedTime, eventTz: string | undefined, allDay: boolean): string {
    if (allDay) return formatWall(t.wall, true);
    if (t.dateOnly) return formatWall({ ...t.wall, hh: 0, mm: 0 }, false);
    if (!eventTz || t.tz === eventTz) return formatWall(t.wall, false);
    return formatWall(instantToWall(wallToInstant(t.wall, t.tz), eventTz), false);
}

/**
 * Parse an .ics document into importable items. `uidPrefix`-free: an item's
 * uid is the file's UID (dedupe across imports) — or, for a changed
 * occurrence flattened into its own event, the UID plus its RECURRENCE-ID.
 */
export function parseIcs(text: string): IcsParseResult {
    const notes: string[] = [];
    const lines = unfold(text).map(parseContentLine).filter((l): l is ContentLine => l !== null);
    const cals = components(lines).filter(c => c.type === 'VCALENDAR');
    if (cals.length === 0) return { items: [], notes: ['This is not an iCalendar file (no VCALENDAR)'] };
    const items: IcsImportItem[] = [];
    let calName: string | undefined;
    const skipped = new Map<string, number>();
    const overrides: { uid: string; recKey: RawComponent; recId: ContentLine }[] = [];
    let linksIgnored = 0;
    for (const cal of cals) {
        calName ??= prop(cal, 'X-WR-CALNAME') ? unescapeText(prop(cal, 'X-WR-CALNAME')!.value) : undefined;
        const calTzRaw = prop(cal, 'X-WR-TIMEZONE')?.value;
        const calTz = calTzRaw ? resolveZone(calTzRaw, undefined).tz : undefined;
        for (const c of cal.children) {
            if (c.type !== 'VEVENT' && c.type !== 'VTODO') {
                if (c.type !== 'VTIMEZONE') skipped.set(c.type, (skipped.get(c.type) ?? 0) + 1);
                continue;
            }
            if (items.length >= MAX_IMPORT_ITEMS) {
                notes.push(`Only the first ${MAX_IMPORT_ITEMS} events are imported`);
                break;
            }
            if (prop(c, 'ATTACH') || prop(c, 'URL')) linksIgnored++;
            const recId = prop(c, 'RECURRENCE-ID');
            const uid = (prop(c, 'UID')?.value ?? '').trim();
            if (recId && uid) { overrides.push({ uid, recKey: c, recId }); continue; }
            const item = componentToItem(c, calTz, uid || null);
            if (typeof item === 'string') { notes.push(item); continue; }
            if (c.type === 'VTODO' && /^COMPLETED$/i.test(prop(c, 'STATUS')?.value ?? '')) {
                skipped.set('completed to-do', (skipped.get('completed to-do') ?? 0) + 1);
                continue;
            }
            items.push(item);
        }
    }
    // Changed occurrences: the series skips that date, and the change comes
    // in as its own one-off event.
    for (const o of overrides) {
        const master = items.find(i => i.uid === o.uid);
        const recT = parseTime(o.recId, master?.schedule.tz);
        const item = componentToItem(o.recKey, master?.schedule.tz, `${o.uid}-${o.recId.value.replace(/[^0-9TZ]/g, '')}`);
        if (typeof item === 'string') { notes.push(item); continue; }
        if (master && recT) {
            const key = toKey(recT, master.schedule.tz, master.schedule.allDay);
            master.schedule.exdates = [...(master.schedule.exdates ?? []), key].slice(0, 200);
            master.notes.push('one changed occurrence imported as its own event');
        }
        item.schedule.rrule = undefined;
        items.push(item);
    }
    for (const [type, n] of skipped) notes.push(`${n} ${type.toLowerCase()}${n === 1 ? '' : 's'} skipped`);
    if (linksIgnored) notes.push(`${linksIgnored} link${linksIgnored === 1 ? '' : 's'} or attachment${linksIgnored === 1 ? '' : 's'} not imported (never fetched)`);
    return { calName, items, notes };
}

function componentToItem(c: RawComponent, calTz: string | undefined, uidOverride: string | null): IcsImportItem | string {
    const itemNotes: string[] = [];
    const summary = unescapeText(prop(c, 'SUMMARY')?.value ?? '').trim() || '(no title)';
    const isTodo = c.type === 'VTODO';
    const startLine = prop(c, 'DTSTART') ?? (isTodo ? prop(c, 'DUE') : undefined);
    const start = parseTime(startLine, calTz);
    if (!start) return `“${summary.slice(0, 60)}” has no start time — skipped`;
    if (start.note) itemNotes.push(start.note);
    const allDay = start.dateOnly;
    const tz = allDay ? undefined : start.tz;
    const schedule: EventSchedule = {
        v: SCHEDULE_VERSION as 1,
        kind: isTodo ? 'task' : 'event',
        uid: (uidOverride ?? '').slice(0, 200) || `import-${hashString(summary + formatWall(start.wall, allDay))}`,
        allDay,
        start: formatWall(start.wall, allDay),
    };
    if (tz) schedule.tz = tz;
    else schedule.alertTz = viewerZone();
    if (/\s/.test(schedule.uid)) schedule.uid = `import-${hashString(schedule.uid)}`;
    // End: DTEND, else DURATION.
    const endLine = isTodo ? undefined : prop(c, 'DTEND');
    const end = parseTime(endLine, calTz);
    if (end) {
        const key = toKey(end, tz, allDay);
        if (key > schedule.start) schedule.end = key;
    } else {
        const dur = prop(c, 'DURATION');
        const mins = dur ? parseDuration(dur.value) : null;
        if (mins && mins > 0) {
            if (allDay) schedule.end = formatWall(addDays(start.wall, Math.max(1, Math.round(mins / 1440))), true);
            else {
                const e = new Date(Date.UTC(start.wall.y, start.wall.m - 1, start.wall.d, start.wall.hh, start.wall.mm) + mins * 60_000);
                schedule.end = formatWall({ y: e.getUTCFullYear(), m: e.getUTCMonth() + 1, d: e.getUTCDate(), hh: e.getUTCHours(), mm: e.getUTCMinutes() }, false);
            }
        }
    }
    if (allDay && schedule.end && schedule.end === formatWall(addDays(start.wall, 1), true)) delete schedule.end;
    const rr = prop(c, 'RRULE');
    if (rr) {
        const r = parseRRule(rr.value);
        if (r.ok) schedule.rrule = rr.value.replace(/^RRULE:/i, '').toUpperCase();
        else itemNotes.push(`repeat rule not supported (${r.reason}) — imported as a single event`);
        if (c.lines.filter(l => l.name === 'RRULE').length > 1) itemNotes.push('only the first repeat rule kept');
    }
    if (prop(c, 'RDATE')) itemNotes.push('extra dates (RDATE) not supported — left out');
    const ex: string[] = [];
    for (const l of c.lines.filter(x => x.name === 'EXDATE')) {
        for (const v of l.value.split(',')) {
            const t = parseTime({ ...l, value: v }, calTz);
            if (t) ex.push(toKey(t, tz, allDay));
        }
    }
    if (ex.length && schedule.rrule) schedule.exdates = [...new Set(ex)].slice(0, 200);
    const loc = prop(c, 'LOCATION');
    if (loc) schedule.location = unescapeText(loc.value).slice(0, 500);
    const alerts: number[] = [];
    for (const a of c.children.filter(x => x.type === 'VALARM')) {
        const trig = prop(a, 'TRIGGER');
        if (!trig) continue;
        if (trig.params.VALUE === 'DATE-TIME') { itemNotes.push('a reminder at a fixed time was left out'); continue; }
        if (trig.params.RELATED === 'END') { itemNotes.push('a reminder relative to the end was left out'); continue; }
        const mins = parseDuration(trig.value);
        if (mins === null) continue;
        alerts.push(-mins);
    }
    if (alerts.length) schedule.alerts = [...new Set(alerts)].slice(0, 5);
    else if (isTodo) schedule.alerts = [0];
    const desc = prop(c, 'DESCRIPTION');
    const description = desc ? unescapeText(desc.value).trim().slice(0, 500) || undefined : undefined;
    const why = validateSchedule(schedule as unknown as Record<string, unknown>);
    if (why) return `“${summary.slice(0, 60)}” could not be imported (${why})`;
    return { kind: schedule.kind, uid: schedule.uid, summary: summary.slice(0, 500), schedule, description, notes: itemNotes };
}

/** FNV-1a, hex — a stable id for items that arrive without a UID. */
function hashString(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
}
