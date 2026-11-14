/**
 * Where the keyboard's focus goes when a view takes the place of the control
 * that had it, and gives that place back: the camera's self-view going full
 * screen and coming back. The self-view (and its menu button, which opened
 * the menu whose Full screen was pressed) is not drawn while full screen is,
 * and full screen's own buttons are not drawn once it closes, so the focus was
 * left on nothing (the page's body): the next Tab started from the top of the
 * page, and a screen reader said nothing of the view that had just opened.
 *
 * As it opens, `into` takes the focus; as it closes, `back` does. Only when
 * the focus was LOST meanwhile (on nothing, or on an element no longer in the
 * page): a focus somewhere else on purpose is left where it is.
 */
import { useEffect, useRef } from 'react';

const lost = (): boolean => {
    const at = document.activeElement;
    return !at || at === document.body || !at.isConnected;
};

export function useFocusAcrossTakeover(open: boolean, into: () => HTMLElement | null, back: () => HTMLElement | null): void {
    const was = useRef(open);
    // The latest getters, for the effect below (it runs on `open` alone).
    const getters = useRef({ into, back });
    useEffect(() => { getters.current = { into, back }; });
    useEffect(() => {
        if (open === was.current) return;
        was.current = open;
        if (!lost()) return;
        (open ? getters.current.into() : getters.current.back())?.focus({ preventScroll: true });
    }, [open]);
}
