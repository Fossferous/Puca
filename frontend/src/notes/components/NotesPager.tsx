/**
 * The notes pager: a tab strip and a horizontal snap scroller over "All
 * notes" + one page per label — Google Tasks' swipe between lists, with
 * Google Keep's vertical scroll inside each page.
 *
 * THE BROWSER OWNS THE GESTURE. There is no JS gesture code here and there
 * must never be: the scroller is `overflow-x: auto` + `scroll-snap-type: x
 * mandatory`, so a swipe, a trackpad flick, a shift-wheel and a keyboard
 * scroll all behave exactly as the platform's own, including the rubber band
 * at the ends and the interrupted fling. Each page is also a `scroll-snap-stop:
 * always` stop (notes.css), which is what holds a fast flick to ONE list: the
 * browser, not this file, refuses to carry momentum past a page. The
 * scrollTo/scrollLeft calls below are end-position scrolls, which that rule
 * does not stop, so a tab still jumps straight to its list. All this
 * component does is
 *
 *   route  -> scroll   (the rail, a tab, a deep link, the back button)
 *   scroll -> route    (a swipe that settled somewhere else)
 *
 * without the two chasing each other: the settle handler navigates only when
 * the page it settled on is NOT the one the route already names, and the
 * alignment effect scrolls only when the scroller is not already there. A
 * programmatic scroll therefore ends in a settle that finds nothing to do.
 *
 * WHEN it has settled is the browser's `scrollend` wherever that exists
 * (Chrome 114+, and the Android System WebView that updates with it) — and
 * ONLY scrollend there. The first cut also ran a 120 ms debounce on `scroll`
 * alongside it, and that debounce fired while a finger was still on the
 * glass: measured with real touch events, a pause of ~130 ms mid-swipe
 * "settled" at scrollLeft 265 of 390, navigated, and would have started a
 * programmatic scroll under the finger. The debounce is now the fallback for
 * WebViews without scrollend only, and no settle happens while a touch is
 * down in either case. After a lift (or a scroll the pager started) a
 * backstop settle is armed that every further scroll event pushes back: it
 * fires only when the browser went quiet WITHOUT a scrollend — measured once,
 * a hold-then-lift that left the pager between two pages with no snap at all
 * — and then puts the pager on the page it mostly shows.
 *
 * MOUNTING. A page holds a real grid when it is the active one, when any part
 * of it is ON SCREEN, or when something being typed in it has the focus.
 * Everything else is an empty box of the same width. "On screen" is read
 * from the scroll position, not the route, which is what makes both
 * directions right:
 *
 *   - a SWIPE: the page being swiped towards gets its grid on the first
 *     scroll event, while only a sliver of it shows;
 *   - a TAP on a tab: the route moves first, but the page being LEFT is still
 *     on screen, so it slides out with its notes instead of going blank (the
 *     first cut keyed this on the route and the old page emptied the instant
 *     the tab was tapped — reproduced in a mid-slide screenshot);
 *   - the FOCUS: a trackpad flick while "Take a note…" is open moves All off
 *     screen without a click, and unmounting it would throw the half-typed
 *     note away (reproduced: the draft was gone on the way back). A page
 *     whose composer or text field has the focus stays mounted until the
 *     focus leaves.
 *
 * Keeping every neighbour mounted at rest was the first cut and it is wrong
 * here: a note carrying a label is in the DOM twice (its label page and All),
 * which doubles the render cost of every note that has a label and makes "how
 * many cards are on screen" unanswerable — the app's own walk asks that
 * question about thirty times.
 *
 * A page that holds no grid is `visibility: hidden` (notes.css) — out of the
 * accessibility tree and the tab order, exactly as the closed rail drawer is,
 * so a screen reader and Tab never walk pages nobody asked for.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { pageDomId, pagesOnScreen, type NotesPage } from '../model/notesPages';

/** Does this engine fire `scrollend`? Where it does, that event says
 *  "settled" (plus the armed backstop for a quiet end with none); where it
 *  does not, the SETTLE_MS debounce does. */
const HAS_SCROLLEND = typeof window !== 'undefined' && 'onscrollend' in window;
/** Fallback only: quiet time after the last scroll event that counts as
 *  "it has settled". Short enough to feel immediate, long enough to sit out a
 *  snap animation's final frames on a slow device. */
const SETTLE_MS = 120;
/** Fallback: the same, while a scroll the pager started itself (a tab, the
 *  rail, the back button) is still on its way — a smooth scroll runs for
 *  ~300 ms and a busy phone can pause inside it for longer than SETTLE_MS.
 *  Settling there would navigate to the page it happened to be passing.
 *  Everywhere: the quiet time for the armed backstop (see `armed`). */
const PROGRAMMATIC_MS = 600;

const tabId = (key: string) => `notes-page-tab-${pageDomId(key)}`;
const panelId = (key: string) => `notes-page-panel-${pageDomId(key)}`;

