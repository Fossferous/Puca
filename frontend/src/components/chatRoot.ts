/**
 * The chat's root element (`.chat-container`), for a bar mounted OUTSIDE
 * Chat that has to be stacked among Chat's own layers: the way back to a
 * minimised remote-control session (DeviceStageReturn.tsx).
 *
 * WHY. In the phone layout mobile.css fixes `.chat-container` to the screen,
 * and a fixed element is a stacking context of its own, z-index or not.
 * Everything Chat draws is stacked INSIDE it (its dialogs at z 1000 to 2000,
 * the bottom bar at 300, the panels below that: docs/DESIGN_PHILOSOPHY.md's
 * table), and the whole of it sits at level 0 of the page. An element
 * outside it with any z-index above 0 is therefore drawn over ALL of Chat,
 * every dialog and backdrop included, and a z from that table means nothing
 * there: the strip at z 250 beside Chat covered the foot of the member
 * profile sheet, of Edit Channel and of Settings, and took the taps meant for
 * them (e2e/return-pill-live.mjs, `dialogs`). Rendered into this element
 * instead, a bar is one more entry in the table: over the panels, under the
 * bottom bar's z and every dialog. On a desktop `.chat-container` is no
 * stacking context, and drawing into it changes nothing.
 *
 * Chat hands its element over with a ref (`setChatRoot`), so nothing has to
 * look for it by class name, and when there is no Chat on the page (still
 * loading, its error card, a test) there is no root: `useChatRoot()` is null
 * and the bar is drawn where it is mounted.
 */
import { useSyncExternalStore } from 'react';

let root: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** Chat's ref on `.chat-container`: the element while it is mounted, null after. */
export function setChatRoot(el: HTMLElement | null): void {
    if (root === el) return;
    root = el;
    for (const l of [...listeners]) l();
}

/** The chat's root element now (null with no Chat on the page). */
export function currentChatRoot(): HTMLElement | null {
    return root;
}

function subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

/** The chat's root element, re-rendering when Chat mounts or unmounts it. */
export function useChatRoot(): HTMLElement | null {
    return useSyncExternalStore(subscribe, currentChatRoot, () => null);
}
