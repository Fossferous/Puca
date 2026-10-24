/**
 * The stream stage TAKING OVER the screen on a phone (StreamStage.tsx,
 * phoneLandscape.css).
 *
 * Two triggers, one look:
 *  - 'landscape': a phone held sideways while a stream is on the stage. At
 *    844 x 390 (less Safari's toolbar in a tab) the chat's header, composer,
 *    voice bar and bottom nav took every pixel and the picture got none: the
 *    iPhone report this exists for ("horizontal mode ... cant even see the
 *    stream at all").
 *  - 'fullscreen': the Fullscreen button, where neither the element nor the
 *    system player can go fullscreen (mediaFullscreen.ts route 3).
 *
 * The stage publishes which one on <html data-stream-takeover>, and the
 * stylesheet keys everything on that attribute alone, so JavaScript is the
 * one place that decides — no media query in the CSS to drift from this one.
 * `data-stream-chrome="hidden"` is the controls overlay hidden by a tap.
 */
import { useEffect, useState } from 'react';

/**
 * A phone on its side: the phone layout (mobile.css's gate) on a screen too
 * short for the chat AND a picture. 500 px clears every phone in landscape
 * (the tallest, a Pro Max, is 440) and no tablet (the smallest iPad is 744
 * tall sideways).
 */
export const PHONE_LANDSCAPE_QUERY =
    '(pointer: coarse) and (max-width: 1024px) and (orientation: landscape) and (max-height: 500px)';

/** How long the takeover's controls stay up after the last touch (ms). */
export const CHROME_HIDE_MS = 4000;

export type StreamTakeover = 'fullscreen' | 'landscape' | null;

/** Publish the takeover on <html>; returns the cleanup. */
export function publishTakeover(takeover: StreamTakeover, chromeHidden: boolean, root: HTMLElement = document.documentElement): () => void {
    if (!takeover) return () => {};
    root.dataset.streamTakeover = takeover;
    if (chromeHidden) root.dataset.streamChrome = 'hidden';
    return () => {
        delete root.dataset.streamTakeover;
        delete root.dataset.streamChrome;
    };
}

export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() =>
        typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia(query);
        const on = () => setMatches(mq.matches);
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
    }, [query]);
    return matches;
}
