/**
 * The one rule for checklist HEADINGS (api/taskHeading.ts): which text is a
 * heading, what it shows, how it is stored, which rows count — and the one
 * move the drag must refuse (api/tasks.ts planDropTarget).
 *
 * The owner pasted a Markdown test checklist and said "The headings should
 * show as headings, not separate tasks." Every surface asks this module, so
 * a wrong answer here is wrong everywhere at once.
 */
import { describe, expect, it } from 'vitest';
import {
    addItemsLabel, asHeadingText, asItemText, countHeadingTexts, countItems, headingLabel, headingLabelOf,
    isHeadingTask, isHeadingText,
} from '../api/taskHeading';
import { type Task, planDropTarget } from '../api/tasks';
import { TASK_DECRYPT_FAILED } from '../api/decryptMarkers';

const task = (id: number, description: string, o: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
});

describe('heading text', () => {
    it('reads "#".."######" and a space as a heading, and gives its label', () => {
        expect(headingLabelOf('## Before you start')).toBe('Before you start');
        expect(headingLabelOf('# Setup')).toBe('Setup');
        expect(headingLabelOf('###### Deep')).toBe('Deep');
        expect(headingLabelOf('  ## Indented')).toBe('Indented');
        // A closing run of hashes after a space is Markdown's, not the label's.
        expect(headingLabelOf('## Calendar ##')).toBe('Calendar');
    });

    it('is NOT a heading without the space, without a label, past six hashes or over two lines', () => {
        expect(isHeadingText('#hashtag')).toBe(false);
        expect(isHeadingText('#1 priority')).toBe(false);
        expect(isHeadingText('## ')).toBe(false);
        expect(isHeadingText('##')).toBe(false);
        expect(isHeadingText('####### Seven')).toBe(false);
        expect(isHeadingText('## a\nb')).toBe(false);
        // POSITIVE CONTROL: an ordinary item is not one either.
        expect(isHeadingText('Buy milk')).toBe(false);
    });

    it('keeps a hash that belongs to the label ("C#")', () => {
        expect(headingLabel('## Learn C#')).toBe('Learn C#');
    });

    it('headingLabel is safe on every item: not a heading comes back as it was', () => {
        expect(headingLabel('Buy milk')).toBe('Buy milk');
        expect(headingLabel('#hashtag')).toBe('#hashtag');
    });

    it('is stored the one way, "## label", whatever it was typed as', () => {
        expect(asHeadingText('Before you start')).toBe('## Before you start');
        expect(asHeadingText('# Before you start')).toBe('## Before you start');
        expect(asHeadingText('### Before you start ###')).toBe('## Before you start');
        expect(asItemText('# Groceries')).toBe('## Groceries');
        // POSITIVE CONTROL: an item stays exactly what was typed.
        expect(asItemText('Milk, 2 litres')).toBe('Milk, 2 litres');
        expect(asItemText('#hashtag')).toBe('#hashtag');
    });
});

describe('heading rows', () => {
    it('a heading is a TOP-LEVEL row whose text is a heading', () => {
        expect(isHeadingTask(task(1, '## Setup'))).toBe(true);
        // Nested, it is an ordinary sub-item that starts with hashes.
        expect(isHeadingTask(task(2, '## Setup', { parent_id: 1 }))).toBe(false);
        // A row this device cannot read is never a heading.
        expect(isHeadingTask(task(3, TASK_DECRYPT_FAILED))).toBe(false);
        expect(isHeadingTask(task(4, 'Setup'))).toBe(false);
    });

    it('progress counts steps only: a heading is neither done nor to do, even ticked by an older client', () => {
        const tasks = [
            task(1, '## Before you start'),
            task(2, 'Update the app', { is_completed: true }),
            task(3, 'Open each app'),
            task(4, '## Calendar', { is_completed: true }),   // an older client ticked it
            task(5, 'Snooze an item'),
        ];
        expect(countItems(tasks)).toEqual({ total: 3, completed: 1 });
        // POSITIVE CONTROL: without headings every row counts.
        expect(countItems(tasks.filter(t => !t.description.startsWith('##')))).toEqual({ total: 3, completed: 1 });
        expect(countItems([task(1, 'a'), task(2, 'b', { is_completed: true })])).toEqual({ total: 2, completed: 1 });
    });

    it('the paste question names headings apart from items, and keeps its old words without any', () => {
        expect(countHeadingTexts(['## A', 'x', 'y'])).toEqual({ items: 2, headings: 1 });
        expect(addItemsLabel(['## Security', 'a', 'b'])).toBe('Add 2 items and 1 heading');
        expect(addItemsLabel(['## A', 'a', '## B'])).toBe('Add 1 item and 2 headings');
        expect(addItemsLabel(['## A', '## B'])).toBe('Add 2 headings');
        expect(addItemsLabel(['Milk', 'Bread'])).toBe('Add 2 items');
    });
});

describe('the drag never nests a heading, or under one (planDropTarget)', () => {
    // Order as the drag hook reports it: the draggable rows, top to bottom.
    const heading = task(1, '## Section');
    const a = task(2, 'first item');
    const b = task(3, 'second item');
    const tasks = [heading, a, b];

    it('a heading dropped with an indent under the row above stays a top-level reorder', () => {
        const other = task(4, 'above it');
        const all = [other, heading, a];
        // Dropping the heading right after `other` with a step to the right.
        expect(planDropTarget(all, heading, [4, 2], 1, 1)).toEqual({ afterId: 4 });
    });

    it('an item indented under a heading is not made its subtask', () => {
        // `b` dropped right after the heading, one step right.
        expect(planDropTarget(tasks, b, [1, 2], 1, 1)).toEqual({ afterId: 1 });
    });

    it('POSITIVE CONTROL: an item indented under an ordinary item still nests', () => {
        expect(planDropTarget(tasks, b, [1, 2], 2, 1)).toEqual({ afterId: null, reparent: { parentId: 2 } });
    });
});
