/**
 * A HEADING row in the shared checklist renderer (components/TaskTree.tsx) —
 * which is Púca's Tasks view, every channel checklist (the side panel, a
 * checklist channel, the All-checklists board, the Tasks board's cards) and
 * Púca Notes' open note, so these rows are what every one of them shows.
 *
 * A heading is a section title: no checkbox, no time, no subtasks, never in
 * Completed — edited as its label, turned back into an item from its row.
 * Every "it has no X" below sits beside an ordinary row that DOES have X, so
 * none of them passes by rendering nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { TaskTree } from '../components/TaskTree';
import type { Task } from '../api/tasks';
import { isHeadingText } from '../api/taskHeading';
import { readPastedItems } from '../notes/model/noteContent';

const task = (id: number, description: string, o: Partial<Task> = {}): Task => ({
    id, channel_id: null, list_id: 1, parent_id: null, description, is_completed: false,
    position: id, created_at: '2026-09-01', created_by: 1, attachments: null, due_at: null, ...o,
});

let root: Root;
let host: HTMLDivElement;
const onEdit = vi.fn();
const onToggle = vi.fn();
const onSetDue = vi.fn();
const onSetSchedule = vi.fn();
const onSnooze = vi.fn();

function render(tasks: Task[], extra: Partial<ComponentProps<typeof TaskTree>> = {}) {
    act(() => {
        root.render(
            <TaskTree
                {...extra}
                tasks={tasks}
                onToggle={onToggle}
                onDelete={() => {}}
                onEdit={onEdit}
                onAddSubtask={() => {}}
                onMove={() => {}}
                onReorder={() => {}}
                onSetDue={onSetDue}
                onSetSchedule={onSetSchedule}
                onSnooze={onSnooze}
                onSetAttachments={() => {}}
            />,
        );
    });
}

/** The <li> of the row whose text is `text`. */
const rowOf = (text: string) => {
    const li = [...host.querySelectorAll('li.tt-item')].find(l => l.querySelector('.tt-description')?.textContent === text);
    expect(li, `the row "${text}"`).toBeTruthy();
    return li as HTMLLIElement;
};
// Compared, not selected: jsdom's selector engine misreads the "&" in
// `[title="Add date & repeat"]` and matches nothing.
const titled = (li: Element, title: string) => [...li.querySelectorAll('button')].find(b => b.getAttribute('title') === title) ?? null;

function typeInto(el: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    act(() => { el.dispatchEvent(new Event('input', { bubbles: true })); });
}

beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
    vi.restoreAllMocks();
    onEdit.mockReset(); onToggle.mockReset(); onSetDue.mockReset(); onSetSchedule.mockReset(); onSnooze.mockReset();
});

describe('a heading row', () => {
    it('shows its label as a heading, with NO checkbox — an item beside it keeps its box', () => {
        render([task(1, '## Before you start'), task(2, 'Update the app')]);
        const heading = rowOf('Before you start');
        expect(heading.classList.contains('tt-heading')).toBe(true);
        expect(heading.querySelector('input[type="checkbox"]')).toBeNull();
        expect(heading.querySelector('[role="heading"]')?.textContent).toBe('Before you start');
        expect(host.textContent).not.toContain('##');
        // POSITIVE CONTROL.
        const item = rowOf('Update the app');
        expect(item.classList.contains('tt-heading')).toBe(false);
        expect(item.querySelector('input[type="checkbox"]')).not.toBeNull();
    });

    it('has no due time, date & repeat, subtask or attach control — an item has every one', () => {
        render([task(1, '## Before you start'), task(2, 'Update the app')]);
        const heading = rowOf('Before you start');
        const item = rowOf('Update the app');
        for (const t of ['Add due time', 'Add date & repeat', 'Add subtask', 'Attach picture/video']) {
            expect(titled(heading, t), `heading: ${t}`).toBeNull();
            expect(titled(item, t), `item: ${t}`).not.toBeNull();
        }
    });

    it('a time an older client put on a heading is not shown on it', () => {
        render([task(1, '## Calendar', { due_at: '2026-09-30T09:00:00Z' }), task(2, 'Snooze an item', { due_at: '2026-09-30T09:00:00Z' })]);
        expect(rowOf('Calendar').querySelector('.tt-due')).toBeNull();
        expect(rowOf('Snooze an item').querySelector('.tt-due')).not.toBeNull();
    });

    it('is edited as its label and saved back as a heading', () => {
        render([task(1, '## Before you start')]);
        act(() => { (rowOf('Before you start').querySelector('.tt-description') as HTMLElement).click(); });
        const input = host.querySelector<HTMLInputElement>('input.tt-edit-input')!;
        expect(input.value).toBe('Before you start');
        typeInto(input, 'Before you begin');
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '## Before you begin');
    });

    it('an unchanged label saves nothing, even from a "# " heading', () => {
        render([task(1, '# Setup')]);
        act(() => { (rowOf('Setup').querySelector('.tt-description') as HTMLElement).click(); });
        const input = host.querySelector<HTMLInputElement>('input.tt-edit-input')!;
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(onEdit).not.toHaveBeenCalled();
    });

    it('is never in Completed, even ticked by an older client; the Completed count is items only', () => {
        render([
            task(1, '## Calendar', { is_completed: true }),
            task(2, 'Done thing', { is_completed: true }),
            task(3, 'Open thing'),
        ]);
        const completed = host.querySelector('.tt-list.completed')!;
        expect(completed.textContent).toContain('Done thing');
        expect(completed.textContent).not.toContain('Calendar');
        expect(host.querySelector('.tt-toggle-completed')?.textContent).toContain('Completed (1)');
        const heading = rowOf('Calendar');
        expect(heading.closest('.tt-list')?.classList.contains('completed')).toBe(false);
        expect(heading.classList.contains('completed')).toBe(false);
    });
});

