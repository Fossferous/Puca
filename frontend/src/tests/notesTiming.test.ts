// Notes' timing rules: what Reminders lists and how (events never overdue,
// snoozes sort by their time, repeating to-dos on their current occurrence),
// "Edited", the search haystack, export, and "Make a copy".
import { describe, expect, it } from 'vitest';
import type { Task } from '../api/tasks';
import { buildNoteCards, groupReminders, nearestDue, noteMatches, reminderBadgeCount, type NoteSource } from '../notes/model/notesModel';
import { noteUpdatedAt } from '../notes/model/notesTiming';
import { reminderSlotOf } from '../api/reminderSlots';
import { notesToJson, openItemTimingOf, openItemsOf } from '../notes/model/noteText';
import { parseNotesPrefs } from '../notes/model/notesPrefs';
import { parseSchedule, serializeSchedule, serializeSnooze, type EventSchedule } from '../api/taskSchedule';

const T = (s: string) => Date.parse(s);
const NOW = T('2026-10-05T12:00:00Z');
function task(id: number, over: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `task ${id}`, is_completed: false, position: id,
        created_at: '2026-09-01T10:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
    };
}
const ev = (over: Partial<EventSchedule> = {}): string => serializeSchedule({
    v: 1, kind: 'event', uid: 'uid-event-01', allDay: false, start: '2026-10-05T09:00', end: '2026-10-05T10:00', tz: 'UTC', ...over,
});
const src: NoteSource = { ref: { kind: 'list', id: 1 }, title: 'Plans', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z' };
const cardsOf = (tasks: Task[]) => buildNoteCards([src], new Map([['list:1', tasks]]), [], { colors: {}, labels: {}, archived: {} });

describe('reminderSlotOf', () => {
    it('a past plain item is overdue; a snooze in force moves it out of Overdue to its snooze time', () => {
        const due = '2026-10-05T11:00:00.000Z';
        expect(reminderSlotOf(task(1, { due_at: due }), NOW)).toMatchObject({ at: T(due), overdue: true, kind: 'plain' });
        const snz = serializeSnooze({ forDue: due, until: '2026-10-05T13:00:00.000Z' });
        expect(reminderSlotOf(task(1, { due_at: due, snooze: snz }), NOW)).toMatchObject({ at: T('2026-10-05T13:00:00Z'), overdue: false, snoozed: true });
        // An expired snooze: overdue again, at its due time.
        const old = serializeSnooze({ forDue: due, until: '2026-10-05T11:30:00.000Z' });
        expect(reminderSlotOf(task(1, { due_at: due, snooze: old }), NOW)).toMatchObject({ overdue: true, snoozed: false });
    });

    it('an EVENT is never overdue: a past one-off leaves the list, a recent one stays as today’s', () => {
        expect(reminderSlotOf(task(1, { schedule: ev(), due_at: null }), NOW)).toBeNull();
        const recent = ev({ start: '2026-10-05T11:30', end: '2026-10-05T12:30' });
        expect(reminderSlotOf(task(1, { schedule: recent }), NOW)).toMatchObject({ overdue: false, kind: 'event' });
        const weekly = ev({ rrule: 'FREQ=WEEKLY' });
        expect(reminderSlotOf(task(1, { schedule: weekly }), NOW)).toMatchObject({ at: T('2026-10-12T09:00:00Z'), overdue: false, repeats: true });
    });

    it('a repeating to-do sits on its current occurrence and is overdue once it passes', () => {
        const daily = serializeSchedule({ v: 1, kind: 'task', uid: 'uid-task-01', allDay: false, start: '2026-10-04T09:00', tz: 'UTC', rrule: 'FREQ=DAILY', doneThrough: '2026-10-04T09:00' });
        expect(reminderSlotOf(task(1, { schedule: daily }), NOW)).toMatchObject({ at: T('2026-10-05T09:00:00Z'), overdue: true, repeats: true });
    });

    it('completed items and undated ones are not reminders', () => {
        expect(reminderSlotOf(task(1, { due_at: '2026-10-05T11:00:00Z', is_completed: true }), NOW)).toBeNull();
        expect(reminderSlotOf(task(1), NOW)).toBeNull();
    });
});

describe('groupReminders with timing', () => {
    it('a calendar full of past events does not flood Overdue or the badge', () => {
        const past = Array.from({ length: 30 }, (_, i) => task(i + 1, { schedule: ev({ uid: `uid-past-${i}0`, start: `2026-09-${String(i + 1).padStart(2, '0')}T09:00`, end: `2026-09-${String(i + 1).padStart(2, '0')}T10:00` }) }));
        const plain = task(99, { due_at: '2026-10-05T11:00:00Z' });
        const g = groupReminders(cardsOf([...past, plain]), NOW);
        expect(g.overdue.map(i => i.task.id)).toEqual([99]);
        expect(reminderBadgeCount(g)).toBe(1);
    });

    it('sorts a snoozed item by its snooze time', () => {
        const a = task(1, { due_at: '2026-10-05T11:00:00.000Z', snooze: serializeSnooze({ forDue: '2026-10-05T11:00:00.000Z', until: '2026-10-05T18:00:00.000Z' }) });
        const b = task(2, { due_at: '2026-10-05T15:00:00.000Z' });
        const g = groupReminders(cardsOf([a, b]), NOW);
        expect(g.overdue).toHaveLength(0);
        expect([...g.today, ...g.upcoming].map(i => i.task.id)).toEqual([2, 1]);
    });

    it('the card "next due" chip ignores scheduled items (their due_at is a reminder, not a deadline)', () => {
        expect(nearestDue([task(1, { schedule: ev(), due_at: '2026-10-01T00:00:00Z' }), task(2, { due_at: '2026-10-09T00:00:00Z' })])?.id).toBe(2);
    });
});

describe('edited, search, export, copy', () => {
    it('a note is edited when its list or its newest item was', () => {
        expect(noteUpdatedAt('2026-09-02T10:00:00Z', [task(1, { updated_at: '2026-10-01T10:00:00Z' }), task(2, { updated_at: '2026-09-15T10:00:00Z' })])).toBe('2026-10-01T10:00:00.000Z');
        expect(noteUpdatedAt('2026-09-02T10:00:00Z', [task(1)])).toBe('2026-09-02T10:00:00.000Z');
        expect(noteUpdatedAt(undefined, null)).toBeUndefined();
        expect(cardsOf([task(1, { updated_at: '2026-10-01T10:00:00Z' })])[0].updatedAt).toBe('2026-10-01T10:00:00.000Z');
    });

    it('the "Recently edited" sort survives a reload of the prefs', () => {
        expect(parseNotesPrefs(JSON.stringify({ sort: 'edited' })).sort).toBe('edited');
        expect(parseNotesPrefs(JSON.stringify({ sort: 'bogus' })).sort).toBe('puca');
    });

    it('search reaches an event’s place, on the device', () => {
        const [c] = cardsOf([task(1, { schedule: ev({ location: 'Room Twelve' }) })]);
        expect(noteMatches(c, 'twelve')).toBe(true);
        expect(noteMatches(c, 'thirteen')).toBe(false);
    });

    it('the JSON export carries the opened schedule; an unreadable one says so', () => {
        const [c] = cardsOf([task(1, { schedule: ev({ location: 'Hall' }) }), task(2, { schedule: '[Unable to decrypt]' })]);
        const doc = JSON.parse(notesToJson([c], '2026-10-05T12:00:00Z'));
        expect(doc.notes[0].items[0].schedule).toMatchObject({ kind: 'event', location: 'Hall', start: '2026-10-05T09:00' });
        expect(doc.notes[0].items[1].schedule).toEqual({ unreadable: '[Unable to decrypt]' });
    });

    it('"Make a copy" carries each scheduled item under a NEW uid, aligned with its text', () => {
        const [c] = cardsOf([task(1), task(2, { schedule: ev({ rrule: 'FREQ=WEEKLY' }), due_at: '2026-10-12T08:50:00Z' }), task(3, { due_at: '2026-10-09T00:00:00Z' })]);
        const texts = openItemsOf(c);
        const timing = openItemTimingOf(c);
        expect(texts).toEqual(['task 1', 'task 2', 'task 3']);
        expect(timing[0]).toBeUndefined();
        expect(timing[2]).toBeUndefined();   // a plain due time is not copied, as before
        const copied = parseSchedule(timing[1]!.schedule!);
        expect(copied.state === 'ok' && copied.schedule.rrule).toBe('FREQ=WEEKLY');
        expect(copied.state === 'ok' && copied.schedule.uid).not.toBe('uid-event-01');
        expect(timing[1]!.dueAt).toBe('2026-10-12T08:50:00Z');
    });
});
