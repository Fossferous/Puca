// The one-tap reminder times, where a person actually meets them: the row in
// the item's due editor, the row in the date & repeat dialog, and the four
// controls in the account menu that say what they mean.
//
// A stored setting with no control is a feature nobody can use, so the menu
// rows are tested as hard as the presets themselves.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TaskTree } from '../components/TaskTree';
import { ScheduleEditor } from '../components/schedule/ScheduleEditor';
import { AccountMenu } from '../notes/components/AccountMenu';
import { DEFAULT_REMINDER_TIMES, presetInstant, type ReminderTimes } from '../api/reminderTimes';
import type { Task } from '../api/tasks';

const TIMES: ReminderTimes = { morning: '07:30', afternoon: '13:15', evening: '21:45', default: '08:00' };
const NOW = Date.parse('2030-10-07T05:00:00Z');

const task: Task = {
    id: 3, channel_id: null, list_id: 1, parent_id: null, description: 'Bins out', is_completed: false, position: 1,
    created_at: '2030-09-01T00:00:00Z', created_by: 1, attachments: null, due_at: null,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    document.body.innerHTML = '';
    root = null;
    host = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function mount(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(node));
    return host;
}

const buttons = (el: ParentNode) => [...el.querySelectorAll('button')];
const byText = (el: ParentNode, text: string) => buttons(el).find(b => b.textContent === text);

function openDueEditor(reminderTimes?: ReminderTimes) {
    const onSetDue = vi.fn();
    const el = mount(
        <TaskTree
            tasks={[task]} onToggle={() => {}} onDelete={() => {}} onEdit={() => {}} onAddSubtask={() => {}}
            onMove={() => {}} onSetDue={onSetDue} onSetAttachments={() => {}} reminderTimes={reminderTimes}
        />,
    );
    const clock = buttons(el).find(b => b.getAttribute('title') === 'Add due time');
    expect(clock).toBeTruthy();
    act(() => clock!.click());
    return { el, onSetDue };
}

describe('the due editor offers the three times', () => {
    it('shows Morning, Afternoon and Evening, and one tap sets the reminder without a date form', () => {
        vi.useFakeTimers({ now: NOW });
        const { el, onSetDue } = openDueEditor(TIMES);
        const presets = el.querySelectorAll('.tt-due-presets button');
        expect([...presets].map(b => b.textContent)).toEqual(['Morning', 'Afternoon', 'Evening']);

        act(() => (presets[0] as HTMLButtonElement).click());
        expect(onSetDue).toHaveBeenCalledTimes(1);
        expect(onSetDue.mock.calls[0][1]).toBe(new Date(presetInstant('07:30', NOW)).toISOString());
        // The editor closed: one tap, no date form left open.
        expect(el.querySelector('.tt-due-edit')).toBeNull();
    });

    it('uses the account’s times, not 09:00', () => {
        vi.useFakeTimers({ now: NOW });
        const mine = openDueEditor(TIMES);
        act(() => (mine.el.querySelectorAll('.tt-due-presets button')[2] as HTMLButtonElement).click());
        expect(mine.onSetDue.mock.calls[0][1]).toBe(new Date(presetInstant('21:45', NOW)).toISOString());
        expect(mine.onSetDue.mock.calls[0][1]).not.toBe(new Date(presetInstant(DEFAULT_REMINDER_TIMES.evening, NOW)).toISOString());

        act(() => root?.unmount());
        document.body.innerHTML = '';
        // Positive control: a caller with no setting (Púca's own Tasks view)
        // still gets the row, at the defaults.
        const theirs = openDueEditor(undefined);
        act(() => (theirs.el.querySelectorAll('.tt-due-presets button')[2] as HTMLButtonElement).click());
        expect(theirs.onSetDue.mock.calls[0][1]).toBe(new Date(presetInstant(DEFAULT_REMINDER_TIMES.evening, NOW)).toISOString());
    });

    it('the typed date field is still there for anything else', () => {
        const { el } = openDueEditor(TIMES);
        expect(el.querySelectorAll('.tt-due-edit input[type="datetime-local"]').length).toBe(1);
    });
});

