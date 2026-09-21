/**
 * A due item in a SHARED note that someone else created reminds whoever set
 * it (GET /task-reminders covers only the caller's own channel tasks), and
 * the Reminders row says so — as a second line under the item, not a third
 * muted column squeezing the row at 390 px. The own-item and personal-note
 * rows are the controls: no hint there.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));
vi.mock('../notes/native/PlaceReminders', () => ({ PlaceReminders: () => null }));

const { RemindersView } = await import('../notes/components/RemindersView');

const due = new Date(Date.now() + 3 * 3600_000).toISOString();
function item(id: number, kind: 'channel' | 'list', createdBy: number) {
    const note = { key: `${kind}:${id}`, ref: { kind, id }, title: `Note ${id}` } as never;
    const task = { id, description: `Item ${id}`, due_at: due, created_by: createdBy, is_completed: false } as never;
    // `kind` since migration 068: a reminder row is an ITEM, or a note's own.
    return { kind: 'task' as const, task, note, at: Date.parse(due) };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
});

function renderRows(): { container: HTMLElement } {
    const groups = {
        overdue: [],
        today: [],
        upcoming: [item(1, 'channel', 99), item(2, 'channel', 7), item(3, 'list', 99)],
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <RemindersView groups={groups} actions={{ toggleTask: vi.fn() } as never} now={Date.now()}
            onOpen={vi.fn()} notificationsState="granted" onEnableNotifications={vi.fn()} />,
    ));
    return { container: host };
}

describe('"Reminds whoever set it"', () => {
    it('sits under the item text of a shared item someone else set, and nowhere else', () => {
        const { container } = renderRows();
        const rows = [...container.querySelectorAll('.notes-reminder-row')];
        expect(rows).toHaveLength(3);
        const hint = (row: Element) => row.querySelector('.notes-reminder-text .notes-reminder-sub')?.textContent ?? null;
        expect(hint(rows[0])).toBe('Reminds whoever set it');
        expect(hint(rows[1])).toBeNull(); // shared, but mine
        expect(hint(rows[2])).toBeNull(); // personal note
        // a second line inside the text cell, not an extra flex column
        for (const r of rows) expect(r.children).toHaveLength(4);
    });
});
