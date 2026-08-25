/**
 * useDragReorder's W4 perpendicular axis: the drop event carries the raw
 * crossDelta, state.crossSteps quantizes live by crossStepPx, and — the
 * regression that matters — a drop back at the task's OWN slot still commits
 * when an indent is engaged (a nest-in-place changes the tree without
 * changing the order).
 *
 * jsdom has no layout: rects are stubbed exactly as imageLightboxZoom does.
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useDragReorder, type DragDropEvent } from '../hooks/useDragReorder';

function Rig({ onDrop, step }: { onDrop: (e: DragDropEvent) => void; step?: number }) {
    const { setContainer, onPointerDown, state } = useDragReorder({
        axis: 'y', handleSelector: '.grip', touchHoldMs: 0, crossStepPx: step, onDrop,
    });
    return (
        <div ref={setContainer} onPointerDown={onPointerDown} data-testid="c" data-cross={state.crossSteps}>
            <div data-drag-key="1" data-drag-group="root"><span className="grip">::</span>one</div>
            <div data-drag-key="2" data-drag-group="root"><span className="grip">::</span>two</div>
        </div>
    );
}

let container: HTMLDivElement;
let root: Root;
const drops: DragDropEvent[] = [];

function stubRect(el: Element, x: number, y: number, w: number, h: number) {
    (el as HTMLElement).getBoundingClientRect = () =>
        ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} }) as DOMRect;
}

function mount(step?: number) {
    act(() => root.render(<Rig onDrop={e => drops.push(e)} step={step} />));
    const c = container.querySelector<HTMLElement>('[data-testid="c"]')!;
    const rows = [...container.querySelectorAll<HTMLElement>('[data-drag-key]')];
    stubRect(c, 0, 0, 300, 100);
    stubRect(rows[0], 0, 0, 300, 40);
    stubRect(rows[1], 0, 40, 300, 40);
    return { c, rows };
}

const fire = (target: EventTarget, type: string, x: number, y: number) =>
    act(() => {
        const ev = new Event(type, { bubbles: true });
        Object.defineProperty(ev, 'pointerId', { value: 1 });
        Object.defineProperty(ev, 'button', { value: 0 });
        Object.defineProperty(ev, 'clientX', { value: x });
        Object.defineProperty(ev, 'clientY', { value: y });
        target.dispatchEvent(ev);
    });

beforeEach(() => {
    drops.length = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('useDragReorder crossDelta', () => {
    it('the drop event carries the raw perpendicular travel; state quantizes it live', () => {
        const { c } = mount(24);
        const grip = container.querySelectorAll('.grip')[0]!;
        fire(grip, 'pointerdown', 10, 10);
        // Down past row 2's mid (60) AND 30px right: insertAt 1, one step.
        fire(window, 'pointermove', 40, 70);
        expect(c.getAttribute('data-cross')).toBe('1');
        fire(window, 'pointerup', 40, 70);
        expect(drops).toHaveLength(1);
        expect(drops[0]).toMatchObject({ key: '1', order: ['2'], insertAt: 1, crossDelta: 30 });
    });

    it('an indent at the SAME slot still commits — a nest-in-place is a real drop', () => {
        mount(24);
        const grip = container.querySelectorAll('.grip')[1]!;
        fire(grip, 'pointerdown', 10, 50);
        // Enough movement to start the drag, no slot change, 26px right.
        fire(window, 'pointermove', 36, 58);
        fire(window, 'pointerup', 36, 58);
        expect(drops).toHaveLength(1);
        expect(drops[0]).toMatchObject({ key: '2', insertAt: 1, crossDelta: 26 });
    });

    it('POSITIVE CONTROL of the old contract: no step configured, same-slot drop commits nothing', () => {
        mount(undefined);
        const grip = container.querySelectorAll('.grip')[1]!;
        fire(grip, 'pointerdown', 10, 50);
        fire(window, 'pointermove', 60, 58); // big cross travel, no quantum
        fire(window, 'pointerup', 60, 58);
        expect(drops).toHaveLength(0);
    });
});
