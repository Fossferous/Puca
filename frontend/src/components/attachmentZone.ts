/**
 * Where a message attachment is relative to the screen: whether it is near
 * enough to be shown (held), how soon it should load, and whether it may have
 * a live media player.
 *
 * WHY. EncryptedAttachment (components/MessageContent.tsx) used to fetch and
 * decrypt every attachment in a channel's history the moment it rendered, all
 * at once, oldest first. Measured 2026-10-05 in headless Edge with a channel
 * of 12 x 22.5 MB videos:
 *  - the two on screen (the newest, at the bottom) were ready LAST: 23.5 s at
 *    100 Mbit (the oldest, off screen, at 12.4 s), 3.8 s unthrottled;
 *  - the renderer grew from 65 MB to 630-830 MB while they decrypted;
 *  - every decrypted copy stayed in memory until sign-out: +257 MB per such
 *    channel opened, 515 MB after two, none ever given back.
 * Loading stays automatic, with no click: what is on screen first (the part
 * that will stay in view first, loadUrgency), then the nearest, two big files
 * at a time (api/attachments.ts); an attachment within LOAD_MARGIN of the
 * screen is shown, one further away is loaded AHEAD into a budget and shown
 * the moment it comes near; one that scrolls far away again, or whose channel
 * is left, gives its copy back (kept within a budget, so coming back is
 * instant). Measured the same way after: the two on screen ready in 5.6-6.0 s
 * at 100 Mbit (2.7-2.9 s unthrottled), the renderer at 320-380 MB, and every
 * video ready as a reader scrolled up to it 10 s later, as before. In the
 * Android WebView (emulator): 17.4 s before, 5.2 s after.
 *
 * At most MAX_LIVE_PLAYERS video or audio players, the closest to the screen,
 * are mounted at once; every one ON the screen always is, and one in use
 * always keeps its player. Measured at 100 Mbit after a reader scrolled up
 * through the 12: with a player for every video near the screen, the whole
 * browser held 1.3-1.5 GB, and 1.2-1.5 GB ten seconds later (two runs); with
 * the closest four, 0.9-1.0 GB (three runs), as with all 12 mounted from the
 * start before (0.9 GB). Each player mounted on the way decodes its first
 * frame, and one taken away frees its frames only when it is collected.
 *
 * The scroller is the attachment's nearest scrolling ancestor (the message
 * list), not the window: an IntersectionObserver rooted at the viewport would
 * clip the target by that scroller and ignore the margin.
 *
 * No IntersectionObserver (an old WebView, jsdom): everything is "near" and
 * every player is granted, which is exactly the old behaviour.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Show what is within this much of the visible list, above and below. */
export const LOAD_MARGIN = '200%';
/** Live <video>/<audio> players at once, unless more than this are on screen. */
export const MAX_LIVE_PLAYERS = 4;

const hasIO = () => typeof IntersectionObserver !== 'undefined';

/** The nearest ancestor that scrolls vertically, or null (the viewport). */
export function scrollRootOf(el: Element): Element | null {
    for (let p = el.parentElement; p; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return p;
    }
    return null;
}

/** Pixels between `el` and the visible part of `root` (0 when they overlap). */
function distanceToScreen(el: Element | null, root: Element | null): number {
    if (!el || !el.isConnected) return Number.MAX_SAFE_INTEGER;
    const r = el.getBoundingClientRect();
    const top = root ? root.getBoundingClientRect().top : 0;
    const bottom = root ? root.getBoundingClientRect().bottom : window.innerHeight;
    if (r.bottom < top) return top - r.bottom;
    if (r.top > bottom) return r.top - bottom;
    return 0;
}

/** Within this of its end, the message list counts as sitting at the newest
 *  message (Chat.tsx's AT_BOTTOM_SLOP: it re-pins to the bottom as it grows). */
const AT_END_SLOP = 120;

