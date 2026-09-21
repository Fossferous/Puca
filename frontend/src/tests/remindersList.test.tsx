/**
 * The shared Reminders list, fed the way PÚCA's Reminders tab feeds it (the
 * same CalendarSource rows the Calendar tab builds from every list and
 * checklist channel).
 *
 * The rules that matter here are the ones the server cannot enforce for us:
 *  - an item in a shared checklist that someone else set says so, because
 *    GET /task-reminders' channel arm is `created_by = $1` — it will never
 *    alert THIS user. Púca needs that line more than Notes does: its sources
 *    include every member's items, not just the caller's.
 *  - Snooze needs the completion right, and an editor's moved snooze is not a
 *    tick-only member's to change (taskSchedule.snoozeLocked).
 *  - the row keeps its shape — the hint is a second line inside the text
 *    cell, never another column, which is what holds the row together at
 *    390 px (the rule frontend/src/tests/notesRemindersHint.test.tsx pins
 *    for Notes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RemindersList } from '../components/reminders/RemindersList';
import { groupReminderSources } from '../api/reminderGroups';
import type { CalendarSource } from '../api/taskCalendar';
import type { Task } from '../api/tasks';
import { serializeSnooze } from '../api/taskSchedule';

const ME = 7;
const DUE = '2030-10-07T09:00:00.000Z';
const NOW = Date.parse('2030-10-07T08:00:00.000Z');

function task(id: number, over: Partial<Task> = {}): Task {
    return {
        id, channel_id: 9, list_id: null, parent_id: null, description: `Item ${id}`, is_completed: false, position: id,
        created_at: '2030-09-01T00:00:00Z', created_by: ME, attachments: null, due_at: DUE, ...over,
    };
}
const chan = (t: Task, over: Partial<CalendarSource> = {}): CalendarSource => ({
    task: t, noteKey: 'channel:9', noteTitle: '#home', serverName: 'Home', canEdit: false, canComplete: true, ...over,
});
const list = (t: Task): CalendarSource => ({ task: t, noteKey: 'list:1', noteTitle: 'Errands', canEdit: true });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null;
    host = null;
});

function mount(sources: CalendarSource[], opts: { snooze?: boolean } = {}): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <RemindersList
            groups={groupReminderSources(sources, NOW)}
            now={NOW}
            currentUserId={ME}
            onOpen={vi.fn()}
            onToggle={vi.fn()}
            onSnooze={opts.snooze === false ? undefined : vi.fn()}
            empty={<div className="notes-empty">Nothing is due.</div>}
        />,
    ));
    return host!;
}
const rowFor = (el: HTMLElement, text: string) =>
    [...el.querySelectorAll('.notes-reminder-row')].find(r => r.textContent?.includes(text)) ?? null;

describe('Púca’s Reminders list', () => {
    it('says "Reminds whoever set it" on a shared item someone else set, and nowhere else', () => {
        const el = mount([
            chan(task(1, { created_by: 99 })),
            chan(task(2)),
            list(task(3)),
        ]);
        const hint = (text: string) => rowFor(el, text)?.querySelector('.notes-reminder-text .notes-reminder-sub')?.textContent ?? null;
        expect(hint('Item 1')).toBe('Reminds whoever set it');
        expect(hint('Item 2')).toBeNull();   // shared, but mine
        expect(hint('Item 3')).toBeNull();   // my own list
    });

    it('keeps the row’s shape — the hint is a second line, not another column', () => {
        const el = mount([chan(task(1, { created_by: 99 }))], { snooze: false });
        const row = rowFor(el, 'Item 1')!;
        // checkbox, text, timing marks, the note it is in, when it is due.
        expect(row.children).toHaveLength(5);
        expect([...row.children].map(c => c.className)).toEqual([
            '', 'notes-reminder-text', 'notes-reminder-marks', 'notes-reminder-note', 'notes-reminder-when',
        ]);
        // and the hint lives INSIDE the text cell, which is what keeps the
        // row from growing a column at 390 px.
        expect(row.querySelector('.notes-reminder-text > .notes-reminder-sub')).not.toBeNull();
    });

    it('groups by Overdue / Today / Upcoming and names the checklist each is in', () => {
        const el = mount([
            list(task(1, { due_at: '2030-10-07T07:00:00.000Z' })),
            chan(task(2, { due_at: '2030-10-09T09:00:00.000Z' })),
        ]);
        expect(el.querySelector('.notes-reminder-group.overdue .notes-reminder-row')?.textContent).toContain('Item 1');
        expect(rowFor(el, 'Item 1')!.querySelector('.notes-reminder-note')?.textContent).toBe('Errands');
        expect(rowFor(el, 'Item 2')!.querySelector('.notes-reminder-note')?.textContent).toBe('#home');
        expect([...el.querySelectorAll('.notes-section-title')].map(h => h.textContent)).toEqual(['Overdue', 'Upcoming']);
    });

    it('offers Snooze only where the rights allow it', () => {
        // Positive control first: an ordinary shared item with the right.
        expect(mount([chan(task(1))]).querySelector('.notes-snooze')).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        // No COMPLETE_TASKS in that channel.
        expect(mount([chan(task(1), { canComplete: false })]).querySelector('.notes-snooze')).toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        // An editor's snooze MOVED due_at; this member may complete but not
        // edit the time, so it is not theirs to change (snoozeLocked).
        const moved = task(1, { due_at: '2030-10-07T10:00:00.000Z', snooze: serializeSnooze({ forDue: DUE, until: '2030-10-07T10:00:00.000Z' }) });
        expect(mount([chan(moved)]).querySelector('.notes-snooze')).toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        // Positive control: an editor of the same moved item is offered it.
        expect(mount([chan(moved, { canEdit: true })]).querySelector('.notes-snooze')).not.toBeNull();
    });

    it('a server with no snooze feature offers none at all', () => {
        expect(mount([chan(task(1))], { snooze: false }).querySelector('.notes-snooze')).toBeNull();
    });

    it('the empty state shows only when there is genuinely nothing', () => {
        const el = mount([list(task(1, { is_completed: true })), list(task(2, { due_at: null }))]);
        expect(el.querySelector('.notes-empty')).not.toBeNull();
        expect(el.querySelector('.notes-reminder-row')).toBeNull();
    });
});
