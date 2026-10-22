/**
 * The simulcast rung an unfocused remote video is subscribed at.
 *
 * WHY THIS FILE EXISTS. Every remote camera used to be pinned to the ladder's
 * bottom rung — 320x180 at 150 kbps and 15 fps — for the whole of every call,
 * because the only code that ever raised a subscription was the screen-share
 * stage's focus handler, and the surface that renders cameras never focuses
 * anybody. With dynacast on, the publisher then stops encoding the layers
 * nobody subscribed, so the better pixels were never produced at all: no
 * renderer could have worked around it. That is the whole of "the webcam looks
 * far worse than Discord", and nothing in the suite would have noticed it
 * changing back.
 *
 * `subscribedQuality` is imported from the real module, not restated here: a
 * test that reimplements the rule it is checking passes whatever the code does.
 */
import { describe, expect, it } from 'vitest';
import { Track, VideoQuality } from 'livekit-client';

import { subscribedQuality } from '../api/rtc/sfuManager';

// No module mock: the real enums are what the app passes at runtime, and a
// hand-written stub of them is a second copy to drift.

describe('subscribedQuality', () => {
    it('gives the focused user the high rung, whatever the room size', () => {
        for (const n of [2, 4, 6, 12]) {
            expect(subscribedQuality(Track.Source.Camera, true, n)).toBe(VideoQuality.HIGH);
            expect(subscribedQuality(Track.Source.ScreenShare, true, n)).toBe(VideoQuality.HIGH);
        }
    });

    it('subscribes an unfocused camera in a SMALL call above the bottom rung', () => {
        // The regression: this returned LOW for every call, forever. A
        // one-to-one call renders a 640px-wide tile, which is the MID rung.
        expect(subscribedQuality(Track.Source.Camera, false, 2)).toBe(VideoQuality.MEDIUM);
        expect(subscribedQuality(Track.Source.Camera, false, 4)).toBe(VideoQuality.MEDIUM);
    });

    it('drops an unfocused camera to the low rung once the grid is small-tiled', () => {
        // Past the threshold the tiles really are ~320px, so the low rung is
        // the right picture — and the node's egress budget depends on it.
        expect(subscribedQuality(Track.Source.Camera, false, 5)).toBe(VideoQuality.LOW);
        expect(subscribedQuality(Track.Source.Camera, false, 12)).toBe(VideoQuality.LOW);
    });

    it('never drops an unfocused screen share below the mid rung', () => {
        // Shares are the thing people are reading; 320x180 makes text
        // unreadable. A focus change used to demote them via the shared
        // ternary, which is the bug this pins.
        for (const n of [2, 6, 12]) {
            expect(subscribedQuality(Track.Source.ScreenShare, false, n, 3)).toBe(VideoQuality.MEDIUM);
            expect(subscribedQuality(Track.Source.ScreenShare, false, n, 6)).toBe(VideoQuality.MEDIUM);
        }
    });

    it('asks for the full picture of one or two watched shares, focused or not', () => {
        // The default grid focuses nobody, and one watched share fills the
        // stage: a laddered share arrived at its 720p middle rung there
        // (measured in the real app, e2e/share-ladder-live-sfu.mjs). HIGH is a
        // ceiling; LiveKit still steps a slow link down the ladder.
        for (const n of [2, 6, 12]) {
            expect(subscribedQuality(Track.Source.ScreenShare, false, n, 1)).toBe(VideoQuality.HIGH);
            expect(subscribedQuality(Track.Source.ScreenShare, false, n, 2)).toBe(VideoQuality.HIGH);
            expect(subscribedQuality(Track.Source.ScreenShare, false, n), 'the default is one watched share').toBe(VideoQuality.HIGH);
        }
        // Cameras are unaffected by how many shares are watched.
        expect(subscribedQuality(Track.Source.Camera, false, 2, 1)).toBe(VideoQuality.MEDIUM);
    });
});
