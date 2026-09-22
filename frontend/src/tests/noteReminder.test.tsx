/**
 * A reminder on the NOTE itself (migration 068): the model, the wire, the
 * offline op and the two pieces of UI that expose it.
 *
 * The thing under test is that a note with NO items at all can remind — the
 * whole reason this exists — so every block starts from a note with an empty
 * task array and asserts it is invisible BEFORE the reminder is given. A
 * test that only asserted the "after" state would pass just as happily if
 * groupReminders had started returning every note.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const { patch: apiPatch, post: apiPost } = vi.hoisted(() => ({ patch: vi.fn(), post: vi.fn() }));
vi.mock('../api/client', async () => {
    const real = await vi.importActual<typeof import('../api/client')>('../api/client');
    return { ...real, apiClient: { get: vi.fn(), post: apiPost, patch: apiPatch, delete: vi.fn(), put: vi.fn() } };
});
vi.mock('../api/listSeal', async () => {
    const real = await vi.importActual<typeof import('../api/listSeal')>('../api/listSeal');
    // Sealing needs an unlocked identity; the point here is WHICH fields are
    // sealed and what shape the request takes, so the envelope is a stand-in.
    return { ...real, sealSelfField: async (s: string) => `SEALED(${s})` };
});

import type { Task, TaskReminder } from '../api/tasks';
import { isNoteReminderId } from '../api/tasks';
import { NO_LIST_FEATURES, parseListFeatures, setTaskListTiming } from '../api/listContent';
import { planEntries, toReminderEntries } from '../api/reminderFeed';
import { noteAsCalendarItem, entriesInRange } from '../api/taskCalendar';
import {
    buildNoteCards, dueItemKey, groupReminders, reminderBadgeCount, searchNotes,
    type NoteCard, type NoteSource, type NotesNoteState,
} from '../notes/model/notesModel';
import { noteReminderSlotOf } from '../notes/model/notesTiming';
import { ops } from '../notes/model/notesOutbox';
import { noteToMarkdown, notesToJson } from '../notes/model/noteText';
import { NoteDueChip, NoteReminderControl } from '../components/schedule/NoteReminderControl';
import { Calendar, type CalendarProps } from '../components/calendar/Calendar';
import { type CalendarSource } from '../api/taskCalendar';
import { localDayKey } from '../utils/calendarMath';
import { BellIcon, ClockIcon } from '../components/Icons';
import { RemindersView } from '../notes/components/RemindersView';
import { type NoteActions } from '../notes/model/notesQueries';

const NOW = Date.parse('2026-09-21T12:00:00Z');
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const NO_LOCAL: NotesNoteState = { colors: {}, labels: {}, archived: {} };

function task(id: number, overrides: Partial<Task> = {}): Task {
    return {
        id, channel_id: null, list_id: 1, parent_id: null, description: `task ${id}`,
        is_completed: false, position: id, created_at: '2026-09-01T10:00:00Z', created_by: 1,
        attachments: null, due_at: null, ...overrides,
    };
}

function cards(sources: NoteSource[], tasks: Record<string, Task[]> = {}): NoteCard[] {
    return buildNoteCards(sources, new Map(Object.entries(tasks)), [], NO_LOCAL);
}

/** A plain text note: a real, common shape (QuickAdd's "Text note"). */
function textNote(id: number, title: string, extra: Partial<NoteSource> = {}): NoteSource {
    return { ref: { kind: 'list', id }, title, body: 'Roses are red', ...extra };
}

