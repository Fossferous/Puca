/**
 * Drag to reorder in the note grid.
 *
 * The pointer mechanics belong to useDragReorder and are tested there; this
 * mocks the hook, captures the options NoteGrid hands it, and drives the drop
 * directly (the tasksViewTrashSlots.test.tsx pattern). What is under test is
 * the wiring that can ship broken and look fine:
 *
 *  - the two sections are two SEPARATE hook instances with separate groups, so
 *    a card can never be dragged from Others into Pinned — nothing visible
 *    would change while Púca's tab bar was silently rewritten;
 *  - a drop reaches the owner as the section's new VISIBLE order;
 *  - drag is off wherever the layout is masonry (grid view on a fine pointer),
 *    the order is not the saved one, or a search is running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type DropEvent = { key: string; group: string; order: string[]; insertAt: number; crossDelta: number; sameSlot: boolean };
type Opts = { axis: string; handleSelector?: string; touchHoldMs?: number; enabled?: boolean; onDrop: (e: DropEvent) => void };

const drag = vi.hoisted(() => ({ calls: [] as Opts[] }));
vi.mock('../hooks/useDragReorder', () => ({
    useDragReorder: (opts: Opts) => {
        drag.calls.push(opts);
        return { state: { dragging: null, indicator: null, crossSteps: 0, order: [], insertAt: 0 }, setContainer: () => {}, onPointerDown: () => {} };
    },
}));

import { NoteGrid } from '../notes/components/NoteGrid';
import { canDragReorder, canReorder, type NoteCard, type NoteFilter } from '../notes/model/notesModel';
import type { NoteActions } from '../notes/model/notesQueries';

const card = (id: number, pinned = false): NoteCard => ({
    key: `list:${id}`, ref: { kind: 'list', id }, title: `Note ${id}`, tasks: [], pinned,
    color: 'default', labels: [], archived: false, total: 0, completed: 0,
}) as unknown as NoteCard;

const PINNED = [card(1, true), card(2, true)];
const OTHERS = [card(3), card(4), card(5)];

const actions = { content: { trashEnabled: false } } as unknown as NoteActions;
const ALL: NoteFilter = { kind: 'all' };

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onDropReorder = vi.fn();

function mount(props: Partial<React.ComponentProps<typeof NoteGrid>> = {}) {
    act(() => {
        root!.render(
            <NoteGrid
                pinned={PINNED}
                others={OTHERS}
                filter={ALL}
                view="list"
                loading={false}
                actions={actions}
                now={0}
                compactTools={false}
                onOpen={() => {}}
                onMenu={() => {}}
                onPickColor={() => {}}
                onPickLabels={() => {}}
                onLabelClick={() => {}}
                onArchive={() => {}}
                registerEl={() => {}}
                canDrag
                onDropReorder={onDropReorder}
                {...props}
            />,
        );
    });
}

/** The hook instances, in NoteGrid's call order: pinned first, then others. */
const pinnedOpts = () => drag.calls[drag.calls.length - 2];
const othersOpts = () => drag.calls[drag.calls.length - 1];

beforeEach(() => {
    drag.calls.length = 0;
    onDropReorder.mockClear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
});

describe('NoteGrid drag to reorder', () => {
    it('marks each card with its own SECTION as the drag group', () => {
        mount();
        const groups = [...document.querySelectorAll<HTMLElement>('[data-drag-key]')]
            .map(el => `${el.dataset.dragKey}:${el.dataset.dragGroup}`);
        expect(groups).toEqual([
            'list:1:pinned', 'list:2:pinned',
            'list:3:others', 'list:4:others', 'list:5:others',
        ]);
        // Two instances, not one shared group: a cross-section drop is
        // unrepresentable rather than merely discouraged.
        expect(drag.calls.length).toBe(2);
        expect(pinnedOpts()).not.toBe(othersOpts());
    });

    it('drags from the GRIP only, with no touch hold', () => {
        mount();
        expect(othersOpts().handleSelector).toBe('.notes-card-grip');
        expect(othersOpts().touchHoldMs).toBe(0);
        expect(document.querySelectorAll('.notes-card-grip').length).toBe(5);
    });

    it('a drop hands the owner the section and its new visible order', () => {
        mount();
        // Dragged list:5 to the front of Others: the hook reports the group
        // WITHOUT the dragged key, plus where it landed.
        act(() => {
            othersOpts().onDrop({ key: 'list:5', group: 'others', order: ['list:3', 'list:4'], insertAt: 0, crossDelta: 0, sameSlot: false });
        });
        expect(onDropReorder).toHaveBeenCalledTimes(1);
        expect(onDropReorder.mock.calls[0]).toEqual(['others', ['list:5', 'list:3', 'list:4']]);
    });

    it('a drop in the pinned section names the pinned section', () => {
        mount();
        act(() => {
            pinnedOpts().onDrop({ key: 'list:1', group: 'pinned', order: ['list:2'], insertAt: 1, crossDelta: 0, sameSlot: false });
        });
        expect(onDropReorder.mock.calls[0]).toEqual(['pinned', ['list:2', 'list:1']]);
    });

    it('a one-card section cannot drag (nothing to reorder it among)', () => {
        mount({ pinned: [card(1, true)] });
        expect(pinnedOpts().enabled).toBe(false);
        expect(othersOpts().enabled).toBe(true);
        expect(document.querySelectorAll('[data-drag-group="pinned"]').length).toBe(0);
        expect(document.querySelectorAll('.notes-card-grip').length).toBe(3);
    });

    it('canDrag false means no hook, no grip, no drag attributes', () => {
        mount({ canDrag: false });
        expect(pinnedOpts().enabled).toBe(false);
        expect(othersOpts().enabled).toBe(false);
        expect(document.querySelectorAll('.notes-card-grip').length).toBe(0);
        expect(document.querySelectorAll('[data-drag-key]').length).toBe(0);
    });
});

