import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useDragReorder — pointer-based drag-and-drop reordering for a linear group
 * of elements (one axis). Used by the Tasks tab bar (horizontal) and the
 * checklist TaskTree (vertical). HTML5 drag-and-drop is a dead end on touch,
 * so this is built on Pointer Events and works for mouse, pen and touch.
 *
 * Contract with the view:
 *  - Draggable items carry `data-drag-key` (unique string) and optionally
 *    `data-drag-group`; a drag only reorders among items with the SAME group
 *    value inside the container. Elements without the attribute (pinned tabs,
 *    completed rows) are invisible to the drag.
 *  - Spread `onPointerDown` on the container and attach `containerRef` to it.
 *    The container (or an ancestor) is the scroller; give it
 *    `position: relative` so the indicator the view renders from
 *    `state.indicator` (content coordinates) lands correctly.
 *  - The dragged element is styled with direct inline-style writes (transform/
 *    opacity), which survive React re-renders because these elements render no
 *    `style` prop. "Something is dragging" UI comes from `state`.
 *
 * Touch modes:
 *  - `touchHoldMs > 0` (tab bar): long-press lifts the item, then moving drags
 *    it; moving before the hold elapses cancels in favour of native scrolling.
 *    Holding still through the browser's own long-press still opens the
 *    context menu — the hook only suppresses `contextmenu` once a real drag
 *    has begun.
 *  - `touchHoldMs = 0` (grip handle): the drag starts on a small movement
 *    threshold, same as mouse. Give the handle `touch-action: none` in CSS so
 *    the browser never claims the gesture for scrolling.
 */

export interface DragIndicator {
    /** Content-coordinate rect (relative to the container's content box, i.e.
     *  offset by its scroll) for the insertion line. */
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DragReorderState {
    /** Key + group of the item being dragged, or null when idle. */
    dragging: { key: string; group: string } | null;
    indicator: DragIndicator | null;
    /** Perpendicular travel quantized by `crossStepPx` (0 without it, or
     *  idle). W4 drag-to-nest: a rightward step over a task row means "nest
     *  under the row above", leftward "un-nest" — the VIEW decides what a
     *  step means; the hook only measures. Unclamped: consumers clamp. */
    crossSteps: number;
}

export interface DragDropEvent {
    key: string;
    group: string;
    /** Keys of the group in visual order, WITHOUT the dragged item. */
    order: string[];
    /** Index in `order` where the dragged item was dropped. */
    insertAt: number;
    /** Raw perpendicular pointer travel at the drop, in px (axis 'y' →
     *  horizontal travel, positive right). Tabs and other one-axis consumers
     *  simply ignore it. */
    crossDelta: number;
}

interface UseDragReorderOptions {
    axis: 'x' | 'y';
    /** Drags only start from a child matching this selector (the grip handle).
     *  Unset = the whole item is a handle. */
    handleSelector?: string;
    /** Touch only: hold-still time before the item lifts. 0 = threshold drag. */
    touchHoldMs?: number;
    /** Quantum for `state.crossSteps` re-renders. Unset = perpendicular
     *  travel never triggers a state update (the tab bar's behaviour,
     *  unchanged). */
    crossStepPx?: number;
    onDrop: (e: DragDropEvent) => void;
    enabled?: boolean;
}

interface MeasuredItem {
    key: string;
    el: HTMLElement;
    /** Content-coordinate start along the drag axis. */
    start: number;
    size: number;
    mid: number;
}

interface Session {
    key: string;
    group: string;
    el: HTMLElement;
    pointerId: number;
    isTouch: boolean;
    startClient: { x: number; y: number };
    lastClient: { x: number; y: number };
    /** Pointer's content coordinate along the axis at drag start. */
    startContent: number;
    lifted: boolean;
    dragging: boolean;
    holdTimer: number | null;
    raf: number | null;
    items: MeasuredItem[];
    /** Index of the dragged item among `items` (which include it). */
    fromIndex: number;
    /** Insertion index among the items EXCLUDING the dragged one. */
    insertAt: number;
    /** Quantized perpendicular travel (see DragReorderState.crossSteps). */
    crossSteps: number;
    scroller: HTMLElement;
    cleanup: (() => void)[];
}

/** Nearest ancestor (inclusive) that actually scrolls along the axis. */
function findScroller(el: HTMLElement, axis: 'x' | 'y'): HTMLElement {
    let cur: HTMLElement | null = el;
    while (cur && cur !== document.body) {
        const style = getComputedStyle(cur);
        const overflow = axis === 'x' ? style.overflowX : style.overflowY;
        const canScroll = axis === 'x'
            ? cur.scrollWidth > cur.clientWidth
            : cur.scrollHeight > cur.clientHeight;
        if ((overflow === 'auto' || overflow === 'scroll') && canScroll) return cur;
        cur = cur.parentElement;
    }
    return el;
}

const DRAG_THRESHOLD_PX = 5;
const TOUCH_CANCEL_SLOP_PX = 8;
const EDGE_ZONE_PX = 48;
const MAX_EDGE_SCROLL_PX = 14;

// The drag-active body class is page-global while hook instances are not
// (every TaskTree card mounts one). Refcounted so a drag ending in one
// instance can't strip the class out from under a drag still live in
// another (two fingers, two containers).
let liveDragCount = 0;
function markDragLive() {
    liveDragCount++;
    document.body.classList.add('drag-reorder-active');
}
function unmarkDragLive() {
    liveDragCount = Math.max(0, liveDragCount - 1);
    if (liveDragCount === 0) document.body.classList.remove('drag-reorder-active');
}

export function useDragReorder(opts: UseDragReorderOptions) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [state, setState] = useState<DragReorderState>({ dragging: null, indicator: null, crossSteps: 0 });
    const session = useRef<Session | null>(null);
    // Latest options without re-binding listeners mid-drag.
    const optsRef = useRef(opts);
    useEffect(() => { optsRef.current = opts; });

