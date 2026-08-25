/**
 * Where a click LANDS on the remote machine.
 *
 * This maths is invisible when wrong: the session connects, the picture looks
 * right, and clicks quietly land somewhere else on a computer the user cannot
 * see. It is `object-fit: contain` letterboxing — the video keeps its aspect
 * ratio inside a differently-shaped box, so the picture is offset from the
 * element and screen coordinates are NOT element coordinates.
 */
import { describe, it, expect } from 'vitest';
import { normalizedOverVideo } from '../api/devices/pointerMapping';

/** A video element with a fixed layout box and intrinsic size. */
function fakeVideo(opts: {
    rect: { left: number; top: number; width: number; height: number };
    videoWidth: number;
    videoHeight: number;
}): HTMLVideoElement {
    return {
        getBoundingClientRect: () => ({
            left: opts.rect.left,
            top: opts.rect.top,
            width: opts.rect.width,
            height: opts.rect.height,
            right: opts.rect.left + opts.rect.width,
            bottom: opts.rect.top + opts.rect.height,
            x: opts.rect.left,
            y: opts.rect.top,
            toJSON: () => ({}),
        }),
        videoWidth: opts.videoWidth,
        videoHeight: opts.videoHeight,
    } as unknown as HTMLVideoElement;
}

describe('remote pointer mapping', () => {
    it('maps the centre to the centre when the box matches the aspect ratio', () => {
        const v = fakeVideo({
            rect: { left: 0, top: 0, width: 1920, height: 1080 },
            videoWidth: 1920, videoHeight: 1080,
        });
        expect(normalizedOverVideo(v, 960, 540)).toEqual({ x: 0.5, y: 0.5 });
    });

    it('accounts for the element being offset on the page', () => {
        // The bar above the stage means the video does not start at y=0. Using
        // clientY directly would shift every click upward by the bar height.
        const v = fakeVideo({
            rect: { left: 100, top: 40, width: 800, height: 450 },
            videoWidth: 1600, videoHeight: 900,
        });
        expect(normalizedOverVideo(v, 500, 265)).toEqual({ x: 0.5, y: 0.5 });
    });

    /**
     * The case that actually bites: a 16:9 screen inside a taller box leaves
     * horizontal bars above and below. Ignoring them stretches every click
     * vertically, and the error grows toward the edges — so it looks "nearly
     * right" in the middle, which is the worst way for it to be wrong.
     */
    it('accounts for LETTERBOX bars (tall box, wide video)', () => {
        const v = fakeVideo({
            rect: { left: 0, top: 0, width: 800, height: 800 },
            videoWidth: 1600, videoHeight: 900,
        });
        // scale = min(800/1600, 800/900) = 0.5 → picture is 800x450,
        // centred vertically with 175px bars.
        expect(normalizedOverVideo(v, 400, 400)).toEqual({ x: 0.5, y: 0.5 });

        const top = normalizedOverVideo(v, 0, 175);
        expect(top!.x).toBeCloseTo(0, 6);
        expect(top!.y).toBeCloseTo(0, 6);

        const bottom = normalizedOverVideo(v, 800, 625);
        expect(bottom!.x).toBeCloseTo(1, 6);
        expect(bottom!.y).toBeCloseTo(1, 6);
    });

    it('accounts for PILLARBOX bars (wide box, tall video)', () => {
        const v = fakeVideo({
            rect: { left: 0, top: 0, width: 1000, height: 500 },
            videoWidth: 500, videoHeight: 500,
        });
        // scale = min(1000/500, 500/500) = 1 → picture is 500x500, centred
        // horizontally with 250px bars.
        expect(normalizedOverVideo(v, 500, 250)).toEqual({ x: 0.5, y: 0.5 });
        expect(normalizedOverVideo(v, 250, 0)).toEqual({ x: 0, y: 0 });
    });

    it('returns null in the bars rather than clamping to an edge', () => {
        // Clamping would silently park the remote cursor on an edge for every
        // click in the black region — a phantom click the user did not make.
        const v = fakeVideo({
            rect: { left: 0, top: 0, width: 800, height: 800 },
            videoWidth: 1600, videoHeight: 900,
        });
        expect(normalizedOverVideo(v, 400, 10)).toBeNull();   // top bar
        expect(normalizedOverVideo(v, 400, 790)).toBeNull();  // bottom bar
    });

    it('returns null before any frame has arrived', () => {
        // videoWidth is 0 until the first frame; dividing by it would yield
        // Infinity/NaN and send garbage coordinates to the injector.
        const v = fakeVideo({
            rect: { left: 0, top: 0, width: 800, height: 450 },
            videoWidth: 0, videoHeight: 0,
        });
        expect(normalizedOverVideo(v, 400, 225)).toBeNull();
    });

    it('returns null for a zero-sized element', () => {
        const v = fakeVideo({
            rect: { left: 0, top: 0, width: 0, height: 0 },
            videoWidth: 1920, videoHeight: 1080,
        });
        expect(normalizedOverVideo(v, 0, 0)).toBeNull();
    });
});
