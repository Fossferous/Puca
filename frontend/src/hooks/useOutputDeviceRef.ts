/**
 * A ref for a media player that the component ALSO reads through a RefObject
 * (to attach a source, to call play()): fills `ref` like `ref={ref}` would,
 * and keeps the element on Settings > Output Device while it is mounted
 * (settingsStore's followOutputDevice). Elements nobody else reads can use
 * the plain `followOutputDeviceRef` instead — no hook needed.
 *
 * Stable across renders, so React attaches it once per element. It returns
 * a cleanup (React 19), which React calls INSTEAD of ref(null) — so the
 * cleanup clears `ref` itself.
 */
import { useCallback, type RefObject } from 'react';
import { followOutputDevice } from '../components/settingsStore';

export function useOutputDeviceRef<T extends HTMLMediaElement>(
    ref: RefObject<T | null>,
): (el: T | null) => (() => void) | undefined {
    return useCallback((el: T | null) => {
        ref.current = el;
        if (!el) return undefined;
        const stop = followOutputDevice(el);
        return () => {
            stop();
            if (ref.current === el) ref.current = null;
        };
    }, [ref]);
}
