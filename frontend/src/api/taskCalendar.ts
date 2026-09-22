/**
 * Tasks → calendar entries. Pure and data-agnostic: Notes and Púca's Tasks
 * view both hand it { task, note } pairs and render what comes back with the
 * same Calendar component.
 *
 * What goes on the calendar:
 *  - an item WITH a schedule, at each of its occurrences (the schedule is
 *    where it is; due_at is only its next reminder);
 *  - a plain item with a due_at, at that instant ("Show plain reminders");
 *  - completed ones only with "Show completed": a ticked plain item, a
 *    completed scheduled one, and a repeating to-do's occurrences up to
 *    doneThrough.
 *
 * Days are the VIEWER's: a timed occurrence lands on the local date(s) its
 * instants fall on (an overnight event covers both), an all-day one on its
 * floating dates.
 */
import { type Task } from './tasks';
import { type EventSchedule, occurrencesBetween, parseSchedule } from './taskSchedule';
import { compareWall, dayStartMs, localDayKey, minutesIntoDay, parseWall, viewerZone, addDaysToKey } from '../utils/calendarMath';
import { parseServerTimestamp } from '../utils/serverTime';

export interface CalendarSource {
    task: Task;
    /** Where it lives (a note key in Notes, a tab key in Púca). */
    noteKey: string;
    noteTitle: string;
    /** A shared checklist's server, shown so nobody mistakes whose it is. */
    serverName?: string;
    /** May this viewer change its date (creator or MANAGE_TASKS)? */
    canEdit: boolean;
    /** May this viewer tick or snooze it (COMPLETE_TASKS or MANAGE_TASKS)?
     *  Omitted = yes (a personal list). */
    canComplete?: boolean;
    /** This entry is a NOTE'S OWN reminder (migration 068), not an item in
     *  it: `task` carries the note's title and timing under the negative id
     *  `-list_id`, the same namespace the reminder feed uses. There is
     *  nothing to tick and nothing to snooze, so the day menu offers neither
     *  — a note's reminder is changed from the note (docs/NOTES.md). */
    isNote?: boolean;
}

/**
 * A NOTE'S OWN reminder as a calendar item. It is not a task and is never
 * stored as one: this is a projection built for the pure entry maths, which
 * reads exactly these fields. The id is NEGATIVE, so it can never collide
 * with a task id in an entry id or in any per-id map (src/task_handlers.rs,
 * list_task_reminders).
 */
export function noteAsCalendarItem(note: { id: number; title: string; dueAt?: string | null; schedule?: string | null }): Task {
    return {
        id: -note.id,
        channel_id: null,
        list_id: note.id,
        parent_id: null,
        description: note.title,
        is_completed: false,
        position: 0,
        created_at: '',
        created_by: 0,
        due_at: note.dueAt ?? null,
        schedule: note.schedule ?? null,
        snooze: null,
        attachments: null,
    };
}

export type EntryKind = 'event' | 'task' | 'plain';

export interface CalendarEntry {
    /** Unique per occurrence: `${noteKey}/${task.id}/${occKey}`. */
    id: string;
    source: CalendarSource;
    kind: EntryKind;
    /** The occurrence key (EXDATE form) for a scheduled item; '' for plain. */
    occKey: string;
    startMs: number;
    endMs: number;
    allDay: boolean;
    /** Viewer-zone days it covers, first to last. */
    dayKeys: string[];
    repeats: boolean;
    completed: boolean;
    privateTiming: boolean;
    location?: string;
    schedule?: EventSchedule;
    /** Drag/move allowed: editable, not completed, not one occurrence of a
     *  series (moving a series' occurrence is "Edit series" in v1). */
    movable: boolean;
}

export interface EntryOptions {
    showCompleted: boolean;
    showPlain: boolean;
    tz?: string;
}

const MAX_SPAN_DAYS = 62;

function coveredDays(startMs: number, endMs: number, tz: string): string[] {
    const first = localDayKey(startMs, tz);
    const last = localDayKey(Math.max(startMs, endMs - 1), tz);
    const out = [first];
    let k = first;
    while (k < last && out.length < MAX_SPAN_DAYS) {
        k = addDaysToKey(k, 1);
        out.push(k);
    }
    return out;
}

