/**
 * "An item is due" has to land on WHICH item. Tapping the notification parks
 * the item's id, Reminders flashes that one row and scrolls it into view, and
 * the note opens behind it.
 *
 * This is the Reminders half of that tap — the half that shows before the
 * notes have loaded, and the only thing the user sees at all when the id is
 * stale (completed, deleted, in a note this account lost). It has to hit the
 * matching row in WHICHEVER group holds it, and no other row anywhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', () => ({ currentUserIdFromToken: () => 7 }));
vi.mock('../notes/native/PlaceReminders', () => ({ PlaceReminders: () => null }));

const { RemindersView } = await import('../notes/components/RemindersView');

function item(id: number, offsetMs: number) {
    const due = new Date(Date.now() + offsetMs).toISOString();
    const note = { key: `list:${id}`, ref: { kind: 'list', id }, title: `Note ${id}` } as never;
    const task = { id, description: `Item ${id}`, due_at: due, created_by: 7, is_completed: false } as never;
    return { task, note, at: Date.parse(due) };
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
// jsdom has no layout and so no scrollIntoView at all; every render here
// would throw out of the effect without one. A recorder stands in, and the
// environment is put back exactly as it was.
const noScroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
let scrolled: string[] = [];
beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this.id); };
});
afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    if (noScroll) Object.defineProperty(Element.prototype, 'scrollIntoView', noScroll);
    else delete (Element.prototype as Partial<Element>).scrollIntoView;
});

// ids 1/2 overdue, 3/4 today, 5/6 upcoming — one flashed, one control, per group.
const GROUPS = {
    overdue: [item(1, -3 * 3600_000), item(2, -2 * 3600_000)],
    today: [item(3, 2 * 3600_000), item(4, 3 * 3600_000)],
    upcoming: [item(5, 3 * 86_400_000), item(6, 4 * 86_400_000)],
};

function render(flashTaskId: number | null): HTMLElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
        <RemindersView groups={GROUPS} actions={{ toggleTask: vi.fn() } as never} now={Date.now()}
            onOpen={vi.fn()} notificationsState="granted" onEnableNotifications={vi.fn()}
            flashTaskId={flashTaskId} />,
    ));
    return host;
}

const flashed = (c: HTMLElement) => [...c.querySelectorAll('.notes-reminder-row.flash')].map(r => r.id);

describe('the row a due notification came for', () => {
    it.each([
        ['overdue', 1],
        ['today', 3],
        ['upcoming', 5],
    ])('flashes in %s, and nowhere else', (_group, id) => {
        const c = render(id);
        expect(c.querySelectorAll('.notes-reminder-row')).toHaveLength(6);
        expect(flashed(c)).toEqual([`notes-reminder-${id}`]);
    });

    it('flashes NOTHING when no notification named an item (control)', () => {
        const c = render(null);
        expect(c.querySelectorAll('.notes-reminder-row')).toHaveLength(6);
        expect(flashed(c)).toEqual([]);
    });

    it('flashes nothing for an id Reminders is not showing', () => {
        const c = render(999);
        expect(flashed(c)).toEqual([]);
    });

    it('every row carries its own anchor id, flashed or not', () => {
        const c = render(3);
        expect([...c.querySelectorAll('.notes-reminder-row')].map(r => r.id))
            .toEqual([1, 2, 3, 4, 5, 6].map(n => `notes-reminder-${n}`));
    });

    it('scrolls the flashed row into view, and only that row', () => {
        const c = render(5);
        expect(scrolled).toEqual(['notes-reminder-5']);
        expect(flashed(c)).toEqual(['notes-reminder-5']);
    });

    it('scrolls nothing when no notification named an item (control)', () => {
        render(null);
        expect(scrolled).toEqual([]);
    });
});
