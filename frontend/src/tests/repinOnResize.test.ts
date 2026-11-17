/**
 * components/repinOnResize.ts: the message list follows its newest message
 * when its geometry changes, and ONLY then — a change that moves nothing must
 * not pull back a reader who has just scrolled up a little (within Chat.tsx's
 * AT_BOTTOM_SLOP). Measured 2026-10-05: every wheel notch up from the bottom
 * of a channel of videos was undone, because a video at the edge of the
 * loaded zone swapped its placeholder (same height) as the reader scrolled.
 *
 * The geometry is the content's height AND the list's own height: on a phone
 * the keyboard, a line more in the message box and the typing indicator shrink
 * the list from the bottom while scrollTop stays, and the newest message slid
 * under the box (2026-11-16: 254 px under the Android app's keyboard, 22 px a
 * line of the box, 31 px for the typing indicator).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { repinOnResize, scrollToEnd } from '../components/repinOnResize';

/** A scroller as the browser keeps it: scrollTop never past its bottom. */
function list(scrollHeight: number, clientHeight: number, scrollTop: number) {
    let top = scrollTop;
    const el = {
        scrollHeight,
        clientHeight,
        get scrollTop() { return top; },
        set scrollTop(v: number) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); },
        get fromBottom() { return el.scrollHeight - el.clientHeight - top; },
    };
    return el;
}

describe('repinOnResize', () => {
    it('a change that moves nothing leaves a reader who scrolled up a little where they are', () => {
        const el = list(3000, 700, 2300);
        const repin = repinOnResize(el, () => true); // still within the slop: "at the bottom"
        el.scrollTop = 2220; // one wheel notch up
        repin(); // a row's placeholder swapped, same height
        expect(el.scrollTop).toBe(2220);
    });

    it('content that grows keeps a list at the bottom pinned to it', () => {
        const el = list(3000, 700, 2300);
        const repin = repinOnResize(el, () => true);
        el.scrollHeight = 3300;
        repin();
        expect(el.fromBottom).toBe(0);
        // Grown once: the next change that moves nothing does not pin again.
        el.scrollTop = 2500;
        repin();
        expect(el.scrollTop).toBe(2500);
    });

    it('the list shrinking from the bottom (keyboard, a line more in the box, the typing indicator) keeps it at the newest message', () => {
        const el = list(3000, 622, 2378);
        const repin = repinOnResize(el, () => true);
        el.clientHeight = 352; // the Android app's WebView resized above the keyboard
        expect(el.fromBottom).toBe(270); // what the browser leaves: the newest 270 px under the box
        repin();
        expect(el.fromBottom).toBe(0);
        for (const h of [329, 307, 284, 262, 231]) { // four lines of the box, then the typing indicator
            el.clientHeight = h;
            repin();
            expect(el.fromBottom).toBe(0);
        }
        // Shrunk once: the next change that moves nothing does not pin again.
        el.scrollTop -= 60;
        repin();
        expect(el.fromBottom).toBe(60);
    });

    it('a reader one wheel notch up (inside the slop) is left where they are when the list itself changes height', () => {
        // The review's case: on the desktop a notch up to re-read a message, then the
        // other side starts typing (or a notice comes up over the list). Neither is
        // theirs; the list pinned them back down, again each time the indicator came.
        const el = list(3000, 642, 2258);
        const repin = repinOnResize(el, () => true); // within AT_BOTTOM_SLOP: "at the bottom"
        el.scrollTop = 2158; // a notch up
        el.clientHeight = 611; // the typing indicator came up
        repin();
        expect(el.scrollTop).toBe(2158);
        el.clientHeight = 642; // and went again
        repin();
        expect(el.scrollTop).toBe(2158);
    });

    it('a reader inside the slop is still pinned when the CONTENT grows, as a new message pins them', () => {
        const el = list(3000, 642, 2258);
        const repin = repinOnResize(el, () => true);
        el.scrollTop = 2158;
        el.scrollHeight = 3200; // a link card under the newest message
        repin();
        expect(el.fromBottom).toBe(0);
    });

    it('a list on its way to the end (Jump to latest, mid-scroll) gets there when the box changes', () => {
        const el = list(3000, 642, 1800);
        let heading = true;
        const repin = repinOnResize(el, () => true, () => heading);
        el.clientHeight = 611;
        repin();
        expect(el.fromBottom).toBe(0);
        heading = false;
        el.scrollTop = 2000; // scrolled up again
        el.clientHeight = 642;
        repin();
        expect(el.scrollTop).toBe(2000);
    });

    it('a reader scrolled well up is never moved, whatever changes', () => {
        const el = list(3000, 700, 800);
        const repin = repinOnResize(el, () => false);
        el.scrollHeight = 3300;
        repin();
        expect(el.scrollTop).toBe(800);
        el.clientHeight = 352;
        repin();
        expect(el.scrollTop).toBe(800);
    });
});