/** Entries overlapping the viewer days [fromKey, toKey) — sorted by start. */
export function entriesInRange(sources: CalendarSource[], fromKey: string, toKey: string, opts: EntryOptions): CalendarEntry[] {
    const tz = opts.tz ?? viewerZone();
    const fromMs = dayStartMs(fromKey, tz);
    const toMs = dayStartMs(toKey, tz);
    const out: CalendarEntry[] = [];
    for (const src of sources) {
        const t = src.task;
        const parsed = parseSchedule(t.schedule);
        if (parsed.state === 'ok') {
            const s = parsed.schedule;
            const done = s.kind === 'task' && s.doneThrough ? parseWall(s.doneThrough)?.wall ?? null : null;
            // All-day dates are floating: ask with a day of slack each side,
            // then keep what covers the requested dates.
            const occ = occurrencesBetween(s, fromMs - 86_400_000, toMs + 86_400_000, 1000);
            for (const o of occ) {
                const occDone = t.is_completed || (!!done && compareWall(parseWall(o.key)!.wall, done) <= 0);
                if (occDone && !opts.showCompleted) continue;
                const dayKeys = o.allDay ? (o.dayKeys ?? []) : coveredDays(o.startMs, o.endMs, tz);
                if (!dayKeys.some(k => k >= fromKey && k < toKey)) continue;
                out.push({
                    id: `${src.noteKey}/${t.id}/${o.key}`,
                    source: src,
                    kind: s.kind,
                    occKey: o.key,
                    startMs: o.startMs,
                    endMs: o.endMs,
                    allDay: o.allDay,
                    dayKeys,
                    repeats: !!s.rrule,
                    completed: occDone,
                    privateTiming: s.privateTiming === true,
                    location: s.location,
                    schedule: s,
                    movable: src.canEdit && !occDone && !s.rrule,
                });
            }
            continue;
        }
        if (parsed.state === 'readonly' || !t.due_at || !opts.showPlain) continue;
        if (t.is_completed && !opts.showCompleted) continue;
        const at = parseServerTimestamp(t.due_at);
        if (!Number.isFinite(at) || at < fromMs || at >= toMs) continue;
        out.push({
            id: `${src.noteKey}/${t.id}/`,
            source: src,
            kind: 'plain',
            occKey: '',
            startMs: at,
            endMs: at,
            allDay: false,
            dayKeys: [localDayKey(at, tz)],
            repeats: false,
            completed: t.is_completed,
            privateTiming: false,
            movable: src.canEdit && !t.is_completed,
        });
    }
    out.sort((a, b) => a.startMs - b.startMs || Number(b.allDay) - Number(a.allDay) || a.id.localeCompare(b.id));
    return out;
}

/** Day key → its entries: all-day first, then by start time. */
export function groupByDay(entries: CalendarEntry[]): Map<string, CalendarEntry[]> {
    const m = new Map<string, CalendarEntry[]>();
    for (const e of entries) {
        for (const k of e.dayKeys) {
            const list = m.get(k) ?? [];
            list.push(e);
            m.set(k, list);
        }
    }
    for (const list of m.values()) list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs || a.id.localeCompare(b.id));
    return m;
}

export interface Placed {
    entry: CalendarEntry;
    /** Minutes into the day (wall clock), clamped to the day. */
    top: number;
    height: number;
    col: number;
    cols: number;
}

/**
 * Lay out one day's timed entries for a time grid: position by wall-clock
 * minutes (never ms since midnight, which is off by an hour on a DST day),
 * and put overlapping ones side by side.
 */
export function layoutDay(entries: CalendarEntry[], dayKey: string, tz: string = viewerZone(), minHeight = 20): Placed[] {
    const dayStart = dayStartMs(dayKey, tz);
    const next = dayStartMs(addDaysToKey(dayKey, 1), tz);
    const minutes = (t: number) => {
        if (t <= dayStart) return 0;
        if (t >= next) return 24 * 60;
        return minutesIntoDay(t, tz);
    };
    const timed = entries.filter(e => !e.allDay).map(e => {
        const top = minutes(e.startMs);
        const bottom = e.endMs > e.startMs ? minutes(e.endMs) : top;
        return { entry: e, top, height: Math.max(minHeight, bottom - top) };
    }).sort((a, b) => a.top - b.top || b.height - a.height);
    // Greedy columns within overlapping clusters.
    const placed: Placed[] = [];
    let cluster: { item: typeof timed[number]; col: number }[] = [];
    let clusterEnd = -1;
    const flush = () => {
        const cols = Math.max(1, ...cluster.map(c => c.col + 1));
        for (const c of cluster) placed.push({ ...c.item, col: c.col, cols });
        cluster = [];
    };
    for (const it of timed) {
        if (cluster.length > 0 && it.top >= clusterEnd) { flush(); clusterEnd = -1; }
        const used = new Set(cluster.filter(c => c.item.top + c.item.height > it.top).map(c => c.col));
        let col = 0;
        while (used.has(col)) col++;
        cluster.push({ item: it, col });
        clusterEnd = Math.max(clusterEnd, it.top + it.height);
    }
    if (cluster.length) flush();
    return placed;
}
