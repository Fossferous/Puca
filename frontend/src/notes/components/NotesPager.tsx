/**
 * The notes pager: a tab strip and a horizontal snap scroller over "All
 * notes" + one page per label — Google Tasks' swipe between lists, with
 * Google Keep's vertical scroll inside each page.
 *
 * THE BROWSER OWNS THE GESTURE. There is no JS gesture code here and there
 * must never be: the scroller is `overflow-x: auto` + `scroll-snap-type: x
 * mandatory`, so a swipe, a trackpad flick, a shift-wheel and a keyboard
 * scroll all behave exactly as the platform's own, including the rubber band
 * at the ends and the interrupted fling. All this component does is
 *
 *   route  -> scroll   (the rail, a tab, a deep link, the back button)
 *   scroll -> route    (a swipe that settled somewhere else)
 *
 * without the two chasing each other: the settle handler navigates only when
 * the page it settled on is NOT the one the route already names, and the
 * alignment effect scrolls only when the scroller is not already there. A
 * programmatic scroll therefore ends in a settle that finds nothing to do.
 * (`scrollend` is used where it exists — Chrome 114+ — and a 120 ms debounce
 * on `scroll` carries the older WebViews that do not have it.)
 *
 * MOUNTING. The active page always holds a real grid. Its neighbours get one
 * only while the pager is MOVING under a real gesture, and give it back a
 * moment after it settles. Keeping all three mounted at rest was the first
 * cut and it is wrong here: a note carrying a label is in the DOM twice (its
 * label page and All), which doubles the decrypt/render cost of every note
 * that has a label and makes "how many cards are on screen" unanswerable —
 * the app's own walk asks that question about thirty times. Mounting on the
 * first scroll event costs at most one frame of empty page at the very edge
 * of the incoming card, which is a sliver a few pixels wide.
 *
 * A page that is neither active nor mounted is `visibility: hidden` (notes.css)
 * — out of the accessibility tree and the tab order, exactly as the closed
 * rail drawer is, so a screen reader and Tab never walk pages nobody asked
 * for.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { type NotesPage } from '../model/notesPages';

/** Quiet time after the last scroll event that counts as "it has settled".
 *  Short enough to feel immediate, long enough to sit out a snap animation's
 *  final frames on a slow device. */
const SETTLE_MS = 120;
/** A programmatic smooth scroll emits events for ~300 ms; this is the belt to
 *  that braces, in case an engine performs one silently. */
const PROGRAMMATIC_MS = 600;

const tabId = (key: string) => `notes-page-tab-${key}`;
const panelId = (key: string) => `notes-page-panel-${key}`;

/** Move without animation? The OS preference, or Púca's own Animations
 *  setting (settingsStore writes `data-animations` on the root). */
