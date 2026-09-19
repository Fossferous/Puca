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

function openMenu(canComplete: boolean | undefined) {
    const src: CalendarSource = { task, noteKey: 'channel:9', noteTitle: '#home', canEdit: false, ...(canComplete === undefined ? {} : { canComplete }) };
    const el = mount(
        <Calendar
            sources={[src]} view="day" date="2030-10-07" onNavigate={() => {}} showCompleted={false} showPlain
            onToggleCompleted={() => {}} onTogglePlain={() => {}} weekStart={1} now={Date.parse('2030-10-01T00:00:00Z')} coarse
            onOpen={() => {}} onMove={() => {}} onAdd={() => {}} onToggleDone={() => {}} onSnooze={() => {}}
        />,
    );
    const more = [...el.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === 'More for Bins out');
    expect(more).toBeTruthy();
    act(() => more!.click());
    return document.body.querySelector('.cal-menu-snooze');
}

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

    const card = (myPerms: number | undefined, kind: 'list' | 'channel'): NoteCard => ({
        key: `${kind}:9`, ref: { kind, id: 9 }, title: 'home', tasks: [task], pinned: false, color: 'default', labels: [], archived: false,
        total: 1, completed: 0, myPerms,
    } as unknown as NoteCard);
    const reminders = (c: NoteCard) => mount(
        <RemindersView
            groups={{ overdue: [], today: [], upcoming: [{ task, note: c, at: Date.parse(DUE) }] }}
            actions={{} as NoteActions} now={Date.parse('2030-10-01T00:00:00Z')} onOpen={() => {}}
            notificationsState="granted" onEnableNotifications={() => {}} canSnooze
        />,
    );
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