/**
 * How soon the attachment in `el` should load: lower first. Off screen, the
 * nearer first, and always after everything on screen. On screen, the one
 * that will STAY in view first: while the list sits at its newest message,
 * the lowest (each file that arrives grows its row and pushes everything above
 * it up and out); scrolled back up, the highest (the browser holds that part
 * still as rows below it grow).
 *
 * Measured 2026-10-05 in Edge at 100 Mbit: ranked by distance alone, a
 * channel opening onto 12 videos had ten of them on screen at once (every one
 * still a 30 px "Loading" chip), so the order they had asked in (oldest
 * first) decided — and the two left in view at the end came last, 20.6 s.
 */
export function loadUrgency(el: Element | null, root: Element | null): number {
    if (!el || !el.isConnected) return Number.MAX_SAFE_INTEGER;
    const r = el.getBoundingClientRect();
    const rr = root?.getBoundingClientRect();
    const top = rr ? rr.top : 0;
    const bottom = rr ? rr.bottom : window.innerHeight;
    const view = Math.max(0, bottom - top);
    if (r.bottom < top) return view + (top - r.bottom);
    if (r.top > bottom) return view + (r.top - bottom);
    const sc = root ?? document.scrollingElement;
    const atEnd = !sc || sc.scrollHeight - sc.scrollTop - sc.clientHeight <= AT_END_SLOP;
    return Math.min(view, Math.max(0, atEnd ? bottom - r.bottom : r.top - top));
}

/** An attachment's on-screen box, kept so its placeholder can hold the space. */
export interface ShownSize { width: number; height: number }
export type MeasureShown = (el: Element) => ShownSize | null;

interface PlayerCandidate {
    el: () => Element | null;
    busy: () => boolean;
    granted: boolean;
    setGranted: (granted: boolean) => void;
}

/** One per scroller: one IntersectionObserver for every attachment in it,
 *  and the player ranking. */
class RootWatch {
    readonly root: Element | null;
    private io: IntersectionObserver;
    private slots = new Map<Element, (near: boolean) => void>();
    private players = new Set<PlayerCandidate>();
    private frame = 0;
    private readonly onScroll = () => {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => { this.frame = 0; this.rank(); });
    };

    constructor(root: Element | null) {
        this.root = root;
        this.io = new IntersectionObserver((entries) => {
            for (const e of entries) this.slots.get(e.target)?.(e.isIntersecting);
        }, { root, rootMargin: `${LOAD_MARGIN} 0px` });
    }

    get empty(): boolean { return this.slots.size === 0 && this.players.size === 0; }

    watch(el: Element, cb: (near: boolean) => void): void {
        this.slots.set(el, cb);
        this.io.observe(el);
    }

    unwatch(el: Element): void {
        this.slots.delete(el);
        this.io.unobserve(el);
    }

    addPlayer(c: PlayerCandidate): void {
        if (this.players.size === 0) {
            (this.root ?? window).addEventListener('scroll', this.onScroll, { passive: true });
            window.addEventListener('resize', this.onScroll);
        }
        this.players.add(c);
        this.rank();
    }

    removePlayer(c: PlayerCandidate): void {
        this.players.delete(c);
        if (this.players.size === 0) {
            (this.root ?? window).removeEventListener('scroll', this.onScroll);
            window.removeEventListener('resize', this.onScroll);
            if (this.frame) { cancelAnimationFrame(this.frame); this.frame = 0; }
        } else {
            this.rank();
        }
    }

    /** The closest MAX_LIVE_PLAYERS keep (or get) a player; every one on
     *  screen and every busy one does regardless. */
    rank(): void {
        const order = [...this.players]
            .map((c) => ({ c, d: distanceToScreen(c.el(), this.root) }))
            .sort((a, b) => a.d - b.d);
        let live = 0;
        for (const { c, d } of order) {
            const grant = c.busy() || d === 0 || live < MAX_LIVE_PLAYERS;
            if (grant) live++;
            if (grant !== c.granted) {
                c.granted = grant;
                c.setGranted(grant);
            }
        }
    }

    dispose(): void {
        this.io.disconnect();
    }
}

const watches = new Map<Element | null, RootWatch>();

