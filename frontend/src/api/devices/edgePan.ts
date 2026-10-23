/**
 * EDGE PAN — moving around a zoomed-in picture with a desktop mouse.
 *
 * On a phone, two fingers move the picture. A desktop mouse has nothing spare
 * to do it with: every button, the wheel and every key go to the other
 * machine. So, as Windows Magnifier does with "follow the mouse pointer within
 * the edges of the screen", the pointer pushing into a band along an edge of
 * the stage scrolls the picture that way — faster the deeper it goes, and
 * stopping where the picture ends (the stage's pan clamp). The stage drives
 * the clock; this file is the arithmetic, so it can be pinned without a DOM.
 */

/** How deep the band along each edge of the stage is, in CSS px. */
export const EDGE_PAN_BAND = 40;

/** How fast the view travels with the pointer AT the edge, in CSS px a second.
 *  Halfway into the band it is half that: a pass on the way to the toolbar
 *  nudges the picture, a pointer parked on the edge crosses a 2x picture in
 *  about a second and a half. */
export const EDGE_PAN_SPEED = 1200;

/** The stage's tick while the pointer pushes (about a display frame). */
export const EDGE_PAN_TICK_MS = 16;

/**
 * How fast to look further along each axis, for a pointer at (x, y) inside a
 * stage of `w` x `h` (both relative to the stage): px/s, positive = further
 * right / down. Zero away from the edges, outside the stage, and in a stage
 * too small to spare a band on each side of a usable middle.
 */
export function edgePanVelocity(
    x: number,
    y: number,
    w: number,
    h: number,
    band: number = EDGE_PAN_BAND,
    speed: number = EDGE_PAN_SPEED,
): { vx: number; vy: number } {
    if (!(x >= 0 && y >= 0 && x <= w && y <= h)) return { vx: 0, vy: 0 };
    const axis = (p: number, size: number): number => {
        if (size < band * 4) return 0;
        if (p < band) return -speed * (1 - p / band);
        if (p > size - band) return speed * (1 - (size - p) / band);
        return 0;
    };
    return { vx: axis(x, w), vy: axis(y, h) };
}
