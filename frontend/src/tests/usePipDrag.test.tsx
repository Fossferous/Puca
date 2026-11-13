import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { usePipDrag } from '../components/usePipDrag';

/**
 * The self-view's drag (components/usePipDrag.ts, used by VoicePanel's camera
 * window). The window holds the Flip button, which keeps its touchstart to
 * itself; its touchmove used to reach the window's drag handler, measured from
 * a start point left over from an earlier drag (or the top-left corner), and
 * one slightly moving press on Flip threw the window across the screen.
 * Raw react-dom/client + act, as the repo's other component tests.
 */

let lastTap: boolean | null = null;

function SelfView() {
    const drag = usePipDrag({ x: 20, y: 100 });
    return (
        <div
            data-testid="pip"
            data-x={drag.position.x}
            data-y={drag.position.y}
            data-dragging={String(drag.isDragging)}
            {...drag.handlers}
        >
            <button type="button" data-testid="open" onClick={(e) => { lastTap = drag.isTap(e); }}>open</button>
            {/* Flip, as it was before this fix: only its touchstart kept to itself. */}
            <button type="button" data-testid="flip" onTouchStart={(e) => e.stopPropagation()}>flip</button>
        </div>
    );
}

let host: HTMLDivElement;
let root: Root;
const el = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const at = () => ({ x: Number(el('pip').dataset.x), y: Number(el('pip').dataset.y) });

/** A touch event as a finger makes it: bubbling, with its touch list. */
function touchEv(target: HTMLElement, type: 'touchstart' | 'touchmove' | 'touchend', x?: number, y?: number) {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const list = x === undefined ? [] : [{ clientX: x, clientY: y, identifier: 0, target }];
    Object.defineProperty(e, 'touches', { value: list });
    Object.defineProperty(e, 'changedTouches', { value: list });
    act(() => { target.dispatchEvent(e); });
}
function press(target: HTMLElement, path: Array<[number, number]>) {
    touchEv(target, 'touchstart', ...path[0]);
    for (const [x, y] of path.slice(1)) touchEv(target, 'touchmove', x, y);
    touchEv(target, 'touchend');
}
function click(target: HTMLElement, detail: number) {
    act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail })); });
}
function mouse(target: HTMLElement | Document, type: string, x = 0, y = 0) {
    act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y })); });
}

beforeEach(() => {
    lastTap = null;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => { root.render(<SelfView />); });
});
afterEach(() => {
    act(() => { root.unmount(); });
    host.remove();
});

describe('the self-view drag', () => {
    it('a drag on the window moves it by as much as the finger moved', () => {
        press(el('pip'), [[50, 150], [90, 230]]);
        expect(at()).toEqual({ x: 60, y: 180 });
        expect(el('pip').dataset.dragging).toBe('false');
    });

    it('THE BUG: a press on Flip that moves a little does not move the window, with no drag before it or after one', () => {
        // No drag before: the old start point was the top-left corner.
        press(el('flip'), [[120, 130], [122, 131]]);
        expect(at(), 'a press on Flip moved the window').toEqual({ x: 20, y: 100 });
        // A drag first, then Flip far from where that drag began.
        press(el('pip'), [[50, 150], [70, 170]]);
        expect(at()).toEqual({ x: 40, y: 120 });
        press(el('flip'), [[300, 600], [302, 601]]);
        expect(at(), 'a press on Flip moved the window').toEqual({ x: 40, y: 120 });
    });

    it('a press that does not move is a tap; the click that ends a drag is not', () => {
        press(el('open'), [[60, 180], [63, 182]]); // within the slop
        click(el('open'), 1);
        expect(lastTap).toBe(true);
        press(el('open'), [[60, 180], [120, 260]]);
        click(el('open'), 1);
        expect(lastTap).toBe(false);
        expect(at()).toEqual({ x: 80, y: 180 });
    });

    it('a short drag the browser still counts as a tap (it then sends mousedown, mouseup and click) moves the window and does NOT open the menu', () => {
        press(el('open'), [[60, 180], [72, 180]]); // 12 px: past the slop, within an engine's tap tolerance
        expect(at()).toEqual({ x: 32, y: 100 });
        mouse(el('open'), 'mousedown', 72, 180);
        mouse(document, 'mouseup', 72, 180);
        click(el('open'), 1);
        expect(lastTap, 'the drag also opened the menu').toBe(false);
    });

    it("a key's press (a click with detail 0) after a drag that ended with no click of its own is still a press", () => {
        press(el('pip'), [[50, 150], [120, 240]]);
        click(el('open'), 0);
        expect(lastTap, 'Enter on the self-view was swallowed').toBe(true);
    });

    it('a mouse drag moves it (the listeners go with the press), and a press that never moved is a tap', () => {
        mouse(el('pip'), 'mousedown', 50, 150);
        mouse(document, 'mousemove', 150, 150);
        mouse(document, 'mouseup');
        expect(at()).toEqual({ x: 120, y: 100 });
        mouse(el('open'), 'mousedown', 60, 160);
        mouse(document, 'mouseup');
        click(el('open'), 1);
        expect(lastTap).toBe(true);
    });
});
