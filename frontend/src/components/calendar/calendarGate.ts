/**
 * The ONE gate between the phone calendar and the desktop one, shared by JS
 * and CSS (docs/DESIGN_PHILOSOPHY.md §2): the native shell, or the coarse-
 * pointer query Calendar.css uses verbatim. Under it there is no week time
 * grid (the month shows dots and the selected day's list instead) and drag
 * starts only after a long press.
 */
import { useSyncExternalStore } from 'react';
import { isMobile as isNativeMobile } from '../../api/platform';

/** Keep in step with the `@media` block at the bottom of Calendar.css. */
export const COARSE_QUERY = '(pointer: coarse) and (max-width: 1024px)';

function subscribe(cb: () => void): () => void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const mq = window.matchMedia(COARSE_QUERY);
    mq.addEventListener('change', cb);
    return () => mq.removeEventListener('change', cb);
}

function snapshot(): boolean {
    if (isNativeMobile()) return true;
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(COARSE_QUERY).matches;
}

export function useCoarseCalendar(): boolean {
    return useSyncExternalStore(subscribe, snapshot, () => false);
}