function watchFor(root: Element | null): RootWatch {
    let w = watches.get(root);
    if (!w) { w = new RootWatch(root); watches.set(root, w); }
    return w;
}

function dropIfEmpty(w: RootWatch): void {
    if (w.empty && watches.get(w.root) === w) {
        w.dispose();
        watches.delete(w.root);
    }
}

/** useAttachmentZone's answer. */
export interface AttachmentZone {
    /** Within LOAD_MARGIN of the screen. */
    near: boolean;
    /** What `measure` said the last time it went OUT of range (null until
     *  then), so its owner can keep that space while it shows nothing — out
     *  there, and again on the way back until it is shown: nothing shifts. */
    size: ShownSize | null;
    /** The observer has placed it at least once: `near: false` is now a
     *  fact, not the not-yet-known that every attachment starts as. */
    placed: boolean;
}

/** Is `el` within LOAD_MARGIN of the screen? See AttachmentZone. */
export function useAttachmentZone(el: Element | null, measure?: MeasureShown): AttachmentZone {
    const [state, setState] = useState<AttachmentZone>(() => ({ near: !hasIO(), size: null, placed: !hasIO() }));
    const measureRef = useRef(measure);
    useEffect(() => { measureRef.current = measure; }, [measure]);
    useEffect(() => {
        if (!el || !hasIO()) return;
        const w = watchFor(scrollRootOf(el));
        w.watch(el, (near) => {
            if (near) {
                setState((s) => (s.near && s.placed ? s : { near: true, size: s.size, placed: true }));
                return;
            }
            // Measured now, while whatever it shows is still on the page; a
            // placeholder that cannot be measured keeps the size it holds.
            const size = measureRef.current?.(el) ?? null;
            setState((s) => (!s.near && s.placed ? s : { near: false, size: s.near ? (size ?? s.size) : s.size, placed: true }));
        });
        return () => { w.unwatch(el); dropIfEmpty(w); };
    }, [el]);
    return state;
}

/**
 * May the attachment in `el` mount its <video>/<audio> now? Only asked while
 * it `wants` one (its file is here and near). `busy` (playing) always keeps
 * it. `size` is what `measure` said when its player was last taken away.
 */
export function usePlayerGrant(el: Element | null, wants: boolean, busy: boolean, measure?: MeasureShown): { granted: boolean; size: ShownSize | null } {
    const io = hasIO();
    // Not granted until ranked (in a layout effect, so before anything is
    // painted): a player mounted for even one commit starts loading its file.
    const [state, setState] = useState<{ granted: boolean; size: ShownSize | null }>({ granted: !io, size: null });
    // The registration lives as long as the wish; the element, the busy flag
    // and the measure are read live, so the re-render that swaps a player for
    // its placeholder (a new element) does not register anything again.
    const elRef = useRef(el);
    const busyRef = useRef(busy);
    const measureRef = useRef(measure);
    const candRef = useRef<{ w: RootWatch; c: PlayerCandidate } | null>(null);
    useLayoutEffect(() => {
        elRef.current = el;
        busyRef.current = busy;
        measureRef.current = measure;
        candRef.current?.w.rank();
    }, [el, busy, measure]);
    const haveEl = !!el;
    useLayoutEffect(() => {
        const first = elRef.current;
        if (!wants || !first || !io) return;
        const w = watchFor(scrollRootOf(first));
        const c: PlayerCandidate = {
            el: () => elRef.current,
            busy: () => busyRef.current,
            granted: false,
            setGranted: (granted) => {
                const cur = elRef.current;
                setState({ granted, size: granted || !cur ? null : (measureRef.current?.(cur) ?? null) });
            },
        };
        candRef.current = { w, c };
        w.addPlayer(c);
        return () => {
            candRef.current = null;
            w.removePlayer(c);
            dropIfEmpty(w);
            // The next wish is ranked again before it shows anything.
            setState((s) => (s.granted ? { granted: false, size: null } : s));
        };
    }, [wants, haveEl, io]);
    return state;
}

/** Test hook: the live watchers (one per scroller in use). */
export function __attachmentZoneWatchCount(): number {
    return watches.size;
}
