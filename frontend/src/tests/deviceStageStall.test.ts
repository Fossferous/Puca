/**
 * The stall watchdog must fire for a genuinely stalled decoder and for
 * NOTHING else. The false-positive bound is the load-bearing part: a still
 * remote desktop legitimately produces zero frames (the agent's pump returns
 * NoChange), so an over-eager watchdog would fire IDR requests at an idle
 * machine forever. Dormancy outside the resume window, and every per-tick
 * guard, each get their own test — with a positive control proving the rig
 * can see a firing at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installStallWatchdog, STALL_MS, RESUME_WINDOW_MS, type StallWatchdog } from '../components/deviceStageStall';

let visibility: DocumentVisibilityState;
beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => visibility,
    });
});
afterEach(() => {
    watchdog?.uninstall();
    watchdog = null;
    vi.useRealTimers();
});
let watchdog: StallWatchdog | null = null;

/** A video the watchdog can frame-clock via rVFC, fully under test control. */
function fakeVideo(opts?: { muted?: boolean; trackState?: MediaStreamTrackState; paused?: boolean; readyState?: number }) {
    let frameCb: (() => void) | null = null;
    const track = {
        readyState: opts?.trackState ?? 'live',
        muted: opts?.muted ?? false,
    };
    const v = {
        paused: opts?.paused ?? false,
        readyState: opts?.readyState ?? 4,
        srcObject: { getVideoTracks: () => [track] },
        requestVideoFrameCallback: (cb: () => void) => { frameCb = cb; return 1; },
        cancelVideoFrameCallback: () => { frameCb = null; },
    } as unknown as HTMLVideoElement;
    return {
        v,
        track,
        /** Deliver one decoded frame to the watchdog's clock. */
        frame: () => { frameCb?.(); },
    };
}

function install(v: HTMLVideoElement, onStall: () => void) {
    watchdog = installStallWatchdog(() => v, onStall, { now: () => Date.now() });
    return watchdog;
}

describe('installStallWatchdog', () => {
    /** POSITIVE CONTROL: inside an open window, visible, live unmuted track,
     *  no frames — it fires. Without this, every dormancy test is vacuous. */
    it('fires when frames stop inside the resume window', () => {
        const { v } = fakeVideo();
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        // The watchdog binds the element lazily on its FIRST tick (the ref
        // may be null at install), which resets the frame clock — so the
        // stall threshold runs from that first tick, one interval in.
        vi.advanceTimersByTime(1_000 + STALL_MS + 1_100);
        expect(onStall).toHaveBeenCalled();
    });

    it('stays dormant OUTSIDE the resume window — a still desktop is not a stall', () => {
        const { v } = fakeVideo();
        const onStall = vi.fn();
        install(v, onStall);
        // No openWindow(). An idle desktop produces no frames for minutes.
        vi.advanceTimersByTime(60_000);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('goes quiet again once the window expires', () => {
        const { v } = fakeVideo();
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        vi.advanceTimersByTime(RESUME_WINDOW_MS + 2_000);
        const fired = onStall.mock.calls.length;
        vi.advanceTimersByTime(60_000);
        expect(onStall.mock.calls.length).toBe(fired); // nothing after expiry
    });

    it('does not fire while frames are flowing', () => {
        const { v, frame } = fakeVideo();
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        for (let i = 0; i < 10; i++) {
            vi.advanceTimersByTime(1_000);
            frame();
        }
        expect(onStall).not.toHaveBeenCalled();
    });

    it('does not fire on a MUTED track — no RTP is a transport state, not decoder loss', () => {
        const { v } = fakeVideo({ muted: true });
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        vi.advanceTimersByTime(RESUME_WINDOW_MS - 1);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('does not fire on an ended track, a paused element, or while hidden', () => {
        for (const setup of [
            () => fakeVideo({ trackState: 'ended' as MediaStreamTrackState }),
            () => fakeVideo({ paused: true }),
        ]) {
            const { v } = setup();
            const onStall = vi.fn();
            // Date.now, because vitest's fake timers advance Date but NOT
            // performance.now — the default clock would mix real and fake time.
            const wd = installStallWatchdog(() => v, onStall, { now: () => Date.now() });
            wd.openWindow();
            vi.advanceTimersByTime(RESUME_WINDOW_MS - 1);
            expect(onStall).not.toHaveBeenCalled();
            wd.uninstall();
        }
        const { v } = fakeVideo();
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        visibility = 'hidden';
        vi.advanceTimersByTime(RESUME_WINDOW_MS - 1);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('is capped per window — a dead session cannot IDR-spam the host', () => {
        const { v } = fakeVideo();
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        vi.advanceTimersByTime(RESUME_WINDOW_MS + 5_000);
        expect(onStall.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('never fires without any frame clock (jsdom-class environments)', () => {
        const v = {
            paused: false, readyState: 4,
            srcObject: { getVideoTracks: () => [{ readyState: 'live', muted: false }] },
            // no requestVideoFrameCallback, no getVideoPlaybackQuality
        } as unknown as HTMLVideoElement;
        const onStall = vi.fn();
        install(v, onStall).openWindow();
        vi.advanceTimersByTime(RESUME_WINDOW_MS - 1);
        expect(onStall).not.toHaveBeenCalled();
    });

    it('uninstall stops the ticking', () => {
        const { v } = fakeVideo();
        const onStall = vi.fn();
        const wd = install(v, onStall);
        wd.openWindow();
        wd.uninstall();
        watchdog = null;
        vi.advanceTimersByTime(60_000);
        expect(onStall).not.toHaveBeenCalled();
    });
});