/**
 * The content's height and the box's changing in the SAME frame: the other side
 * sends, so their message arrives as their typing indicator goes (or comes up, or
 * a line more in your own box). One call sees both; it goes by the content's rule,
 * as the message alone would (Chat.tsx's tail effect takes a list within the slop
 * to a new message anyway), and never moves a reader scrolled well up.
 */
describe('repinOnResize, the content and the box changing together', () => {
    /** The browser keeps scrollTop through both, inside the new end. */
    const change = (el: ReturnType<typeof list>, content: number, box: number) => {
        const top = el.scrollTop;
        el.scrollHeight = content;
        el.clientHeight = box;
        el.scrollTop = top;
    };

    it('a list at the end: a message arrives as the typing indicator goes', () => {
        const el = list(3000, 611, 2389);
        const repin = repinOnResize(el, () => true);
        change(el, 3064, 642);
        repin();
        expect(el.fromBottom).toBe(0);
    });

    it('a list at the end: a message arrives as the typing indicator comes up', () => {
        const el = list(3000, 642, 2358);
        const repin = repinOnResize(el, () => true);
        change(el, 3064, 611);
        repin();
        expect(el.fromBottom).toBe(0);
    });

    it('a list at the end: a message deleted as the box gets a line shorter', () => {
        const el = list(3000, 620, 2380);
        const repin = repinOnResize(el, () => true);
        change(el, 2936, 642);
        repin();
        expect(el.fromBottom).toBe(0);
    });

    it('a list on its way to the end (Jump to latest) gets there', () => {
        const el = list(3000, 642, 1800);
        const repin = repinOnResize(el, () => true, () => true);
        change(el, 3064, 611);
        repin();
        expect(el.fromBottom).toBe(0);
        // Both moved together once: the next change that moves nothing does nothing.
        el.scrollTop = 2000;
        repin();
        expect(el.scrollTop).toBe(2000);
    });

    it('a reader a notch up, inside the slop, goes to the new message, as the message alone takes them', () => {
        const el = list(3000, 642, 2258);
        const repin = repinOnResize(el, () => true);
        change(el, 3064, 611);
        repin();
        expect(el.fromBottom).toBe(0);
    });

    it('a reader scrolled well up stays exactly where they are reading', () => {
        const el = list(3000, 642, 1200);
        const repin = repinOnResize(el, () => false, () => false);
        change(el, 3064, 611);
        repin();
        expect(el.scrollTop).toBe(1200);
        change(el, 3128, 642);
        repin();
        expect(el.scrollTop).toBe(1200);
    });
});

/**
 * Jump to latest: Chat.tsx's scroll to the newest message, its scroll handler
 * (`ownScroll`, then "at the bottom" is within AT_BOTTOM_SLOP) and repinOnResize
 * on its ResizeObserver, wired as Chat.tsx wires them, over a scroller that runs
 * a smooth scroll as Chromium and WebKit do: its target is the end as it was
 * when the scroll STARTED, and a scrollTop set from script stops it (both seen
 * 2026-11-17 in real Chromium and WebKit, scrollToEnd's header).
 */
