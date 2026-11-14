/**
 * WHERE A MONITOR-HOP CHIP SITS on a touch screen.
 *
 * The chip lives on the edge the view has run out of, centred along it
 * (DeviceStage.css). On a phone that spot can be under one of the stage's
 * floating controls: the mouse pad's L/M/R row and scroll column and the
 * pinned keys are `position: fixed` at offsets from the bottom of the WINDOW,
 * above the picture, and the user drags them anywhere. In landscape (390 px
 * tall) their default places cover exactly the middle of both side edges, so
 * the chip was invisible and a tap on its spot pressed the pad's button
 * instead. So the chip slides along its own edge to the nearest spot nothing
 * covers, and stays centred when nothing is in the way.
 *
 * Pure: DeviceStage measures (the chip at its centred place, the picture's
 * box, the controls) and applies the answer as `--hop-shift`.
 */
import type { HopDir } from './deviceZoomFollow';

export interface PlaceRect { left: number; top: number; right: number; bottom: number }

/** Room kept between a chip's target and a control beside it, px. */
export const HOP_CLEARANCE_PX = 4;

/**
 * How far to slide a chip along its edge, in px (positive is down for the
 * left and right chips, right for the up and down ones), so that its target
 * `chip`, measured at its centred place, overlaps none of `obstacles` and
 * stays inside `bounds`. The free spot nearest the centre wins; 0 when the
 * centre is already free, and 0 when nowhere along the edge is (the chip is
 * then no worse off than it was).
 */
export function hopChipShift(
    dir: HopDir, chip: PlaceRect, bounds: PlaceRect, obstacles: readonly PlaceRect[],
    gap: number = HOP_CLEARANCE_PX,
): number {
    const sideways = dir === 'left' || dir === 'right';   // slides up and down
    const start = sideways ? chip.top : chip.left;
    const size = sideways ? chip.bottom - chip.top : chip.right - chip.left;
    const laneLo = sideways ? chip.left : chip.top;
    const laneHi = sideways ? chip.right : chip.bottom;
    const min = (sideways ? bounds.top : bounds.left) + gap;
    const max = (sideways ? bounds.bottom : bounds.right) - gap - size;
    // Where the chip's leading edge may NOT be, one open interval per
    // control that reaches into the chip's lane.
    const blocked: Array<[number, number]> = [];
    for (const o of obstacles) {
        const oLaneLo = sideways ? o.left : o.top;
        const oLaneHi = sideways ? o.right : o.bottom;
        if (oLaneHi <= laneLo - gap || oLaneLo >= laneHi + gap) continue;
        const oLo = sideways ? o.top : o.left;
        const oHi = sideways ? o.bottom : o.right;
        blocked.push([oLo - gap - size, oHi + gap]);
    }
    const free = (s: number) => s >= min - 0.5 && s <= max + 0.5 && blocked.every(([a, b]) => s <= a || s >= b);
    if (free(start)) return 0;
    let best: number | null = null;
    for (const [a, b] of blocked) {
        for (const s of [a, b]) {
            if (free(s) && (best === null || Math.abs(s - start) < Math.abs(best - start))) best = s;
        }
    }
    return best === null ? 0 : best - start;
}
