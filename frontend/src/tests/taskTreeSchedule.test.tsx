// TaskTree with schedules: an item that HAS a schedule never shows the raw
// due editor or a "Due" chip (its due_at is the next reminder), whatever the
// owner passes; the date & repeat button appears only when the owner passes
// onSetSchedule (i.e. the server stores schedules). Mounted with
// react-dom/client + act, the repo's component-test pattern.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TaskTree } from '../components/TaskTree';
import type { Task } from '../api/tasks';
import { serializeSchedule } from '../api/taskSchedule';

// jsdom's selector engine mishandles "&" inside an attribute value; match by hand.
const byLabel = (el: ParentNode, label: string) =>
    [...el.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label) ?? null;

const task = (id: number, over: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description: `item ${id}`, is_completed: false, position: id,
    created_at: '2026-10-01T00:00:00Z', created_by: 1, attachments: null, due_at: null, ...over,
});
const sched = serializeSchedule({ v: 1, kind: 'event', uid: 'uid-tree-001', allDay: false, start: '2030-10-05T15:00', end: '2030-10-05T16:00', tz: 'UTC', rrule: 'FREQ=WEEKLY', alerts: [10] });

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

function renderTree(tasks: Task[], extra: Partial<ComponentProps<typeof TaskTree>> = {}): HTMLDivElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
        root!.render(
            <TaskTree
                tasks={tasks}
                onToggle={vi.fn()} onDelete={vi.fn()} onEdit={vi.fn()} onAddSubtask={vi.fn()} onMove={vi.fn()}
                onSetDue={vi.fn()} onSetAttachments={vi.fn()}
                {...extra}
            />,
        );
    });
    return host;
}

describe('TaskTree and schedules', () => {
    it('a scheduled item: no raw due editor, no "Due" chip — its own chip instead', () => {
        const el = renderTree([task(1, { schedule: sched, due_at: '2030-10-05T14:50:00Z' }), task(2, { due_at: '2030-10-06T09:00:00Z' })]);
        const rows = el.querySelectorAll('.tt-item');
        // Positive control: the PLAIN row keeps its clock and its due chip.
        expect(rows[1].querySelector('.tt-btn[title="Edit due time"]')).not.toBeNull();
        expect(rows[1].querySelector('.tt-due:not(.tt-sched)')).not.toBeNull();
        expect(rows[0].querySelector('.tt-btn[title="Edit due time"]')).toBeNull();
        expect(rows[0].querySelector('.tt-btn[title="Add due time"]')).toBeNull();
        expect(rows[0].querySelector('.tt-due:not(.tt-sched):not(.tt-snoozed)')).toBeNull();
        expect(rows[0].querySelector('.tt-sched')?.textContent).toMatch(/weekly/);
    });

    it('an unreadable schedule still suppresses the due editor and shows a locked chip', () => {
        const el = renderTree([task(1, { schedule: '[Encrypted — key unavailable]', due_at: '2030-10-05T14:50:00Z' })]);
        expect(el.querySelector('.tt-btn[title="Edit due time"]')).toBeNull();
        expect(el.querySelector('.tt-sched.locked')).not.toBeNull();
    });

    it('the date & repeat button exists only when the owner passes onSetSchedule, and Save hands back a schedule', () => {
        let el = renderTree([task(1)]);
        expect(byLabel(el, 'Add date & repeat')).toBeNull();
        act(() => root?.unmount());
        host?.remove();
        const onSetSchedule = vi.fn();
        el = renderTree([task(1)], { onSetSchedule });
        act(() => { byLabel(el, 'Add date & repeat')!.click(); });
        const dialog = [...document.querySelectorAll('[role="dialog"]')].find(d => d.getAttribute('aria-label') === 'Date and repeat') ?? null;
        expect(dialog).not.toBeNull();
        const repeat = dialog!.querySelector('select[aria-label="Repeat"]') as HTMLSelectElement;
        act(() => {
            const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
            setter.call(repeat, 'weekly');
            repeat.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const save = [...dialog!.querySelectorAll('button')].find(b => b.textContent === 'Save')!;
        act(() => { save.click(); });
        expect(onSetSchedule).toHaveBeenCalledTimes(1);
        const [t, text, due] = onSetSchedule.mock.calls[0];
        expect(t.id).toBe(1);
        expect(JSON.parse(text)).toMatchObject({ v: 1, kind: 'task', rrule: expect.stringMatching(/^FREQ=WEEKLY;BYDAY=/) });
        expect(typeof due === 'string' || due === null).toBe(true);
        expect([...document.querySelectorAll('[role="dialog"]')].length).toBe(0);
    });
});
