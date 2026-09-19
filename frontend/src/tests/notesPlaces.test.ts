/**
 * Púca Notes' "At a place" section and its pruning: which open items have a
 * saved place on this phone, and which completed items still carry one (a
 * fence for a finished errand must stop firing).
 */
import { describe, it, expect } from 'vitest';
import { completedWithPlace, placeReminderItems } from '../notes/native/useNotesPlaces';
import type { NoteCard } from '../notes/model/notesModel';
import type { Task } from '../api/tasks';
import type { TaskPlace } from '../api/taskPlaces';

const home: TaskPlace = { id: 'p1', label: 'Home', lat: 1, lon: 2, radiusM: 150 };

function task(id: number, done = false): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `t${id}`, is_completed: done,
        position: id, created_at: '2026-01-01T00:00:00Z', created_by: 7, attachments: null, due_at: null,
    };
}

function card(tasks: Task[] | null): NoteCard {
    return { key: 'list:1', ref: { kind: 'list', id: 1 }, title: 'N', tasks } as unknown as NoteCard;
}

const placeOf = (id: number) => (id === 1 || id === 3 ? home : null);

describe('placeReminderItems', () => {
    it('lists open items with a place, skipping completed ones and ones without', () => {
        const items = placeReminderItems([card([task(1), task(2), task(3, true)])], placeOf);
        expect(items.map(i => [i.task.id, i.place.label])).toEqual([[1, 'Home']]);
    });
    it('a note whose items are not loaded contributes nothing', () => {
        expect(placeReminderItems([card(null)], placeOf)).toEqual([]);
    });
});

describe('completedWithPlace', () => {
    it('finds completed items that still carry a place', () => {
        expect(completedWithPlace([card([task(1), task(3, true), task(4, true)])], placeOf)).toEqual([3]);
    });
});