describe('turning a row into a heading and back', () => {
    it('"Turn into heading" on a top-level item makes it a heading', () => {
        render([task(1, 'Before you start')]);
        act(() => { (titled(rowOf('Before you start'), 'Turn into heading') as HTMLButtonElement).click(); });
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '## Before you start');
    });

    it('"Turn into item" on a heading makes it an item again', () => {
        render([task(1, '## Before you start')]);
        const heading = rowOf('Before you start');
        expect(titled(heading, 'Turn into heading')).toBeNull();
        act(() => { (titled(heading, 'Turn into item') as HTMLButtonElement).click(); });
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), 'Before you start');
    });

    it('a sub-item is not offered it: a heading is a top-level row', () => {
        render([task(1, 'Parent'), task(2, 'Child', { parent_id: 1 })]);
        expect(titled(rowOf('Child'), 'Turn into heading')).toBeNull();
        expect(titled(rowOf('Parent'), 'Turn into heading')).not.toBeNull();
    });

    it('typing "## " over a top-level item makes it a heading', () => {
        render([task(1, 'Calendar')]);
        act(() => { (rowOf('Calendar').querySelector('.tt-description') as HTMLElement).click(); });
        const input = host.querySelector<HTMLInputElement>('input.tt-edit-input')!;
        typeInto(input, '# Calendar');
        act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '## Calendar');
    });

    it('an item with a due time asks first, and loses the time BEFORE it becomes a heading', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const calls: string[] = [];
        onSetDue.mockImplementation(() => { calls.push('due'); });
        onEdit.mockImplementation(() => { calls.push('edit'); });
        render([task(1, 'Calendar', { due_at: '2026-09-30T09:00:00Z' })]);
        act(() => { (titled(rowOf('Calendar'), 'Turn into heading') as HTMLButtonElement).click(); });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(onSetDue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), null);
        expect(calls).toEqual(['due', 'edit']);
    });

    it('a date & repeat is removed the same way; saying no changes nothing', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        render([task(1, 'Standup', { due_at: '2026-09-30T09:00:00Z', schedule: '{"v":1}' })]);
        act(() => { (titled(rowOf('Standup'), 'Turn into heading') as HTMLButtonElement).click(); });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(onEdit).not.toHaveBeenCalled();
        expect(onSetSchedule).not.toHaveBeenCalled();
        confirm.mockReturnValue(true);
        act(() => { (titled(rowOf('Standup'), 'Turn into heading') as HTMLButtonElement).click(); });
        expect(onSetSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), null, null);
        expect(onSetDue).not.toHaveBeenCalled();
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '## Standup');
    });

    it('POSITIVE CONTROL: an item with no time is not asked about', () => {
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        render([task(1, 'Calendar')]);
        act(() => { (titled(rowOf('Calendar'), 'Turn into heading') as HTMLButtonElement).click(); });
        expect(confirm).not.toHaveBeenCalled();
        expect(onSetDue).not.toHaveBeenCalled();
    });
});

