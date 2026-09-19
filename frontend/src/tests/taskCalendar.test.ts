// Tasks → calendar entries: plain items, events, series, completion, the
// viewer's days (an overnight event covers two), all-day dates that do not
// move with the viewer's zone, and the time-grid layout on a DST day.
import { describe, expect, it } from 'vitest';
import type { Task } from '../api/tasks';
import { entriesInRange, groupByDay, layoutDay, type CalendarSource } from '../api/taskCalendar';
import { serializeSchedule, type EventSchedule } from '../api/taskSchedule';

const task = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: false, position: id,
    created_at: '2026-10-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
});
const src = (t: Task, canEdit = true): CalendarSource => ({ task: t, noteKey: 'list:1', noteTitle: 'Plans', canEdit });
const sch = (s: Partial<EventSchedule>) => serializeSchedule({ v: 1, kind: 'event', uid: 'uid-cal-0001', allDay: false, start: '2026-10-05T09:00', tz: 'UTC', ...s } as EventSchedule);
const ALL = { showCompleted: true, showPlain: true };
const OPEN = { showCompleted: false, showPlain: true };

describe('entriesInRange', () => {
    it('plain dated items, gated by "Show plain reminders"', () => {
        const s = [src(task(1, { due_at: '2026-10-05T09:00:00Z' }))];
        expect(entriesInRange(s, '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' })).toHaveLength(1);
        expect(entriesInRange(s, '2026-10-01', '2026-11-01', { showCompleted: false, showPlain: false, tz: 'UTC' })).toHaveLength(0);
        expect(entriesInRange(s, '2026-10-06', '2026-11-01', { ...OPEN, tz: 'UTC' })).toHaveLength(0);
    });

    it('a weekly event appears on each week; a skipped week does not', () => {
        const s = [src(task(1, { schedule: sch({ rrule: 'FREQ=WEEKLY', exdates: ['2026-10-12T09:00'] }) }))];
        const e = entriesInRange(s, '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' });
        expect(e.map(x => x.dayKeys[0])).toEqual(['2026-10-05', '2026-10-19', '2026-10-26']);
        expect(e.every(x => x.repeats && !x.movable)).toBe(true);   // an occurrence of a series is not dragged in v1
    });

    it('completed: hidden by default, shown with the toggle; a repeating to-do’s done occurrences too', () => {
        const done = src(task(1, { is_completed: true, due_at: '2026-10-05T09:00:00Z' }));
        expect(entriesInRange([done], '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' })).toHaveLength(0);
        expect(entriesInRange([done], '2026-10-01', '2026-11-01', { ...ALL, tz: 'UTC' })[0].completed).toBe(true);
        const rep = src(task(2, { schedule: sch({ kind: 'task', rrule: 'FREQ=DAILY;COUNT=4', doneThrough: '2026-10-06T09:00' }) }));
        expect(entriesInRange([rep], '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' }).map(x => x.occKey)).toEqual(['2026-10-07T09:00', '2026-10-08T09:00']);
        expect(entriesInRange([rep], '2026-10-01', '2026-11-01', { ...ALL, tz: 'UTC' }).filter(x => x.completed)).toHaveLength(2);
    });

    it('an overnight event covers both of the viewer’s days', () => {
        const s = [src(task(1, { schedule: sch({ start: '2026-10-05T23:00', end: '2026-10-06T01:00' }) }))];
        const [e] = entriesInRange(s, '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' });
        expect(e.dayKeys).toEqual(['2026-10-05', '2026-10-06']);
        expect([...groupByDay([e]).keys()]).toEqual(['2026-10-05', '2026-10-06']);
    });

    it('a timed event lands on the VIEWER’s date; an all-day one stays on its date everywhere', () => {
        const timed = src(task(1, { schedule: sch({ start: '2026-10-05T23:30', tz: 'Europe/Dublin' }) }));
        expect(entriesInRange([timed], '2026-10-01', '2026-11-01', { ...OPEN, tz: 'Europe/Dublin' })[0].dayKeys).toEqual(['2026-10-05']);
        expect(entriesInRange([timed], '2026-10-01', '2026-11-01', { ...OPEN, tz: 'Asia/Tokyo' })[0].dayKeys).toEqual(['2026-10-06']);
        const allDay = src(task(2, { schedule: serializeSchedule({ v: 1, kind: 'event', uid: 'uid-cal-0002', allDay: true, start: '2026-10-05', end: '2026-10-07', alertTz: 'Europe/Dublin' }) }));
        for (const tz of ['Pacific/Apia', 'UTC', 'America/Los_Angeles']) {
            expect(entriesInRange([allDay], '2026-10-01', '2026-11-01', { ...OPEN, tz })[0].dayKeys).toEqual(['2026-10-05', '2026-10-06']);
        }
    });

    it('only an editor may move an item', () => {
        const t = task(1, { due_at: '2026-10-05T09:00:00Z' });
        expect(entriesInRange([src(t, false)], '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' })[0].movable).toBe(false);
        expect(entriesInRange([src(t, true)], '2026-10-01', '2026-11-01', { ...OPEN, tz: 'UTC' })[0].movable).toBe(true);
    });

    it('an unreadable schedule is not placed, and not guessed from due_at', () => {
        expect(entriesInRange([src(task(1, { schedule: '[Unable to decrypt]', due_at: '2026-10-05T09:00:00Z' }))], '2026-10-01', '2026-11-01', { ...ALL, tz: 'UTC' })).toHaveLength(0);
    });
});

describe('layoutDay', () => {
    it('positions by WALL minutes on a DST day and puts overlaps side by side', () => {
        const tz = 'America/New_York';
        const s = [
            src(task(1, { schedule: sch({ uid: 'uid-lay-0001', start: '2026-11-01T15:00', end: '2026-11-01T16:00', tz }) })),
            src(task(2, { schedule: sch({ uid: 'uid-lay-0002', start: '2026-11-01T15:30', end: '2026-11-01T17:00', tz }) })),
            src(task(3, { schedule: sch({ uid: 'uid-lay-0003', start: '2026-11-01T18:00', end: '2026-11-01T18:30', tz }) })),
        ];
        const e = entriesInRange(s, '2026-11-01', '2026-11-02', { ...OPEN, tz });
        const placed = layoutDay(e, '2026-11-01', tz);
        const byId = new Map(placed.map(p => [p.entry.source.task.id, p]));
        expect(byId.get(1)).toMatchObject({ top: 900, height: 60, col: 0, cols: 2 });
        expect(byId.get(2)).toMatchObject({ top: 930, height: 90, col: 1, cols: 2 });
        expect(byId.get(3)).toMatchObject({ top: 1080, col: 0, cols: 1 });
    });
});
