/**
 * The visibility signal the device-session watchdogs are corroborated against.
 *
 * Reported 2026-08-14: after a phone was locked for hours, a remote session sat
 * on "Waiting for the device's screen…" indefinitely and never produced the
 * honest error it has, and the app would not reconnect until it was force-quit.
 * Both follow from `document.visibilityState` reporting 'hidden' while the user
 * is looking at the app: every watchdog defers on that flag, and each one
 * re-armed without limit.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    appIsBackgrounded,
    pageIsPainting,
    __setPaintProbeForTests,
} from '../api/devices/pagePainting';

function setVisibility(state: 'visible' | 'hidden'): void {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
    });
}

beforeEach(() => {
    setVisibility('visible');
    __setPaintProbeForTests({ running: false, lastFrameAt: 0 });
});

describe('is this page actually on screen', () => {
    it('believes a hidden flag when no frames are arriving', () => {
        // The case the deferral exists for and must keep working: genuinely
        // backgrounded. Firing a watchdog here is what used to tear down
        // sessions that were about to resume.
        setVisibility('hidden');
        __setPaintProbeForTests({ running: true, lastFrameAt: Date.now() - 60_000 });
        expect(appIsBackgrounded()).toBe(true);
    });

    it('does NOT believe a hidden flag while frames are still arriving', () => {
        // THE REGRESSION. A WebView reporting 'hidden' while it paints is
        // lying, and believing it deferred every watchdog for ever — the
        // reported "grey forever, no error".
        setVisibility('hidden');
        __setPaintProbeForTests({ running: true, lastFrameAt: Date.now() });
        expect(appIsBackgrounded()).toBe(false);
    });

    it('is never backgrounded while the flag says visible', () => {
        setVisibility('visible');
        __setPaintProbeForTests({ running: true, lastFrameAt: Date.now() - 60_000 });
        expect(appIsBackgrounded()).toBe(false);
    });

    it('falls back to the flag alone where there is no rAF to measure', () => {
        // jsdom/SSR: inventing a visibility signal we cannot measure would be
        // worse than deferring to the only one that exists.
        setVisibility('hidden');
        __setPaintProbeForTests({ running: false, lastFrameAt: 0 });
        expect(pageIsPainting()).toBe(false);
        expect(appIsBackgrounded()).toBe(true);
    });

    it('treats a stale frame as not painting', () => {
        __setPaintProbeForTests({ running: true, lastFrameAt: Date.now() - 10_000 });
        expect(pageIsPainting()).toBe(false);
        __setPaintProbeForTests({ running: true, lastFrameAt: Date.now() });
        expect(pageIsPainting()).toBe(true);
    });
});

describe('noticing a resume without visibilitychange', () => {
    it('fires subscribers when frames restart after a gap', async () => {
        // The half that fixes the reconnect: when `visibilitychange` is never
        // delivered, frames restarting is the only remaining evidence that the
        // app is back, and it is what triggers the socket heal.
        vi.resetModules();
        // The probe SAMPLES: an interval asks for one frame, and the frame
        // callback is what proves painting. Drive both by hand.
        let frame: FrameRequestCallback | null = null;
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            frame = cb;
            return 1;
        });
        vi.stubGlobal('setInterval', () => 1 as unknown as ReturnType<typeof setInterval>);
        const mod = await import('../api/devices/pagePainting');
        const resumed = vi.fn();
        mod.onPaintResumed(resumed);
        mod.installPaintProbe(); // requests the first frame

        // First frame: establishes a baseline, nothing to report yet.
        frame?.(0);
        expect(resumed).not.toHaveBeenCalled();

        // Frames stop for a long time (screen locked), then restart.
        mod.__setPaintProbeForTests({ running: true, lastFrameAt: Date.now() - 60_000 });
        frame?.(0);
        expect(resumed).toHaveBeenCalledTimes(1);

        // A normal next frame is not a resume.
        frame?.(0);
        expect(resumed).toHaveBeenCalledTimes(1);

        vi.unstubAllGlobals();
    });
});
