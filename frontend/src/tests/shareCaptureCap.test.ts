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

import { shareVideoConstraints } from '../api/rtc/media';

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
