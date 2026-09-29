/**
 * Checklist HEADINGS in the pure model — reading a checklist in, counting
 * it, reminding from it, and writing it back out.
 *
 * The owner pasted a Markdown test checklist ("# Title", "## Section",
 * "- [ ] step") and said: "The headings should show as headings, not
 * separate tasks." Before this, readChecklist turned every section into a
 * checkable "Before you start:" and "Show checkboxes" stripped the "## ".
 * Now a section is a heading item (api/taskHeading.ts), and every count,
 * bulk action, reminder list and export below leaves it out of what is a
 * step — each with an ordinary item beside it that is still counted.
 */
import { describe, expect, it } from 'vitest';
import { type Task } from '../api/tasks';
import {
    bodyToItems, conversionLosses, itemsToBody, linesFromPaste, pasteAsOneLine, readChecklist, readPastedItems,
} from '../notes/model/noteContent';
import {
    buildNoteCards, cleanQuickItems, countProgress, deriveQuickTitle, groupReminders, nearestDue, noteMatches, previewRows,
    type NoteSource,
} from '../notes/model/notesModel';
import { EMPTY_KEEP_PREFS } from '../notes/model/notesPrefs';
import { checkedCount, checkedRoots, uncheckOrder } from '../notes/model/noteItemBulk';
import { copyPlanOf, noteToMarkdown, noteToMessage, notesToJson } from '../notes/model/noteText';
import { entriesInRange, noteAsCalendarItem, type CalendarSource } from '../api/taskCalendar';
import { groupReminderSources } from '../api/reminderGroups';

/** The owner's paste, as the assistant's Copy button put it on the clipboard. */
const OWNER_MARKDOWN = `Here's your 0.9.826 test checklist:

# Púca 0.9.826 test checklist

## Before you start
- [ ] Update the desktop app to 0.9.826 (the updater should offer it)
- [ ] Let Púca and Púca Notes on your phone pick up the update (open each once)

## Paste this checklist (the tests themselves)
- [ ] On the PC, copy this message with the Copy button under it
- [ ] Click the rail's Tasks & notes: Púca Notes opens inside Púca, not in a browser

## Calendar
- [ ] Snooze an item from the Notes calendar: it moves once, to your morning time

That's everything new in 0.9.826, so tick as you go!`;

const OWNER_ITEMS = [
    '## Before you start',
    'Update the desktop app to 0.9.826 (the updater should offer it)',
    'Let Púca and Púca Notes on your phone pick up the update (open each once)',
    '## Paste this checklist (the tests themselves)',
    'On the PC, copy this message with the Copy button under it',
    "Click the rail's Tasks & notes: Púca Notes opens inside Púca, not in a browser",
    '## Calendar',
    'Snooze an item from the Notes calendar: it moves once, to your morning time',
];

const task = (id: number, description: string, o: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 7, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, ...o,
});
const tasksOf = (items: string[]): Task[] => items.map((d, i) => task(i + 1, d));
const cardOf = (tasks: Task[], source: Partial<NoteSource> = {}) =>
    buildNoteCards([{ ref: { kind: 'list', id: 7 }, title: 'Púca 0.9.826 test checklist', ...source }], new Map([['list:7', tasks]]), [], EMPTY_KEEP_PREFS)[0];