    // Callback ref (a function, not the ref object). CONSUMERS MUST
    // DESTRUCTURE the hook's result: passing `hook.setContainer` to a JSX
    // `ref` makes the react-hooks/refs lint infer the WHOLE returned object
    // is a ref and flag every `hook.state` read in render as an error.
    // Destructured bindings keep the taint on setContainer alone.
    const setContainer = useCallback((el: HTMLDivElement | null) => {
        containerRef.current = el;
    }, []);

    const axisCoord = (p: { x: number; y: number }) => (optsRef.current.axis === 'x' ? p.x : p.y);

    /** Pointer's content coordinate along the axis, recomputed against the
     *  container's CURRENT rect+scroll so ancestor/edge scrolling stays true. */
    const toContent = (client: { x: number; y: number }): number => {
        const c = containerRef.current!;
        const rect = c.getBoundingClientRect();
        return optsRef.current.axis === 'x'
            ? client.x - rect.left + c.scrollLeft
            : client.y - rect.top + c.scrollTop;
    };

    const teardown = (commit: boolean) => {
        const s = session.current;
        if (!s) return;
        session.current = null;
        if (s.holdTimer !== null) window.clearTimeout(s.holdTimer);
        if (s.raf !== null) cancelAnimationFrame(s.raf);
        for (const fn of s.cleanup) fn();
        s.el.style.transform = '';
        s.el.style.opacity = '';
        s.el.style.zIndex = '';
        if (s.dragging) unmarkDragLive();
        setState({ dragging: null, indicator: null, crossSteps: 0 });

        // An indent at the SAME slot is a real drop now (nest under the row
        // above without moving), so crossSteps alone can commit.
        if (commit && s.dragging && (s.insertAt !== s.fromIndex || s.crossSteps !== 0)) {
            const order = s.items.filter((_, i) => i !== s.fromIndex).map(it => it.key);
            const cross = optsRef.current.axis === 'y'
                ? s.lastClient.x - s.startClient.x
                : s.lastClient.y - s.startClient.y;
            optsRef.current.onDrop({ key: s.key, group: s.group, order, insertAt: s.insertAt, crossDelta: cross });
        }
        // The browser fires a click on the source element right after
        // pointerup; a drag released over a tab must not double as a tab
        // click. Commit-path only: a pointercancel or Escape abort produces
        // no ghost click, and the swallow (window capture, 250ms) would eat
        // the user's NEXT unrelated click instead.
        if (commit && s.dragging) {
            const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
            window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 250);
        }
    };

    const measureAndLift = (s: Session): boolean => {
        const c = containerRef.current;
        if (!c) return false;
        const rect = c.getBoundingClientRect();
        const nodes = Array.from(c.querySelectorAll<HTMLElement>('[data-drag-key]'))
            .filter(el => (el.dataset.dragGroup ?? '') === s.group);
        if (nodes.length < 2) return false;
        const axis = optsRef.current.axis;
        s.items = nodes.map(el => {
            const r = el.getBoundingClientRect();
            const start = axis === 'x'
                ? r.left - rect.left + c.scrollLeft
                : r.top - rect.top + c.scrollTop;
            const size = axis === 'x' ? r.width : r.height;
            return { key: el.dataset.dragKey!, el, start, size, mid: start + size / 2 };
        }).sort((a, b) => a.start - b.start);
        s.fromIndex = s.items.findIndex(it => it.key === s.key);
        if (s.fromIndex < 0) return false;
        s.insertAt = s.fromIndex;
        s.crossSteps = 0;
        s.startContent = toContent(s.lastClient);
        s.dragging = true;
        s.el.style.opacity = '0.45';
        s.el.style.zIndex = '5';
        markDragLive();
        setState({ dragging: { key: s.key, group: s.group }, indicator: null, crossSteps: 0 });
        return true;
    };

    const update = (s: Session) => {
        const c = containerRef.current;
        if (!c || !s.dragging) return;
        const axis = optsRef.current.axis;
        const pointer = toContent(s.lastClient);
        s.el.style.transform = axis === 'x'
            ? `translateX(${pointer - s.startContent}px)`
            : `translateY(${pointer - s.startContent}px)`;

        const others = s.items.filter((_, i) => i !== s.fromIndex);
        let insertAt = 0;
        for (const it of others) if (it.mid < pointer) insertAt++;
        const step = optsRef.current.crossStepPx;
        const crossNow = step
            ? Math.trunc((axis === 'y'
                ? s.lastClient.x - s.startClient.x
                : s.lastClient.y - s.startClient.y) / step)
            : 0;
        if (insertAt !== s.insertAt || crossNow !== s.crossSteps) {
            s.insertAt = insertAt;
            s.crossSteps = crossNow;
            if (insertAt === s.fromIndex && crossNow === 0) {
                // Back at its own slot with no indent — a drop changes nothing.
                setState({ dragging: { key: s.key, group: s.group }, indicator: null, crossSteps: 0 });
            } else {
                // Line position: before the item now at insertAt, or after the last.
                const linePos = insertAt < others.length
                    ? others[insertAt].start - 2
                    : others[others.length - 1].start + others[others.length - 1].size;
                const indicator: DragIndicator = axis === 'x'
                    ? { x: linePos, y: 2, width: 2, height: Math.max(c.clientHeight - 4, 8) }
                    : { x: 4, y: linePos, width: Math.max(c.clientWidth - 8, 8), height: 2 };
                setState({ dragging: { key: s.key, group: s.group }, indicator, crossSteps: crossNow });
            }
        }

        // Edge auto-scroll on the real scroller (may be an ancestor).
        const sc = s.scroller;
        const scRect = sc.getBoundingClientRect();
        const client = axisCoord(s.lastClient);
        const [lo, hi] = axis === 'x' ? [scRect.left, scRect.right] : [scRect.top, scRect.bottom];
        let delta = 0;
        if (client < lo + EDGE_ZONE_PX) {
            delta = -Math.min(MAX_EDGE_SCROLL_PX, Math.ceil((lo + EDGE_ZONE_PX - client) / 4));
        } else if (client > hi - EDGE_ZONE_PX) {
            delta = Math.min(MAX_EDGE_SCROLL_PX, Math.ceil((client - (hi - EDGE_ZONE_PX)) / 4));
        }
        if (delta !== 0) {
            if (axis === 'x') sc.scrollLeft += delta;
            else sc.scrollTop += delta;
        }
    };

    const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
        const o = optsRef.current;
        if (o.enabled === false || session.current) return;
        if (e.button !== 0) return; // right-click stays a context menu
        const c = containerRef.current;
        if (!c) return;
        const target = e.target as Element;
        const itemEl = target.closest<HTMLElement>('[data-drag-key]');
        if (!itemEl || !c.contains(itemEl)) return;
        if (o.handleSelector && !target.closest(o.handleSelector)) return;

        const isTouch = e.pointerType === 'touch';
        const s: Session = {
            key: itemEl.dataset.dragKey!,
            group: itemEl.dataset.dragGroup ?? '',
            el: itemEl,
            pointerId: e.pointerId,
            isTouch,
            startClient: { x: e.clientX, y: e.clientY },
            lastClient: { x: e.clientX, y: e.clientY },
            startContent: 0,
            lifted: false,
            dragging: false,
            holdTimer: null,
            raf: null,
            items: [],
            fromIndex: 0,
            insertAt: 0,
            crossSteps: 0,
            scroller: findScroller(c, o.axis),
            cleanup: [],
        };
        session.current = s;

        const holdMs = isTouch ? (o.touchHoldMs ?? 0) : 0;
        if (holdMs > 0) {
            s.holdTimer = window.setTimeout(() => {
                if (session.current === s) {
                    s.lifted = true;
                    s.el.style.opacity = '0.7';
                }
            }, holdMs);
        } else {
            s.lifted = true; // threshold drag (mouse, or touch on a handle)
        }

        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== s.pointerId) return;
            s.lastClient = { x: ev.clientX, y: ev.clientY };
            if (!s.dragging) {
                const dx = ev.clientX - s.startClient.x;
                const dy = ev.clientY - s.startClient.y;
                const dist = Math.hypot(dx, dy);
                if (!s.lifted) {
                    // Waiting out a touch hold: real movement means a scroll.
                    if (dist > TOUCH_CANCEL_SLOP_PX) teardown(false);
                    return;
                }
                if (dist > DRAG_THRESHOLD_PX && !measureAndLift(s)) {
                    teardown(false);
                    return;
                }
            }
            if (s.dragging) update(s);
        };
        const onUp = (ev: PointerEvent) => {
            if (ev.pointerId !== s.pointerId) return;
            teardown(true);
        };
        const onCancel = (ev: PointerEvent) => {
            if (ev.pointerId !== s.pointerId) return;
            teardown(false);
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') teardown(false);
        };
        // Once a drag is live: stop the browser from turning the gesture into
        // a scroll (needs a NON-passive touchmove) and from opening the
        // long-press context menu mid-drag.
        const onTouchMove = (ev: TouchEvent) => {
            if (s.dragging) ev.preventDefault();
        };
        const onCtx = (ev: Event) => {
            // Mid-drag long-press: preventDefault kills the NATIVE menu, but
            // the app's own ContextMenu opens from a React onContextMenu on
            // the tab — stopPropagation (window capture runs first) keeps the
            // event from ever reaching it.
            if (s.dragging) {
                ev.preventDefault();
                ev.stopPropagation();
            }
        };

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('keydown', onKey);
        window.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('contextmenu', onCtx, { capture: true });
        s.cleanup.push(
            () => window.removeEventListener('pointermove', onMove),
            () => window.removeEventListener('pointerup', onUp),
            () => window.removeEventListener('pointercancel', onCancel),
            () => window.removeEventListener('keydown', onKey),
            () => window.removeEventListener('touchmove', onTouchMove),
            () => window.removeEventListener('contextmenu', onCtx, { capture: true }),
        );

        // rAF loop: keeps edge auto-scroll flowing while the pointer holds
        // still inside the edge zone (no pointermove events fire then).
        const loop = () => {
            if (session.current !== s) return;
            if (s.dragging) update(s);
            s.raf = requestAnimationFrame(loop);
        };
        s.raf = requestAnimationFrame(loop);
    };

    // Abort any live session on unmount.
    useEffect(() => () => teardown(false), []);

    return { setContainer, state, onPointerDown };
}
