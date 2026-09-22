// Moving a reminder from the Reminders row. Three things have to hold:
//
//  - it is offered on the EDIT right (creator, task manager, any personal
//    note), which is what the server enforces on due_at and schedule — not on
//    the snooze right, which is a different permission on a different field;
//  - a plain dated item takes a plain due time even on a server with no
//    schedule support, while an item that repeats opens the schedule editor
//    (rewriting a repeat as a bare due time would destroy it);
//  - a snooze on an item that moves LAPSES by itself, and nothing sends a
//    snooze field to make it do so.
//
// The harness is snoozeRights.test.tsx's, extended with a spying NoteActions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RemindersView } from '../notes/components/RemindersView';
import type { Task } from '../api/tasks';
import type { NoteCard } from '../notes/model/notesModel';
import type { NoteActions } from '../notes/model/notesQueries';
import { PERM } from '../api/permissionBits';
import { serializeSchedule, serializeSnooze, type EventSchedule } from '../api/taskSchedule';
import { reminderSlotOf } from '../notes/model/notesTiming';

const NOW = Date.parse('2030-10-01T00:00:00Z');
const DUE = '2030-10-07T09:00:00.000Z';
const MOVED = '2030-10-07T10:00:00.000Z';

const task: Task = {
    id: 5, channel_id: 9, list_id: null, parent_id: null, description: 'Bins out', is_completed: false, position: 1,
    created_at: '2030-09-01T00:00:00Z', created_by: 2, attachments: null, due_at: DUE,
};
const repeating: EventSchedule = { v: 1, kind: 'task', uid: 'uid-retime-0001', allDay: false, start: '2030-10-07T09:00', tz: 'UTC', rrule: 'FREQ=WEEKLY', alerts: [0] };
const scheduled: Task = { ...task, schedule: serializeSchedule(repeating) };

let root: Root | null = null;
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null;
    vi.restoreAllMocks();
});

const card = (myPerms: number | undefined, kind: 'list' | 'channel', t: Task = task): NoteCard => ({
    key: `${kind}:9`, ref: { kind, id: 9 }, title: 'home', tasks: [t], pinned: false, color: 'default', labels: [], archived: false,
    total: 1, completed: 0, myPerms,
} as unknown as NoteCard);

function reminders(c: NoteCard, t: Task = task, opts: { canSchedule?: boolean; onOpen?: () => void; onModal?: (open: boolean) => void; empty?: boolean } = {}) {
    const actions = { setDue: vi.fn(), setSchedule: vi.fn(), snoozeTask: vi.fn(), toggleTask: vi.fn() } as unknown as NoteActions;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const view = (empty: boolean) => (
        <RemindersView
            groups={{ overdue: [], today: [], upcoming: empty ? [] : [{ task: t, note: c, at: Date.parse(t.due_at ?? DUE), slot: reminderSlotOf(t, NOW) ?? undefined }] }}
            actions={actions} now={NOW} onOpen={opts.onOpen ?? (() => {})}
            notificationsState="granted" onEnableNotifications={() => {}} canSnooze
            canSchedule={opts.canSchedule ?? true} onModal={opts.onModal}
        />
    );
    act(() => root!.render(view(false)));
    /** Re-render with the row gone, as a refresh that re-groups the feed does. */
    const dropTheRow = () => act(() => root!.render(view(true)));
    return { host, actions, dropTheRow };
}

const retimeBtn = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.notes-retime button');

describe('who is offered a retime', () => {
    it('a personal note, a task manager — yes', () => {
        expect(retimeBtn(reminders(card(undefined, 'list')).host)).not.toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        expect(retimeBtn(reminders(card(PERM.VIEW_CHANNEL | PERM.MANAGE_TASKS, 'channel')).host)).not.toBeNull();
    });

    it('a member who may tick but not edit the time — no, and the row is still there', () => {
        const { host } = reminders(card(PERM.VIEW_CHANNEL | PERM.COMPLETE_TASKS, 'channel'));
        expect(host.querySelector('.notes-reminder-row')).not.toBeNull();
        expect(host.querySelector('.notes-reminder-row input[type="checkbox"]')).not.toBeNull();
        expect(retimeBtn(host)).toBeNull();
        // …and the snooze they DO have is untouched by this (the two rights
        // are separate, which is the whole point of the new predicate).
        expect(host.querySelector('.notes-snooze')).not.toBeNull();
    });
});

