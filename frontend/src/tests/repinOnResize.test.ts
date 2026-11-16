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
import { describe, it, expect } from 'vitest';
import { repinOnResize } from '../components/repinOnResize';

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
