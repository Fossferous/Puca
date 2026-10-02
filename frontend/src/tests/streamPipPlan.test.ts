/**
 * The two pure decisions behind stream picture-in-picture:
 *
 *  - inAppPipPlan: which stream the in-app float may show while streams are
 *    popped out to the OS window, and whether it hides. Before: Chat hid the
 *    float on `usingDocPip && popped.length > 0` — never on the single-video
 *    engines (the same stream showed twice), and on the grid whenever ANY
 *    stream was popped (a watched, NOT popped stream showed nowhere).
 *  - streamAudioPlan: which watched streams the always-mounted audio host
 *    voices, and at what level. Before: one element, for the first stream.
 */
import { describe, it, expect } from 'vitest';
import { inAppPipPlan } from '../components/streamDocPip';
import { streamAudioPlan } from '../components/streamAudioRouting';

describe('inAppPipPlan — the float never shows a stream that is in the OS window', () => {
    it('nothing popped: the first watched stream, on every engine', () => {
        for (const mode of ['docpip', 'standard', 'webkit', 'native', null] as const) {
            expect(inAppPipPlan([5, 6], [], mode)).toEqual({ show: 5, hidden: false });
        }
    });

    it('the single-video engines hide the float when its stream is the popped one', () => {
        expect(inAppPipPlan([5], [5], 'standard')).toEqual({ show: null, hidden: true });
        expect(inAppPipPlan([5], [5], 'webkit')).toEqual({ show: null, hidden: true });
    });

    it('…and show the next watched stream when one is not popped', () => {
        expect(inAppPipPlan([5, 6], [5], 'standard')).toEqual({ show: 6, hidden: false });
        expect(inAppPipPlan([5, 6], [6], 'webkit')).toEqual({ show: 5, hidden: false });
    });

    it('the grid hides only when EVERY watched stream is in it', () => {
        // The old rule (usingDocPip && popped.length > 0) said hidden here.
        expect(inAppPipPlan([5, 6], [6], 'docpip')).toEqual({ show: 5, hidden: false });
        expect(inAppPipPlan([5, 6], [5], 'docpip')).toEqual({ show: 6, hidden: false });
        expect(inAppPipPlan([5, 6], [5, 6], 'docpip')).toEqual({ show: null, hidden: true });
        expect(inAppPipPlan([5, 6], [6, 5], 'docpip')).toEqual({ show: null, hidden: true });
    });

    it('a popped id that is no longer watched does not count', () => {
        expect(inAppPipPlan([5], [9], 'docpip')).toEqual({ show: 5, hidden: false });
    });

    it('the Android app (native) is untouched: the strip lives under the full-viewport host', () => {
        expect(inAppPipPlan([5, 6], [5], 'native')).toEqual({ show: 5, hidden: false });
    });

    it('no PiP at all (Firefox): nothing can be popped, the first stream shows', () => {
        expect(inAppPipPlan([5], [], null)).toEqual({ show: 5, hidden: false });
    });

    it('nothing watched: nothing to show, nothing hidden', () => {
        expect(inAppPipPlan([], [5], 'docpip')).toEqual({ show: null, hidden: false });
    });
});

describe('streamAudioPlan — every watched stream once, at the right level', () => {
    const base = { selected: [5, 6], ownId: null, stageOwns: false, mutes: {}, volumes: {}, master: 1 };

    it('every watched stream gets an audible entry at its level', () => {
        expect(streamAudioPlan(base)).toEqual([
            { userId: 5, audible: true, volume: 1 },
            { userId: 6, audible: true, volume: 1 },
        ]);
    });

    it('your own share is not in it', () => {
        expect(streamAudioPlan({ ...base, ownId: 6 }).map(e => e.userId)).toEqual([5]);
    });

    it('while the stage is mounted nothing here is audible (the stage graph owns it)', () => {
        expect(streamAudioPlan({ ...base, stageOwns: true }).every(e => !e.audible)).toBe(true);
    });

    it('a per-stream mute silences that stream only', () => {
        const plan = streamAudioPlan({ ...base, mutes: { 6: true } });
        expect(plan.find(e => e.userId === 5)!.audible).toBe(true);
        expect(plan.find(e => e.userId === 6)!.audible).toBe(false);
    });

    it('volume = stream volume × master, clamped to what an element can do', () => {
        const plan = streamAudioPlan({ ...base, volumes: { 5: 40, 6: 200 }, master: 0.5 });
        expect(plan[0].volume).toBeCloseTo(0.2, 9);
        expect(plan[1].volume).toBe(1); // 200% × 50%
        expect(streamAudioPlan({ ...base, volumes: { 5: 180 } })[0].volume).toBe(1);
        expect(streamAudioPlan({ ...base, master: 0 })[0].volume).toBe(0);
    });
});