describe('what the retime opens', () => {
    it('a plain dated item gets a due-time field — and one tap away from the note', () => {
        const { host } = reminders(card(undefined, 'list'));
        act(() => retimeBtn(host)!.click());
        expect(host.querySelectorAll('.notes-retime input[type="datetime-local"]').length).toBe(1);
        expect(document.body.querySelector('.sched-dialog')).toBeNull();
    });

    it('an item that repeats opens the Date & repeat dialog instead', () => {
        const { host } = reminders(card(undefined, 'list', scheduled), scheduled);
        act(() => retimeBtn(host)!.click());
        expect(document.body.querySelector('.sched-dialog[aria-label="Date and repeat"]')).not.toBeNull();
        expect(host.querySelector('.notes-retime input[type="datetime-local"]')).toBeNull();
    });

    it('an older server (no schedule support) still moves a plain due time, and never offers the dialog', () => {
        const noSched = reminders(card(undefined, 'list', scheduled), scheduled, { canSchedule: false });
        expect(retimeBtn(noSched.host)).toBeNull();
        act(() => root?.unmount());
        document.body.innerHTML = '';
        // Positive control: the same server, a plain dated item — still offered.
        const plain = reminders(card(undefined, 'list'), task, { canSchedule: false });
        expect(retimeBtn(plain.host)).not.toBeNull();
        act(() => retimeBtn(plain.host)!.click());
        expect(plain.host.querySelectorAll('.notes-retime input[type="datetime-local"]').length).toBe(1);
    });

    it('a schedule this build cannot read opens, explains, and offers no Save', () => {
        const unreadable: Task = { ...task, schedule: '[unreadable: encrypted with a key this device does not have]' };
        reminders(card(undefined, 'list', unreadable), unreadable);
        act(() => retimeBtn(document.body as unknown as HTMLElement)!.click());
        const dialog = document.body.querySelector('.sched-dialog')!;
        expect(dialog).not.toBeNull();
        expect([...dialog.querySelectorAll('button')].some(b => b.textContent === 'Save')).toBe(false);
        act(() => root?.unmount());
        document.body.innerHTML = '';
        // Positive control: a readable one has Save.
        const ok = reminders(card(undefined, 'list', scheduled), scheduled);
        act(() => retimeBtn(ok.host)!.click());
        expect([...document.body.querySelectorAll('.sched-dialog button')].some(b => b.textContent === 'Save')).toBe(true);
    });
});

