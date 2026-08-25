/**
 * The virtual mouse pad's one hard obligation: never strand a button down on
 * the remote machine — and never lie about what is held. This codebase has
 * shipped stranded-input bugs twice in other paths (mode-switch with a finger
 * down, cancelled touches releasing buttons they never pressed), and the
 * pad's first review found two more shapes: a second finger on an already
 * held button releasing it early, and one scroll arrow's release killing the
 * repeat the other still-held arrow owned. All of those are pinned here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeviceStageVirtualMouse } from '../components/DeviceStageVirtualMouse';

let container: HTMLDivElement;
let root: Root;
let buttons: Array<[number, boolean]>;
let wheels: number[];

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    buttons = [];
    wheels = [];
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

const mount = () => act(() => root.render(
    <DeviceStageVirtualMouse
        onButton={(b, down) => buttons.push([b, down])}
        onWheel={dy => wheels.push(dy)}
    />,
));

const el = (label: string) => container.querySelector(`[aria-label="${label}"]`)!;
/** Dispatch with an explicit pointer id — the pad is a two-thumb surface and
 *  its state is keyed by pointer, so the tests must be able to be two fingers. */
const fire = (target: Element, type: string, pointerId = 1) =>
    act(() => {
        const ev = new Event(type, { bubbles: true });
        Object.defineProperty(ev, 'pointerId', { value: pointerId });
        target.dispatchEvent(ev);
    });

describe('DeviceStageVirtualMouse', () => {
    it('presses on pointer down, releases on pointer up — a physical mouse, not a click', () => {
        mount();
        fire(el('Left mouse button'), 'pointerdown');
        expect(buttons).toEqual([[0, true]]);       // held, not clicked
        fire(el('Left mouse button'), 'pointerup');
        expect(buttons).toEqual([[0, true], [0, false]]);

        fire(el('Right mouse button'), 'pointerdown');
        fire(el('Right mouse button'), 'pointerup');
        fire(el('Middle mouse button'), 'pointerdown');
        fire(el('Middle mouse button'), 'pointerup');
        expect(buttons.slice(2)).toEqual([[2, true], [2, false], [1, true], [1, false]]);
    });

    it('a cancelled pointer counts as a release', () => {
        mount();
        fire(el('Left mouse button'), 'pointerdown');
        fire(el('Left mouse button'), 'pointercancel');
        expect(buttons).toEqual([[0, true], [0, false]]);
        // And a cancel with nothing held releases nothing (the phantom-click
        // bug this repo has already shipped once in the touch path).
        fire(el('Right mouse button'), 'pointercancel');
        expect(buttons).toHaveLength(2);
    });

    it('a second finger on a held button neither re-presses nor releases early', () => {
        mount();
        fire(el('Left mouse button'), 'pointerdown', 1);
        fire(el('Left mouse button'), 'pointerdown', 2);   // brush with another finger
        expect(buttons).toEqual([[0, true]]);              // one press, not two
        fire(el('Left mouse button'), 'pointerup', 2);     // brushing finger lifts
        expect(buttons).toEqual([[0, true]]);              // finger 1 still holds it
        fire(el('Left mouse button'), 'pointerup', 1);
        expect(buttons).toEqual([[0, true], [0, false]]);  // last finger off releases
    });

    it('unmounting mid-hold releases what it pressed', () => {
        mount();
        fire(el('Left mouse button'), 'pointerdown');
        expect(buttons).toEqual([[0, true]]);
        act(() => root.unmount());
        expect(buttons).toEqual([[0, true], [0, false]]);
    });

    it('scroll taps once immediately, repeats on exact key-repeat pacing, stops on release', () => {
        vi.useFakeTimers();
        mount();
        fire(el('Scroll up'), 'pointerdown');
        expect(wheels).toEqual([120]);              // one notch, straight away

        // 350ms delay then one notch per 130ms: at t=615 exactly two repeats
        // have fired. An exact count, so a faster-or-slower mutation fails.
        act(() => { vi.advanceTimersByTime(615); });
        expect(wheels).toEqual([120, 120, 120]);

        fire(el('Scroll up'), 'pointerup');
        act(() => { vi.advanceTimersByTime(2000); });
        expect(wheels).toHaveLength(3);             // silence after release

        fire(el('Scroll down'), 'pointerdown');
        expect(wheels[wheels.length - 1]).toBe(-120);
        fire(el('Scroll down'), 'pointerup');
    });

    it('releasing one scroll arrow hands the repeat back to the other, still-held arrow', () => {
        vi.useFakeTimers();
        mount();
        fire(el('Scroll down'), 'pointerdown', 1);         // thumb holds down-arrow
        fire(el('Scroll up'), 'pointerdown', 2);           // index taps up-arrow
        fire(el('Scroll up'), 'pointerup', 2);             // ...and lifts
        expect(wheels).toEqual([-120, 120]);

        // The thumb never lifted: its repeat must resume, not freeze.
        act(() => { vi.advanceTimersByTime(615); });
        expect(wheels.slice(2)).toEqual([-120, -120]);

        fire(el('Scroll down'), 'pointerup', 1);
        act(() => { vi.advanceTimersByTime(2000); });
        expect(wheels).toHaveLength(4);
    });

    it('unmounting mid-scroll stops the repeat timers', () => {
        vi.useFakeTimers();
        mount();
        fire(el('Scroll up'), 'pointerdown');
        expect(wheels).toEqual([120]);
        act(() => root.unmount());
        act(() => { vi.advanceTimersByTime(2000); });
        expect(wheels).toEqual([120]);              // nothing after unmount
    });
});
