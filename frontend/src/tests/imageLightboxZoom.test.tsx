/**
 * ImageLightbox zoom — the DOM wiring on top of the pure imageZoom maths.
 *
 * Same fixture as imageZoom.test.ts: a 400x800 surface showing a 1000x500
 * picture (drawn 400x200 at offY 300). jsdom has no layout, no PointerEvent
 * and no pointer capture, so: geometry is stubbed on the elements, pointer
 * events are plain Events with the fields defined on them (the repo's
 * established trick, see deviceStageVirtualMouse.test.tsx), and the
 * component's optional-call capture is exactly what lets this run.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageLightbox } from '../components/ImageLightbox';

let container: HTMLDivElement;
let root: Root;
let onClose: Mock<() => void>;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn<() => void>();
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
});

function mount(): { surface: HTMLElement; canvas: HTMLElement; img: HTMLImageElement } {
    act(() => root.render(<ImageLightbox url="blob:x" name="pic.png" onClose={onClose} />));
    const surface = document.body.querySelector<HTMLElement>('.image-lightbox-surface')!;
    const canvas = document.body.querySelector<HTMLElement>('.image-lightbox-canvas')!;
    const img = document.body.querySelector<HTMLImageElement>('.image-lightbox img')!;
    // Layout stubs (jsdom has none): the surface box + the picture's letterbox.
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON() {} }) as DOMRect;
    Object.defineProperty(img, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'offsetHeight', { value: 200, configurable: true });
    Object.defineProperty(img, 'offsetLeft', { value: 0, configurable: true });
    Object.defineProperty(img, 'offsetTop', { value: 300, configurable: true });
    return { surface, canvas, img };
}

const fire = (target: Element, type: string, x: number, y: number, pointerId = 1) =>
    act(() => {
        const ev = new Event(type, { bubbles: true });
        Object.defineProperty(ev, 'pointerId', { value: pointerId });
        Object.defineProperty(ev, 'clientX', { value: x });
        Object.defineProperty(ev, 'clientY', { value: y });
        target.dispatchEvent(ev);
    });

const tap = (target: Element, x: number, y: number, id = 1) => {
    fire(target, 'pointerdown', x, y, id);
    fire(target, 'pointerup', x, y, id);
};

describe('ImageLightbox zoom', () => {
    it('a double-tap on the picture zooms in at the tapped point', () => {
        const { canvas, img } = mount();
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');

        tap(img, 200, 400);
        tap(img, 200, 400);
        // Same numbers as the pure test: x = 200 − 200·2.5 = −300; y underfills → centred at −600.
        expect(canvas.style.transform).toBe('translate(-300px, -600px) scale(2.5)');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('a third double-tap returns to fit', () => {
        const { canvas, img } = mount();
        tap(img, 200, 400); tap(img, 200, 400);
        expect(canvas.style.transform).toContain('scale(2.5)');
        tap(img, 50, 400); tap(img, 50, 400);
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
    });

    it('two taps 400 ms apart are two single taps, not a zoom', () => {
        vi.useFakeTimers();
        const { canvas, img } = mount();
        tap(img, 200, 400);
        vi.advanceTimersByTime(400);
        tap(img, 200, 400);
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
    });

    it('a backdrop tap closes at fit but NOT while zoomed', () => {
        const { surface, img } = mount();
        // On the picture: never closes.
        tap(img, 200, 400);
        expect(onClose).not.toHaveBeenCalled();
        // On the backdrop at fit: closes (today's behaviour).
        vi.useFakeTimers(); vi.advanceTimersByTime(1000); // outside the double-tap window
        tap(surface, 20, 20);
        expect(onClose).toHaveBeenCalledTimes(1);

        // Zoom in, then a backdrop tap must NOT close.
        vi.advanceTimersByTime(1000);
        tap(img, 200, 400); tap(img, 200, 400);
        vi.advanceTimersByTime(1000);
        tap(surface, 20, 20);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('a drag is not a tap: panning never closes the viewer', () => {
        const { surface, canvas, img } = mount();
        // Drag on the backdrop at fit (nothing to pan, but still not a tap).
        fire(surface, 'pointerdown', 100, 100);
        fire(surface, 'pointermove', 200, 140);
        fire(surface, 'pointerup', 200, 140);
        expect(onClose).not.toHaveBeenCalled();

        // Zoomed: a one-finger drag pans, clamped to the picture.
        tap(img, 200, 400); tap(img, 200, 400);
        expect(canvas.style.transform).toBe('translate(-300px, -600px) scale(2.5)');
        fire(img, 'pointerdown', 200, 400);
        fire(img, 'pointermove', 250, 400); // +50 → x −250
        fire(img, 'pointerup', 250, 400);
        expect(canvas.style.transform).toBe('translate(-250px, -600px) scale(2.5)');
        fire(img, 'pointerdown', 200, 400);
        fire(img, 'pointermove', 900, 400); // way past the near edge → clamped to 0
        fire(img, 'pointerup', 900, 400);
        expect(canvas.style.transform).toBe('translate(0px, -600px) scale(2.5)');
        expect(onClose).not.toHaveBeenCalled();
    });

    it('two fingers pinch about their midpoint', () => {
        const { img, canvas } = mount();
        fire(img, 'pointerdown', 150, 400, 1);
        fire(img, 'pointerdown', 250, 400, 2);   // dist 100, centre (200,400)
        fire(img, 'pointermove', 100, 400, 1);   // dist 150
        fire(img, 'pointermove', 300, 400, 2);   // dist 200 → 2x about (200,400)
        fire(img, 'pointerup', 100, 400, 1);
        fire(img, 'pointerup', 300, 400, 2);
        // 2x about (200,400): x = 200 − 200·2 = −200; y underfills → (800−400)/2 − 2·300 = −400.
        expect(canvas.style.transform).toBe('translate(-200px, -400px) scale(2)');
        expect(onClose).not.toHaveBeenCalled(); // a pinch is never a tap
    });

    it('lightbox touches do not reach the app around it (the panel-swipe leak)', () => {
        const outer = vi.fn();
        act(() => root.render(
            <div onTouchStart={outer} onTouchEnd={outer}>
                <ImageLightbox url="blob:x" onClose={onClose} />
            </div>,
        ));
        const img = document.body.querySelector<HTMLImageElement>('.image-lightbox img')!;
        act(() => { img.dispatchEvent(new Event('touchstart', { bubbles: true })); });
        act(() => { img.dispatchEvent(new Event('touchend', { bubbles: true })); });
        // React portals propagate through the REACT tree, so without the
        // stopPropagation on the overlay root this spy would fire.
        expect(outer).not.toHaveBeenCalled();
    });

    it('two pinch moves in ONE frame both accumulate (functional updates, not the lagging ref)', () => {
        // Same pinch as above but with no act() boundary between the two
        // moves — that boundary is the only reason a value-form setT against a
        // passive-effect-synced ref would have looked right. Two fingers emit
        // two moves per frame in a real browser.
        const { img, canvas } = mount();
        fire(img, 'pointerdown', 150, 400, 1);
        fire(img, 'pointerdown', 250, 400, 2);
        act(() => {
            for (const [x, id] of [[100, 1], [300, 2]] as const) {
                const ev = new Event('pointermove', { bubbles: true });
                Object.defineProperty(ev, 'pointerId', { value: id });
                Object.defineProperty(ev, 'clientX', { value: x });
                Object.defineProperty(ev, 'clientY', { value: 400 });
                img.dispatchEvent(ev);
            }
        });
        // 100→150→200 px: 1.5x then 4/3x → 2x, NOT 1.333x.
        expect(canvas.style.transform).toBe('translate(-200px, -400px) scale(2)');
    });

    it('a third finger lifting back to two re-baselines the pinch instead of jumping', () => {
        const { img, canvas } = mount();
        fire(img, 'pointerdown', 150, 400, 1);
        fire(img, 'pointerdown', 250, 400, 2);   // baseline dist 100
        fire(img, 'pointerdown', 200, 700, 3);   // third finger: pinch pauses
        fire(img, 'pointermove', 100, 400, 1);   // three fingers down → no zoom (1 now at 100, 2 at 250)
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
        fire(img, 'pointerup', 200, 700, 3);     // back to two: baseline is the SURVIVORS' dist, 150
        // A move that keeps the survivors' distance must not zoom.
        fire(img, 'pointermove', 100, 400, 1);
        expect(canvas.style.transform).toBe('translate(0px, 0px) scale(1)');
        // Spreading the survivors 150 → 300 is exactly 2x. Against the STALE
        // baseline of 100 it would read as 3x — that is the jump.
        fire(img, 'pointermove', 400, 400, 2);
        expect(canvas.style.transform).toContain('scale(2)');
        expect(canvas.style.transform).not.toContain('scale(3)');
    });

    it('a right-click on the backdrop does not close the viewer', () => {
        const { surface } = mount();
        act(() => {
            for (const type of ['pointerdown', 'pointerup']) {
                const ev = new Event(type, { bubbles: true });
                Object.defineProperty(ev, 'pointerId', { value: 1 });
                Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
                Object.defineProperty(ev, 'button', { value: 2 });
                Object.defineProperty(ev, 'clientX', { value: 20 });
                Object.defineProperty(ev, 'clientY', { value: 20 });
                surface.dispatchEvent(ev);
            }
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('ctrl+wheel zooms in line-mode browsers too (Firefox reports deltaMode 1)', () => {
        const { surface, canvas } = mount();
        const wheel = (deltaY: number, deltaMode: number) => act(() => {
            const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY, deltaMode, clientX: 200, clientY: 400 });
            surface.dispatchEvent(ev);
        });
        wheel(-3, 1); // one Firefox notch up = 3 lines ≈ 48 px
        const lines = canvas.style.transform;
        expect(lines).not.toBe('translate(0px, 0px) scale(1)');
        // The same physical notch in pixel mode (Chromium: ~48-100 px) lands in the same ballpark, not 16x apart.
        act(() => root.unmount());
        root = createRoot(container);
        const again = mount();
        act(() => {
            again.surface.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -48, deltaMode: 0, clientX: 200, clientY: 400 }));
        });
        expect(again.canvas.style.transform).toBe(lines);
    });

    /**
     * A TOUCH EVENT IS ONE STEP, not one per finger (components/deviceStagePinch.ts,
     * which the remote-control stage got in 0.9.864). The browser hands one touch
     * event to the page as a pointermove PER FINGER, all carrying the event's
     * timeStamp, and the viewer stepped the gesture on each: between the two it
     * saw a pinch the hand never made, and the zoom floor and the pan clamp acted
     * on it.
     */
    describe('two fingers, one touch event at a time', () => {
        /** One finger's pointer event, as part of a touch event stamped `at`. */
        const finger = (target: Element, type: string, id: number, x: number, y: number, at: number) => {
            const ev = new Event(type, { bubbles: true });
            Object.defineProperty(ev, 'pointerId', { value: id });
            Object.defineProperty(ev, 'pointerType', { value: 'touch' });
            Object.defineProperty(ev, 'clientX', { value: x });
            Object.defineProperty(ev, 'clientY', { value: y });
            Object.defineProperty(ev, 'timeStamp', { value: at });
            target.dispatchEvent(ev);
        };
        const view = (canvas: HTMLElement) => {
            const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(canvas.style.transform)!;
            return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
        };

        /** Two fingers 60 px apart, side by side at y 400, carried `steps` x
         *  `dx` px sideways, each step ONE touch event: `first` (1 the left
         *  finger, 2 the right) handed over first. One act per event, as a
         *  frame is. */
        function slide(surface: HTMLElement, first: 1 | 2, steps: number, dx: number, startAt = 1000) {
            const p = { 1: 100, 2: 160 };
            act(() => {
                finger(surface, 'pointerdown', 1, p[1], 400, startAt);
                finger(surface, 'pointerdown', 2, p[2], 400, startAt);
            });
            for (let i = 1; i <= steps; i++) {
                const at = startAt + 16 * i;
                act(() => {
                    for (const id of first === 1 ? [1, 2] as const : [2, 1] as const) {
                        finger(surface, 'pointermove', id, p[id] + dx * i, 400, at);
                    }
                });
            }
            const end = startAt + 16 * (steps + 1);
            act(() => {
                finger(surface, 'pointerup', 1, p[1] + dx * steps, 400, end);
                finger(surface, 'pointerup', 2, p[2] + dx * steps, 400, end);
            });
        }

        /** Zoomed x2.5 by a double-tap at (200, 400): x = -300, the picture's
         *  left edge 300 px off to the left (x 0 puts it on the screen's). */
        function zoomedIn() {
            const m = mount();
            tap(m.img, 200, 400); tap(m.img, 200, 400);
            expect(m.canvas.style.transform, 'precondition').toBe('translate(-300px, -600px) scale(2.5)');
            return m;
        }

        it('a two-finger pan into an edge ENDS on it when the finger closing the gap is handed over first', () => {
            const { surface, canvas } = zoomedIn();
            slide(surface, 1, 15, 25);   // 375 px right; the edge is 300 px away
            const t = view(canvas);
            expect(t.scale, 'a pan, not a zoom').toBeCloseTo(2.5, 9);
            expect(t.x, 'the picture\'s left edge on the screen\'s, not short of it').toBe(0);
            expect(onClose).not.toHaveBeenCalled();
        });

        it('CONTROL: the far finger handed over first reaches the edge too (it did before as well)', () => {
            const { surface, canvas } = zoomedIn();
            slide(surface, 2, 15, 25);
            expect(view(canvas).x).toBe(0);
            expect(view(canvas).scale).toBeCloseTo(2.5, 9);
        });

        it('away from the edge the picture goes with the fingers, whichever is handed over first', () => {
            const a = zoomedIn();
            slide(a.surface, 1, 4, 25);
            const left = view(a.canvas);
            act(() => root.unmount());
            root = createRoot(container);
            const b = zoomedIn();
            slide(b.surface, 2, 4, 25);
            const right = view(b.canvas);
            expect(left.x).toBeCloseTo(-200, 9);
            expect(right.x).toBeCloseTo(-200, 9);
            expect(left.scale).toBeCloseTo(2.5, 9);
        });

        it('a slide of a picture zoomed a little keeps its zoom (the half-step does not hit the floor)', () => {
            const { surface, canvas } = mount();
            // Pinch out to x1.05: the right finger 3 px further out.
            act(() => {
                finger(surface, 'pointerdown', 1, 100, 400, 500);
                finger(surface, 'pointerdown', 2, 160, 400, 500);
            });
            act(() => finger(surface, 'pointermove', 2, 163, 400, 516));
            act(() => {
                finger(surface, 'pointerup', 1, 100, 400, 532);
                finger(surface, 'pointerup', 2, 163, 400, 532);
            });
            expect(view(canvas).scale, 'precondition').toBeCloseTo(1.05, 9);
            // Two fingers again, 60 px apart, one sideways step, the left finger
            // first: 35 px apart between its move and the right one's.
            slide(surface, 1, 1, 25);
            expect(view(canvas).scale, 'a sideways slide is no zoom').toBeCloseTo(1.05, 9);
        });
    });

    it('positive control: without a portal barrier, React DOES bubble touch through the tree', () => {
        const outer = vi.fn();
        act(() => root.render(
            <div onTouchStart={outer}>
                <div className="inner" />
            </div>,
        ));
        const inner = container.querySelector('.inner')!;
        act(() => { inner.dispatchEvent(new Event('touchstart', { bubbles: true })); });
        expect(outer).toHaveBeenCalledTimes(1);
    });
});