describe('what the retime writes', () => {
    const type = (input: HTMLInputElement, value: string) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };

    it('a plain item: setDue once, with this note and this item — and no setSchedule', () => {
        const { host, actions } = reminders(card(undefined, 'list'));
        act(() => retimeBtn(host)!.click());
        type(host.querySelector<HTMLInputElement>('.notes-retime input')!, '2030-10-09T18:30');
        act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Set')!.click());
        expect(actions.setDue).toHaveBeenCalledTimes(1);
        const [ref, t, iso] = (actions.setDue as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(ref).toEqual({ kind: 'list', id: 9 });
        expect((t as Task).id).toBe(5);
        expect(iso).toBe(new Date('2030-10-09T18:30').toISOString());
        expect(actions.setSchedule).not.toHaveBeenCalled();
        expect(host.querySelector('.notes-retime input')).toBeNull();   // closed after the Set
    });

    it('an unchanged or unparseable value writes nothing at all', () => {
        const { host, actions } = reminders(card(undefined, 'list'));
        act(() => retimeBtn(host)!.click());
        act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Set')!.click());
        expect(actions.setDue).not.toHaveBeenCalled();
    });

    it('a repeating item: setSchedule, through the dialog', () => {
        const { actions } = reminders(card(undefined, 'list', scheduled), scheduled);
        act(() => retimeBtn(document.body as unknown as HTMLElement)!.click());
        act(() => [...document.body.querySelectorAll('.sched-dialog button')].find(b => b.textContent === 'Save')!.click());
        expect(actions.setSchedule).toHaveBeenCalledTimes(1);
        expect(actions.setDue).not.toHaveBeenCalled();
        const [ref, t, schedule] = (actions.setSchedule as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(ref).toEqual({ kind: 'list', id: 9 });
        expect((t as Task).id).toBe(5);
        expect(String(schedule)).toContain('FREQ=WEEKLY');            // the repeat survived the move
    });

    it('a snooze on the item lapses by itself — nothing clears it, because a snooze rides another right', () => {
        const snoozed: Task = { ...task, due_at: MOVED, snooze: serializeSnooze({ forDue: DUE, until: MOVED }) };
        expect(reminderSlotOf(snoozed, NOW)!.snoozed).toBe(true);      // positive control: it IS snoozed
        const { host, actions } = reminders(card(undefined, 'list', snoozed), snoozed);
        act(() => retimeBtn(host)!.click());
        type(host.querySelector<HTMLInputElement>('.notes-retime input')!, '2030-10-11T08:00');
        act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Set')!.click());

        const iso = (actions.setDue as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as string;
        expect(reminderSlotOf({ ...snoozed, due_at: iso }, NOW)!.snoozed).toBe(false);
        expect(actions.snoozeTask).not.toHaveBeenCalled();
        // setDue takes (note, task, dueAt) and nothing else: no snooze field,
        // no expect_due_at — the retime carries neither.
        expect((actions.setDue as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toHaveLength(3);
    });

    it('the control belongs to the row, not to the note: opening it never opens the note', () => {
        const onOpen = vi.fn();
        const { host } = reminders(card(undefined, 'list'), task, { onOpen });
        act(() => retimeBtn(host)!.click());
        const input = host.querySelector<HTMLInputElement>('.notes-retime input')!;
        act(() => input.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
        expect(onOpen).not.toHaveBeenCalled();
        // Positive control: the row itself still opens the note.
        act(() => host.querySelector<HTMLElement>('.notes-reminder-text')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
        expect(onOpen).toHaveBeenCalledTimes(1);
    });
});

// The shell turns its single-key shortcuts off while the schedule dialog is
// up. Turning them back ON is the half that has no visible symptom: a row
// that unmounts mid-edit (the item crosses Today/Overdue on the clock tick,
// another device retimes it, the feed re-groups) takes the portalled dialog
// with it, and a flag left true kills `c`, `r`, `?` and `/` for the rest of
// the session.
describe('the shortcut flag always comes back', () => {
    it('Cancel clears it', () => {
        const onModal = vi.fn();
        const { host } = reminders(card(undefined, 'list', scheduled), scheduled, { onModal });
        act(() => retimeBtn(host)!.click());
        expect(onModal.mock.calls.map(c => c[0])).toEqual([true]);
        act(() => [...document.body.querySelectorAll('.sched-dialog button')].find(b => b.textContent === 'Cancel')!.click());
        expect(onModal.mock.calls.map(c => c[0])).toEqual([true, false]);
    });

    it('so does the row disappearing under the open dialog', () => {
        const onModal = vi.fn();
        const { host, dropTheRow } = reminders(card(undefined, 'list', scheduled), scheduled, { onModal });
        act(() => retimeBtn(host)!.click());
        expect(document.body.querySelector('.sched-dialog')).not.toBeNull();
        dropTheRow();
        expect(document.body.querySelector('.sched-dialog')).toBeNull();   // it went with the row
        expect(onModal.mock.calls.map(c => c[0])).toEqual([true, false]);
    });

    it('a plain due-time field never claimed it in the first place (control)', () => {
        const onModal = vi.fn();
        const { host, dropTheRow } = reminders(card(undefined, 'list'), task, { onModal });
        act(() => retimeBtn(host)!.click());
        dropTheRow();
        expect(onModal).not.toHaveBeenCalled();
    });
});