describe('a press on the GRIP is a drag, never a selection', () => {
    // Android fires `contextmenu` after ~500 ms of a still finger. The grip
    // cancels the long-press TIMER, but that left the contextmenu route wide
    // open: useDragReorder only swallows contextmenu once a drag is live, and
    // a drag needs 5px of movement a press-and-hold has not made. Holding the
    // grip therefore opened a bulk selection nobody asked for.
    const onSelect = vi.fn();
    /** React reads pointerType/pointerId off the NATIVE event; jsdom's
     *  PointerEvent is not wired to React's synthetic pointer events, so a
     *  MouseEvent with a PointerEvent-shaped init is the idiom here. */
    const touch = (type: string) => {
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 10, clientY: 10 });
        Object.assign(ev, { pointerType: 'touch', pointerId: 1, isPrimary: true });
        return ev;
    };
    beforeEach(() => { onSelect.mockClear(); vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    const firstCard = () => document.querySelector<HTMLElement>('[data-drag-group="others"]')!;

    it('holding the grip opens no selection, by either route', () => {
        mount({ onSelect, selected: new Set<string>() });
        const card = firstCard();
        const grip = card.querySelector<HTMLElement>('.notes-card-grip')!;
        act(() => { grip.dispatchEvent(touch('pointerdown')); });
        act(() => { vi.advanceTimersByTime(900); });
        expect(onSelect).not.toHaveBeenCalled();          // the timer was cancelled
        act(() => { card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
        expect(onSelect).not.toHaveBeenCalled();          // ...and so is the contextmenu
    });

    it('POSITIVE CONTROL: the same hold on the card BODY does open one', () => {
        mount({ onSelect, selected: new Set<string>() });
        const card = firstCard();
        const title = card.querySelector<HTMLElement>('.notes-card-title')!;
        act(() => { title.dispatchEvent(touch('pointerdown')); });
        // The contextmenu route alone, before the timer could fire: this is
        // the path Android takes, and it must still reach the selection.
        act(() => { card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
        expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it('POSITIVE CONTROL: a grip press RELEASED frees the next press on the body', () => {
        mount({ onSelect, selected: new Set<string>() });
        const card = firstCard();
        act(() => { card.querySelector<HTMLElement>('.notes-card-grip')!.dispatchEvent(touch('pointerdown')); });
        act(() => { card.dispatchEvent(touch('pointerup')); });
        act(() => { card.querySelector<HTMLElement>('.notes-card-title')!.dispatchEvent(touch('pointerdown')); });
        act(() => { card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
        expect(onSelect).toHaveBeenCalledTimes(1);
    });
});

describe('when reordering is offered at all', () => {
    it('the menu offers Move only against the saved order and outside a search', () => {
        expect(canReorder('puca', 'all')).toBe(true);
        expect(canReorder('puca', 'label')).toBe(true);
        expect(canReorder('puca', 'archive')).toBe(true);
        expect(canReorder('puca', 'search')).toBe(false);
        expect(canReorder('title', 'all')).toBe(false);
        expect(canReorder('edited', 'all')).toBe(false);
        expect(canReorder('created', 'all')).toBe(false);
    });

    it('drag needs a one-column layout on top of that', () => {
        // list view: one column on any pointer.
        expect(canDragReorder('puca', 'all', 'list', false)).toBe(true);
        // grid view on a fine pointer is MASONRY — a y-axis drag is meaningless.
        expect(canDragReorder('puca', 'all', 'grid', false)).toBe(false);
        // ...but on a phone notes.css forces one column in BOTH views.
        expect(canDragReorder('puca', 'all', 'grid', true)).toBe(true);
        // and the saved-order/search rules still apply on a phone.
        expect(canDragReorder('puca', 'search', 'grid', true)).toBe(false);
        expect(canDragReorder('title', 'all', 'list', true)).toBe(false);
    });
});
