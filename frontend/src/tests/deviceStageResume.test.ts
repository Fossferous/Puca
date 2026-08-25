/**
 * Returning to the app must un-pause the stage's <video>.
 *
 * Android/iOS pause a playing <video> when the app is backgrounded and never
 * un-pause it; DeviceStage's bind effect only acts when the stream identity
 * changes, and the stream deliberately survives a backgrounding
 * (deviceBackground.test.ts). Net effect before this fix: tab out of a live
 * device session on a phone, tab back, and the stage is a still image of the
 * desktop as it was — while input keeps landing on the real, moved-on desktop.
 *
 * The nudge must be play() ONLY. Re-binding srcObject paints black until the
 * next frame, and the host agent sends no frames while the remote screen is
 * still — permanent black on an idle desktop. These tests pin both the nudge
 * and its restraint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installBackgroundResume, installBackgroundResumeAll } from '../components/deviceStageResume';

let visibility: DocumentVisibilityState;
beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
});

/** The element as the helper sees it — jsdom's media stubs are not involved. */
function fakeVideo(opts: { paused: boolean; stream: boolean }) {
    const play = vi.fn(() => Promise.resolve());
    const v = {
        paused: opts.paused,
        srcObject: opts.stream ? new MediaStream() : null,
        play,
    } as unknown as HTMLVideoElement;
    return { v, play };
}

function goVisible() {
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
}
function goHidden() {
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
}

let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; });

describe('installBackgroundResume', () => {
    /** POSITIVE CONTROL for every "does nothing" case below: the same rig,
     *  the same events, and the nudge IS observable. */
    it('plays a paused, stream-bound video when the app becomes visible', () => {
        const { v, play } = fakeVideo({ paused: true, stream: true });
        uninstall = installBackgroundResume(() => v);
        goHidden();
        expect(play).not.toHaveBeenCalled();   // never while still hidden
        goVisible();
        expect(play).toHaveBeenCalledTimes(1);
    });

    it('does not fight the platform pause while the app is hidden', () => {
        const { v, play } = fakeVideo({ paused: true, stream: true });
        uninstall = installBackgroundResume(() => v);
        goHidden();
        goHidden();
        expect(play).not.toHaveBeenCalled();
    });

    it('leaves a playing video alone — the nudge undoes a pause, nothing else', () => {
        const { v, play } = fakeVideo({ paused: false, stream: true });
        uninstall = installBackgroundResume(() => v);
        goVisible();
        expect(play).not.toHaveBeenCalled();
    });

    it('does not play an element with no stream bound', () => {
        const { v, play } = fakeVideo({ paused: true, stream: false });
        uninstall = installBackgroundResume(() => v);
        goVisible();
        expect(play).not.toHaveBeenCalled();
    });

    it('survives the video ref being gone (session ended mid-background)', () => {
        uninstall = installBackgroundResume(() => null);
        expect(() => goVisible()).not.toThrow();
    });

    it('a rejected play() is swallowed, not an unhandled rejection', async () => {
        const play = vi.fn(() => Promise.reject(new Error('AbortError')));
        const v = {
            paused: true, srcObject: new MediaStream(), play,
        } as unknown as HTMLVideoElement;
        uninstall = installBackgroundResume(() => v);
        goVisible();
        expect(play).toHaveBeenCalledTimes(1);
        // Let the rejection settle inside the helper's catch; an escape here
        // fails the run via vitest's unhandled-rejection reporter.
        await new Promise(r => setTimeout(r, 0));
    });

    it('uninstalling removes the listener', () => {
        const { v, play } = fakeVideo({ paused: true, stream: true });
        const un = installBackgroundResume(() => v);
        un();
        goVisible();
        expect(play).not.toHaveBeenCalled();
    });
});

