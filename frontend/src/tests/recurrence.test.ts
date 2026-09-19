import { describe, expect, it } from 'vitest';
import { describeRRule, expandSeries, parseRRule, serializeRRule, type RRule } from '../api/recurrence';
import { instantToWall, parseWall, wallToInstant, formatWall } from '../utils/calendarMath';

function rule(s: string): RRule {
    const r = parseRRule(s);
    if (!r.ok) throw new Error(r.reason);
    return r.rule;
}
const keys = (r: string, start: string, opts: Parameters<typeof expandSeries>[2] = {}, n = 20) =>
    [...expandSeries(rule(r), start, { limit: n, ...opts })].map(o => o.key);

describe('parseRRule — the supported subset, and refusals with a reason', () => {
    it('parses and serializes the subset losslessly', () => {
        for (const s of [
            'FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', 'FREQ=MONTHLY;BYDAY=2TU', 'FREQ=MONTHLY;BYDAY=-1FR',
            'FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3', 'FREQ=DAILY;COUNT=3', 'FREQ=WEEKLY;UNTIL=20261231T235959Z',
            'FREQ=WEEKLY;BYDAY=SU,SA;WKST=SU', 'FREQ=YEARLY;UNTIL=20300101',
        ]) {
            expect(serializeRRule(rule(s))).toBe(s);
        }
        expect(serializeRRule(rule('RRULE:freq=daily;interval=1'))).toBe('FREQ=DAILY');
    });

    it('refuses what it does not implement, saying what', () => {
        const refused = (s: string) => { const r = parseRRule(s); return r.ok ? null : r.reason; };
        expect(refused('FREQ=HOURLY')).toMatch(/hourly/);
        expect(refused('FREQ=MONTHLY;BYSETPOS=-1;BYDAY=MO,TU,WE,TH,FR')).toMatch(/BYSETPOS/);
        expect(refused('FREQ=YEARLY;BYWEEKNO=20')).toMatch(/BYWEEKNO/);
        expect(refused('FREQ=YEARLY;BYDAY=20MO')).toMatch(/outside a month/);
        expect(refused('FREQ=YEARLY;BYDAY=MO')).toMatch(/week numbers/);
        expect(refused('FREQ=WEEKLY;BYDAY=2MO')).toMatch(/numbered/);
        expect(refused('FREQ=DAILY;COUNT=2;UNTIL=20260101')).toMatch(/COUNT and UNTIL/);
        expect(refused('FREQ=DAILY;INTERVAL=0')).toMatch(/INTERVAL/);
        expect(refused('FREQ=DAILY;FREQ=WEEKLY')).toMatch(/twice/);
        expect(refused('')).toBeTruthy();
    });
});

