/**
 * What "Make a copy" plans to make (noteText.ts copyPlanOf), and what stops
 * it (copyBlockersOf / copyRefusal).
 *
 * A copy used to be the note's text plus its OPEN items, flattened: ticked
 * items were dropped, nesting was dropped, a plain item's due time was
 * dropped, pictures were absent, and a note whose items had not loaded yet
 * copied to an empty note that still said "Copied". The export path already
 * guarded that last one; the copy path did not.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../api/tasks';
import { buildNoteCards, type NoteSource } from '../notes/model/notesModel';
import { copyBlockersOf, copyPlanOf, copyRefusal, flattenCopyItems } from '../notes/model/noteText';
import { type EventSchedule, parseSchedule, serializeSchedule } from '../api/taskSchedule';

function task(id: number, over: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `task ${id}`, is_completed: false,
        position: id, created_at: '2026-09-01T10:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
    };
}
const fileRef = (id: string) => ({ href: `sovereign-enc:${id}?k=KEY&m=${encodeURIComponent('image/png')}`, name: `${id}.png` });
const sidecar = (...ids: string[]) => JSON.stringify(ids.map(fileRef));
const weekly = (over: Partial<EventSchedule> = {}): string => serializeSchedule({
    v: 1, kind: 'task', uid: 'uid-weekly-01', allDay: false, start: '2026-09-07T09:00',
    tz: 'UTC', rrule: 'FREQ=WEEKLY', doneThrough: '2026-09-28T09:00', ...over,
});
const src: NoteSource = { ref: { kind: 'list', id: 1 }, title: 'Groceries', body: null, noteAttachments: null };
function cardOf(tasks: Task[] | null, over: Partial<NoteSource> = {}) {
    const map = tasks === null ? new Map() : new Map([['list:1', tasks]]);
    return buildNoteCards([{ ...src, ...over }], map, [], { colors: {}, labels: {}, archived: {} })[0];
}

describe('copyPlanOf', () => {
    const nested = [
        task(1, { description: 'Milk' }),
        task(2, { description: 'Semi-skimmed', parent_id: 1 }),
        task(3, { description: 'Whole', parent_id: 1 }),
        task(4, { description: 'Bread', is_completed: true }),
    ];

    it('keeps the NESTING — a parent with two children is one item with two children', () => {
        const plan = copyPlanOf(cardOf(nested));
        expect(plan.items.map(i => i.text)).toEqual(['Milk', 'Bread']);
        expect(plan.items[0].children.map(i => i.text)).toEqual(['Semi-skimmed', 'Whole']);
        // The old flat plan would have made three roots out of Milk's branch.
        expect(flattenCopyItems(plan.items).map(({ item }) => item.text)).toEqual(['Milk', 'Semi-skimmed', 'Whole', 'Bread']);
    });

    it('keeps the items that are already TICKED, marked as such', () => {
        const plan = copyPlanOf(cardOf(nested));
        expect(plan.items.find(i => i.text === 'Bread')).toMatchObject({ completed: true });
        expect(plan.items.find(i => i.text === 'Milk')).toMatchObject({ completed: false });
    });

    it('re-seals a schedule as a NEW series, and carries the note text and the title', () => {
        const plan = copyPlanOf(cardOf([task(1, { schedule: weekly(), due_at: '2026-10-05T09:00:00.000Z' })], { body: 'Before Friday' }));
        const s = parseSchedule(plan.items[0].schedule!);
        expect(s.state === 'ok' && s.schedule.uid).not.toBe('uid-weekly-01');
        expect(s.state === 'ok' && s.schedule.doneThrough).toBeUndefined();
        expect(s.state === 'ok' && s.schedule.rrule).toBe('FREQ=WEEKLY');
        expect(plan.title).toBe('Groceries (copy)');
        expect(plan.body).toBe('Before Friday');
    });

    it('carries the note’s own pictures and each item’s, and counts them', () => {
        const plan = copyPlanOf(cardOf(
            [task(1, { attachments: sidecar('a1', 'a2') }), task(2)],
            { noteAttachments: sidecar('n1') },
        ));
        expect(plan.noteRefs).toEqual([fileRef('n1')]);
        expect(plan.items[0].attachments).toEqual([fileRef('a1'), fileRef('a2')]);
        expect(plan.items[1].attachments).toEqual([]);
        expect(plan.files).toBe(3);
    });

    it('POSITIVE CONTROL: a plain note plans no files and no timing at all', () => {
        const plan = copyPlanOf(cardOf([task(1)]));
        expect(plan).toMatchObject({ body: '', noteRefs: [], files: 0 });
        expect(plan.items[0]).toMatchObject({ dueAt: null, schedule: null, completed: false, attachments: [] });
    });
});

describe('copyBlockersOf / copyRefusal', () => {
    const clean = cardOf([task(1)]);

    it('POSITIVE CONTROL: a readable note reports nothing and is copied', () => {
        expect(copyBlockersOf(clean)).toEqual({
            itemsNotLoaded: false, unreadableItems: 0, unreadableSchedules: 0,
            unreadableBody: false, unreadableTitle: false, lockedSidecar: false,
        });
        expect(copyRefusal(copyBlockersOf(clean))).toBeNull();
    });

    it('refuses while the items are still loading, rather than copying an empty note', () => {
        const b = copyBlockersOf(cardOf(null));
        expect(b.itemsNotLoaded).toBe(true);
        expect(copyRefusal(b)).toMatch(/try the copy again in a moment/);
    });

    it('refuses a note this device cannot fully read — an item, a schedule, the text, or a locked sidecar', () => {
        const cases = [
            cardOf([task(1, { description: '[Unable to decrypt]' })]),
            cardOf([task(1, { schedule: '[Unable to decrypt]' })]),
            cardOf([task(1)], { body: '[Unable to decrypt]' }),
            cardOf([task(1)], { noteAttachments: '[Unable to decrypt]' }),
            cardOf([task(1, { attachments: '[Unable to decrypt]' })]),
            // Otherwise the copy would be called "[Unable to decrypt] (copy)".
            cardOf([task(1)], { title: '[Unable to decrypt]' }),
        ];
        for (const c of cases) {
            expect(copyRefusal(copyBlockersOf(c)), JSON.stringify(copyBlockersOf(c))).toMatch(/can’t be read on this device/);
        }
    });
});
