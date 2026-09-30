import { useCallback, useEffect, useState } from 'react';

/** How long the Share button may say "starting" with nothing live: past
 *  WebView2's 5 s first-frame wait with room to spare, short of forever. */
export const SHARE_STARTING_MAX_MS = 30_000;

/**
 * The Share button's "starting" state, from the click until the share is live
 * or abandoned.
 *
 * WHY. WebView2 holds a window capture for up to 5 s after the picker closes,
 * waiting for the window's first frame (WebRTC's WgcCaptureSession,
 * kFirstFrameTimeoutMs = 5000; measured 4.3 s on the owner's backgrounded
 * game, 2026-09-30, while everything Púca does after it took 144 ms). That
 * wait cannot be skipped from here, so the button shows the share as on at
 * once and nobody sits wondering whether the click took.
 *
 * `showing` is true only while nothing is live yet. `end()` is for every
 * other way out (cancelled picker, a failed or refused go-live, the dialog
 * closing); the backstop clears it anyway if nothing answers, so the button
 * can never be stuck ignoring clicks.
 */
export function useShareStarting(isLive: boolean, maxMs = SHARE_STARTING_MAX_MS) {
    const [starting, setStarting] = useState(false);
    // Going live finishes the start, so stopping the share later cannot bring
    // "starting" back. Adjusted during render (React's "storing information
    // from previous renders" pattern), not in an effect.
    const [wasLive, setWasLive] = useState(isLive);
    if (isLive !== wasLive) {
        setWasLive(isLive);
        if (isLive) setStarting(false);
    }
    useEffect(() => {
        if (!starting || isLive) return;
        const t = setTimeout(() => setStarting(false), maxMs);
        return () => clearTimeout(t);
    }, [starting, isLive, maxMs]);
    const begin = useCallback(() => setStarting(true), []);
    const end = useCallback(() => setStarting(false), []);
    return { showing: starting && !isLive, begin, end };
}
