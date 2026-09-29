/**
 * The query of the route as the HISTORY holds it right now — whichever
 * router Notes is under: the HashRouter of its own page, or the MemoryRouter
 * it gets inside the Púca desktop app (components/NotesDesktopView.tsx).
 *
 * Not `useLocation().search`: React Router renders every navigation inside
 * startTransition, so a note opened a moment ago is already in the history
 * but not yet in the last render. Measured: with the render's query, a card
 * clicked in the same task as a snap's end lost its note 12 times out of 12.
 *
 * Not `window.location.hash` either, which is what this read before Notes
 * could be embedded: that is the hash router's store and nobody else's.
 * Inside the desktop app it is the main app's address, which never carries
 * `?note=`, so every pager settle there closed the note again.
 *
 * Both routers hand their history object down as the navigation context's
 * `navigator`, and its `location` is live. Should a router ever hand down
 * something without one, the last rendered query is the fallback — it is
 * right whenever no navigation is in flight.
 */
import { useCallback, useContext, useEffect, useRef } from 'react';
import { UNSAFE_NavigationContext, useLocation, type Navigator } from 'react-router-dom';

export function useLiveRouteQuery(): () => string {
    const { navigator } = useContext(UNSAFE_NavigationContext);
    const rendered = useLocation().search;
    const renderedRef = useRef(rendered);
    useEffect(() => { renderedRef.current = rendered; }, [rendered]);
    return useCallback(() => {
        const live = (navigator as Navigator & { location?: { search?: unknown } }).location;
        return typeof live?.search === 'string' ? live.search : renderedRef.current;
    }, [navigator]);
}