describe('a note reminds by itself', () => {
    it('a note with no items produces nothing until it is given a time', () => {
        const before = cards([textNote(1, 'Call the vet')], { 'list:1': [] });
        expect(before[0].tasks).toEqual([]);
        // Positive control: without 068 columns this note is invisible here.
        expect(groupReminders(before, NOW)).toEqual({ overdue: [], today: [], upcoming: [] });

        const after = cards([textNote(1, 'Call the vet', { dueAt: iso(60) })], { 'list:1': [] });
        const g = groupReminders(after, NOW);
        expect(g.today).toHaveLength(1);
        expect(g.today[0].kind).toBe('note');
        expect(g.today[0].note.title).toBe('Call the vet');
        expect(g.overdue).toHaveLength(0);
        // ...and it created no task to hang the time on.
        expect(after[0].tasks).toEqual([]);
        expect(after[0].total).toBe(0);
    });

    it('classifies a note reminder as overdue / today / upcoming like an item', () => {
        const g = groupReminders(cards([
            textNote(1, 'past', { dueAt: iso(-30) }),
            textNote(2, 'soon', { dueAt: iso(30) }),
            textNote(3, 'later', { dueAt: iso(60 * 24 * 3) }),
            textNote(4, 'none'),
        ], { 'list:1': [], 'list:2': [], 'list:3': [], 'list:4': [] }), NOW);
        expect(g.overdue.map(i => i.note.title)).toEqual(['past']);
        expect(g.today.map(i => i.note.title)).toEqual(['soon']);
        expect(g.upcoming.map(i => i.note.title)).toEqual(['later']);
        expect(reminderBadgeCount(g)).toBe(2);
    });

    it('sorts among its own note’s items by time, and keys them apart', () => {
        const g = groupReminders(cards(
            [textNote(1, 'shopping', { dueAt: iso(-20) })],
            { 'list:1': [task(1, { due_at: iso(-40) }), task(2, { due_at: iso(-10) })] },
        ), NOW);
        expect(g.overdue.map(i => (i.kind === 'note' ? 'NOTE' : `task ${i.task.id}`))).toEqual(['task 1', 'NOTE', 'task 2']);
        // A note id and a task id may both be 1: the row keys must not clash.
        expect(new Set(g.overdue.map(dueItemKey)).size).toBe(3);
        expect(dueItemKey(g.overdue[1])).toBe('note:list:1');
    });

    it('keeps the time private when the schedule says so: no due_at, still a reminder', () => {
        const priv = JSON.stringify({ v: 1, kind: 'task', uid: 'u1', allDay: false, start: '2026-09-21T14:00', tz: 'UTC', privateTiming: true });
        // The server holds NO instant at all for this note...
        const slot = noteReminderSlotOf({ dueAt: null, schedule: priv }, NOW);
        // ...and the device still knows when to remind.
        expect(slot).not.toBeNull();
        expect(slot!.at).toBe(Date.parse('2026-09-21T14:00:00Z'));
        // Positive control: with neither column there is nothing to show.
        expect(noteReminderSlotOf({ dueAt: null, schedule: null }, NOW)).toBeNull();
    });

    it('is searchable by the place in its own schedule', () => {
        const sched = JSON.stringify({ v: 1, kind: 'event', uid: 'u2', allDay: false, start: '2026-09-22T09:00', tz: 'UTC', location: 'Riverside Surgery' });
        const [c] = cards([textNote(1, 'appointment', { dueAt: iso(60), schedule: sched })], { 'list:1': [] });
        expect(c.title.includes('Riverside')).toBe(false);   // positive control
        expect(noteMatchesVia(c, 'riverside')).toBe(true);
        expect(noteMatchesVia(c, 'lakeside')).toBe(false);
    });

    it('rides the shared markdown export', () => {
        const [c] = cards([textNote(1, 'Call the vet', { dueAt: '2026-09-22T09:00:00Z' })], { 'list:1': [] });
        expect(noteToMarkdown(c)).toContain('reminder: 2026-09-22T09:00:00Z');
        const [plain] = cards([textNote(2, 'Nothing due')], { 'list:2': [] });
        expect(noteToMarkdown(plain)).not.toContain('reminder:');
    });

    it('rides the machine-readable export too — the other half of the pair', () => {
        const sched = JSON.stringify({ v: 1, kind: 'task', uid: 'u9', allDay: false, start: '2026-09-22T09:00', tz: 'UTC' });
        // A note with a reminder AND an item with one, so an export that
        // carried only the item's would still look plausible.
        const [timed] = cards(
            [textNote(1, 'Call the vet', { dueAt: '2026-09-22T09:00:00Z', schedule: sched })],
            { 'list:1': [task(7, { due_at: '2026-09-23T09:00:00Z' })] },
        );
        const [bare] = cards([textNote(2, 'Nothing due')], { 'list:2': [] });
        const out = JSON.parse(notesToJson([timed, bare], '2026-09-21T12:00:00Z'));
        expect(out.notes[0].items[0].dueAt).toBe('2026-09-23T09:00:00Z');   // it did carry the item's
        expect(out.notes[0].dueAt).toBe('2026-09-22T09:00:00Z');
        expect(out.notes[0].schedule).toMatchObject({ uid: 'u9', start: '2026-09-22T09:00' });
        // Positive control: a note with no reminder carries the same two keys,
        // empty — an export that simply omitted them could not be told apart
        // from one that dropped them.
        expect(bare.dueAt ?? null).toBeNull();
        expect(out.notes[1].dueAt).toBeNull();
        expect(out.notes[1].schedule).toBeNull();
        // And a schedule this device cannot open says WHY, as an item's does,
        // rather than exporting as "no reminder".
        const [locked] = cards([textNote(3, 'Sealed', { schedule: 'not json at all' })], { 'list:3': [] });
        const lockedOut = JSON.parse(notesToJson([locked], '2026-09-21T12:00:00Z')).notes[0];
        expect(lockedOut.schedule).toHaveProperty('unreadable');
    });
});

