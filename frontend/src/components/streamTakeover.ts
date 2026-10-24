/**
 * The stream stage TAKING OVER the screen on a phone (StreamStage.tsx,
 * phoneLandscape.css).
 *
 * Two triggers, one look:
 *  - 'landscape': a phone held sideways (api/phoneSideways.ts: the DEVICE's
 *    orientation, never the viewport's shape) while a stream is on the
 *    stage. At 844 x 390 (less Safari's toolbar in a tab) the chat's header,
 *    composer, voice bar and bottom nav took every pixel and the picture got
 *    none: the iPhone report this exists for ("horizontal mode ... cant even
 *    see the stream at all").
 *  - 'fullscreen': the Fullscreen button, where neither the element nor the
 *    system player can go fullscreen (mediaFullscreen.ts route 3).
 *
 * The stage publishes which one on <html data-stream-takeover>, and the
 * stylesheet keys everything on that attribute alone, so JavaScript is the
 * one place that decides. `data-stream-chrome="hidden"` is the controls
 * overlay hidden by a tap; `data-stream-controlling` is a control session on
 * the stage, which lays the controls out BESIDE the picture instead of over
 * it and never hides them (a tap there is a click on the other computer).
 */
import { useSyncExternalStore } from 'react';
import { phoneSideways, subscribePhoneSideways } from '../api/phoneSideways';

/** How long the takeover's controls stay up after the last interaction (ms). */
export const CHROME_HIDE_MS = 4000;

export type StreamTakeover = 'fullscreen' | 'landscape' | null;

/** Publish the takeover on <html>; returns the cleanup. */
export function publishTakeover(
    takeover: StreamTakeover,
    chromeHidden: boolean,
    controlling = false,
    root: HTMLElement = document.documentElement,
): () => void {
    if (!takeover) return () => {};
    root.dataset.streamTakeover = takeover;
    if (chromeHidden) root.dataset.streamChrome = 'hidden';
    if (controlling) root.dataset.streamControlling = 'true';
    return () => {
        delete root.dataset.streamTakeover;
        delete root.dataset.streamChrome;
        delete root.dataset.streamControlling;
    };
}

/** api/phoneSideways.ts, as React state. */
export function usePhoneSideways(): boolean {
    return useSyncExternalStore(subscribePhoneSideways, phoneSideways, () => false);
}

/** Elements that are the takeover's controls: a focus or a touch inside one
 *  keeps them up. The voice bar is portaled to <body>, outside the stage. */
export function inTakeoverControls(el: Element | null): boolean {
    return !!el?.closest?.('.stream-stage, .voice-panel-compact');
}

/** A stream or a camera holds the whole screen. The chat panel underneath is
 *  not moving with it (phoneLandscape.css turns its slide off), so a swipe
 *  must not change the panel unseen: Chat would come back to another one. */
export function screenTakenOver(root: HTMLElement = document.documentElement): boolean {
    return !!root.dataset.streamTakeover || !!root.dataset.mediaFullscreen;
}
