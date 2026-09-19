/**
 * The calendar's device-local choices: Show completed / Show plain reminders,
 * the week-start override, the note tap-to-add used last, and whether the
 * "your phone's calendar may sync this" notice was seen. Namespaced per
 * account like Notes' own prefs (a shared browser never mixes two people's),
 * and presentation only — nothing here is content. If a sealed synced prefs
 * blob lands, this moves there.
 */
import { useSyncExternalStore } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { type WeekStart, weekStartFor } from '../../utils/calendarMath';

export interface CalendarPrefs {
    showCompleted: boolean;
    showPlain: boolean;
    weekStart: 'auto' | WeekStart;
    lastNote: string | null;
    phoneCalendarNoticeSeen: boolean;
}

const DEFAULTS: CalendarPrefs = Object.freeze({
    showCompleted: false, showPlain: true, weekStart: 'auto', lastNote: null, phoneCalendarNoticeSeen: false,
}) as CalendarPrefs;

const PREFIX = 'pucaCalendarPrefs';

export function parseCalendarPrefs(raw: string | null): CalendarPrefs {
    if (!raw) return DEFAULTS;
    try {
        const o = JSON.parse(raw) as Record<string, unknown>;
        return {
            showCompleted: o.showCompleted === true,
            showPlain: o.showPlain !== false,
            weekStart: o.weekStart === 0 || o.weekStart === 1 || o.weekStart === 6 ? o.weekStart : 'auto',
            lastNote: typeof o.lastNote === 'string' && /^(list|channel):\d+$/.test(o.lastNote) ? o.lastNote : null,
            phoneCalendarNoticeSeen: o.phoneCalendarNoticeSeen === true,
        };
    } catch {
        return DEFAULTS;
    }
}

let cachedUid: string | null | undefined;
let cached: CalendarPrefs = DEFAULTS;
const listeners = new Set<() => void>();

function uid(): string | null {
    const id = currentUserIdFromToken();
    return id === null ? null : String(id);
}

export function getCalendarPrefs(): CalendarPrefs {
    const u = uid();
    if (cachedUid === undefined || cachedUid !== u) {
        cachedUid = u;
        try {
            cached = u === null ? DEFAULTS : parseCalendarPrefs(localStorage.getItem(`${PREFIX}:${u}`));
        } catch {
            cached = DEFAULTS;
        }
    }
    return cached;
}

export function setCalendarPrefs(patch: Partial<CalendarPrefs>): void {
    const u = uid();
    if (u === null) return;
    cached = { ...getCalendarPrefs(), ...patch };
    cachedUid = u;
    try { localStorage.setItem(`${PREFIX}:${u}`, JSON.stringify(cached)); } catch { /* in-memory for this page */ }
    for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

export function useCalendarPrefs(): CalendarPrefs {
    return useSyncExternalStore(subscribe, getCalendarPrefs, getCalendarPrefs);
}

/** The effective week start: the override, else the locale's. */
export function effectiveWeekStart(p: CalendarPrefs, locale?: string): WeekStart {
    if (p.weekStart !== 'auto') return p.weekStart;
    const loc = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    return weekStartFor(loc);
}
