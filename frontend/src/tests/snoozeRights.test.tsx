// A snooze rides the COMPLETE_TASKS right on the server. A member without it
// must not be offered Snooze (the calendar's item menu, Notes' Reminders row),
// and every server refusal in the calendars/Notes is toasted with the
// server's own words (toastRefusal) — a 403 used to vanish silently.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Calendar } from '../components/calendar/Calendar';
import { RemindersView } from '../notes/components/RemindersView';
import type { CalendarSource } from '../api/taskCalendar';
import type { Task } from '../api/tasks';
import type { NoteCard } from '../notes/model/notesModel';
import type { NoteActions } from '../notes/model/notesQueries';
import { ApiError } from '../api/client';
import { toastRefusal } from '../api/refusalToast';
import { setMessageToastSink } from '../components/messageToastBus';
import { PERM } from '../api/permissionBits';
import { serializeSnooze } from '../api/taskSchedule';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null;
    host = null;
    setMessageToastSink(null);
});
function mount(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
    return host;
}

const DUE = '2030-10-07T09:00:00.000Z';
const task: Task = {
    id: 5, channel_id: 9, list_id: null, parent_id: null, description: 'Bins out', is_completed: false, position: 1,
    created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: DUE,
};

function openMenu(canComplete: boolean | undefined, over: { t?: Task; canEdit?: boolean } = {}) {
    const t = over.t ?? task;
    const src: CalendarSource = { task: t, noteKey: 'channel:9', noteTitle: '#home', canEdit: over.canEdit ?? false, ...(canComplete === undefined ? {} : { canComplete }) };
    const el = mount(
        <Calendar
            sources={[src]} view="day" date="2030-10-07" onNavigate={() => {}} showCompleted={false} showPlain
            onToggleCompleted={() => {}} onTogglePlain={() => {}} weekStart={1} now={Date.parse('2030-10-01T00:00:00Z')} coarse
            onOpen={() => {}} onMove={() => {}} onAdd={() => {}} onToggleDone={() => {}} onSnooze={() => {}}
        />,
    );
    const more = [...el.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === `More for ${t.description}`);
    expect(more).toBeTruthy();
    act(() => more!.click());
    return document.body.querySelector('.cal-menu-snooze');
}

const card = (myPerms: number | undefined, kind: 'list' | 'channel', t: Task = task): NoteCard => ({
    key: `${kind}:9`, ref: { kind, id: 9 }, title: 'home', tasks: [t], pinned: false, color: 'default', labels: [], archived: false,
    total: 1, completed: 0, myPerms,
} as unknown as NoteCard);
const reminders = (c: NoteCard, t: Task = task) => mount(
    <RemindersView
        groups={{ overdue: [], today: [], upcoming: [{ task: t, note: c, at: Date.parse(t.due_at!) }] }}
        actions={{} as NoteActions} now={Date.parse('2030-10-01T00:00:00Z')} onOpen={() => {}}
        notificationsState="granted" onEnableNotifications={() => {}} canSnooze
    />,
);

describe('Snooze needs the completion right', () => {
    it('the calendar menu hides Snooze from a member without COMPLETE_TASKS', () => {
        expect(openMenu(false)).toBeNull();
    });
    it('positive control: with the right (or in a personal list) it is offered', () => {
        expect(openMenu(true)).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(openMenu(undefined)).not.toBeNull();
    });

    it('Notes’ Reminders row hides it in a shared note without the right', () => {
        const el = reminders(card(PERM.VIEW_CHANNEL, 'channel'));
        expect(el.querySelector('.notes-snooze')).toBeNull();
    });
    it('positive control: shows it with COMPLETE_TASKS, and in a personal note', () => {
        expect(reminders(card(PERM.VIEW_CHANNEL | PERM.COMPLETE_TASKS, 'channel')).querySelector('.notes-snooze')).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(reminders(card(undefined, 'list')).querySelector('.notes-snooze')).not.toBeNull();
    });
});

// An editor's snooze MOVED due_at to the snooze instant. A member who may
// complete but not edit the item's time can neither unsnooze it (due_at is
// the editor's to put back) nor re-snooze it (taskSchedule.snoozeLocked), so
// neither surface offers it to them.
describe('an editor’s moved snooze is not a tick-only member’s to change', () => {
    const MOVED = '2030-10-07T10:00:00.000Z';
    const moved: Task = { ...task, description: 'Moved bins', due_at: MOVED, snooze: serializeSnooze({ forDue: DUE, until: MOVED }) };
    it('the calendar menu hides Snooze from a member who may complete but not edit', () => {
        expect(openMenu(true, { t: moved, canEdit: false })).toBeNull();
    });
    it('positive control: an editor is offered it, and the same member is offered it on an unsnoozed item', () => {
        expect(openMenu(true, { t: moved, canEdit: true })).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(openMenu(true, { t: { ...moved, snooze: null }, canEdit: false })).not.toBeNull();
    });
    it('Notes’ Reminders row hides it from a COMPLETE-only member of a shared note', () => {
        const el = reminders(card(PERM.VIEW_CHANNEL | PERM.COMPLETE_TASKS, 'channel', moved), moved);
        expect(el.querySelector('.notes-reminder-row')).not.toBeNull();
        expect(el.querySelector('.notes-snooze')).toBeNull();
    });
    it('positive control: a task manager, and a personal note, still get it', () => {
        expect(reminders(card(PERM.VIEW_CHANNEL | PERM.MANAGE_TASKS, 'channel', moved), moved).querySelector('.notes-snooze')).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(reminders(card(undefined, 'list', moved), moved).querySelector('.notes-snooze')).not.toBeNull();
    });
});

describe('toastRefusal', () => {
    it('toasts every ApiError with the server’s words — a 403 too — and nothing else', () => {
        const sink = vi.fn();
        setMessageToastSink(sink);
        expect(toastRefusal(new ApiError('Missing Complete Tasks permission', 403))).toBe(true);
        expect(toastRefusal(new ApiError('This item has a date or repeats — update the app to complete it', 409))).toBe(true);
        expect(toastRefusal(new TypeError('Failed to fetch'))).toBe(false);
        expect(sink.mock.calls.map(c => c[0].title)).toEqual([
            'Missing Complete Tasks permission', 'This item has a date or repeats — update the app to complete it',
        ]);
    });
});