describe('expandSeries — RFC behaviour', () => {
    it('DTSTART is the first occurrence even when the pattern would not produce it, and counts toward COUNT', () => {
        // 2026-10-07 is a Wednesday; the rule is Mondays.
        expect(keys('FREQ=WEEKLY;BYDAY=MO;COUNT=3', '2026-10-07T09:00')).toEqual(['2026-10-07T09:00', '2026-10-12T09:00', '2026-10-19T09:00']);
    });

    it('COUNT counts BEFORE EXDATE removes an occurrence', () => {
        const ex = new Set(['2026-10-02']);
        expect(keys('FREQ=DAILY;COUNT=3', '2026-10-01', { exdates: ex })).toEqual(['2026-10-01', '2026-10-03']);
    });

    it('monthly on the 31st SKIPS months without one (no clamping)', () => {
        expect(keys('FREQ=MONTHLY', '2026-01-31T10:00', {}, 5)).toEqual([
            '2026-01-31T10:00', '2026-03-31T10:00', '2026-05-31T10:00', '2026-07-31T10:00', '2026-08-31T10:00',
        ]);
        expect(keys('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-01-31', {}, 3)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    });

    it('yearly on Feb 29 happens in leap years only', () => {
        expect(keys('FREQ=YEARLY', '2024-02-29', {}, 3)).toEqual(['2024-02-29', '2028-02-29', '2032-02-29']);
    });

    it('ordinal weekdays: second Tuesday, last Friday, last Sunday of March', () => {
        expect(keys('FREQ=MONTHLY;BYDAY=2TU', '2026-10-13T18:00', {}, 3)).toEqual(['2026-10-13T18:00', '2026-11-10T18:00', '2026-12-08T18:00']);
        expect(keys('FREQ=MONTHLY;BYDAY=-1FR', '2026-10-30', {}, 3)).toEqual(['2026-10-30', '2026-11-27', '2026-12-25']);
        expect(keys('FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', '2026-03-29', {}, 3)).toEqual(['2026-03-29', '2027-03-28', '2028-03-26']);
    });

    it('interval and weekday sets', () => {
        expect(keys('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE', '2026-10-05', {}, 5)).toEqual(['2026-10-05', '2026-10-07', '2026-10-19', '2026-10-21', '2026-11-02']);
        expect(keys('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR', '2026-10-09', {}, 3)).toEqual(['2026-10-09', '2026-10-12', '2026-10-13']);
        expect(keys('FREQ=DAILY;INTERVAL=3', '2026-10-30', {}, 3)).toEqual(['2026-10-30', '2026-11-02', '2026-11-05']);
    });

    it('UNTIL is inclusive: as an instant for a timed series, a date for all-day', () => {
        expect(keys('FREQ=DAILY;UNTIL=20261003T090000Z', '2026-10-01T09:00', { tz: 'UTC' })).toEqual(['2026-10-01T09:00', '2026-10-02T09:00', '2026-10-03T09:00']);
        expect(keys('FREQ=DAILY;UNTIL=20261003T085959Z', '2026-10-01T09:00', { tz: 'UTC' })).toEqual(['2026-10-01T09:00', '2026-10-02T09:00']);
        expect(keys('FREQ=DAILY;UNTIL=20261003', '2026-10-01')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    });

    it('a weekly 15:00 London series stays at 15:00 local across both DST changes', () => {
        const tz = 'Europe/London';
        const occ = [...expandSeries(rule('FREQ=WEEKLY'), '2026-03-22T15:00', { limit: 32 })];
        const walls = occ.map(o => formatWall(instantToWall(wallToInstant(o.wall, tz), tz), false).slice(11));
        expect(new Set(walls)).toEqual(new Set(['15:00']));
        const utcHours = new Set(occ.map(o => new Date(wallToInstant(o.wall, tz)).getUTCHours()));
        expect(utcHours).toEqual(new Set([15, 14]));   // GMT then BST then GMT
    });

    it('a rule that can never match terminates', () => {
        expect(keys('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30', '2026-01-10')).toEqual(['2026-01-10']);
        expect(keys('FREQ=MONTHLY;BYMONTHDAY=30;BYMONTH=2', '2026-01-10')).toEqual(['2026-01-10']);
    });

    it('fast-forwarding with `from` gives the same occurrences as walking from DTSTART', () => {
        const r = rule('FREQ=WEEKLY;BYDAY=TU,TH');
        const from = parseWall('2031-06-01')!.wall;
        const until = parseWall('2031-07-01')!.wall;
        const all = [...expandSeries(r, '2026-01-06T08:00', { until })].map(o => o.key).filter(k => k >= '2031-06-01');
        const fast = [...expandSeries(r, '2026-01-06T08:00', { from, until })].map(o => o.key).filter(k => k >= '2031-06-01');
        expect(fast).toEqual(all);
        expect(fast.length).toBe(8);   // June 2031: four Tuesdays, four Thursdays
    });

    it('describes rules for a chip', () => {
        expect(describeRRule(rule('FREQ=WEEKLY'), 'en-US')).toBe('weekly');
        expect(describeRRule(rule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'), 'en-US')).toBe('weekdays');
        expect(describeRRule(rule('FREQ=MONTHLY;BYDAY=-1FR'), 'en-US')).toBe('monthly on last Fri');
        expect(describeRRule(rule('FREQ=DAILY;INTERVAL=2;COUNT=5'), 'en-US')).toBe('every 2 days, 5 times');
    });
});
