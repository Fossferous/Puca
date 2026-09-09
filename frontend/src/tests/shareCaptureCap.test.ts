/**
 * A screen share must never capture more pixels than the person asked for.
 *
 * THE BUG THIS PINS. The share asked the browser for `width: { ideal }`,
 * `height: { ideal }` and `frameRate: { ideal, max }` — a cap on the frame
 * rate and only a preference on the size. An ideal is a preference the browser
 * may ignore, and for display capture Chromium routinely does: it hands back
 * the surface at its native resolution. So somebody on a 1440p monitor who
 * picked "1080p" was encoding 1440p, 1.8x the pixels they chose, and on a 4K
 * monitor four times.
 *
 * It matters because the share is encoded in SOFTWARE on every machine we have
 * logs from (`encoder=OpenH264`), and software H.264 costs roughly linearly in
 * pixels per second. Silently doubling the pixel count doubles the CPU taken
 * from the game the person is sharing and also trying to play.
 *
 * The clip recorder two directories away has always capped all three
 * (clips/replayBuffer.ts's displayConstraints). This is the same job.
 */
import { describe, it, expect } from 'vitest';

import { shareVideoConstraints, capWouldReduce } from '../api/rtc/media';

describe('what a screen share asks the browser for', () => {
    it('caps the resolution rather than preferring it', () => {
        const c = shareVideoConstraints(1920, 1080, 30);
        expect(c.width, 'width must be a ceiling, not a wish').toEqual({ max: 1920 });
        expect(c.height, 'height must be a ceiling, not a wish').toEqual({ max: 1080 });
    });

    it('caps the frame rate too', () => {
        expect(shareVideoConstraints(1280, 720, 30).frameRate).toEqual({ max: 30 });
        expect(shareVideoConstraints(1280, 720, 60).frameRate).toEqual({ max: 60 });
    });

    it('never emits an `ideal` for any of the three', () => {
        // The specific regression: an `ideal` anywhere in here is a size the
        // browser is free to exceed. Written as a scan rather than three
        // equality checks so a fourth constraint added later is covered too.
        const c = shareVideoConstraints(2560, 1440, 60) as Record<string, Record<string, unknown>>;
        for (const [name, spec] of Object.entries(c)) {
            expect(Object.keys(spec), `${name} must constrain with max alone`).toEqual(['max']);
        }
    });

    it('passes the chosen size through unchanged', () => {
        // POSITIVE CONTROL: the cap is the caller's number, so a person who
        // picks 720p gets 720p rather than a hard-coded default.
        expect(shareVideoConstraints(1280, 720, 30)).toEqual({
            width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 },
        });
    });
});

describe('whether a cap would reduce anything at all', () => {
    it('refuses a ceiling at or above what is already captured', () => {
        // The exact case that shipped broken: Source on a 1080p monitor,
        // "stepped down" to 1440p. Nothing to reduce.
        expect(capWouldReduce({ width: 1920, height: 1080, frameRate: 60 }, 2560, 1440, 60)).toBe(false);
        // Equal is not a reduction either.
        expect(capWouldReduce({ width: 1920, height: 1080, frameRate: 60 }, 1920, 1080, 60)).toBe(false);
    });

    it('accepts a ceiling that reduces ANY of the three', () => {
        // POSITIVE CONTROL: the guard must not simply always refuse.
        expect(capWouldReduce({ width: 1920, height: 1080, frameRate: 60 }, 1280, 720, 60)).toBe(true);
        expect(capWouldReduce({ width: 1920, height: 1080, frameRate: 60 }, 1920, 1080, 30)).toBe(true);
        // A wide monitor: the height alone is already inside the cap, so a
        // width-only reduction has to count or an ultrawide can never lower.
        expect(capWouldReduce({ width: 2560, height: 1080, frameRate: 60 }, 1920, 1080, 60)).toBe(true);
    });

    it('treats a track that reports nothing as not worth re-capping', () => {
        // getSettings() can come back empty before the first frame. Applying
        // a cap then tells us nothing and risks a false "lowered".
        expect(capWouldReduce({}, 1280, 720, 30)).toBe(false);
    });

    it('compares frame rate as a whole number', () => {
        // A 60 fps capture commonly reports 59.94. Without rounding, a cap of
        // 60 would read as a reduction and claim success for a no-op.
        expect(capWouldReduce({ width: 1280, height: 720, frameRate: 59.94 }, 1280, 720, 60)).toBe(false);
        expect(capWouldReduce({ width: 1280, height: 720, frameRate: 59.94 }, 1280, 720, 30)).toBe(true);
    });
});
