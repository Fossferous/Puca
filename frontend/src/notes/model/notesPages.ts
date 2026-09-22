/**
 * The pages of the notes pager: "All notes" first, then one page per LABEL,
 * in `allLabels` order (Google Tasks' lists; Google Keep's scroll lives
 * inside each page).
 *
 * Pure on purpose. The pager is a native scroll-snap container — the browser
 * owns the gesture and there is no JS animation to test — so everything that
 * CAN be wrong lives here: which pages exist, which page an address is on,
 * and which address a page index means. The routes are exactly the ones Notes
 * already had (`/` and `/label/<name>`), so a page is a deep link and the rail
 * keeps working unchanged.
 */

/** The All page's key. A label can be called "all"; its key is `label:all`. */
export const ALL_PAGE_KEY = 'all';

export interface NotesPage {
    /** Stable React key (case-folded for labels, as the rail compares them). */
    key: string;
    /** What the tab says. */
    label: string;
    /** The hash route this page IS. */
    route: string;
}

/** The label route for a name — the one the rail and the label chips use. */
export function labelRoute(label: string): string {
    return `/label/${encodeURIComponent(label)}`;
}

/** All notes, then one page per label, in the order given. */
export function pageRoutes(labels: readonly string[]): NotesPage[] {
    return [
        { key: ALL_PAGE_KEY, label: 'All notes', route: '/' },
        ...labels.map(l => ({ key: `label:${l.toLocaleLowerCase()}`, label: l, route: labelRoute(l) })),
    ];
}

/** The label a `/label/<name>` path names, decoded; null for any other path.
 *  A hand-typed or truncated address can carry a malformed escape and
 *  decodeURIComponent THROWS on it — this runs inside a render, where a throw
 *  is the crash screen, so the raw segment is used instead (notesModel's
 *  labelFromPath makes the same promise; this module stays free of it so the
 *  pager's arithmetic can be tested on its own). */
function labelOf(path: string): string | null {
    const m = /^\/label\/(.+)$/.exec(path);
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}

/**
 * Which page `path` is on. `/` — and anything that is not a label address —
 * is page 0. A label address whose label names no page (it was renamed,
 * merged or deleted in another tab, or typed by hand) ALSO answers 0: the
 * pager must land somewhere real, and All is the only page that always
 * exists. Callers that must tell those two apart ask `hasPageForPath`.
 */
export function pageIndexForPath(path: string, labels: readonly string[]): number {
    const label = labelOf(path);
    if (label === null) return 0;
    const want = label.toLocaleLowerCase();
    const i = labels.findIndex(l => l.toLocaleLowerCase() === want);
    return i < 0 ? 0 : i + 1;
}

/** Is there really a page for this address? False for a label that no longer
 *  exists — the shell then shows that route the way it always did (the empty
 *  "No notes labelled X"), rather than a pager sitting on All under an
 *  address naming something else. */
export function hasPageForPath(path: string, labels: readonly string[]): boolean {
    const label = labelOf(path);
    if (label === null) return path === '/';
    const want = label.toLocaleLowerCase();
    return labels.some(l => l.toLocaleLowerCase() === want);
}

/** The address of page `i`, clamped to the pages that exist. */
export function routeForIndex(index: number, labels: readonly string[]): string {
    const pages = pageRoutes(labels);
    const i = Math.min(Math.max(Math.round(index), 0), pages.length - 1);
    return pages[i].route;
}

/**
 * The pages any part of which is on screen, as [first, last], when the pager
 * is scrolled to `scrollLeft` and every page is `width` wide. This is what
 * decides which pages hold a real grid while the pager moves: the one being
 * swiped towards from the first sliver of it, the one being left until the
 * last. One pixel of slack either side, so a scroller resting a sub-pixel off
 * a snap point (fractional device pixels) is ON one page rather than
 * straddling two — which would mount a neighbour at rest for nothing. Null
 * before there is a width to divide by.
 */
export function pagesOnScreen(scrollLeft: number, width: number): [number, number] | null {
    if (!(width > 0)) return null;
    const at = scrollLeft / width;
    const first = Math.max(0, Math.floor(at + 1 / width));
    const last = Math.max(first, Math.ceil(at - 1 / width));
    return [first, last];
}