/**
 * The pager's width, FRACTIONAL — which is how wide every page is. Never
 * clientWidth: that is rounded to a whole pixel, and a page's offset is
 * index × the true width, so the error grows by the fraction on every page.
 * Measured on a Pixel-class phone (411.43 px, clientWidth 411): from page 4
 * on, the NEXT list counted as on screen at rest and held a real grid; at
 * 125% scaling (clientWidth rounding up) the PREVIOUS one did, ahead of the
 * active page in the tab order. The pager and its ancestors carry no
 * transform, so the box's width is the layout width.
 */
function pagerWidth(el: HTMLElement): number {
    const w = el.getBoundingClientRect().width;
    return w > 0 ? w : el.clientWidth;
}

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
    const firstRef = useRef(true);

    // Keep the active tab in view. Scrolling the STRIP itself, never
    // scrollIntoView(): that walks every scrollable ancestor, and one of them
    // is the pager. Instant the first time (a deep link to the tenth label
    // must not open with the strip gliding across), smooth after.
    useEffect(() => {
        const strip = stripRef.current;
        const el = tabRefs.current[index];
        if (!strip || !el) return;
        const pad = 8;
        const left = el.offsetLeft - pad;
        const right = el.offsetLeft + el.offsetWidth + pad;
        const behavior: ScrollBehavior = firstRef.current || instantOnly() ? 'instant' : 'smooth';
        firstRef.current = false;
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

/** The pages any part of which is on screen, as "first:last" (state wants
 *  a primitive, so an unchanged range is an unchanged value). */
function onScreenOf(el: HTMLElement): string | null {
    const r = pagesOnScreen(el.scrollLeft, pagerWidth(el));
    return r ? `${r[0]}:${r[1]}` : null;
}

/** Is the focus somewhere a half-made thing lives — the composer, or a field
 *  you type into? Only then does it keep its page mounted: a ticked checkbox
 *  or a pressed button keeps the focus too, and holding a page for those
 *  would leave every list you ever touched rendered off screen. */
const TYPED = new Set(['text', 'search', 'url', 'email', 'tel', 'number', 'password', 'date', 'datetime-local', 'time']);
function holdsADraft(a: HTMLElement): boolean {
    if (a.closest('.notes-quickadd')) return true;
    if (a.isContentEditable || a instanceof HTMLTextAreaElement) return true;
    return a instanceof HTMLInputElement && TYPED.has(a.type);
}

export function NotesPager({ pages, index, onSettle, children }: PagerProps) {
    const elRef = useRef<HTMLDivElement>(null);
    const indexRef = useRef(index);
    const firstRef = useRef(true);
    const shapeRef = useRef('');
    const timerRef = useRef<number | undefined>(undefined);
    /** A scroll the pager started is still travelling (see PROGRAMMATIC_MS). */
    const travelling = useRef(false);
    /** A finger is on the pager: nothing has settled while it is. */
    const touching = useRef(false);
    /** A backstop settle is armed (after a lift, or a scroll we started):
     *  every scroll event pushes it back, scrollend replaces it. */
    const armed = useRef(false);
    // What is on screen: seeded with the page the route names, which is where
    // the first alignment puts the scroller before anything is painted.
    const [onScreen, setOnScreen] = useState(() => `${index}:${index}`);
    // The page whose composer or text field holds the focus (its key).
    const [held, setHeld] = useState<string | null>(null);
    // Each page's vertical scroll position, so coming back to a list does not
    // throw away where you were reading. Written on every vertical scroll of
    // a page that holds its grid (a plain map, so it costs nothing) rather
    // than on unmount, whose ordering against the DOM removal that zeroes
    // scrollTop is not ours to assume — and NOT from the scroll event that
    // zeroing fires (see Page).
    const [tops] = useState(() => new Map<string, number>());

    useEffect(() => { indexRef.current = index; }, [index]);
    const settleRef = useRef(onSettle);
    useEffect(() => { settleRef.current = onSettle; }, [onSettle]);

    const measure = useCallback(() => {
        const el = elRef.current;
        const next = el ? onScreenOf(el) : null;
        if (next !== null) setOnScreen(prev => (prev === next ? prev : next));
    }, []);

    const syncHeld = useCallback(() => {
        const el = elRef.current;
        const a = document.activeElement;
        const key = el && a instanceof HTMLElement && el.contains(a) && holdsADraft(a)
            ? a.closest<HTMLElement>('.notes-page')?.dataset.page ?? null
            : null;
        setHeld(prev => (prev === key ? prev : key));
    }, []);

    const settle = useCallback(() => {
        const el = elRef.current;
        if (!el) return;
        const w = pagerWidth(el);
        if (w <= 0) return;
        // Still held: the lift arms a settle of its own.
        if (touching.current) return;
        armed.current = false;
        travelling.current = false;
        measure();
        // A focused element that was REMOVED (a composer that closed) fires
        // no focusout; re-read the focus here so a page is not held forever.
        syncHeld();
        const landed = Math.round(el.scrollLeft / w);
        // Only when it is somewhere else: a programmatic scroll lands on the
        // page the route already names and this is a no-op, which is what
        // keeps route and scroll from chasing each other. A programmatic
        // scroll the USER interrupted lands somewhere else and is honoured,
        // which is the right answer for that too.
        if (landed !== indexRef.current) settleRef.current(landed);
        else if (Math.abs(el.scrollLeft - landed * w) > 2) {
            // At rest BETWEEN two pages, on the page the route names: the
            // browser did not snap. Measured with real touch events — a
            // finger held still mid-swipe and then lifted left the pager at
            // 495 of 390/780 with no snap and no scrollend. Put it on the
            // page it is mostly showing. (Landing on ANOTHER page needs no
            // such line: the route changes and the alignment effect does it.)
            el.scrollTo({ left: landed * w, behavior: instantOnly() ? 'instant' : 'smooth' });
        }
    }, [measure, syncHeld]);

    const schedule = useCallback((ms: number) => {
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(settle, ms);
    }, [settle]);

    // Route -> scroll, in a LAYOUT effect so it happens before the browser
    // paints: a deep link must LAND on its page, never show All for a frame
    // first. Instant on the first alignment, when the set of pages changed (a
    // label added before this one moves every page along; sliding across
    // them would read as a swipe nobody made) and whenever motion is turned
    // off; smooth after that, so a tap on a tab reads as movement.
    const shape = pages.map(p => p.key).join('\n');
    useLayoutEffect(() => {
        const el = elRef.current;
        if (!el) return;
        const w = pagerWidth(el);
        if (w <= 0) return;
        const want = index * w;
        const instant = firstRef.current || shapeRef.current !== shape || instantOnly();
        firstRef.current = false;
        shapeRef.current = shape;
        if (Math.abs(el.scrollLeft - want) <= 2) return;
        travelling.current = !instant;
        el.scrollTo({ left: want, behavior: instant ? 'instant' : 'smooth' });
        armed.current = true;
        schedule(PROGRAMMATIC_MS);
    }, [index, shape, schedule]);

    // Scroll -> route, once it has stopped moving.
    const onScroll = useCallback(() => {
        measure();
        if (!HAS_SCROLLEND) schedule(travelling.current ? PROGRAMMATIC_MS : SETTLE_MS);
        else if (armed.current) schedule(PROGRAMMATIC_MS);
    }, [measure, schedule]);
    const onScrollEnd = useCallback(() => {
        // A user scroll only ENDS once the finger is off the glass (a held
        // pause mid-swipe fired none), so this is also the word that no touch
        // is down — which un-sticks `touching` if a touchend never reached
        // the pager (its target was removed from the page mid-gesture).
        touching.current = false;
        schedule(0);
    }, [schedule]);
    // Watching, not handling: the touch events are passive and nothing here
    // moves anything. They only say when a finger is down, so a pause in the
    // middle of a swipe is never taken for the end of it.
    const onTouchStart = useCallback(() => { touching.current = true; }, []);
    const onTouchEnd = useCallback((e: React.TouchEvent) => {
        touching.current = e.touches.length > 0;
        if (touching.current) return;
        // Without scrollend, the lift starts the quiet period. With it, the
        // snap after the lift ends in its own scrollend (which replaces this
        // timer); the backstop only matters when no scroll follows at all —
        // a finger lifted exactly on a page, or a snap the browser skipped.
        armed.current = true;
        schedule(HAS_SCROLLEND ? PROGRAMMATIC_MS : SETTLE_MS);
    }, [schedule]);
    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    // Focus in or out anywhere: which page (if any) holds it now. focusout
    // runs before the next element is focused, so it is read a tick later.
    useEffect(() => {
        let t: number | undefined;
        const onIn = () => syncHeld();
        const onOut = () => { window.clearTimeout(t); t = window.setTimeout(syncHeld, 0); };
        document.addEventListener('focusin', onIn);
        document.addEventListener('focusout', onOut);
        return () => {
            window.clearTimeout(t);
            document.removeEventListener('focusin', onIn);
            document.removeEventListener('focusout', onOut);
        };
    }, [syncHeld]);

    // A width change (the window, the rail opening on a narrow desktop) moves
    // every page: re-align to the one the route names, instantly, or the
    // scroller is left between two pages.
    useEffect(() => {
        const el = elRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => {
            const w = pagerWidth(el);
            if (w <= 0) return;
            const want = indexRef.current * w;
            if (Math.abs(el.scrollLeft - want) <= 1) return;
            el.scrollLeft = want;
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const [first, last] = onScreen.split(':').map(Number);
    return (
        <div
            className="notes-pager"
            ref={elRef}
            onScroll={onScroll}
            onScrollEnd={onScrollEnd}
            onTouchStart={onTouchStart}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
        >
            {pages.map((p, i) => {
                const active = i === index;
                const live = active || (i >= first && i <= last) || p.key === held;
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
            /* Only a page holding its grid has a reading position. When the
               grid goes, the emptied page is clamped to scrollTop 0 and the
               browser reports that with a scroll event of its own, a frame
               after React committed `live` false — recording it replaced the
               real position with 0 every time, so a list always came back at
               its top (measured: 240 saved, 0 restored). */
            onScroll={e => { if (live) tops.set(page.key, e.currentTarget.scrollTop); }}
        >
            {children}
        </div>
    );
}
