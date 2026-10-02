/**
 * placeProfilePopup — where the member profile popup opens (UserProfilePopup).
 *
 * The bug this pins: the clamp assumed a 400px popup while the real one was
 * up to 450px, and nothing capped the height to the window. A click on a row
 * low in the member list (y≈630 at 1280x720) put the popup's bottom at 754 —
 * 34px below the window, at ANY window height — and the Manage Roles section
 * there could not be scrolled into view. These cases go red on that formula:
 * they demand that the popup's visible box (its measured height, capped by
 * the maxHeight it is given) lies inside the window with the margin kept.
 *
 * The real-browser half (wheel/touch actually reaching the last control) is
 * e2e/member-popup-scroll.mjs; jsdom has no box model to measure.
 */
import { describe, it, expect } from 'vitest';
import { placeProfilePopup } from '../components/userProfilePopupPlacement';

const MARGIN = 16;
const visibleBottom = (p: { top: number; maxHeight: number }, contentHeight: number) =>
    p.top + Math.min(contentHeight, p.maxHeight);

describe('placeProfilePopup', () => {
    it('a click low in the list keeps a tall popup inside a 1280x720 window', () => {
        const p = placeProfilePopup({ anchor: { x: 1160, y: 652 }, contentHeight: 900, viewport: { width: 1280, height: 720 } });
        expect(p.top).toBeGreaterThanOrEqual(MARGIN);
        expect(visibleBottom(p, 900)).toBeLessThanOrEqual(720 - MARGIN);
    });

    it('caps the height to the window, so a short window still shows the whole box (1280x460)', () => {
        const p = placeProfilePopup({ anchor: { x: 1160, y: 300 }, contentHeight: 900, viewport: { width: 1280, height: 460 } });
        expect(p.maxHeight).toBeLessThanOrEqual(460 - 2 * MARGIN);
        expect(p.top).toBeGreaterThanOrEqual(MARGIN);
        expect(visibleBottom(p, 900)).toBeLessThanOrEqual(460 - MARGIN);
    });

    it('never grows past the 450px design cap on a tall window', () => {
        const p = placeProfilePopup({ anchor: { x: 1160, y: 100 }, contentHeight: 2000, viewport: { width: 1920, height: 1400 } });
        expect(p.maxHeight).toBe(450);
        expect(p.top).toBe(100);
    });

    it('a short popup opens AT the click, not pushed up by a worst-case guess', () => {
        // Measured, not assumed: a 280px popup clicked at y=400 in 720 fits as is.
        const p = placeProfilePopup({ anchor: { x: 1160, y: 400 }, contentHeight: 280, viewport: { width: 1280, height: 720 } });
        expect(p.top).toBe(400);
    });

    it('a short popup low in the window moves up only as far as it must', () => {
        const p = placeProfilePopup({ anchor: { x: 1160, y: 600 }, contentHeight: 280, viewport: { width: 1280, height: 720 } });
        expect(visibleBottom(p, 280)).toBe(720 - MARGIN);
    });

    it('opens to the LEFT of the click (the member list is on the right) and stays in the window', () => {
        const p = placeProfilePopup({ anchor: { x: 1160, y: 200 }, contentHeight: 400, viewport: { width: 1280, height: 720 } });
        expect(p.left + p.width).toBeLessThanOrEqual(1160);
        expect(p.left).toBeGreaterThanOrEqual(MARGIN);
    });

    it('falls back to the right of a click near the left edge, clamped into the window', () => {
        const p = placeProfilePopup({ anchor: { x: 100, y: 200 }, contentHeight: 400, viewport: { width: 1280, height: 720 } });
        expect(p.left).toBe(112);
        expect(p.left + p.width).toBeLessThanOrEqual(1280 - MARGIN);
    });

    it('a window narrower than the popup narrows the popup instead of hanging it off-screen', () => {
        const p = placeProfilePopup({ anchor: { x: 200, y: 200 }, contentHeight: 400, viewport: { width: 300, height: 720 } });
        expect(p.left).toBeGreaterThanOrEqual(MARGIN);
        expect(p.left + p.width).toBeLessThanOrEqual(300 - MARGIN);
    });

    it('a window shorter than its margins still yields a non-negative box at the top margin', () => {
        const p = placeProfilePopup({ anchor: { x: 600, y: 10 }, contentHeight: 400, viewport: { width: 1280, height: 20 } });
        expect(p.maxHeight).toBeGreaterThanOrEqual(0);
        expect(p.top).toBe(MARGIN);
    });
});
