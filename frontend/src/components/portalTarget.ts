/**
 * Where a subtree's dialogs, pickers, menus and snackbars are portaled.
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
