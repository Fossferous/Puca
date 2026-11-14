/**
 * The desktop small player's first spot (components/streamPipSpot.ts). It
 * opened 420 px from the window's right and 280 px from its bottom, which at
 * 1280x800 is over the right end of the composer and its Send button (0.9.850's
 * live round). Boxes here are what the app lays out at 1280x800: the chat
 * column between the channel list and the member list, the composer at its foot.
 * e2e/host-share-start-live.mjs checks the same in the real app.
 */
import { describe, it, expect } from 'vitest';
import { defaultPipSpot, fallbackPipSpot, PIP_GAP, type Box } from '../components/streamPipSpot';

const VIEWPORT = { width: 1280, height: 800 };
const SIZE = { width: 400, height: 250 };
const COLUMN: Box = { left: 312, top: 0, right: 1040, bottom: 800 };
const COMPOSER: Box = { left: 328, top: 728, right: 1024, bottom: 784 };
const SEND: Box = { left: 944, top: 736, right: 1016, bottom: 776 };

const boxOf = (spot: { x: number; y: number }): Box => ({ left: spot.x, top: spot.y, right: spot.x + SIZE.width, bottom: spot.y + SIZE.height });
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe("the small player's first spot", () => {
    it('negative control: the old spot covers the composer and Send at 1280x800', () => {
        const old = boxOf({ x: VIEWPORT.width - 420, y: VIEWPORT.height - 280 });
        expect(overlaps(old, COMPOSER)).toBe(true);
        expect(overlaps(old, SEND)).toBe(true);
        // ...and the fallback is that same spot, for a page with no composer.
        expect(fallbackPipSpot(VIEWPORT, SIZE)).toEqual({ x: 860, y: 520 });
    });

    it('opens above the composer, clear of Send, at the right of the chat column', () => {
        const spot = defaultPipSpot(VIEWPORT, SIZE, COLUMN, COMPOSER);
        const box = boxOf(spot);
        expect(overlaps(box, COMPOSER)).toBe(false);
        expect(overlaps(box, SEND)).toBe(false);
        expect(box.bottom).toBe(COMPOSER.top - PIP_GAP);
        expect(box.right).toBe(COLUMN.right - PIP_GAP);
        expect(box.left).toBeGreaterThanOrEqual(COLUMN.left);
    });

    it('stays inside the window when the window is too short for it above the composer', () => {
        const short = { width: 1000, height: 300 };
        const spot = defaultPipSpot(short, SIZE, { left: 312, top: 0, right: 760, bottom: 300 }, { left: 328, top: 230, right: 744, bottom: 286 });
        expect(spot.y).toBe(0);
        expect(spot.x).toBeGreaterThanOrEqual(0);
        expect(spot.x + SIZE.width).toBeLessThanOrEqual(short.width);
    });

    it('a narrow chat column: never off the window to the left', () => {
        const spot = defaultPipSpot({ width: 700, height: 800 }, SIZE, { left: 72, top: 0, right: 380, bottom: 800 }, { left: 80, top: 728, right: 372, bottom: 784 });
        expect(spot.x).toBe(0);
    });

    it('no composer or no chat column on screen: the old spot', () => {
        expect(defaultPipSpot(VIEWPORT, SIZE, COLUMN, null)).toEqual(fallbackPipSpot(VIEWPORT, SIZE));
        expect(defaultPipSpot(VIEWPORT, SIZE, null, COMPOSER)).toEqual(fallbackPipSpot(VIEWPORT, SIZE));
    });
});
