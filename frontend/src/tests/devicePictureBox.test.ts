/**
 * One letterbox calculation, used in both directions.
 *
 * `object-fit: contain` keeps the picture's aspect ratio inside a differently
 * shaped box, so element coordinates are not picture coordinates. Input was
 * corrected for that and the cursor overlay was not — it divided by the raw
 * element size — so the dot was drawn hundreds of pixels from where the host
 * pointer actually was. These pin the maths and the round trip between the two
 * directions.
 */
import { describe, it, expect } from 'vitest';
import { pictureBox, normalizedOverVideo, videoToScreen } from '../api/devices/pointerMapping';

describe('pictureBox', () => {
    /** The reported case: a 2560x1440 desktop on a 390x844 phone in portrait. */
    it('letterboxes a wide picture in a tall box', () => {
        const b = pictureBox(2560, 1440, 390, 780)!;
        expect(b.dispW).toBeCloseTo(390, 5);
        expect(b.dispH).toBeCloseTo(219.375, 3);
        expect(b.offX).toBeCloseTo(0, 5);
        // Bars top and bottom — and this offset is the entire bug: the old
        // code drew the cursor at `y * boxHeight`, which at y=0 is 280px above
        // the picture and at y=1 is 280px below it.
        expect(b.offY).toBeCloseTo(280.3125, 3);
    });

    it('pillarboxes a tall picture in a wide box', () => {
        const b = pictureBox(1440, 2560, 800, 600)!;
        expect(b.dispH).toBeCloseTo(600, 5);
        expect(b.dispW).toBeCloseTo(337.5, 3);
        expect(b.offY).toBeCloseTo(0, 5);
        expect(b.offX).toBeCloseTo(231.25, 3);
    });

    it('fills exactly when the aspects match', () => {
        const b = pictureBox(1920, 1080, 960, 540)!;
        expect(b).toEqual({ offX: 0, offY: 0, dispW: 960, dispH: 540 });
    });

    /** Before the first frame there is no picture, and drawing a cursor over
     *  nothing put it at the middle of a black rectangle. */
    it('is null when there is nothing drawn yet', () => {
        expect(pictureBox(0, 0, 390, 780)).toBeNull();
        expect(pictureBox(2560, 1440, 0, 0)).toBeNull();
        expect(pictureBox(2560, 0, 390, 780)).toBeNull();
    });
});

describe('the two directions agree', () => {
    const video = {
        videoWidth: 2560,
        videoHeight: 1440,
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 390, height: 780 }),
    };

    it('round-trips a normalised point through screen coordinates', () => {
        for (const p of [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }, { x: 0.25, y: 0.8 }]) {
            const screen = videoToScreen(video, p)!;
            const back = normalizedOverVideo(video, screen.x, screen.y)!;
            expect(back.x).toBeCloseTo(p.x, 6);
            expect(back.y).toBeCloseTo(p.y, 6);
        }
    });

    it('still refuses a touch in the letterbox bars', () => {
        // 20px down from the element's top is inside the black bar, not the
        // picture — clamping it would be a click the user never made.
        expect(normalizedOverVideo(video, 200, 25)).toBeNull();
    });
});
