import { useCallback, useRef, useState } from 'react';

/**
 * Pull-to-refresh for a scroll container on a touch screen.
 *
 * Returns touch handlers to spread onto the SCROLLING element and a small
 * state object for drawing the pull. Only a touch that starts with the
 * container scrolled to the very top can begin a pull, and the pull only
 * counts while it stays there — so ordinary scrolling never turns into a
 * refresh, and a refresh never steals a scroll.
 *
 * WHY THE INDICATOR IS THE CALLER'S. React attaches its touch listeners
 * passively (React ≥17), so `preventDefault` here would be ignored and there
 * is no way to stop the browser's own overscroll from this side; the caller
 * puts `overscroll-behavior-y: contain` on the container and renders the pull
 * as a spacer whose height is `state.distance`, which pushes the content down
 * without transforms and without fighting the browser. That keeps this hook
 * free of DOM writes and testable in jsdom.
 *
 * Mouse and pen never reach here: these are touch handlers, and on a fine
 * pointer the caller offers a button instead.
 */
export interface PullToRefreshState {
    /** Pixels the content should be pushed down by, 0 when idle. */
    distance: number;
    /** The pull has passed the threshold; letting go will refresh. */
    armed: boolean;
    /** `onRefresh` is running. */
    refreshing: boolean;
}

interface Options {
    onRefresh: () => Promise<unknown> | unknown;
    /** `false` turns the gesture off (a modal is open, the view is busy). */
    enabled?: boolean;
    /** Pull distance (after damping) that commits a refresh. */
    threshold?: number;
    /** The pull stops growing here so a long drag does not push the list off screen. */
    maxPull?: number;
    /** Height the spacer holds while refreshing, so the spinner has a home. */
    refreshingHeight?: number;
    /** Keep the spinner up at least this long — a 60 ms refresh that flashes
     *  reads as "nothing happened". */
    minSpinMs?: number;
}

const IDLE: PullToRefreshState = { distance: 0, armed: false, refreshing: false };

/** A touch that starts here is typing or a control, not a pull. */
function startsOnControl(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null;
    while (el && el !== document.body) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        el = el.parentElement;
    }
    return false;
}

export function usePullToRefresh(opts: Options) {
    const threshold = opts.threshold ?? 64;
    const maxPull = opts.maxPull ?? 110;
    const refreshingHeight = opts.refreshingHeight ?? 44;
    const minSpinMs = opts.minSpinMs ?? 450;
    const enabled = opts.enabled !== false;

    const [state, setState] = useState<PullToRefreshState>(IDLE);
    /** Live tracking, kept out of React state so a 60 Hz drag does not
     *  re-render on every event that changes nothing visible. */
    const track = useRef<{ startY: number; container: HTMLElement; distance: number } | null>(null);
    const refreshingRef = useRef(false);
    /** The latest onRefresh, so a stale closure never runs an old one. */
    const onRefreshRef = useRef(opts.onRefresh);
    onRefreshRef.current = opts.onRefresh;

    const reset = useCallback(() => {
        track.current = null;
        if (!refreshingRef.current) setState(IDLE);
    }, []);

    const commit = useCallback(async () => {
        track.current = null;
        if (refreshingRef.current) return;
        refreshingRef.current = true;
        setState({ distance: refreshingHeight, armed: true, refreshing: true });
        const started = Date.now();
        try {
            await onRefreshRef.current();
        } catch {
            // The caller reports its own failures; the gesture just ends.
        } finally {
            const wait = Math.max(0, minSpinMs - (Date.now() - started));
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
            refreshingRef.current = false;
            setState(IDLE);
        }
    }, [refreshingHeight, minSpinMs]);

    const onTouchStart = useCallback((e: React.TouchEvent<HTMLElement>) => {
        // A second finger landing MID-PULL (a pinch starting) ends the pull.
        // Just nulling the tracker would leave the spacer stuck at its last
        // height — onTouchMove/onTouchEnd both bail on a null tracker without
        // resetting — so snap the indicator back here too.
        if (!enabled || refreshingRef.current || e.touches.length !== 1) {
            track.current = null;
            setState(s => (s.distance === 0 ? s : IDLE));
            return;
        }
        const container = e.currentTarget;
        // Only from the very top. A container mid-scroll is being scrolled,
        // and a downward drag there is a scroll, not a pull.
        if (container.scrollTop > 0) { track.current = null; return; }
        if (startsOnControl(e.target)) { track.current = null; return; }
        track.current = { startY: e.touches[0].clientY, container, distance: 0 };
    }, [enabled]);

    const onTouchMove = useCallback((e: React.TouchEvent<HTMLElement>) => {
        const t = track.current;
        if (!t || e.touches.length !== 1) return;
        // Scrolled away since the touch began (a fast flick that then came
        // back down): this is a scroll now, and it stays one.
        if (t.container.scrollTop > 0) { reset(); return; }
        const dy = e.touches[0].clientY - t.startY;
        if (dy <= 0) {
            if (t.distance !== 0) { t.distance = 0; setState(IDLE); }
            return;
        }
        // Damped: the first pixels move 1:1 so it feels attached, then it
        // gets heavier, and it never passes maxPull.
        const distance = Math.min(maxPull, dy < 40 ? dy : 40 + (dy - 40) * 0.45);
        if (Math.abs(distance - t.distance) < 1) return; // sub-pixel; nothing to draw
        t.distance = distance;
        setState({ distance, armed: distance >= threshold, refreshing: false });
    }, [maxPull, threshold, reset]);

    const onTouchEnd = useCallback(() => {
        const t = track.current;
        if (!t) return;
        if (t.distance >= threshold) void commit();
        else reset();
    }, [threshold, commit, reset]);

    return {
        handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset },
        state,
        threshold,
    };
}
