// The shared Reminders bucketing (api/reminderGroups.ts): the rules Púca's
// Reminders tab and Púca Notes' Reminders view BOTH run. Overdue / Today /
// Upcoming, soonest first; an event is never overdue; a snooze moves the row
// and an expired one puts it back; completed and undated items are not
// reminders at all; the badge is overdue + today.
import { describe, expect, it } from 'vitest';
import { bucketDue, groupReminderSources, reminderBadgeCount, type DueRow } from '../api/reminderGroups';
import type { CalendarSource } from '../api/taskCalendar';
import type { Task } from '../api/tasks';
import { serializeSchedule, serializeSnooze } from '../api/taskSchedule';

const T = (s: string) => Date.parse(s);
const NOW = T('2026-10-05T12:00:00Z');

function task(id: number, over: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `task ${id}`, is_completed: false, position: id,
        created_at: '2026-09-01T10:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
    };
}
const listSrc = (t: Task): CalendarSource => ({ task: t, noteKey: 'list:1', noteTitle: 'Plans', canEdit: true });
const chanSrc = (t: Task, myPermsCanComplete = true): CalendarSource => ({
    task: t, noteKey: 'channel:9', noteTitle: '#home', canEdit: false, canComplete: myPermsCanComplete,
});
const event = (start: string, end: string, over: Record<string, unknown> = {}) => serializeSchedule({
    v: 1, kind: 'event', uid: `uid-${start}`, allDay: false, start, end, tz: 'UTC', ...over,
} as never);

const ids = (rows: DueRow[]) => rows.map(r => r.source.task.id);

describe('groupReminderSources', () => {
    it('buckets Overdue / Today / Upcoming, soonest first inside each', () => {
        const rows = groupReminderSources([
            listSrc(task(1, { due_at: '2026-10-06T09:00:00Z' })),   // upcoming
            listSrc(task(2, { due_at: '2026-10-05T11:00:00Z' })),   // overdue
            listSrc(task(3, { due_at: '2026-10-05T18:00:00Z' })),   // today
            listSrc(task(4, { due_at: '2026-10-05T09:00:00Z' })),   // overdue, earlier
            listSrc(task(5, { due_at: '2026-10-05T15:00:00Z' })),   // today, earlier
        ], NOW);
        expect(ids(rows.overdue)).toEqual([4, 2]);
        expect(ids(rows.today)).toEqual([5, 3]);
        expect(ids(rows.upcoming)).toEqual([1]);
        // The badge is what is late or landing today.
        expect(reminderBadgeCount(rows)).toBe(4);
    });

    it('an EVENT is never overdue, and a finished one-off leaves the list', () => {
        const recent = groupReminderSources([listSrc(task(1, { schedule: event('2026-10-05T11:30', '2026-10-05T12:30') }))], NOW);
        expect(ids(recent.overdue)).toEqual([]);
        expect(ids(recent.today)).toEqual([1]);
        const gone = groupReminderSources([listSrc(task(2, { schedule: event('2026-10-01T09:00', '2026-10-01T10:00') }))], NOW);
        expect([...gone.overdue, ...gone.today, ...gone.upcoming]).toEqual([]);
        // Positive control: the same instant as a PLAIN reminder is overdue.
        const plain = groupReminderSources([listSrc(task(3, { due_at: '2026-10-01T09:00:00Z' }))], NOW);
        expect(ids(plain.overdue)).toEqual([3]);
    });

    it('an active snooze moves the row out of Overdue; an expired one puts it back', () => {
        const due = '2026-10-05T11:00:00.000Z';
        const ahead = serializeSnooze({ forDue: due, until: '2026-10-05T13:00:00.000Z' });
        const moved = groupReminderSources([listSrc(task(1, { due_at: due, snooze: ahead }))], NOW);
        expect(ids(moved.overdue)).toEqual([]);
        expect(ids(moved.today)).toEqual([1]);
        expect(moved.today[0].at).toBe(T('2026-10-05T13:00:00Z'));
        expect(moved.today[0].slot?.snoozed).toBe(true);
        const expired = serializeSnooze({ forDue: due, until: '2026-10-05T11:30:00.000Z' });
        const back = groupReminderSources([listSrc(task(1, { due_at: due, snooze: expired }))], NOW);
        expect(ids(back.overdue)).toEqual([1]);
        expect(back.overdue[0].slot?.snoozed).toBe(false);
    });

    it('a completed item and an item with no readable timing are not reminders', () => {
        const rows = groupReminderSources([
            listSrc(task(1, { due_at: '2026-10-05T11:00:00Z', is_completed: true })),
            listSrc(task(2)),                                            // no date at all
            chanSrc(task(3, { schedule: 'sealed-for-someone-else' })), // unreadable, no due_at
        ], NOW);
        expect([...rows.overdue, ...rows.today, ...rows.upcoming]).toEqual([]);
        // Positive control: the same three with a due time DO show up.
        const shown = groupReminderSources([
            listSrc(task(1, { due_at: '2026-10-05T11:00:00Z' })),
            listSrc(task(2, { due_at: '2026-10-05T11:00:00Z' })),
            chanSrc(task(3, { schedule: 'sealed-for-someone-else', due_at: '2026-10-05T11:00:00Z' })),
        ], NOW);
        expect(ids(shown.overdue)).toEqual([1, 2, 3]);
    });

    it('carries the source through, so a row knows whose checklist it is', () => {
        const rows = groupReminderSources([chanSrc(task(7, { due_at: '2026-10-05T11:00:00Z', created_by: 99 }), false)], NOW);
        expect(rows.overdue[0].source.noteTitle).toBe('#home');
        expect(rows.overdue[0].source.canComplete).toBe(false);
        expect(rows.overdue[0].source.task.created_by).toBe(99);
    });
});

describe('bucketDue', () => {
    it('sorts by time then id, so the order is stable for two items at the same instant', () => {
        const at = T('2026-10-06T09:00:00Z');
        const rows = bucketDue([
            { task: task(9), at, slot: undefined },
            { task: task(2), at, slot: undefined },
        ], NOW);
        expect(rows.upcoming.map(r => r.task.id)).toEqual([2, 9]);
    });

    it('a row handed in with no slot is judged by its plain due time', () => {
        const late = task(1, { due_at: '2026-10-05T11:00:00Z' });
        const rows = bucketDue([{ task: late, at: T('2026-10-05T11:00:00Z') }], NOW);
        expect(rows.overdue.map(r => r.task.id)).toEqual([1]);
        // Positive control: a future one is not overdue.
        const soon = task(2, { due_at: '2026-10-06T11:00:00Z' });
        expect(bucketDue([{ task: soon, at: T('2026-10-06T11:00:00Z') }], NOW).upcoming).toHaveLength(1);
    });
});
