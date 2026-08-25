import { useRef } from 'react';

/**
 * Touch swipe detection for mobile navigation. Returns props to spread onto an
 * element ({...useSwipe(...)}). Fires onSwipeLeft/onSwipeRight for a mostly-
 * horizontal drag past `threshold`.
 *
 * Guards (so gestures don't fight the rest of the UI):
 *  - ignores a swipe that STARTS inside a horizontally-scrollable element
 *    (the task tab bar, code blocks, sliders) — that element scrolls instead.
 *  - ignores swipes that start on inputs / textareas / contenteditable.
 *  - only acts on a mostly-horizontal drag (|dx| dominates |dy|) so vertical
 *    scrolling is never hijacked.
 *  - `enabled: false` turns it off (e.g. a modal is open).
 */
interface UseSwipeOptions {
    onSwipeLeft?: () => void;
    onSwipeRight?: () => void;
    enabled?: boolean;
    /** Min horizontal distance (px) to count as a swipe. */
    threshold?: number;
    /** Max duration (ms); slower drags are treated as scrolls, not swipes. */
    maxTime?: number;
}

function startsInBlockedRegion(target: EventTarget | null): boolean {
    let el = target as HTMLElement | null;
    while (el && el !== document.body) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        const style = getComputedStyle(el);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 4) {
            return true; // let this element scroll horizontally instead
        }
        el = el.parentElement;
    }
    return false;
}

export function useSwipe(opts: UseSwipeOptions) {
    const start = useRef<{ x: number; y: number; t: number; blocked: boolean } | null>(null);
    const threshold = opts.threshold ?? 60;
    const maxTime = opts.maxTime ?? 700;

    return {
        onTouchStart: (e: React.TouchEvent) => {
            if (opts.enabled === false || e.touches.length !== 1) { start.current = null; return; }
            const t = e.touches[0];
            start.current = {
                x: t.clientX,
                y: t.clientY,
                t: Date.now(),
                blocked: startsInBlockedRegion(e.target),
            };
        },
        onTouchEnd: (e: React.TouchEvent) => {
            const s = start.current;
            start.current = null;
            if (!s || s.blocked || opts.enabled === false) return;
            const t = e.changedTouches[0];
            if (!t) return;
            const dx = t.clientX - s.x;
            const dy = t.clientY - s.y;
            if (Date.now() - s.t > maxTime) return;
            if (Math.abs(dx) < threshold) return;
            if (Math.abs(dx) < Math.abs(dy) * 1.3) return; // must be mostly horizontal
            if (dx < 0) opts.onSwipeLeft?.();
            else opts.onSwipeRight?.();
        },
    };
}