/**
 * The onForeground duty, added in 0.8.44. The 0.8.43 play() nudge shipped and
 * the field report SURVIVED it: Android can freeze the process with the
 * element never paused while the decoder loses its reference state — and with
 * the agent's infinite GOP nothing recovers unless the controller explicitly
 * asks for a keyframe. That ask hangs off this callback, so the callback must
 * fire on every visible transition with a stream bound, PAUSED OR NOT.
 */
describe('installBackgroundResume onForeground', () => {
    it('fires even when the element was never paused — the exact residual case', () => {
        const { v, play } = fakeVideo({ paused: false, stream: true });
        const onForeground = vi.fn();
        uninstall = installBackgroundResume(() => v, { onForeground });
        goVisible();
        expect(onForeground).toHaveBeenCalledTimes(1);
        expect(play).not.toHaveBeenCalled(); // restraint unchanged
    });

    it('fires alongside the play() nudge when the element IS paused', () => {
        const { v, play } = fakeVideo({ paused: true, stream: true });
        const onForeground = vi.fn();
        uninstall = installBackgroundResume(() => v, { onForeground });
        goVisible();
        expect(onForeground).toHaveBeenCalledTimes(1);
        expect(play).toHaveBeenCalledTimes(1);
    });

    it('does not fire while hidden', () => {
        const { v } = fakeVideo({ paused: false, stream: true });
        const onForeground = vi.fn();
        uninstall = installBackgroundResume(() => v, { onForeground });
        goHidden();
        expect(onForeground).not.toHaveBeenCalled();
    });

    it('does not fire with no stream bound — nothing to refresh', () => {
        const { v } = fakeVideo({ paused: false, stream: false });
        const onForeground = vi.fn();
        uninstall = installBackgroundResume(() => v, { onForeground });
        goVisible();
        expect(onForeground).not.toHaveBeenCalled();
    });

    it('is removed by the uninstaller', () => {
        const { v } = fakeVideo({ paused: false, stream: true });
        const onForeground = vi.fn();
        const un = installBackgroundResume(() => v, { onForeground });
        un();
        goVisible();
        expect(onForeground).not.toHaveBeenCalled();
    });
});

/**
 * The multi-video variant, for the voice-channel stages: StreamStage's tile
 * map, the PiP, camera tiles. Same duty, many elements, and the collection is
 * read AT VISIBILITY TIME so dynamic tile sets need no registration. No
 * onForeground here — voice media comes from browser encoders whose decoders
 * recover via their own PLI; the platform pause is the only dead end.
 */
describe('installBackgroundResumeAll', () => {
    it('plays exactly the paused, stream-bound videos of a mixed set', () => {
        const paused = fakeVideo({ paused: true, stream: true });
        const playing = fakeVideo({ paused: false, stream: true });
        const unbound = fakeVideo({ paused: true, stream: false });
        uninstall = installBackgroundResumeAll(() => [paused.v, playing.v, unbound.v, null]);
        goVisible();
        expect(paused.play).toHaveBeenCalledTimes(1);
        expect(playing.play).not.toHaveBeenCalled();
        expect(unbound.play).not.toHaveBeenCalled();
    });

    it('does nothing while hidden', () => {
        const a = fakeVideo({ paused: true, stream: true });
        uninstall = installBackgroundResumeAll(() => [a.v]);
        goHidden();
        expect(a.play).not.toHaveBeenCalled();
    });

    it('reads the collection at visibility time — late tiles are covered', () => {
        const tiles: HTMLVideoElement[] = [];
        uninstall = installBackgroundResumeAll(() => tiles);
        const late = fakeVideo({ paused: true, stream: true });
        tiles.push(late.v); // mounted AFTER install
        goVisible();
        expect(late.play).toHaveBeenCalledTimes(1);
    });

    it('is removed by the uninstaller', () => {
        const a = fakeVideo({ paused: true, stream: true });
        const un = installBackgroundResumeAll(() => [a.v]);
        un();
        goVisible();
        expect(a.play).not.toHaveBeenCalled();
    });
});
