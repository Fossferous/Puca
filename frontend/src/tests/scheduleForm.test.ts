import { describe, expect, it } from 'vitest';
import { detectPreset, formFromSchedule, newForm, presetRule, scheduleFromForm } from '../api/scheduleForm';
import { type EventSchedule } from '../api/taskSchedule';

const T = (s: string) => Date.parse(s);

describe('the schedule editor form', () => {
    it('presets follow the chosen date (2026-10-13 is the second Tuesday)', () => {
        expect(presetRule('weekly', '2026-10-13')).toBe('FREQ=WEEKLY;BYDAY=TU');
        expect(presetRule('monthly-day', '2026-10-13')).toBe('FREQ=MONTHLY;BYMONTHDAY=13');
        expect(presetRule('monthly-nth', '2026-10-13')).toBe('FREQ=MONTHLY;BYDAY=2TU');
        expect(presetRule('monthly-last', '2026-10-27')).toBe('FREQ=MONTHLY;BYDAY=-1TU');
        expect(detectPreset('FREQ=MONTHLY;BYDAY=2TU;COUNT=4', '2026-10-13')).toEqual({ preset: 'monthly-nth', ends: 'count', count: 4, untilKey: '' });
        expect(detectPreset('FREQ=WEEKLY;BYDAY=MO,WE', '2026-10-13').preset).toBe('custom');
        expect(detectPreset('FREQ=HOURLY', '2026-10-13').preset).toBe('custom');
    });

    it('a new event defaults to an hour at 09:00 with a 10-minute reminder; today, the next full hour', () => {
        const f = newForm('event', '2026-10-20', T('2026-10-05T12:34:00Z'), undefined, 'UTC');
        expect(f).toMatchObject({ startTime: '09:00', endTime: '10:00', alert: '10', privateTiming: false });
        expect(newForm('event', '2026-10-05', T('2026-10-05T12:34:00Z'), undefined, 'UTC').startTime).toBe('13:00');
        expect(newForm('task', '2026-10-20', 0, undefined, 'UTC')).toMatchObject({ endTime: '', alert: '0' });
    });

    it('round-trips an existing schedule, keeping uid, exdates and doneThrough', () => {
        const s: EventSchedule = {
            v: 1, kind: 'event', uid: 'uid-keep-001', allDay: false, start: '2026-10-13T18:00', end: '2026-10-13T19:30', tz: 'Europe/Dublin',
            rrule: 'FREQ=MONTHLY;BYDAY=2TU', exdates: ['2026-11-10T18:00'], location: 'Hall', alerts: [60],
        };
        const back = scheduleFromForm(formFromSchedule(s), s);
        expect(back).toEqual(s);
    });

    it('an end time before the start runs past midnight', () => {
        const f = { ...newForm('event', '2026-10-13', 0, '23:00', 'UTC'), endTime: '01:00' };
        expect((scheduleFromForm(f) as EventSchedule).end).toBe('2026-10-14T01:00');
    });

    it('all-day: the inclusive "last day" becomes an exclusive end, and alerts use the stored zone', () => {
        const f = { ...newForm('event', '2026-10-13', 0, undefined, 'Europe/Dublin'), allDay: true, endDate: '2026-10-15', alert: '-540' };
        const s = scheduleFromForm(f) as EventSchedule;
        expect(s).toMatchObject({ allDay: true, start: '2026-10-13', end: '2026-10-16', alertTz: 'Europe/Dublin', alerts: [-540] });
        expect(s.tz).toBeUndefined();
        expect(formFromSchedule(s).endDate).toBe('2026-10-15');
        // A one-day all-day event has no end at all.
        expect((scheduleFromForm({ ...f, endDate: '2026-10-13' }) as EventSchedule).end).toBeUndefined();
        expect(scheduleFromForm({ ...f, endDate: '2026-10-12' })).toMatch(/before the start/);
    });

    it('ends: after N times, or through a date — an instant in the event zone for a timed series', () => {
        const base = { ...newForm('task', '2026-10-13', 0, '09:00', 'America/New_York'), repeat: 'daily' as const };
        expect((scheduleFromForm({ ...base, ends: 'count', count: 5 }) as EventSchedule).rrule).toBe('FREQ=DAILY;COUNT=5');
        // 23:59 on Oct 20 in New York (EDT, -4) is 03:59Z on the 21st.
        expect((scheduleFromForm({ ...base, ends: 'until', until: '2026-10-20' }) as EventSchedule).rrule).toBe('FREQ=DAILY;UNTIL=20261021T035900Z');
        expect(scheduleFromForm({ ...base, ends: 'count', count: 0 })).toMatch(/between 1 and 1000/);
        const allDay = { ...base, allDay: true };
        expect((scheduleFromForm({ ...allDay, ends: 'until', until: '2026-10-20' }) as EventSchedule).rrule).toBe('FREQ=DAILY;UNTIL=20261020');
    });

    it('a custom (imported) rule is kept verbatim; "keep" leaves imported alerts alone', () => {
        const s: EventSchedule = { v: 1, kind: 'event', uid: 'uid-custom-1', allDay: false, start: '2026-10-13T09:00', tz: 'UTC', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', alerts: [30, 5] };
        const f = formFromSchedule(s);
        expect(f.repeat).toBe('custom');
        expect(f.alert).toBe('keep');
        expect(scheduleFromForm(f, s)).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE;COUNT=6', alerts: [30, 5] });
    });

    it('turning repeat off drops the skipped dates and progress with it; private timing is kept', () => {
        const s: EventSchedule = { v: 1, kind: 'task', uid: 'uid-rep-0009', allDay: false, start: '2026-10-13T09:00', tz: 'UTC', rrule: 'FREQ=DAILY', exdates: ['2026-10-14T09:00'], doneThrough: '2026-10-15T09:00' };
        const out = scheduleFromForm({ ...formFromSchedule(s), repeat: 'none', privateTiming: true }, s) as EventSchedule;
        expect(out.rrule).toBeUndefined();
        expect(out.exdates).toBeUndefined();
        expect(out.doneThrough).toBeUndefined();
        expect(out.privateTiming).toBe(true);
    });
});
