/**
 * Where a subtree's dialogs, pickers, menus and snackbars are portaled, and
 * whether that place is on the screen.
 *
 * document.body everywhere, except inside Púca Notes mounted in the desktop
 * app (components/NotesDesktopView.tsx), which provides a layer INSIDE its
 * own view. That view stays mounted but hidden while the person is elsewhere
 * in the app, and a note editor, an Undo bar or a colour picker portaled to
 * the body would stay on screen over the chat. In the view's layer they hide
 * with it, and stack inside its z-band rather than over the app's own
 * dialogs.
 *
 * A context, not a prop: the portals sit several components deep (a picture
 * opened from a note, a date picked from a reminder), and the components are
 * shared with Púca's own Tasks view, which provides nothing and keeps the
 * body.
 */
import { createContext, useContext } from 'react';

export const PortalTargetContext = createContext<HTMLElement | null>(null);

export function usePortalTarget(): HTMLElement {
    return useContext(PortalTargetContext) ?? document.body;
}

/**
 * Whether that layer is on the screen. True everywhere — Notes' own page and
 * its Android app included, where the page itself going to the background is
 * what takes it off (`visibilitychange`) — except inside Notes in the desktop
 * app while the person is in another view: the view stays mounted, hidden,
 * and the window is still in front, so no page event says so.
 * NotesDesktopView provides it beside the layer.
 *
 * Whatever only the foreground may hold lets go while it is false:
 *  - the voice recorder's microphone (notes/components/AudioRecorder.tsx,
 *    "FOREGROUND ONLY");
 *  - the keyboard. A dialog, menu or picker left open in the hidden view — a
 *    picture opened from a note, a schedule, a half-made drawing, left there
 *    by a toast click — listens for keys only while it is on screen. Each
 *    takes Escape in the capture phase and stops it, so one nobody can see
 *    would close itself on an Escape meant for the chat (or ask "Discard the
 *    changes to this drawing?" over it) and swallow the key before Púca's own
 *    handlers — remote control's "Escape always revokes" among them
 *    (api/remoteControl.ts) — ever saw it. Back on screen it is still open,
 *    and listens again.
 */
export const LayerOnScreenContext = createContext(true);

export function useLayerOnScreen(): boolean {
    return useContext(LayerOnScreenContext);
}

/**
 * Something else is on top of `el`: asked of the page itself, by what is at
 * its centre, so no list of the app's dozens of modals has to be kept in
 * step with it. One of the app's dialogs over Notes in the desktop app is;
 * so is Notes hidden, which `visibility: hidden` takes out of hit-testing.
 */
export function coveredAt(el: HTMLElement): boolean {
    // jsdom has no layout; there is nothing on top of anything there.
    if (typeof document.elementFromPoint !== 'function') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return top !== null && !el.contains(top);
}