/** Through the filter the grid uses, so the test exercises the same path. */
function noteMatchesVia(card: NoteCard, query: string): boolean {
    return searchNotes([card], query).length === 1;
}

describe('the feed carries a note reminder without colliding with a task', () => {
    const noteRow: TaskReminder = { id: -5, channel_id: null, list_id: 5, due_at: iso(-10), created_by: 7, schedule: null, snooze: null, is_list: true };
    const taskRow: TaskReminder = { id: 5, channel_id: null, list_id: 5, due_at: iso(-20), created_by: 7, schedule: null, snooze: null };

    it('5 and -5 are two reminders, with two fired markers', () => {
        const entries = toReminderEntries([noteRow, taskRow], NOW);
        expect(entries.map(e => e.id).sort((a, b) => a - b)).toEqual([-5, 5]);
        const plan = planEntries(entries, {}, NOW);
        expect(plan.toFire).toHaveLength(2);
        expect(Object.keys(plan.prunedFired).sort()).toEqual(['-5', '5']);

        // Firing the NOTE must not silence the item that shares its number.
        const afterNote = planEntries(entries, { '-5': noteRow.due_at }, NOW);
        expect(afterNote.toFire.map(e => e.id)).toEqual([5]);
        const afterTask = planEntries(entries, { '5': taskRow.due_at }, NOW);
        expect(afterTask.toFire.map(e => e.id)).toEqual([-5]);
    });

    it('names the namespace by the id, not by a flag an old server would omit', () => {
        expect(isNoteReminderId(-5)).toBe(true);
        expect(isNoteReminderId(5)).toBe(false);
        expect(isNoteReminderId(0)).toBe(false);
    });

    it('puts the note on the calendar as a read-only entry under a negative id', () => {
        const item = noteAsCalendarItem({ id: 5, title: 'Call the vet', dueAt: '2026-09-22T09:00:00Z' });
        expect(item.id).toBe(-5);
        const [e] = entriesInRange(
            [{ task: item, noteKey: 'list:5', noteTitle: 'Call the vet', canEdit: false, canComplete: false, isNote: true }],
            '2026-09-22', '2026-09-23', { showCompleted: false, showPlain: true },
        );
        expect(e.source.isNote).toBe(true);
        expect(e.movable).toBe(false);          // it is changed from the note
        expect(e.id).toBe('list:5/-5/');        // and can never collide with task 5's entry
    });
});

describe('the wire', () => {
    beforeEach(() => { apiPatch.mockReset(); apiPatch.mockResolvedValue(undefined); });

    it('reads note_reminders from the features route, failing closed', () => {
        expect(parseListFeatures({ body: true, max_body_len: 100, attachments: true, trash: true, note_reminders: true }).noteReminders).toBe(true);
        expect(parseListFeatures({ body: true, max_body_len: 100, note_reminders: 'yes' }).noteReminders).toBe(false);
        expect(parseListFeatures({ body: true, max_body_len: 100 }).noteReminders).toBe(false);
        expect(parseListFeatures(null).noteReminders).toBe(false);
        expect(NO_LIST_FEATURES.noteReminders).toBe(false);
    });

    it('sends the three-state timing patch, sealing the schedule and never the time', async () => {
        await setTaskListTiming(9, { dueAt: '2026-09-22T09:00:00Z' });
        expect(apiPatch).toHaveBeenLastCalledWith('/task-lists/9', expect.objectContaining({ due_at: '2026-09-22T09:00:00Z' }));
        // A field left out is KEPT: it must not appear in the body at all.
        expect(Object.keys(apiPatch.mock.calls[0][1])).not.toContain('schedule');

        await setTaskListTiming(9, { dueAt: null, schedule: null });
        expect(apiPatch).toHaveBeenLastCalledWith('/task-lists/9', expect.objectContaining({ due_at: '', schedule: '' }));

        await setTaskListTiming(9, { schedule: '{"v":1}', dueAt: '2026-09-22T09:00:00Z', expectDueAt: '2026-09-21T09:00:00Z' });
        const body = apiPatch.mock.calls[2][1];
        expect(body.schedule).toBe('SEALED({"v":1})');
        expect(body.expect_due_at).toBe('2026-09-21T09:00:00Z');
        expect(body.due_at).toBe('2026-09-22T09:00:00Z');   // plaintext, as an item's is
    });

    it('queues as an op that pokes the reminder loop on replay', () => {
        const op = ops.setListTiming(9, 'Call the vet', { dueAt: '2026-09-22T09:00:00Z' }, 'reminder on');
        expect(op.k).toBe('listTiming');
        expect(op.label).toContain('Call the vet');
        expect(op.oid).toBeTruthy();
    });
});

