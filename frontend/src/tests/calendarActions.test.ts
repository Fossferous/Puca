import { describe, expect, it } from 'vitest';
import type { Task } from '../api/tasks';
import { entriesInRange, type CalendarSource } from '../api/taskCalendar';
import { newItemTiming, planMove, planSkip } from '../api/calendarActions';
import { parseSchedule, serializeSchedule, type EventSchedule } from '../api/taskSchedule';

const NOW = Date.parse('2026-03-01T00:00:00Z');
const task = (over: Partial<Task>): Task => ({
    id: 1, channel_id: null, list_id: 1, parent_id: null, description: 'x', is_completed: false, position: 1,
    created_at: '2026-01-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
});
const src = (t: Task, canEdit = true): CalendarSource => ({ task: t, noteKey: 'list:1', noteTitle: 'N', canEdit });
const entry = (t: Task, tz: string, canEdit = true) => entriesInRange([src(t, canEdit)], '2026-01-01', '2027-01-01', { showCompleted: false, showPlain: true, tz })[0];

describe('planMove', () => {
    it('a plain item keeps its local clock time, and says when a DST gap moved it', () => {
        const tz = 'America/New_York';
        const e = entry(task({ due_at: '2026-03-01T07:30:00Z' }), tz);   // 02:30 EST on Mar 1
        const p = planMove(e, '2026-03-08', NOW, tz)!;   // 02:30 does not exist on Mar 8
        expect(p).toEqual({ kind: 'due', dueAt: '2026-03-08T07:30:00.000Z', adjusted: true });
        const q = planMove(e, '2026-03-09', NOW, tz)!;
        expect(q).toEqual({ kind: 'due', dueAt: '2026-03-09T06:30:00.000Z', adjusted: false });   // 02:30 EDT
    });

    it('an event keeps its wall time in ITS zone and moves start and end together', () => {
        const s: EventSchedule = { v: 1, kind: 'event', uid: 'mv-000001', allDay: false, start: '2026-10-05T15:00', end: '2026-10-05T16:00', tz: 'Europe/Dublin', alerts: [10] };
        const e = entry(task({ schedule: serializeSchedule(s, { extra: true }) }), 'America/New_York');
        const p = planMove(e, '2026-10-07', NOW, 'America/New_York');
        expect(p?.kind).toBe('schedule');
        const back = parseSchedule(p!.kind === 'schedule' ? p!.schedule : null);
        expect(back.state === 'ok' && back.schedule).toMatchObject({ start: '2026-10-07T15:00', end: '2026-10-07T16:00', tz: 'Europe/Dublin' });
        expect(back.state === 'ok' && back.raw.extra).toBe(true);
        expect(p!.kind === 'schedule' && p!.dueAt).toBe('2026-10-07T13:50:00.000Z');
    });

    it('all-day moves by dates; a series, a non-editor, or the same day is not a move', () => {
        const allDay = { v: 1, kind: 'event', uid: 'mv-000002', allDay: true, start: '2026-10-05', end: '2026-10-07', alertTz: 'UTC' } as EventSchedule;
        const p = planMove(entry(task({ schedule: serializeSchedule(allDay) }), 'UTC'), '2026-10-10', NOW, 'UTC');
        const back = parseSchedule(p && p.kind === 'schedule' ? p.schedule : null);
        expect(back.state === 'ok' && back.schedule).toMatchObject({ start: '2026-10-10', end: '2026-10-12' });
        const series = entry(task({ schedule: serializeSchedule({ ...allDay, rrule: 'FREQ=WEEKLY' }) }), 'UTC');
        expect(planMove(series, '2026-10-10', NOW, 'UTC')).toBeNull();
        expect(planMove(entry(task({ due_at: '2026-10-05T09:00:00Z' }), 'UTC', false), '2026-10-06', NOW, 'UTC')).toBeNull();
        expect(planMove(entry(task({ schedule: serializeSchedule(allDay) }), 'UTC'), '2026-10-05', NOW, 'UTC')).toBeNull();
    });
});

describe('planSkip', () => {
    it('adds the occurrence to the EXDATEs and re-derives the next reminder', () => {
        const s: EventSchedule = { v: 1, kind: 'event', uid: 'sk-000001', allDay: false, start: '2026-10-05T09:00', tz: 'UTC', rrule: 'FREQ=WEEKLY', alerts: [0] };
        const e = entriesInRange([src(task({ schedule: serializeSchedule(s) }))], '2026-10-05', '2026-10-06', { showCompleted: false, showPlain: true, tz: 'UTC' })[0];
        const p = planSkip(e, Date.parse('2026-10-01T00:00:00Z'))!;
        const back = parseSchedule(p.schedule);
        expect(back.state === 'ok' && back.schedule.exdates).toEqual(['2026-10-05T09:00']);
        expect(p.dueAt).toBe('2026-10-12T09:00:00.000Z');
    });
});

describe('newItemTiming — tap-to-add in one POST', () => {
    it('a timed event: an hour long, 10-minute reminder, in this zone', () => {
        const t = newItemTiming({ dayKey: '2026-10-05', time: '14:00', allDay: false, kind: 'event' }, true, Date.parse('2026-10-01T00:00:00Z'), 'Europe/Dublin');
        const s = parseSchedule(t.schedule);
        expect(s.state === 'ok' && s.schedule).toMatchObject({ start: '2026-10-05T14:00', end: '2026-10-05T15:00', tz: 'Europe/Dublin', alerts: [10] });
        expect(t.dueAt).toBe('2026-10-05T12:50:00.000Z');
    });

    it('an older server gets a plain due time instead (no schedule is sent)', () => {
        const t = newItemTiming({ dayKey: '2026-10-05', time: '14:00', allDay: false, kind: 'event' }, false, 0, 'UTC');
        expect(t).toEqual({ dueAt: '2026-10-05T14:00:00.000Z' });
        expect(newItemTiming({ dayKey: '2026-10-05', time: '', allDay: true, kind: 'event' }, false, 0, 'UTC')).toEqual({ dueAt: '2026-10-05T09:00:00.000Z' });
    });

    it('all-day: 09:00 on the day in the stored zone', () => {
        const t = newItemTiming({ dayKey: '2026-10-05', time: '', allDay: true, kind: 'event' }, true, 0, 'America/New_York');
        expect(t.dueAt).toBe('2026-10-05T13:00:00.000Z');
    });
});
