import { describe, expect, it } from 'vitest';
import {
    addDaysToKey, dayKeyOf, formatWall, instantToWall, isInGap, localDayKey, minutesIntoDay, monthMatrix, moveToDay,
    parseWall, wallToInstant, weekOf, weekStartFor, zoneOffsetMs,
} from '../utils/calendarMath';

const w = (s: string) => parseWall(s)!.wall;
const iso = (t: number) => new Date(t).toISOString();

describe('wallToInstant — RFC 5545 §3.3.5 semantics', () => {
    it('a normal wall time round-trips in several zones', () => {
        for (const tz of ['America/New_York', 'Europe/Dublin', 'Australia/Lord_Howe', 'Pacific/Apia', 'UTC', 'Asia/Kolkata']) {
            const wall = w('2026-07-15T13:45');
            expect(instantToWall(wallToInstant(wall, tz), tz)).toEqual(wall);
        }
    });

    it('a nonexistent (spring-forward) time takes the PRE-gap offset: 02:30 → 03:30', () => {
        // New York, 2026-03-08: 02:00 EST jumps to 03:00 EDT.
        const t = wallToInstant(w('2026-03-08T02:30'), 'America/New_York');
        expect(iso(t)).toBe('2026-03-08T07:30:00.000Z');
        expect(formatWall(instantToWall(t, 'America/New_York'), false)).toBe('2026-03-08T03:30');
        expect(isInGap(w('2026-03-08T02:30'), 'America/New_York')).toBe(true);
        expect(isInGap(w('2026-03-08T03:30'), 'America/New_York')).toBe(false);
        // Dublin, 2026-03-29: 01:00 GMT jumps to 02:00 IST.
        expect(iso(wallToInstant(w('2026-03-29T01:30'), 'Europe/Dublin'))).toBe('2026-03-29T01:30:00.000Z');
        // Santiago, 2026-09-06: midnight does not exist (00:00 → 01:00).
        const cl = wallToInstant(w('2026-09-06T00:30'), 'America/Santiago');
        expect(iso(cl)).toBe('2026-09-06T04:30:00.000Z');
        expect(formatWall(instantToWall(cl, 'America/Santiago'), false)).toBe('2026-09-06T01:30');
    });

    it('a half-hour gap (Lord Howe, +10:30 → +11:00) moves forward by the gap', () => {
        const t = wallToInstant(w('2026-10-04T02:15'), 'Australia/Lord_Howe');
        expect(formatWall(instantToWall(t, 'Australia/Lord_Howe'), false)).toBe('2026-10-04T02:45');
    });

    it('an ambiguous (fall-back) time is the EARLIER instant', () => {
        // New York, 2026-11-01: 01:30 happens at -04 and again at -05.
        expect(iso(wallToInstant(w('2026-11-01T01:30'), 'America/New_York'))).toBe('2026-11-01T05:30:00.000Z');
        // Dublin, 2026-10-25: 01:30 happens at +01 and again at +00.
        expect(iso(wallToInstant(w('2026-10-25T01:30'), 'Europe/Dublin'))).toBe('2026-10-25T00:30:00.000Z');
    });

    it('offsets are read per instant, including a 30-minute DST', () => {
        expect(zoneOffsetMs('Australia/Lord_Howe', Date.parse('2026-07-01T00:00:00Z'))).toBe(10.5 * 3600_000);
        expect(zoneOffsetMs('Australia/Lord_Howe', Date.parse('2026-12-01T00:00:00Z'))).toBe(11 * 3600_000);
        expect(zoneOffsetMs('Asia/Kolkata', Date.parse('2026-01-01T00:00:23.456Z'))).toBe(5.5 * 3600_000);
    });
});

describe('days, weeks and months', () => {
    it('day keys at 23:30 and 00:30 around a DST change stay on their own dates', () => {
        const tz = 'America/New_York';
        expect(localDayKey(wallToInstant(w('2026-03-07T23:30'), tz), tz)).toBe('2026-03-07');
        expect(localDayKey(wallToInstant(w('2026-03-08T00:30'), tz), tz)).toBe('2026-03-08');
        expect(localDayKey(wallToInstant(w('2026-11-01T23:30'), tz), tz)).toBe('2026-11-01');
        expect(localDayKey(wallToInstant(w('2026-11-02T00:30'), tz), tz)).toBe('2026-11-02');
    });

    it('minutesIntoDay is wall-clock minutes, not ms since midnight', () => {
        const tz = 'America/New_York';
        // 15:00 on a 23-hour day is still minute 900.
        expect(minutesIntoDay(wallToInstant(w('2026-03-08T15:00'), tz), tz)).toBe(900);
        expect(minutesIntoDay(wallToInstant(w('2026-11-01T15:00'), tz), tz)).toBe(900);
    });

    it('month matrix: six weeks, starting on the requested weekday', () => {
        const mon = monthMatrix(2026, 10, 1);
        expect(mon).toHaveLength(6);
        expect(mon[0][0]).toBe('2026-09-28');   // Oct 1 2026 is a Thursday
        expect(mon[0][3]).toBe('2026-10-01');
        const sun = monthMatrix(2026, 10, 0);
        expect(sun[0][0]).toBe('2026-09-27');
        const sat = monthMatrix(2026, 10, 6);
        expect(sat[0][0]).toBe('2026-09-26');
        // A month that starts on the week's first day starts in row 0, col 0.
        expect(monthMatrix(2026, 6, 1)[0][0]).toBe('2026-06-01');
        // Across the DST month the matrix is plain dates — no hour drift.
        expect(monthMatrix(2026, 3, 0).flat()).toContain('2026-03-08');
    });

    it('week of a day, and adding days across a DST change', () => {
        expect(weekOf('2026-11-01', 1)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
        expect(weekOf('2026-11-01', 0)[0]).toBe('2026-11-01');
        expect(addDaysToKey('2026-03-07', 1)).toBe('2026-03-08');
        expect(addDaysToKey('2026-12-31', 1)).toBe('2027-01-01');
        expect(dayKeyOf({ y: 2026, m: 2, d: 28 })).toBe('2026-02-28');
    });

    it('week start per locale, with the region fallback', () => {
        expect(weekStartFor('en-US')).toBe(0);
        expect(weekStartFor('en-GB')).toBe(1);
        expect(weekStartFor('de-DE')).toBe(1);
        expect(weekStartFor('ar-EG')).toBe(6);
        expect(weekStartFor('not a locale!!')).toBe(1);
    });

    it('moveToDay keeps the clock time, and says so when the gap adjusted it', () => {
        const tz = 'America/New_York';
        const moved = moveToDay(w('2026-03-01T02:30'), '2026-03-08', tz);
        expect(moved.adjusted).toBe(true);
        expect(formatWall(instantToWall(moved.instant, tz), false)).toBe('2026-03-08T03:30');
        const normal = moveToDay(w('2026-03-01T15:00'), '2026-03-09', tz);
        expect(normal.adjusted).toBe(false);
        expect(formatWall(instantToWall(normal.instant, tz), false)).toBe('2026-03-09T15:00');
    });

    it('parseWall is strict', () => {
        expect(parseWall('2026-02-30')).toBeNull();
        expect(parseWall('2026-13-01')).toBeNull();
        expect(parseWall('2026-10-01T24:00')).toBeNull();
        expect(parseWall('2026-10-01T09:00:00')).toBeNull();
        expect(parseWall('2026-10-01')?.dateOnly).toBe(true);
        expect(parseWall('2026-10-01T09:05')?.dateOnly).toBe(false);
    });
});
