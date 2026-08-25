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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ImageLightbox } from '../components/ImageLightbox';

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
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