describe('scrollToEnd: Jump to latest ends at the newest message', () => {
    const SLOP = 120; // Chat.tsx's AT_BOTTOM_SLOP
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    function chat(scrollHeight: number, clientHeight: number, fromBottom: number) {
        const el = list(scrollHeight, clientHeight, scrollHeight - clientHeight - fromBottom);
        let atBottom = el.fromBottom <= SLOP;
        const settled = vi.fn(() => { atBottom = el.fromBottom <= SLOP; });
        const pin = scrollToEnd(800, settled);
        const repin = repinOnResize(el, () => atBottom, pin.heading);
        const scrolled = () => {
            if (pin.ownScroll(el)) return;
            atBottom = el.fromBottom <= SLOP;
        };
        let smooth: { from: number; to: number; step: number } | null = null;
        let mine = false;
        const setTop = (v: number) => { mine = true; el.scrollTop = v; mine = false; };
        // Script setting scrollTop (repinOnResize does) stops a smooth scroll on its way.
        const own = Object.getOwnPropertyDescriptor(el, 'scrollTop')!;
        Object.defineProperty(el, 'scrollTop', {
            get: own.get,
            set(v: number) { if (!mine) smooth = null; own.set!.call(el, v); },
        });
        return {
            el, pin, repin, scrolled, settled,
            atBottom: () => atBottom,
            /** The Jump to latest pill: scrollToLatest('smooth'). */
            jump() {
                pin.start();
                atBottom = true;
                smooth = { from: el.scrollTop, to: el.scrollHeight - el.clientHeight, step: 0 };
            },
            /** One frame of the smooth scroll (thirty frames end it) and its scroll event. */
            frame(): boolean {
                if (!smooth) return false;
                smooth.step += 1;
                setTop(smooth.from + (smooth.to - smooth.from) * smooth.step / 30);
                if (smooth.step >= 30) smooth = null;
                scrolled();
                return true;
            },
            /** The list's box changes height (the browser keeps scrollTop), and the ResizeObserver runs. */
            box(h: number) {
                el.clientHeight = h;
                setTop(el.scrollTop);
                const top = el.scrollTop;
                repin();
                if (el.scrollTop !== top) scrolled(); // a scroll repinOnResize made is an event too
            },
            /** The reader's own scroll: the wheel, a finger (Chat.tsx's onWheel / onTouchStart cancel it). */
            wheel(dy: number) {
                pin.cancel();
                smooth = null;
                setTop(el.scrollTop + dy);
                scrolled();
            },
        };
    }

    for (const [what, px] of [['the other side\'s typing indicator coming up', 31], ['a line more in the message box', 22]] as const) {
        for (const at of [100, 60, 30]) {
            it(`${what} ${at} px from the end, in the jump's last stretch`, () => {
                const c = chat(4000, 642, 900);
                c.jump();
                let changed = false;
                while (c.frame()) {
                    if (!changed && c.el.fromBottom <= at) {
                        expect(c.el.fromBottom).toBeGreaterThan(0); // still on its way
                        changed = true;
                        c.box(642 - px);
                    }
                }
                expect(changed).toBe(true);
                expect(c.el.fromBottom).toBe(0);
                expect(c.pin.heading()).toBe(false); // let go on arriving
            });
        }
    }

    it('the box changing early in the jump takes it straight to the end', () => {
        const c = chat(4000, 642, 900);
        c.jump();
        while (c.frame() && c.el.fromBottom > 400);
        c.box(620);
        expect(c.el.fromBottom).toBe(0);
        expect(c.pin.heading()).toBe(false);
    });

    it('arrived, it has let go: a notch up after it is the reader\'s, through the box changing', () => {
        const c = chat(4000, 642, 900);
        c.jump();
        while (c.frame());
        expect(c.el.fromBottom).toBe(0);
        expect(c.pin.heading()).toBe(false);
        c.wheel(-80);
        c.box(611);
        expect(c.el.fromBottom).toBe(80 + 31);
        c.box(642);
        expect(c.el.fromBottom).toBe(80);
    });

    it('a reader who takes the wheel in the last stretch keeps where they scrolled to', () => {
        const c = chat(4000, 642, 900);
        c.jump();
        while (c.frame() && c.el.fromBottom > 100);
        c.wheel(-200);
        const top = c.el.scrollTop;
        c.box(611);
        expect(c.el.scrollTop).toBe(top);
        expect(c.atBottom()).toBe(false);
    });

    it('a jump from the end makes no scroll event: it lets go after 800 ms and squares the state', () => {
        const c = chat(4000, 642, 0);
        c.jump();
        expect(c.pin.heading()).toBe(true);
        vi.advanceTimersByTime(799);
        expect(c.pin.heading()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(c.pin.heading()).toBe(false);
        expect(c.settled).toHaveBeenCalledTimes(1);
    });

    it('a second jump restarts the clock, and an arrival or the reader stops it', () => {
        const c = chat(4000, 642, 0);
        c.jump();
        vi.advanceTimersByTime(500);
        c.jump();
        vi.advanceTimersByTime(500);
        expect(c.pin.heading()).toBe(true);
        expect(c.settled).not.toHaveBeenCalled();
        vi.advanceTimersByTime(300);
        expect(c.settled).toHaveBeenCalledTimes(1);

        const d = chat(4000, 642, 900);
        d.jump();
        while (d.frame());
        d.wheel(-300);
        vi.advanceTimersByTime(2000);
        expect(d.settled).not.toHaveBeenCalled();
    });
});
