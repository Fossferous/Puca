/**
 * EDGE PAN's arithmetic (api/devices/edgePan.ts): which way, and how fast, a
 * zoomed-in desktop stage looks along when the pointer pushes into the band
 * along one of its edges. The stage's clock and clamp are pinned through the
 * real component in deviceStageDesktopHover.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import { EDGE_PAN_BAND, EDGE_PAN_SPEED, edgePanVelocity } from '../api/devices/edgePan';

const W = 1280;
const H = 720;

describe('edge pan', () => {
    it('is still away from the edges, up to and on the band\'s inner line', () => {
        expect(edgePanVelocity(640, 360, W, H)).toEqual({ vx: 0, vy: 0 });
        expect(edgePanVelocity(EDGE_PAN_BAND, EDGE_PAN_BAND, W, H)).toEqual({ vx: 0, vy: 0 });
        expect(edgePanVelocity(W - EDGE_PAN_BAND, H - EDGE_PAN_BAND, W, H)).toEqual({ vx: 0, vy: 0 });
    });

    it('looks the way the pointer pushes, at full speed on the edge itself', () => {
        expect(edgePanVelocity(0, 360, W, H)).toEqual({ vx: -EDGE_PAN_SPEED, vy: 0 });
        expect(edgePanVelocity(W, 360, W, H)).toEqual({ vx: EDGE_PAN_SPEED, vy: 0 });
        expect(edgePanVelocity(640, 0, W, H)).toEqual({ vx: 0, vy: -EDGE_PAN_SPEED });
        expect(edgePanVelocity(640, H, W, H)).toEqual({ vx: 0, vy: EDGE_PAN_SPEED });
    });

    it('goes faster the deeper the pointer is into the band', () => {
        const shallow = edgePanVelocity(W - EDGE_PAN_BAND * 0.75, 360, W, H).vx;
        const half = edgePanVelocity(W - EDGE_PAN_BAND / 2, 360, W, H).vx;
        const deep = edgePanVelocity(W - EDGE_PAN_BAND * 0.25, 360, W, H).vx;
        expect(half).toBeCloseTo(EDGE_PAN_SPEED / 2, 6);
        expect(shallow).toBeGreaterThan(0);
        expect(shallow).toBeLessThan(half);
        expect(deep).toBeGreaterThan(half);
    });

    it('a corner pans both ways at once', () => {
        const c = edgePanVelocity(2, H - 2, W, H);
        expect(c.vx).toBeLessThan(0);
        expect(c.vy).toBeGreaterThan(0);
    });

    it('does nothing for a pointer outside the stage, or no position at all', () => {
        for (const [x, y] of [[-1, 360], [W + 1, 360], [640, -1], [640, H + 1], [Number.NaN, 360], [640, Number.NaN]]) {
            expect(edgePanVelocity(x, y, W, H), `${x},${y}`).toEqual({ vx: 0, vy: 0 });
        }
    });

    it('a stage too small for a band each side of a usable middle never pans', () => {
        // 150 px wide < four bands: the whole width would be edge.
        expect(edgePanVelocity(0, 0, EDGE_PAN_BAND * 4 - 10, EDGE_PAN_BAND * 4 - 10)).toEqual({ vx: 0, vy: 0 });
        // Only the axis that is too small is off.
        expect(edgePanVelocity(0, 0, W, EDGE_PAN_BAND * 4 - 10)).toEqual({ vx: -EDGE_PAN_SPEED, vy: 0 });
    });
});