describe('reading a checklist in', () => {
    it("the owner's paste: the title is the note's, each section a HEADING, each step an item", () => {
        expect(readChecklist(OWNER_MARKDOWN)).toEqual({ title: 'Púca 0.9.826 test checklist', items: OWNER_ITEMS });
        expect(readPastedItems(OWNER_MARKDOWN)?.items).toEqual(OWNER_ITEMS);
    });

    it('a colon line inside the list is a heading; an empty one at the end is dropped', () => {
        expect(readChecklist('- a\n- b\nOptional extras:\n- c\nLater:')?.items).toEqual(['a', 'b', '## Optional extras', 'c']);
    });

    it('"Show checkboxes" and a plain paste keep a "## " line as a heading, in the one stored form', () => {
        expect(bodyToItems('# Groceries\n- Milk\n### Later ###\n2. Bread')).toEqual(['## Groceries', 'Milk', '## Later', 'Bread']);
        expect(linesFromPaste('## Setup\nPlug it in\nTurn it on')).toEqual(['## Setup', 'Plug it in', 'Turn it on']);
        // POSITIVE CONTROL: a hashtag is not a heading, and keeps its hash.
        expect(bodyToItems('#weekend\n- socks')).toEqual(['#weekend', 'socks']);
    });

    it('"Add as one item" is an ITEM, whatever the paste began with', () => {
        expect(pasteAsOneLine('## Setup\n- a\n- b')).toBe('Setup - a - b');
        expect(pasteAsOneLine('Milk\nBread')).toBe('Milk Bread');
    });

    it('a quick-add stores a typed heading the one way, and an untitled note borrows its label', () => {
        expect(cleanQuickItems(['# Groceries', ' Milk ', '', '### Later'])).toEqual(['## Groceries', 'Milk', '## Later']);
        expect(deriveQuickTitle('', ['## Groceries', 'Milk'])).toBe('Groceries');
        expect(deriveQuickTitle('', ['Milk'])).toBe('Milk');
    });
});

describe('counting and ticking leave headings out', () => {
    // An older client can tick a heading — it shows "## Calendar" as an item.
    const tasks = [
        task(1, '## Before you start'),
        task(2, 'Update the app', { is_completed: true }),
        task(3, 'Open each app'),
        task(4, '## Calendar', { is_completed: true }),
        task(5, 'Snooze an item'),
        task(6, 'Tick it', { is_completed: true }),
    ];

    it('progress ("2/4") counts steps only', () => {
        expect(countProgress(tasks)).toEqual({ total: 4, completed: 2 });
        expect(cardOf(tasks)).toMatchObject({ total: 4, completed: 2 });
    });

    it('Uncheck all and Delete checked never touch a heading', () => {
        expect(checkedCount(tasks)).toBe(2);
        expect(checkedRoots(tasks).map(t => t.id)).toEqual([2, 6]);
        expect(uncheckOrder(tasks).map(t => t.id)).toEqual([2, 6]);
    });

    it('a card shows headings where they stand and counts only the items it hid', () => {
        const all = previewRows(tasks, 8);
        expect(all.rows.map(r => r.task.id)).toEqual([1, 3, 4, 5]);
        expect(all.completedCount).toBe(2);
        expect(all.moreOpen).toBe(0);
        // Capped at two rows: the heading and one item show; one open ITEM is hidden.
        const capped = previewRows(tasks, 2);
        expect(capped.rows.map(r => r.task.id)).toEqual([1, 3]);
        expect(capped.moreOpen).toBe(1);
    });

    it('"Hide checkboxes" writes a heading as a "## " line where it stands, and loses no "done" for it', () => {
        expect(itemsToBody(tasks)).toBe('## Before you start\nOpen each app\n## Calendar\nSnooze an item\nUpdate the app\nTick it');
        expect(conversionLosses(tasks).completed).toBe(2);
        // ...and "Show checkboxes" reads those lines back as headings.
        expect(bodyToItems(itemsToBody(tasks)).filter(l => l.startsWith('## '))).toEqual(['## Before you start', '## Calendar']);
    });

    it('search reads a heading by its label: its "## " is not text to find', () => {
        const card = cardOf([task(1, '## Calendar'), task(2, 'Milk')]);
        expect(noteMatches(card, 'calendar')).toBe(true);
        expect(noteMatches(card, '##')).toBe(false);
        // POSITIVE CONTROL: hashes an item really holds are found.
        expect(noteMatches(cardOf([task(1, 'Tag it ## later')]), '##')).toBe(true);
    });
});

