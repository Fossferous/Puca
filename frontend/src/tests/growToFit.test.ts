/**
 * components/growToFit.ts: the message box grows to fit its words and leaves
 * the message list beside it where it was. Measuring sets the box to `auto`
 * and reads its scrollHeight; WebKit (the iPhone's engine) lays the page out
 * then, with the box at one line and the list taller, and clamps the list's
 * scrollTop to that taller list's bottom. Measured 2026-11-16 at 390x844, the
 * box at four lines: every keystroke left the newest 90 px of the list under
 * the box. The fake below does what WebKit does.
 */
import { describe, it, expect } from 'vitest';
import { growToFit } from '../components/growToFit';

const LINE = 22, ONE_LINE = 46;

/** The box and the list share a column of fixed height: the list gets what the box leaves. */
function column(textLines: number, boxPx: number, scrollHeight: number, column: number) {
    let top = 0;
    const box = {
        style: { height: `${boxPx}px` },
        lines: textLines,
        get scrollHeight() {
            // Reading it lays the page out with the box at its current style (WebKit's clamp).
            list.relayout();
            return ONE_LINE + (box.lines - 1) * LINE;
        },
    };
    const boxHeight = () => (box.style.height === 'auto' ? ONE_LINE : parseFloat(box.style.height));
    const list = {
        scrollHeight,
        get clientHeight() { return column - boxHeight(); },
        get scrollTop() { return top; },
        set scrollTop(v: number) { top = Math.max(0, Math.min(v, list.scrollHeight - list.clientHeight)); },
        get fromBottom() { return list.scrollHeight - list.clientHeight - top; },
        /** A layout: scrollTop is clamped to the list's bottom at its height of the moment. */
        relayout() { top = Math.max(0, Math.min(top, list.scrollHeight - list.clientHeight)); },
    };
    list.scrollTop = scrollHeight; // at the newest message
    return { box, list };
}

describe('growToFit', () => {
    it('another keystroke on a box of four lines leaves the list at the newest message', () => {
        const { box, list } = column(4, ONE_LINE + 3 * LINE, 2000, 800);
        expect(list.fromBottom).toBe(0);
        growToFit(box, 200, list);
        expect(box.style.height).toBe(`${ONE_LINE + 3 * LINE}px`);
        expect(list.fromBottom).toBe(0); // it was 3 * LINE = 66 px short of it
    });

    it('a box at its 200 px ceiling: still at the newest message (it was 154 px short: past the at-bottom slop)', () => {
        const { box, list } = column(12, 200, 3000, 800);
        growToFit(box, 200, list);
        expect(box.style.height).toBe('200px');
        expect(list.fromBottom).toBe(0);
    });

    it('a line more: the box grows, and the list is only where it was (its own height changed; repinOnResize pins it)', () => {
        const { box, list } = column(3, ONE_LINE + 2 * LINE, 2000, 800);
        const before = list.scrollTop;
        box.lines = 4;
        growToFit(box, 200, list);
        expect(box.style.height).toBe(`${ONE_LINE + 3 * LINE}px`);
        expect(list.scrollTop).toBe(before);
    });

    it('a reader scrolled well up: nothing moves', () => {
        const { box, list } = column(4, ONE_LINE + 3 * LINE, 2000, 800);
        list.scrollTop = 400;
        growToFit(box, 200, list);
        expect(list.scrollTop).toBe(400);
    });

    it('with no list, it only sizes the box', () => {
        const { box } = column(2, ONE_LINE, 2000, 800);
        growToFit(box, 200, null);
        expect(box.style.height).toBe(`${ONE_LINE + LINE}px`);
    });
});
