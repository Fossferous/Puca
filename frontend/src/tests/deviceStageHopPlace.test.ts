/**
 * Where a monitor-hop chip sits on a touch screen (deviceStageHopPlace.ts):
 * centred on its edge, slid along it only as far as a floating control
 * forces. The numbers are a landscape phone's (844x390, the picture 0..328
 * above the toolbar) with the mouse pad at its default places — the case the
 * review measured, where both side chips were under the pad.
 */
import { describe, it, expect } from 'vitest';
import { hopChipShift, HOP_CLEARANCE_PX, type PlaceRect } from '../components/deviceStageHopPlace';

const BOUNDS: PlaceRect = { left: 0, top: 0, right: 844, bottom: 328 };
/** A 44 px target centred on its edge, 8 px in, as DeviceStage.css puts it. */
const LEFT: PlaceRect = { left: 8, right: 52, top: 142, bottom: 186 };
const RIGHT: PlaceRect = { left: 792, right: 836, top: 142, bottom: 186 };
const UP: PlaceRect = { left: 400, right: 444, top: 8, bottom: 52 };
const DOWN: PlaceRect = { left: 400, right: 444, top: 276, bottom: 320 };
/** The L/M/R row and the scroll column at their default places. */
const LMR: PlaceRect = { left: 12, right: 200, top: 140, bottom: 200 };
const SCROLL: PlaceRect = { left: 772, right: 832, top: 60, bottom: 200 };

const moved = (r: PlaceRect, d: number, sideways: boolean): PlaceRect => sideways
    ? { ...r, top: r.top + d, bottom: r.bottom + d }
    : { ...r, left: r.left + d, right: r.right + d };
const overlaps = (a: PlaceRect, b: PlaceRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('hopChipShift', () => {
    it('nothing in the way: the chip stays centred', () => {
        for (const [dir, r] of [['left', LEFT], ['right', RIGHT], ['up', UP], ['down', DOWN]] as const) {
            expect(hopChipShift(dir, r, BOUNDS, []), dir).toBe(0);
        }
    });

    it('a control beside the lane, not in it, moves nothing', () => {
        // The L/M/R row is on the left edge's lane, not the right one's.
        expect(hopChipShift('right', RIGHT, BOUNDS, [LMR])).toBe(0);
        expect(hopChipShift('up', UP, BOUNDS, [LMR, SCROLL])).toBe(0);
    });

    it('the left chip under the L/M/R row slides to the nearest free spot, clear by the margin', () => {
        const d = hopChipShift('left', LEFT, BOUNDS, [LMR]);
        expect(d, 'it must move').not.toBe(0);
        const at = moved(LEFT, d, true);
        expect(overlaps(at, LMR)).toBe(false);
        expect(at.top >= BOUNDS.top && at.bottom <= BOUNDS.bottom).toBe(true);
        // Nearest: above the row (142 -> 92) is 50 px away, below (204) 62.
        expect(at.bottom).toBe(LMR.top - HOP_CLEARANCE_PX);
    });

    it('the right chip under the scroll column goes below it when above is too far', () => {
        const d = hopChipShift('right', RIGHT, BOUNDS, [SCROLL]);
        const at = moved(RIGHT, d, true);
        expect(overlaps(at, SCROLL)).toBe(false);
        // Above the column would need the top at 12 (130 px away); below, 204 (62).
        expect(at.top).toBe(SCROLL.bottom + HOP_CLEARANCE_PX);
    });

    it('never slides out of the picture: a spot that would leave it is not taken', () => {
        // A column covering everything but a strip too thin for the chip at the top.
        const tall: PlaceRect = { left: 772, right: 832, top: 30, bottom: 328 };
        expect(hopChipShift('right', RIGHT, BOUNDS, [tall])).toBe(0);
    });

    it('two controls: the free gap between them is used when it fits', () => {
        const above: PlaceRect = { left: 0, right: 60, top: 0, bottom: 120 };
        const below: PlaceRect = { left: 0, right: 60, top: 175, bottom: 328 };
        const d = hopChipShift('left', LEFT, BOUNDS, [above, below]);
        const at = moved(LEFT, d, true);
        expect(overlaps(at, above) || overlaps(at, below)).toBe(false);
        expect(at.top).toBeGreaterThanOrEqual(124);
        expect(at.bottom).toBeLessThanOrEqual(171);
    });

    it('the bottom chip slides sideways past a feedback line over the bottom centre', () => {
        const line: PlaceRect = { left: 340, right: 504, top: 280, bottom: 312 };
        const d = hopChipShift('down', DOWN, BOUNDS, [line]);
        const at = moved(DOWN, d, false);
        expect(overlaps(at, line)).toBe(false);
        expect(Math.abs(d)).toBeLessThan(120);
    });
});
