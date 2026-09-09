/**
 * Auto-arm has to survive being early.
 *
 * THE EVIDENCE THIS ENCODES. Auto-arm fires 800 ms after joining a voice
 * channel, and the app rejoins about a second after a cold start — so on
 * launch, the first thing it does is open a DXGI desktop duplication while
 * Windows is still bringing the app's window up. From one machine's log on
 * 2026-09-09:
 *
 *     09-06 16:14:37 start -> 16:14:39 armed OK   (+2s)
 *     09-06 17:52:27 start -> 17:52:29 armed OK   (+2s)
 *     09-07 16:37:13 start -> 16:37:15 armed OK   (+2s)
 *     09-09 17:49:52 start -> 17:49:53 FAILED     (+1s)
 *     09-09 19:47:27 start -> 19:47:28 FAILED     (+1s)
 *
 * Every arm at +2s worked; every arm at +1s failed on EVERY monitor, including
 * ones that duplicate perfectly a minute later. The race was always there — it
 * became visible when the "armed here by hand once" gate was removed in
 * 0.9.803 and auto-arm started firing on cold starts again.
 *
 * A longer fixed delay would just be a guess about someone else's machine, so
 * the schedule retries instead. These tests pin the shape of it.
 */
import { describe, it, expect } from 'vitest';

import { autoArmDelayMs, AUTO_ARM_BACKOFF_MS } from '../api/clips/autoArmSchedule';

describe('the auto-arm retry schedule', () => {
    it('tries more than once', () => {
        // The whole point. One attempt is what shipped, and one attempt is what
        // turned a race into "Could not arm" with no way forward.
        expect(AUTO_ARM_BACKOFF_MS.length).toBeGreaterThan(1);
    });

    it('starts as promptly as it always did', () => {
        // The first attempt must not get slower: a machine that is ready
        // immediately should still arm immediately, and 800 ms is the delay
        // every version has used to let the panel settle.
        expect(autoArmDelayMs(0)).toBe(800);
    });

    it('backs off, so a slow start gets a real second chance', () => {
        // Retrying at the same 800 ms three times would land inside the same
        // busy window and fail three times for one reason.
        for (let i = 1; i < AUTO_ARM_BACKOFF_MS.length; i++) {
            expect(autoArmDelayMs(i)!, `attempt ${i + 1}`).toBeGreaterThan(autoArmDelayMs(i - 1)!);
        }
    });

    it('reaches well past the window that actually failed', () => {
        // The failures landed ~1s after start and the successes ~2s. The
        // schedule has to cover materially more than that or it re-runs the
        // same experiment.
        const total = AUTO_ARM_BACKOFF_MS.reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThanOrEqual(5_000);
    });

    it('stops, rather than retrying for ever', () => {
        // A machine that genuinely cannot capture — no duplication support at
        // all — must reach 'failed' and stay there. An endless retry would
        // hold a capture attempt open against the member's game indefinitely.
        expect(autoArmDelayMs(AUTO_ARM_BACKOFF_MS.length)).toBeNull();
        expect(autoArmDelayMs(99)).toBeNull();
    });

    it('refuses a nonsense attempt number instead of returning a delay', () => {
        // POSITIVE CONTROL for the bound above: the guard is about the range,
        // not about large numbers only.
        expect(autoArmDelayMs(-1)).toBeNull();
    });
});
