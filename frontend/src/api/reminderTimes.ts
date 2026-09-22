/**
 * The four reminder times a person keeps: what Morning, Afternoon and Evening
 * mean to them, and the time a new reminder starts at.
 *
 * Pure and dependency-light on purpose: Notes stores them (and syncs them,
 * sealed, with the rest of its prefs — notes/model/notesPrefs.ts), while
 * Púca's own task tree and schedule editor only READ them through a prop and
 * fall back to these defaults. Keeping the type here is what lets a shared
 * component take the setting without importing Notes' model.
 *
 * The defaults are exactly what the product did before the setting existed
 * (09:00 / 14:00 / 19:00, new reminders at 09:00), so an account that never
 * opens the setting sees no change at all.
 *
 * PRIVACY. A preset writes the same plaintext `due_at` any reminder does —
 * the server learns WHEN, never WHAT (docs/SECURITY_MODEL.md §2). The times
 * themselves are personal (they say when you sleep), so they live inside the
 * sealed prefs document and never reach the server in the clear.
 */
import { addDays, instantToWall, viewerZone, wallToInstant } from '../utils/calendarMath';

export type ReminderPreset = 'morning' | 'afternoon' | 'evening';

export interface ReminderTimes {
    morning: string;      // 'HH:mm'
    afternoon: string;
    evening: string;
    /** What a fresh date & repeat, or a tap-to-add, starts at. */
    default: string;
}

export const REMINDER_TIME_KEYS = ['morning', 'afternoon', 'evening', 'default'] as const;

export const DEFAULT_REMINDER_TIMES: ReminderTimes = Object.freeze({
    morning: '09:00',
    afternoon: '14:00',
    evening: '19:00',
    default: '09:00',
}) as ReminderTimes;

/** Presets in the order they are offered, on a row of three. */
export const REMINDER_PRESETS: { value: ReminderPreset; label: string }[] = [
    { value: 'morning', label: 'Morning' },
    { value: 'afternoon', label: 'Afternoon' },
    { value: 'evening', label: 'Evening' },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isReminderTime(v: unknown): v is string {
    return typeof v === 'string' && HHMM.test(v);
}

/**
 * Validate a stored value field by field: anything that is not 'HH:mm' falls
 * back to that field's default rather than taking the whole object down (the
 * same discipline as parseNotesPrefs).
 */
export function parseReminderTimes(v: unknown): ReminderTimes {
    const o = (typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    const out = {} as ReminderTimes;
    for (const k of REMINDER_TIME_KEYS) out[k] = isReminderTime(o[k]) ? o[k] : DEFAULT_REMINDER_TIMES[k];
    return out;
}

export function sameReminderTimes(a: ReminderTimes, b: ReminderTimes): boolean {
    return REMINDER_TIME_KEYS.every(k => a[k] === b[k]);
}

/**
 * The instant a preset names: that wall time TODAY, or tomorrow when today's
 * has already gone (tapping Morning at 11:00, or an Evening of 23:30 at
 * 23:45). Built from wall time in the viewer's zone, so the day the clocks
 * change still lands at the time the user asked for.
 */
export function presetInstant(timeHHmm: string, nowMs: number, tz: string = viewerZone()): number {
    const time = isReminderTime(timeHHmm) ? timeHHmm : DEFAULT_REMINDER_TIMES.default;
    const hh = Number(time.slice(0, 2));
    const mm = Number(time.slice(3));
    const now = instantToWall(nowMs, tz);
    const today = wallToInstant({ ...now, hh, mm }, tz);
    return today > nowMs ? today : wallToInstant({ ...addDays(now, 1), hh, mm }, tz);
}