describe('the UI', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => { act(() => root.unmount()); host.remove(); });

    it('offers the clock, and hands back a cleared time', () => {
        const saved: Array<{ dueAt?: string | null; schedule?: string | null }> = [];
        act(() => root.render(<NoteReminderControl note={{ title: 'Call the vet', dueAt: '2026-09-22T09:00:00Z' }} onSave={p => saved.push(p)} />));
        const clock = host.querySelector<HTMLButtonElement>('button[aria-label="Edit this note’s reminder"]');
        expect(clock).not.toBeNull();
        act(() => clock!.click());
        const clear = [...host.querySelectorAll('button')].find(b => b.textContent === 'Clear');
        expect(clear).toBeTruthy();
        act(() => clear!.click());
        expect(saved).toEqual([{ dueAt: null }]);
    });

    it('the chip is its OWN chip, and does not draw the item clock', () => {
        act(() => root.render(<NoteDueChip note={{ title: 'Call the vet', dueAt: '2026-09-22T09:00:00Z' }} now={NOW} />));
        const chip = host.querySelector('.note-due-chip');
        // Its own class, from its own stylesheet: Púca's Tasks view mounts
        // this control and never loads notes.css, so a chip that asked for
        // `.notes-chip` rendered there as bare inline text.
        expect(chip).not.toBeNull();
        expect(host.querySelector('.notes-chip')).toBeNull();

        // And it draws the BELL, not the clock the ITEM chip beside it draws
        // — two identical clock pills on one card would be one claim made
        // twice. Compared against the icons themselves rather than a copied
        // path string, so a redrawn bell does not fail this.
        const iconHost = document.createElement('div');
        document.body.appendChild(iconHost);
        const iconRoot = createRoot(iconHost);
        const paths = (el: Element) => [...el.querySelectorAll('svg path')].map(n => n.getAttribute('d')).join('|');
        act(() => iconRoot.render(<BellIcon />));
        const bell = paths(iconHost);
        act(() => iconRoot.render(<ClockIcon />));
        const clock = paths(iconHost);
        expect(bell).not.toBe(clock);              // positive control for the comparison itself
        expect(paths(chip!)).toBe(bell);
        expect(paths(chip!)).not.toBe(clock);
        act(() => iconRoot.unmount());
        iconHost.remove();
    });

    it('hides the plain clock once the note carries a schedule (as an item does)', () => {
        const sched = JSON.stringify({ v: 1, kind: 'task', uid: 'u3', allDay: false, start: '2026-09-22T09:00', tz: 'UTC' });
        act(() => root.render(<NoteReminderControl note={{ title: 'n', schedule: sched }} onSave={() => {}} canSchedule />));
        // querySelector is not used for these two: an attribute selector
        // carrying '&' is not reliably matched by the test DOM.
        const labels = () => [...host.querySelectorAll('button')].map(b => b.getAttribute('aria-label'));
        expect(labels()).not.toContain('Remind me');
        expect(labels()).toContain('Edit date & repeat');
    });

    it('renders a note row with no tick box and no snooze, and clears it', () => {
        const cleared: unknown[] = [];
        const actions = {
            setNoteTiming: (...args: unknown[]) => { cleared.push(args); return Promise.resolve(true); },
            toggleTask: () => Promise.resolve(),
        } as unknown as NoteActions;
        const groups = groupReminders(cards([textNote(1, 'Call the vet', { dueAt: iso(-30) })], { 'list:1': [] }), NOW);
        act(() => root.render(
            <RemindersView groups={groups} actions={actions} now={NOW} onOpen={() => {}}
                notificationsState="granted" onEnableNotifications={() => {}} canSnooze />,
        ));
        const row = host.querySelector('.notes-reminder-row.note');
        expect(row).not.toBeNull();
        expect(row!.textContent).toContain('Call the vet');
        expect(row!.querySelector('input[type="checkbox"]')).toBeNull();
        expect(host.querySelector('.notes-snooze')).toBeNull();
        // Positive control: an ITEM row in the same view does have both.
        const withItem = groupReminders(cards([textNote(2, 'shopping')], { 'list:2': [task(3, { due_at: iso(-30), list_id: 2 })] }), NOW);
        act(() => root.render(
            <RemindersView groups={withItem} actions={actions} now={NOW} onOpen={() => {}}
                notificationsState="granted" onEnableNotifications={() => {}} canSnooze />,
        ));
        expect(host.querySelector('.notes-reminder-row input[type="checkbox"]')).not.toBeNull();
        expect(host.querySelector('.notes-snooze')).not.toBeNull();

        act(() => root.render(
            <RemindersView groups={groups} actions={actions} now={NOW} onOpen={() => {}}
                notificationsState="granted" onEnableNotifications={() => {}} canSnooze />,
        ));
        const clear = host.querySelector<HTMLButtonElement>('.notes-reminder-clear');
        act(() => clear!.click());
        expect(cleared).toHaveLength(1);
        expect(cleared[0]).toEqual([{ kind: 'list', id: 1 }, { dueAt: null, schedule: null }, 'clear the reminder on']);
    });

    /* The calendar's day list is the OTHER place a note's reminder stands
       beside items, and it is the ONLY body a coarse pointer ever gets
       (Calendar.tsx's phone gate), so a phone meets it before the menu. The
       menu already refuses to tick a note (onToggleDone short-circuits on
       isNote); the row must not offer the control either, or the calendar
       ships a tick box that silently does nothing. */
    it('the calendar day row gives a note’s reminder a bell, not a tick box that does nothing', () => {
        const ticked: string[] = [];
        const day = localDayKey(Date.parse(iso(60)));
        const noteSource: CalendarSource = {
            task: noteAsCalendarItem({ id: 1, title: 'Call the vet', dueAt: iso(60) }),
            noteKey: 'list:1', noteTitle: 'Call the vet', canEdit: false, canComplete: false, isNote: true,
        };
        const itemSource: CalendarSource = {
            task: task(3, { description: 'buy food', due_at: iso(90), list_id: 2 }),
            noteKey: 'list:2', noteTitle: 'shopping', canEdit: true,
        };
        const props: CalendarProps = {
            sources: [noteSource, itemSource], view: 'day', date: day, onNavigate: () => {},
            showCompleted: true, showPlain: true, onToggleCompleted: () => {}, onTogglePlain: () => {},
            weekStart: 1, now: NOW, coarse: true,
            onOpen: () => {}, onMove: () => {}, onAdd: () => {},
            onToggleDone: e => { ticked.push(e.source.task.description); },
        };
        act(() => root.render(<Calendar {...props} />));
        const rows = [...host.querySelectorAll('.cal-row')];
        const noteRow = rows.find(r => r.textContent?.includes('Call the vet'));
        const itemRow = rows.find(r => r.textContent?.includes('buy food'));
        expect(noteRow, 'the note’s own reminder is on the day list').toBeTruthy();
        expect(itemRow, 'the item is on the same day list').toBeTruthy();
        expect(noteRow!.querySelector('input[type="checkbox"]')).toBeNull();
        expect(noteRow!.querySelector('.cal-row-mark')).not.toBeNull();

        // Positive control, in the SAME render: the item keeps a tick box
        // that really ticks — so the two assertions above are about the
        // note, not about a day list that draws no checkboxes at all.
        const box = itemRow!.querySelector<HTMLInputElement>('input[type="checkbox"]');
        expect(box).not.toBeNull();
        act(() => box!.click());
        expect(ticked).toEqual(['buy food']);
    });
});
