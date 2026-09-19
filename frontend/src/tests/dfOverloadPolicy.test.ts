/**
 * When a DeepFilter call stops using DeepFilter. The worklet's bridge covers
 * every late moment regardless; this pins when the CALL gives up on the model
 * (dfOverloadPolicy.ts), which used to be at the first ~500 ms episode.
 */
import { describe, it, expect } from 'vitest';
import {
    DfOverloadPolicy, REPEAT_EPISODES, REPEAT_WINDOW_MS, SUSTAINED_MS,
} from '../api/dfOverloadPolicy';

describe('DfOverloadPolicy', () => {
    it('an isolated spike keeps DeepFilter', () => {
        const p = new DfOverloadPolicy();
        expect(p.onOverload(0)).toBeNull();
        p.onRecovered();
        expect(p.check(SUSTAINED_MS * 10)).toBeNull(); // over, so never "sustained"
        expect(p.settled).toBeNull();
    });

    it('an episode that lasts SUSTAINED_MS settles, and not a moment before', () => {
        const p = new DfOverloadPolicy();
        expect(p.episodeOpen).toBe(false);
        p.onOverload(1_000);
        expect(p.episodeOpen).toBe(true);
        expect(p.check(1_000 + SUSTAINED_MS - 1)).toBeNull();
        expect(p.check(1_000 + SUSTAINED_MS)).toBe('sustained');
        expect(p.settled).toBe('sustained');
    });

    it(`${REPEAT_EPISODES} episodes inside the window settle as repeated`, () => {
        const p = new DfOverloadPolicy();
        const gap = REPEAT_WINDOW_MS / REPEAT_EPISODES - 1; // all inside one window
        for (let k = 0; k < REPEAT_EPISODES - 1; k++) {
            expect(p.onOverload(k * gap)).toBeNull();
            p.onRecovered();
        }
        expect(p.onOverload((REPEAT_EPISODES - 1) * gap)).toBe('repeated');
    });

    it('positive control: the same number spread past the window does not', () => {
        // Without this, a policy that settled on ANY fourth episode ever would
        // pass the test above.
        const p = new DfOverloadPolicy();
        for (let k = 0; k < REPEAT_EPISODES * 3; k++) {
            expect(p.onOverload(k * REPEAT_WINDOW_MS / (REPEAT_EPISODES - 1))).toBeNull();
            p.onRecovered();
        }
        expect(p.settled).toBeNull();
    });

    it('settles once, and says nothing more after', () => {
        const p = new DfOverloadPolicy();
        p.onOverload(0);
        expect(p.check(SUSTAINED_MS)).toBe('sustained');
        expect(p.check(SUSTAINED_MS * 2)).toBeNull();
        expect(p.onOverload(SUSTAINED_MS * 3)).toBeNull();
        expect(p.settled).toBe('sustained');
    });

    it('the thresholds are the ones the docs promise', () => {
        // VOICE_SETTINGS.md, FEATURES_AND_TECHNOLOGY.md and CHANGELOG.md say
        // "15 s, or 4 times in 3 minutes". Change them together.
        expect([SUSTAINED_MS, REPEAT_EPISODES, REPEAT_WINDOW_MS]).toEqual([15_000, 4, 180_000]);
    });
});