function instantOnly(): boolean {
    try {
        if (document.documentElement.getAttribute('data-animations') === 'false') return true;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

interface TabsProps {
    pages: NotesPage[];
    /** The page the ROUTE names. */
    index: number;
    onSelect: (index: number) => void;
}

/**
 * The strip above the pager: one tab per page, the active one marked and
 * scrolled into view. Roving tabindex with Left/Right/Home/End, per the ARIA
 * tabs pattern — and every tab is also a plain button, so the tap, the click
 * and the keyboard all do the same thing.
 */
export function NotesPagesTabs({ pages, index, onSelect }: TabsProps) {
    const stripRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

    // Keep the active tab in view. Scrolling the STRIP itself, never
    // scrollIntoView(): that walks every scrollable ancestor, and one of them
    // is the page's own vertical scroller.
    useEffect(() => {
        const strip = stripRef.current;
        const el = tabRefs.current[index];
        if (!strip || !el) return;
        const pad = 8;
        const left = el.offsetLeft - pad;
        const right = el.offsetLeft + el.offsetWidth + pad;
        const behavior = instantOnly() ? 'auto' : 'smooth';
        if (left < strip.scrollLeft) strip.scrollTo({ left, behavior });
        else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollTo({ left: right - strip.clientWidth, behavior });
    }, [index, pages.length]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        const last = pages.length - 1;
        let next = -1;
        if (e.key === 'ArrowRight') next = Math.min(index + 1, last);
        else if (e.key === 'ArrowLeft') next = Math.max(index - 1, 0);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = last;
        if (next < 0) return;
        e.preventDefault();
        if (next !== index) onSelect(next);
        tabRefs.current[next]?.focus();
    };

    return (
        <div className="notes-pages-tabs" role="tablist" aria-label="Note lists" ref={stripRef} onKeyDown={onKeyDown}>
            {pages.map((p, i) => (
                <button
                    key={p.key}
                    ref={el => { tabRefs.current[i] = el; }}
                    type="button"
                    role="tab"
                    id={tabId(p.key)}
                    aria-controls={panelId(p.key)}
                    aria-selected={i === index}
                    tabIndex={i === index ? 0 : -1}
                    className={`notes-pages-tab ${i === index ? 'active' : ''}`}
                    onClick={() => onSelect(i)}
                >
                    {p.label}
                </button>
            ))}
        </div>
    );
}

interface PagerProps {
    pages: NotesPage[];
    /** The page the ROUTE names. */
    index: number;
    /** A scroll settled on a different page: the owner navigates (replace). */
    onSettle: (index: number) => void;
    /** One page's content. `live` false = render nothing; the page is an
     *  empty box of the same width, holding its slot in the scroller. */
    children: (page: NotesPage, live: boolean, active: boolean) => ReactNode;
}

export function NotesPager({ pages, index, onSettle, children }: PagerProps) {
    const elRef = useRef<HTMLDivElement>(null);
    const indexRef = useRef(index);
    const firstRef = useRef(true);
    const timerRef = useRef<number | undefined>(undefined);
    const programmatic = useRef(false);
    const movingRef = useRef(false);
    const [moving, setMoving] = useState(false);
    // Each page's vertical scroll position, so coming back to a list does not
    // throw away where you were reading. Written on every vertical scroll
    // (a ref, so it costs nothing) rather than on unmount, whose ordering
    // against the DOM removal that zeroes scrollTop is not ours to assume.
    const [tops] = useState(() => new Map<string, number>());

    useEffect(() => { indexRef.current = index; }, [index]);
    const settleRef = useRef(onSettle);
    useEffect(() => { settleRef.current = onSettle; }, [onSettle]);

    const settle = useCallback(() => {
        const el = elRef.current;
        if (!el) return;
        const w = el.clientWidth;
        if (w <= 0) return;
        programmatic.current = false;
        if (movingRef.current) { movingRef.current = false; setMoving(false); }
        const landed = Math.round(el.scrollLeft / w);
        // Only when it is somewhere else: a programmatic scroll lands on the
        // page the route already names and this is a no-op, which is what
        // keeps route and scroll from chasing each other. A programmatic
        // scroll the USER interrupted lands somewhere else and is honoured,
        // which is the right answer for that too.
        if (landed !== indexRef.current) settleRef.current(landed);
    }, []);

    const schedule = useCallback((ms: number) => {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(settle, ms);
    }, [settle]);

    // Route -> scroll. Instant on the first alignment (a deep link must LAND
    // on its page, never fly to it) and whenever motion is turned off;
    // smooth after that, so a tap on a tab reads as movement between lists.
    useEffect(() => {
        const el = elRef.current;
        if (!el) return;
        const w = el.clientWidth;
        if (w <= 0) return;
        const want = index * w;
        const first = firstRef.current;
        firstRef.current = false;
        if (Math.abs(el.scrollLeft - want) <= 2) return;
        programmatic.current = true;
        el.scrollTo({ left: want, behavior: first || instantOnly() ? 'auto' : 'smooth' });
        schedule(PROGRAMMATIC_MS);
    }, [index, pages.length, schedule]);

    // Scroll -> route, once it has stopped moving.
    const onScroll = useCallback(() => {
        if (!programmatic.current && !movingRef.current) { movingRef.current = true; setMoving(true); }
        schedule(SETTLE_MS);
    }, [schedule]);
    const onScrollEnd = useCallback(() => { schedule(0); }, [schedule]);
    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    // A width change (the window, the rail opening on a narrow desktop) moves
    // every page: re-align to the one the route names, instantly, or the
    // scroller is left between two pages.
    useEffect(() => {
        const el = elRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            const w = el.clientWidth;
            if (w <= 0) return;
            const want = indexRef.current * w;
            if (Math.abs(el.scrollLeft - want) <= 1) return;
            programmatic.current = true;
            el.scrollLeft = want;
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return (
        <div className={`notes-pager ${moving ? 'moving' : ''}`} ref={elRef} onScroll={onScroll} onScrollEnd={onScrollEnd}>
            {pages.map((p, i) => {
                const active = i === index;
                const live = active || (moving && Math.abs(i - index) === 1);
                return (
                    <Page
                        key={p.key}
                        page={p}
                        active={active}
                        live={live}
                        tops={tops}
                    >
                        {children(p, live, active)}
                    </Page>
                );
            })}
        </div>
    );
}

interface PageProps {
    page: NotesPage;
    active: boolean;
    live: boolean;
    tops: Map<string, number>;
    children: ReactNode;
}

function Page({ page, active, live, tops, children }: PageProps) {
    const ref = useRef<HTMLDivElement>(null);
    // Put the reading position back the moment the content exists again, in
    // a LAYOUT effect so nobody ever sees the top of the list first.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || !live) return;
        const top = tops.get(page.key) ?? 0;
        if (top > 0 && el.scrollTop !== top) el.scrollTop = top;
    }, [live, page.key, tops]);
    return (
        <div
            ref={ref}
            className={`notes-page ${active ? 'active' : ''} ${live ? 'live' : ''}`}
            role="tabpanel"
            id={panelId(page.key)}
            /* aria-label, not aria-labelledby: the name is the same string the
               tab carries, and a tab that has scrolled out of the strip is
               still in the DOM either way — but one attribute cannot go stale
               against the other. */
            aria-label={page.label}
            data-page={page.key}
            onScroll={e => { tops.set(page.key, e.currentTarget.scrollTop); }}
        >
            {children}
        </div>
    );
}
