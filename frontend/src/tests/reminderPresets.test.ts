// The one-tap reminder times: what an instant a preset names, and the three
// places the old hardcoded 09:00 used to live (Snooze's Tomorrow, a fresh
// schedule form, an all-day form's time row).
//
// Every case fixes `now` and names the zone explicitly — a test that took the
// machine's zone would pass in Dublin and fail in the CI container, and the
// DST case would prove nothing at all.
import { describe, it, expect } from 'vitest';
import {
    DEFAULT_REMINDER_TIMES, isReminderTime, parseReminderTimes, presetInstant, sameReminderTimes,
} from '../api/reminderTimes';
import { snoozeUntil } from '../api/taskSchedule';
import { formFromSchedule, newForm } from '../api/scheduleForm';
import { instantToWall } from '../utils/calendarMath';

const TZ = 'Europe/Dublin';
const wall = (ms: number, tz = TZ) => {
    const w = instantToWall(ms, tz);
    return `${w.y}-${String(w.m).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.hh).padStart(2, '0')}:${String(w.mm).padStart(2, '0')}`;
};

describe('presetInstant', () => {
    it('lands on today when that time is still ahead', () => {
        const now = Date.parse('2026-03-10T06:00:00Z');   // 06:00 Dublin (GMT)
        expect(wall(presetInstant('09:00', now, TZ))).toBe('2026-03-10 09:00');
        expect(wall(presetInstant('14:00', now, TZ))).toBe('2026-03-10 14:00');
        expect(wall(presetInstant('19:00', now, TZ))).toBe('2026-03-10 19:00');
    });

    it('rolls to tomorrow when it has already gone — Morning tapped at 11:00', () => {
        const now = Date.parse('2026-03-10T11:00:00Z');
        expect(wall(presetInstant('07:00', now, TZ))).toBe('2026-03-11 07:00');
        // Positive control: the same tap at 06:00 stays today.
        expect(wall(presetInstant('07:00', Date.parse('2026-03-10T06:00:00Z'), TZ))).toBe('2026-03-10 07:00');
    });

    it('an evening of 23:30 tapped at 23:45 is tomorrow evening, never the past', () => {
        const now = Date.parse('2026-03-10T23:45:00Z');
        const at = presetInstant('23:30', now, TZ);
        expect(at).toBeGreaterThan(now);
        expect(wall(at)).toBe('2026-03-11 23:30');
    });

    it('exactly now counts as gone (a preset never lands on this instant)', () => {
        const now = Date.parse('2026-03-10T09:00:00Z');
        const at = presetInstant('09:00', now, TZ);
        expect(at).toBeGreaterThan(now);
        expect(wall(at)).toBe('2026-03-11 09:00');
    });

    it('crosses the spring DST change by WALL time, not by +24h', () => {
        // Ireland goes forward at 01:00 on 2026-03-29, so that day is 23h.
        const now = Date.parse('2026-03-28T10:00:00Z');   // 10:00 Dublin
        const at = presetInstant('09:00', now, TZ);
        expect(wall(at)).toBe('2026-03-29 09:00');        // 09:00 IST, not 08:00
        expect(at - now).toBe(22 * 3_600_000);            // a naive +24h would be 23h
    });

    it('falls back to the default time for a malformed setting', () => {
        const now = Date.parse('2026-03-10T06:00:00Z');
        expect(presetInstant('nonsense', now, TZ)).toBe(presetInstant(DEFAULT_REMINDER_TIMES.default, now, TZ));
    });
});

describe('parseReminderTimes / isReminderTime', () => {
    it('accepts only a 24-hour HH:mm', () => {
        for (const ok of ['00:00', '09:00', '23:59', '07:30']) expect(isReminderTime(ok)).toBe(true);
        for (const bad of ['24:00', '9:00', '07:60', '7:5', '', '0900', 900, null, undefined, {}]) expect(isReminderTime(bad)).toBe(false);
    });
    it('fills every field, per field', () => {
        expect(parseReminderTimes(undefined)).toEqual(DEFAULT_REMINDER_TIMES);
        expect(parseReminderTimes({ evening: '22:15' })).toEqual({ ...DEFAULT_REMINDER_TIMES, evening: '22:15' });
        expect(parseReminderTimes('07:30')).toEqual(DEFAULT_REMINDER_TIMES);
        expect(sameReminderTimes(parseReminderTimes({}), DEFAULT_REMINDER_TIMES)).toBe(true);
        expect(sameReminderTimes(parseReminderTimes({ morning: '07:30' }), DEFAULT_REMINDER_TIMES)).toBe(false);
    });
});

describe('the old hardcoded 09:00s now follow the setting', () => {
    it("Snooze's Tomorrow is the morning time, and 09:00 when none is given", () => {
        const now = Date.parse('2026-03-10T11:00:00Z');
        expect(wall(snoozeUntil('tomorrow', now, TZ, '07:30'))).toBe('2026-03-11 07:30');
        expect(wall(snoozeUntil('tomorrow', now, TZ))).toBe('2026-03-11 09:00');
        // A broken setting must not produce 00:00 (Number('') is 0, not NaN).
        expect(wall(snoozeUntil('tomorrow', now, TZ, ''))).toBe('2026-03-11 09:00');
        // The relative presets are untouched.
        expect(snoozeUntil('10m', now, TZ, '07:30') - now).toBe(600_000);
    });

    it('a new schedule form starts at the configured time — but today still means the next full hour', () => {
        const now = Date.parse('2026-03-10T11:20:00Z');
        expect(newForm('task', '2026-03-12', now, undefined, TZ, '07:30').startTime).toBe('07:30');
        expect(newForm('task', '2026-03-12', now, undefined, TZ).startTime).toBe('09:00');
        expect(newForm('task', '2026-03-10', now, undefined, TZ, '07:30').startTime).toBe('12:00');
        // An explicit time (an item that already has one) still wins.
        expect(newForm('task', '2026-03-12', now, '16:45', TZ, '07:30').startTime).toBe('16:45');
    });

    it('an all-day schedule shows the configured time in the row that appears when All day is unticked', () => {
        const allDay = { v: 1 as const, kind: 'task' as const, uid: 'u1', allDay: true, start: '2026-03-12' };
        expect(formFromSchedule(allDay, '07:30').startTime).toBe('07:30');
        expect(formFromSchedule(allDay).startTime).toBe('09:00');
        // A TIMED schedule keeps its own time, setting or no setting.
        const timed = { v: 1 as const, kind: 'task' as const, uid: 'u2', allDay: false, start: '2026-03-12T16:45', tz: TZ };
        expect(formFromSchedule(timed, '07:30').startTime).toBe('16:45');
    });
});
