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
import { isHeadingText } from '../api/taskHeading';

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

// Review round (2026-09-29): what only LOOKS like a heading stays what it
// is, and the round trip survives what Copy as text writes around a list.
describe('text that only looks like a heading', () => {
    it('a list line whose text starts with "# " is an ITEM, and keeps its hash', () => {
        const items = bodyToItems('- # of guests\n- chairs');
        expect(items).toEqual(['#\u00a0of guests', 'chairs']);
        expect(items.map(isHeadingText)).toEqual([false, false]);
        expect(readChecklist('Party:\n- # of guests to invite\n- chairs to rent')).toEqual({
            title: 'Party', items: ['#\u00a0of guests to invite', 'chairs to rent'],
        });
        // POSITIVE CONTROL: a line that is nothing but a heading is one.
        expect(bodyToItems('# Party\n- chairs')).toEqual(['## Party', 'chairs']);
    });

    it('...and reads back as the same item after Copy as text', () => {
        const tasks = [task(1, '#\u00a0of guests'), task(2, 'chairs')];
        expect(readChecklist(noteToMarkdown(cardOf(tasks)))?.items).toEqual(['#\u00a0of guests', 'chairs']);
    });

    it('the composer keeps that item an item; "# x" TYPED there is still a heading', () => {
        expect(cleanQuickItems(['#\u00a0of guests'])).toEqual(['#\u00a0of guests']);
        expect(cleanQuickItems(['# of guests'])).toEqual(['## of guests']);
    });

    it('a comment inside a fenced code block is not a heading', () => {
        const items = bodyToItems('```\n# install deps\nnpm i\n```');
        expect(items).toEqual(['```', '#\u00a0install deps', 'npm i', '```']);
        // POSITIVE CONTROL: the same line after the fence closes is one.
        expect(bodyToItems('```\nnpm i\n```\n# install deps')).toContain('## install deps');
    });

    it('a hash that belongs to the label survives the round trip ("Learn C#")', () => {
        expect(readChecklist('# Learn C#\n- a\n- b\n## Learn C#\n- c')).toEqual({
            title: 'Learn C#', items: ['a', 'b', '## Learn C#', 'c'],
        });
        const read = readChecklist(noteToMarkdown(cardOf([task(1, 'a'), task(2, '## Learn C#'), task(3, 'c')])));
        expect(read?.items).toEqual(['a', '## Learn C#', 'c']);
        // POSITIVE CONTROL: Markdown's own closing hashes still go.
        expect(readChecklist('- a\n- b\n## Calendar ##\n- c')?.items).toEqual(['a', 'b', '## Calendar', 'c']);
    });

    it('Copy as text of a pinned, labelled or shared note reads back with no extra first item', () => {
        const tasks = tasksOf(['## Before you start', 'Update the app', 'Back up', '## Then', 'Open it']);
        const plain = readChecklist(noteToMarkdown(cardOf(tasks)));
        for (const meta of [{ pinned: true }, { labels: ['work', 'home'] }, { serverName: 'Home server' }, { pinned: true, labels: ['work'], serverName: 'S' }]) {
            const md = noteToMarkdown({ ...cardOf(tasks), ...meta });
            expect(md).toMatch(/\n_.+_\n/);             // the meta line really is there
            expect(readChecklist(md), JSON.stringify(meta)).toEqual(plain);
        }
        // POSITIVE CONTROL: a plain line before the list is still an item,
        // and so is a bold one — only a wholly italic line is a subtitle.
        expect(readChecklist('# T\nFirst thing\n- a\n- b')?.items).toEqual(['First thing', 'a', 'b']);
        expect(readChecklist('# T\n**First thing**\n- a\n- b')?.items).toEqual(['First thing', 'a', 'b']);
    });
});

describe('a paste carrying both formats reads the one that kept its structure', () => {
    // A Markdown checklist as a code editor copies it: the text is the
    // Markdown, the HTML one <div> a line in a white-space: pre block, its
    // spaces as &nbsp; — so its indents do not survive the HTML reading.
    const MD = ['# Release test', '', '## Before you start', '- [ ] Update the app', '  (from the download page)', '- [ ] Sign in', '', '## Calls', '- [ ] Join a call', '- [ ] Leave it'].join('\n');
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
    const EDITOR_HTML = `<meta charset='utf-8'><div style="font-family: Consolas, monospace; white-space: pre;">${MD.split('\n').map(l => (l === '' ? '<br>' : `<div><span style="color: #cccccc;">${esc(l)}</span></div>`)).join('')}</div>`;

    it('Markdown with its own headings wins over the HTML beside it', () => {
        const alone = readPastedItems(MD);
        expect(alone?.items).toEqual(['## Before you start', 'Update the app — (from the download page)', 'Sign in', '## Calls', 'Join a call', 'Leave it']);
        expect(readPastedItems(MD, { html: EDITOR_HTML })).toEqual(alone);
    });

    it('plain text that kept its list marks but lost its headings reads the HTML, which has them', () => {
        // What a browser that writes list markers into a copied selection's
        // text gives: "1." and "*" kept, the headings bare lines.
        const text = 'Router setup\n1. Unplug the old router\n2. Connect the new one\nSecurity\n* Change the admin password\n* Turn on WPA3';
        const html = '<h1>Router setup</h1><ol><li>Unplug the old router</li><li>Connect the new one</li></ol><h2>Security</h2><ul><li>Change the admin password</li><li>Turn on WPA3</li></ul>';
        // On its own the text is a checklist whose title and heading are items.
        expect(readPastedItems(text)?.items).toContain('Security');
        expect(readPastedItems(text, { html })).toEqual({
            items: ['Unplug the old router', 'Connect the new one', '## Security', 'Change the admin password', 'Turn on WPA3'],
            total: 5, title: 'Router setup',
        });
    });

    it('POSITIVE CONTROL: with no heading in the HTML either, the plain text is read as it was', () => {
        const text = '- a\n- b\n- c';
        expect(readPastedItems(text, { html: '<ul><li>a</li><li>b</li><li>c (html)</li></ul>' })).toEqual(readPastedItems(text));
    });
});