describe('reminders and the calendar leave headings out', () => {
    const due = '2026-09-30T09:00:00Z';
    const now = Date.parse('2026-09-29T09:00:00Z');

    it("a heading's time (only an older client can set one) is no card chip and no reminder", () => {
        const tasks = [task(1, '## Calendar', { due_at: '2026-09-29T10:00:00Z' }), task(2, 'Snooze an item', { due_at: due })];
        expect(nearestDue(tasks)?.id).toBe(2);
        const groups = groupReminders([cardOf(tasks)], now);
        const ids = [...groups.overdue, ...groups.today, ...groups.upcoming].map(r => (r.kind === 'task' ? r.task.id : 0));
        expect(ids).toEqual([2]);
    });

    it("Púca's Reminders tab and both calendars skip a heading — but never a note's own row", () => {
        const sources: CalendarSource[] = [
            { task: task(1, '## Calendar', { due_at: due }), noteKey: 'list:7', noteTitle: 'N', canEdit: true },
            { task: task(2, 'Snooze an item', { due_at: due }), noteKey: 'list:7', noteTitle: 'N', canEdit: true },
            // A NOTE titled like a heading is still a note with a reminder.
            { task: noteAsCalendarItem({ id: 8, title: '## Weekly', dueAt: due }), noteKey: 'list:8', noteTitle: '## Weekly', canEdit: false, isNote: true },
        ];
        const g = groupReminderSources(sources, now);
        expect([...g.overdue, ...g.today, ...g.upcoming].map(r => r.task.id).sort()).toEqual([-8, 2]);
        const entries = entriesInRange(sources, '2026-09-29', '2026-10-02', { showCompleted: true, showPlain: true, tz: 'UTC' });
        expect(entries.map(e => e.source.task.id).sort()).toEqual([-8, 2]);
    });
});

describe('writing a checklist out', () => {
    it('Copy as text / Export writes a heading as a "## " section, never "- [ ]"', () => {
        const md = noteToMarkdown(cardOf(tasksOf(OWNER_ITEMS)));
        expect(md).toContain('\n## Before you start\n- [ ] Update the desktop app');
        expect(md).toContain('open each once)\n\n## Paste this checklist');
        expect(md).not.toContain('- [ ] ## ');
        expect(md).not.toContain('- [ ] Calendar');
        // POSITIVE CONTROL: an item is still a box.
        expect(md).toContain('- [ ] Snooze an item from the Notes calendar');
    });

    it('the round trip keeps its shape: Markdown → note → Copy as text → paste', () => {
        const read = readChecklist(OWNER_MARKDOWN)!;
        const again = readChecklist(noteToMarkdown(cardOf(tasksOf(read.items), { title: read.title! })));
        expect(again).toEqual(read);
    });

    it('a heading an older client ticked is written as a heading, not "[x]"', () => {
        const md = noteToMarkdown(cardOf([task(1, '## Calendar', { is_completed: true }), task(2, 'Snooze')]));
        expect(md).toContain('## Calendar\n- [ ] Snooze');
        expect(md).not.toContain('[x]');
    });

    it('Send to Púca writes it the same way', () => {
        const { text } = noteToMessage(cardOf([task(1, 'First'), task(2, '## Later'), task(3, 'Second')]));
        expect(text).toContain('- [ ] First\n\n## Later\n- [ ] Second');
    });

    it('the JSON export says which rows are headings', () => {
        const json = JSON.parse(notesToJson([cardOf([task(1, '## Calendar', { is_completed: true }), task(2, 'Snooze')])], '2026-09-29'));
        expect(json.notes[0].items.map((i: { heading: boolean; completed: boolean }) => [i.heading, i.completed])).toEqual([[true, false], [false, false]]);
    });

    it('Make a copy keeps a heading a heading — never done, never dated', () => {
        const plan = copyPlanOf(cardOf([
            task(1, '## Calendar', { is_completed: true, due_at: '2026-09-30T09:00:00Z' }),
            task(2, 'Snooze', { is_completed: true, due_at: '2026-09-30T09:00:00Z' }),
        ]));
        expect(plan.items.map(i => [i.text, i.completed, i.dueAt])).toEqual([
            ['## Calendar', false, null],
            // POSITIVE CONTROL: an item keeps its tick and its time.
            ['Snooze', true, '2026-09-30T09:00:00Z'],
        ]);
    });
});