describe('the date & repeat dialog offers them too — with the privacy switch still on it', () => {
    it('a preset fills the date and time, and does not hide "Keep the time private from the server"', () => {
        const onSave = vi.fn();
        mount(<ScheduleEditor task={task} onSave={onSave} onClose={() => {}} now={NOW} times={TIMES} />);
        const dialog = document.body.querySelector('.sched-dialog')!;
        const presets = dialog.querySelectorAll('.sched-presets button');
        expect([...presets].map(b => b.textContent)).toEqual(['Morning', 'Afternoon', 'Evening']);

        act(() => (presets[1] as HTMLButtonElement).click());
        const at = dialog.querySelector<HTMLInputElement>('input[aria-label="Start time"]')!;
        expect(at.value).toBe('13:15');
        const date = dialog.querySelector<HTMLInputElement>('input[aria-label="Date"]')!;
        const want = new Date(presetInstant('13:15', Date.now()));
        expect(date.value).toBe(`${want.getFullYear()}-${String(want.getMonth() + 1).padStart(2, '0')}-${String(want.getDate()).padStart(2, '0')}`);
        expect(dialog.querySelectorAll('input[type="checkbox"]').length).toBeGreaterThan(0);

        // And a Save writes that time, not the old 09:00 default.
        act(() => byText(dialog, 'Save')!.click());
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(String(onSave.mock.calls[0][0])).not.toContain('T09:00');
    });

    it('coming off all-day leaves the reminder choice on an offset the timed list actually offers', () => {
        const onSave = vi.fn();
        mount(<ScheduleEditor task={task} onSave={onSave} onClose={() => {}} now={NOW} times={TIMES} />);
        const dialog = document.body.querySelector('.sched-dialog')!;
        const allDay = dialog.querySelector<HTMLInputElement>('.sched-check input[type="checkbox"]')!;
        act(() => { allDay.click(); });
        const alert = dialog.querySelector<HTMLSelectElement>('select[aria-label="Reminder"]')!;
        expect(alert.value).toBe('-540');                       // the all-day offset
        act(() => (dialog.querySelectorAll('.sched-presets button')[0] as HTMLButtonElement).click());
        expect(dialog.querySelector<HTMLInputElement>('.sched-check input[type="checkbox"]')!.checked).toBe(false);
        expect([...alert.options].some(o => o.value === alert.value)).toBe(true);
        expect(alert.value).toBe('0');
    });

    it('a new schedule with no preset tapped starts at the account’s "new reminders at" time', () => {
        mount(<ScheduleEditor task={task} onSave={() => {}} onClose={() => {}} now={NOW} defaultDate="2030-10-09" times={TIMES} />);
        expect(document.body.querySelector<HTMLInputElement>('input[aria-label="Start time"]')!.value).toBe('08:00');
    });
});

describe('the account menu is where the times are set', () => {
    const menu = (times: ReminderTimes, onTimes = vi.fn()) => ({
        el: mount(
            <AccountMenu
                username="mick" sort="puca" onSort={() => {}} times={times} onTimes={onTimes}
                onExportMarkdown={() => {}} onExportJson={() => {}} onHelp={() => {}}
                onSignOut={() => {}} onSignOutEverywhere={() => {}}
            />,
        ),
        onTimes,
    });

    it('has all four controls, showing the stored values', () => {
        const { el } = menu(TIMES);
        const ids = ['notes-remind-morning', 'notes-remind-afternoon', 'notes-remind-evening', 'notes-remind-default'];
        expect(ids.every(id => el.querySelector(`#${id}`))).toBe(true);
        expect(ids.map(id => el.querySelector<HTMLInputElement>(`#${id}`)!.value)).toEqual(['07:30', '13:15', '21:45', '08:00']);
        expect(ids.every(id => el.querySelector<HTMLInputElement>(`#${id}`)!.type === 'time')).toBe(true);
        // Labelled, not a bare box.
        expect(el.querySelector(`label[for="notes-remind-morning"]`)?.textContent).toBe('Morning');
    });

    it('a change reports just that field', () => {
        const { el, onTimes } = menu(TIMES);
        const input = el.querySelector<HTMLInputElement>('#notes-remind-evening')!;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
        act(() => {
            setter.call(input, '22:30');
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect(onTimes).toHaveBeenCalledTimes(1);
        expect(onTimes.mock.calls[0][0]).toEqual({ evening: '22:30' });
    });
});
