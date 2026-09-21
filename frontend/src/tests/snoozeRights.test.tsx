// A snooze rides the COMPLETE_TASKS right on the server. A member without it
// must not be offered Snooze (the calendar's item menu, either Reminders row,
// an item row inside a list), and every server refusal in the calendars/Notes
// is toasted with the server's own words (toastRefusal) — a 403 used to
// vanish silently.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Calendar } from '../components/calendar/Calendar';
import { TaskTree } from '../components/TaskTree';
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

// The item ROW's snooze (TaskTree), the third surface: same rule, one
// implementation (taskSchedule.maySnooze).
const row = (over: { t?: Task; myPerms?: number; me?: number; on?: boolean } = {}) => {
    const el = mount(
        <TaskTree
            tasks={[over.t ?? task]}
            onToggle={() => {}} onDelete={() => {}} onEdit={() => {}} onAddSubtask={() => {}} onMove={() => {}}
            onSetDue={() => {}} onSetAttachments={() => {}}
            onSnooze={over.on === false ? undefined : () => {}}
            myPerms={over.myPerms} currentUserId={over.me ?? 3}
        />,
    );
    return el.querySelector('.tt-item .notes-snooze');
};

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

describe('Snooze on the item row', () => {
    it('is offered to a member who may complete, and to the owner of a personal list', () => {
        expect(row({ myPerms: PERM.VIEW_CHANNEL | PERM.COMPLETE_TASKS })).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(row({ myPerms: undefined })).not.toBeNull();
    });
    it('is hidden without COMPLETE_TASKS, on an item with no reminder time, and on a server with no snooze', () => {
        expect(row({ myPerms: PERM.VIEW_CHANNEL })).toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(row({ t: { ...task, due_at: null } })).toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(row({ on: false })).toBeNull();
    });
    it('an editor’s moved snooze is not a tick-only member’s to change', () => {
        const MOVED = '2030-10-07T10:00:00.000Z';
        const moved: Task = { ...task, due_at: MOVED, snooze: serializeSnooze({ forDue: DUE, until: MOVED }) };
        expect(row({ t: moved, myPerms: PERM.VIEW_CHANNEL | PERM.COMPLETE_TASKS })).toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        // Positive control: a task manager may, and so may the same member on
        // an item nobody has snoozed.
        expect(row({ t: moved, myPerms: PERM.VIEW_CHANNEL | PERM.MANAGE_TASKS })).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(row({ t: { ...moved, snooze: null }, myPerms: PERM.VIEW_CHANNEL | PERM.COMPLETE_TASKS })).not.toBeNull();
    });
    // The row's menu is absolutely positioned OVER the next item
    // (Reminders.css), so one left open would swallow that row's clicks.
    it('the menu closes on Escape and on a press outside it', () => {
        const el = mount(
            <TaskTree
                tasks={[task]}
                onToggle={() => {}} onDelete={() => {}} onEdit={() => {}} onAddSubtask={() => {}} onMove={() => {}}
                onSetDue={() => {}} onSetAttachments={() => {}} onSnooze={() => {}}
                myPerms={PERM.VIEW_CHANNEL | PERM.MANAGE_TASKS} currentUserId={3}
            />,
        );
        const btn = () => el.querySelector('.tt-item .notes-snooze button') as HTMLButtonElement;
        const menu = () => el.querySelector('.notes-snooze-menu');

        act(() => btn().click());
        expect(menu()).not.toBeNull();
        act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(menu()).toBeNull();

        act(() => btn().click());
        expect(menu()).not.toBeNull();
        // Inside it first — a press on the menu itself must NOT close it.
        act(() => { menu()!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(menu()).not.toBeNull();
        act(() => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        expect(menu()).toBeNull();
    });

    it('offers Unsnooze only while a snooze is in force', () => {
        const el = mount(
            <TaskTree
                tasks={[{ ...task, snooze: serializeSnooze({ forDue: DUE, until: '2030-10-07T10:00:00.000Z' }) }]}
                onToggle={() => {}} onDelete={() => {}} onEdit={() => {}} onAddSubtask={() => {}} onMove={() => {}}
                onSetDue={() => {}} onSetAttachments={() => {}} onSnooze={() => {}}
                myPerms={PERM.VIEW_CHANNEL | PERM.MANAGE_TASKS} currentUserId={3}
            />,
        );
        const btn = el.querySelector('.tt-item .notes-snooze button');
        act(() => (btn as HTMLButtonElement).click());
        const labels = [...el.querySelectorAll('.notes-snooze-menu button')].map(b => b.textContent);
        expect(labels).toEqual(['10 min', '1 hour', 'Tomorrow', 'Unsnooze']);
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