/** Click a row's text, type `value` over it, press Enter. */
function retype(text: string, value: string) {
    act(() => { (rowOf(text).querySelector('.tt-description') as HTMLElement).click(); });
    const input = host.querySelector<HTMLInputElement>('input.tt-edit-input')!;
    typeInto(input, value);
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
}

describe('a heading is never ticked, never timed, and a "# " label can go back to being an item', () => {
    it('"## x" typed over a TICKED item unticks it as it becomes a heading (a ticked one could never be dragged)', () => {
        const calls: string[] = [];
        onToggle.mockImplementation(() => { calls.push('untick'); });
        onEdit.mockImplementation(() => { calls.push('edit'); });
        render([task(1, 'Open item'), task(2, 'Done item', { is_completed: true })]);
        retype('Done item', '## Section');
        expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), false);
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), '## Section');
        expect(calls).toEqual(['untick', 'edit']);
    });

    it('POSITIVE CONTROL: "## x" over an OPEN item sends no untick', () => {
        render([task(1, 'Open item')]);
        retype('Open item', '## Section');
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '## Section');
        expect(onToggle).not.toHaveBeenCalled();
    });

    it('someone who may edit but not tick is told why, and nothing is written', () => {
        const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
        // Their own item (creator may edit), in a channel where they hold no
        // right to tick (myPerms 0).
        render([task(1, 'Open item'), task(2, 'Done item', { is_completed: true })], { myPerms: 0, currentUserId: 1 });
        retype('Done item', '## Section');
        expect(alert).toHaveBeenCalledTimes(1);
        expect(onEdit).not.toHaveBeenCalled();
        expect(onToggle).not.toHaveBeenCalled();
        // POSITIVE CONTROL: an open item of theirs still becomes a heading.
        retype('Open item', '## Section');
        expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), '## Section');
    });

    it('"Turn into item" on a heading whose label starts with "# " makes an ITEM of it, hash kept', () => {
        render([task(1, '## # of guests')]);
        act(() => { (titled(rowOf('# of guests'), 'Turn into item') as HTMLButtonElement).click(); });
        const saved = onEdit.mock.calls[0]?.[1] as string;
        expect(saved).toBe('#\u00a0of guests');
        expect(isHeadingText(saved)).toBe(false);
    });

    it('a heading that still has a time shows the one control that takes it off — and nothing else of time', () => {
        render([
            task(1, '## Calendar', { due_at: '2026-09-30T09:00:00Z' }),
            task(2, '## Standup', { due_at: '2026-09-30T09:00:00Z', schedule: '{"v":1}' }),
            task(3, '## Plain'),
            task(4, 'Timed item', { due_at: '2026-09-30T09:00:00Z' }),
        ]);
        act(() => { (titled(rowOf('Calendar'), 'Remove due time') as HTMLButtonElement).click(); });
        expect(onSetDue).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), null);
        expect(titled(rowOf('Calendar'), 'Edit due time')).toBeNull();
        act(() => { (titled(rowOf('Standup'), 'Remove date & repeat') as HTMLButtonElement).click(); });
        expect(onSetSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), null, null);
        // POSITIVE CONTROLS: a heading with no time has neither; an item
        // keeps its own editor and has no "Remove" button.
        for (const t of ['Remove due time', 'Remove date & repeat']) {
            expect(titled(rowOf('Plain'), t), `Plain: ${t}`).toBeNull();
            expect(titled(rowOf('Timed item'), t), `item: ${t}`).toBeNull();
        }
        expect(titled(rowOf('Timed item'), 'Edit due time')).not.toBeNull();
    });
});

describe("a selection of Púca's own list, pasted back", () => {
    it('keeps its headings: the rows read as the Markdown they are', () => {
        render([task(1, 'Pack'), task(2, '## Before you start'), task(3, 'Update the app'), task(4, '## Calls'), task(5, 'Join')]);
        // The clipboard as a browser writes a copied selection: the markup,
        // and a plain text with no marks at all.
        const html = `<html><body><!--StartFragment-->${host.querySelector('.task-tree')?.outerHTML ?? host.innerHTML}<!--EndFragment--></body></html>`;
        const plain = 'Pack\nBefore you start\nUpdate the app\nCalls\nJoin';
        expect(readPastedItems(plain, { html })?.items).toEqual(['Pack', '## Before you start', 'Update the app', '## Calls', 'Join']);
        // POSITIVE CONTROL: the plain text alone has no heading in it.
        expect(readPastedItems(plain)?.items).toEqual(['Pack', 'Before you start', 'Update the app', 'Calls', 'Join']);
    });
});
