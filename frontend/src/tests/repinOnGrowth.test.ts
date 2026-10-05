/**
 * components/repinOnGrowth.ts: the message list follows its newest message
 * as content grows, and ONLY then — a change that moves nothing must not
 * pull back a reader who has just scrolled up a little (within Chat.tsx's
 * AT_BOTTOM_SLOP). Measured 2026-10-05: every wheel notch up from the bottom
 * of a channel of videos was undone, because a video at the edge of the
 * loaded zone swapped its placeholder (same height) as the reader scrolled.
 */
import { describe, it, expect } from 'vitest';
import { repinOnGrowth } from '../components/repinOnGrowth';

function list(scrollHeight: number, scrollTop: number) {
    return { scrollHeight, scrollTop };
}

describe('repinOnGrowth', () => {
    it('a change that moves nothing leaves a reader who scrolled up a little where they are', () => {
        const el = list(3000, 2200);
        const repin = repinOnGrowth(el, () => true); // still within the slop: "at the bottom"
        el.scrollTop = 2120; // one wheel notch up
        repin(); // a row's placeholder swapped, same height
        expect(el.scrollTop).toBe(2120);
    });

    it('content that grows keeps a list at the bottom pinned to it', () => {
        const el = list(3000, 2260);
        const repin = repinOnGrowth(el, () => true);
        el.scrollHeight = 3300;
        repin();
        expect(el.scrollTop).toBe(3300);
        // Grown once: the next change that moves nothing does not pin again.
        el.scrollTop = 3200;
        repin();
        expect(el.scrollTop).toBe(3200);
    });

    it('a reader scrolled well up is never moved', () => {
        const el = list(3000, 800);
        const repin = repinOnGrowth(el, () => false);
        el.scrollHeight = 3300;
        repin();
        expect(el.scrollTop).toBe(800);
    });
});
