import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useVoiceMemberDrag — drag a PERSON from one voice channel onto another in the
 * sidebar (moderator move).
 *
 * Built on Pointer Events rather than the mouse-event pattern the channel
 * REORDER drag uses (Chat.tsx). That pattern decides its drop target from
 * `onMouseEnter`, which the browser never synthesises while a finger slides —
 * so it silently does nothing on touch. Here the target is hit-tested from the
 * pointer's own coordinates, which works identically for mouse, pen and touch.
 * HTML5 drag-and-drop is not an option at all: WebView2 fires no dragover/drop.
 *
 * Contract with the view:
 *  - Draggable rows carry `data-voice-user`, `data-voice-username` and
 *    `data-voice-from` (the channel id they are currently in).
 *  - Drop targets carry `data-voice-drop` (a channel id).
 *  - Spread `onPointerDown` on a container enclosing both, and attach
 *    `setContainer` to that same element.
 *
 * Touch uses a long-press to lift: moving before the hold elapses is a scroll
 * and cancels the drag, so a sidebar full of draggable rows still scrolls
 * normally under a finger. This is why the rows do NOT get `touch-action:
 * none` — that would trade the feature for the ability to scroll past it.
 */

export interface VoiceDragSubject {
    userId: number;
    username: string;
    fromChannelId: number;
}

export interface VoiceDragState {
    dragging: VoiceDragSubject | null;
    /** Channel currently under the pointer AND a legal destination. */
    overChannelId: number | null;
}

interface Options {
    enabled?: boolean;
    /** Legal destination? Drives both the drop highlight and the commit. */
    canDropOn: (subject: VoiceDragSubject, toChannelId: number) => boolean;
    onDrop: (subject: VoiceDragSubject, toChannelId: number) => void;
}

interface Session {
    subject: VoiceDragSubject;
    el: HTMLElement;
    pointerId: number;
    startClient: { x: number; y: number };
    lastClient: { x: number; y: number };
    lifted: boolean;
    dragging: boolean;
    over: number | null;
    holdTimer: number | null;
    raf: number | null;
    scroller: HTMLElement | null;
    cleanup: (() => void)[];
}

const DRAG_THRESHOLD_PX = 5;
const TOUCH_CANCEL_SLOP_PX = 8;
const TOUCH_HOLD_MS = 350;
const EDGE_ZONE_PX = 44;
const MAX_EDGE_SCROLL_PX = 12;

/** Nearest vertically-scrolling ancestor, for edge auto-scroll. */
function findScroller(el: HTMLElement): HTMLElement | null {
    let cur: HTMLElement | null = el;
    while (cur && cur !== document.body) {
        const overflow = getComputedStyle(cur).overflowY;
        if ((overflow === 'auto' || overflow === 'scroll') && cur.scrollHeight > cur.clientHeight) {
            return cur;
        }
        cur = cur.parentElement;
    }
    return null;
}

export function useVoiceMemberDrag(opts: Options) {
    const containerRef = useRef<HTMLElement | null>(null);
    const [state, setState] = useState<VoiceDragState>({ dragging: null, overChannelId: null });
    const session = useRef<Session | null>(null);
    // Latest options without re-binding listeners mid-drag.
    const optsRef = useRef(opts);
    useEffect(() => { optsRef.current = opts; });

    // A callback ref, and consumers MUST destructure the returned object:
    // handing `hook.setContainer` straight to a JSX `ref` makes the
    // react-hooks/refs lint treat the whole result as a ref and flag every
    // `hook.state` read in render.
    const setContainer = useCallback((el: HTMLElement | null) => {
        containerRef.current = el;
    }, []);

    const teardown = useCallback((commit: boolean) => {
        const s = session.current;
        if (!s) return;
        session.current = null;
        if (s.holdTimer !== null) window.clearTimeout(s.holdTimer);
        if (s.raf !== null) cancelAnimationFrame(s.raf);
        for (const fn of s.cleanup) fn();
        s.el.style.opacity = '';
        setState({ dragging: null, overChannelId: null });

        if (commit && s.dragging && s.over !== null) {
            optsRef.current.onDrop(s.subject, s.over);
        }
        // The browser fires a click right after pointerup, and the source row's
        // own onClick opens the user context menu — a drag must not also open
        // one. Armed for any drag that actually STARTED, commit or not: an
        // Escape-abort with the pointer still over the source row (easy, the
        // threshold is 5px) otherwise released into a menu for the very user
        // whose drag was just cancelled. Never armed when no drag began, or
        // this window-capture swallow would eat an ordinary click.
        if (s.dragging) {
            const swallow = (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); };
            window.addEventListener('click', swallow, { capture: true, once: true });
            window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 250);
        }
    }, []);

    /** Hit-test the pointer against the drop targets and update the highlight. */
    const updateTarget = useCallback((s: Session) => {
        const hit = document
            .elementFromPoint(s.lastClient.x, s.lastClient.y)
            ?.closest<HTMLElement>('[data-voice-drop]');
        const raw = hit ? Number(hit.dataset.voiceDrop) : NaN;
        const over = Number.isFinite(raw) && optsRef.current.canDropOn(s.subject, raw) ? raw : null;
        if (over !== s.over) {
            s.over = over;
            setState({ dragging: s.subject, overChannelId: over });
        }

        // Edge auto-scroll, so a destination below the fold is reachable
        // without letting go.
        const sc = s.scroller;
        if (!sc) return;
        const rect = sc.getBoundingClientRect();
        const y = s.lastClient.y;
        let delta = 0;
        if (y < rect.top + EDGE_ZONE_PX) {
            delta = -Math.min(MAX_EDGE_SCROLL_PX, Math.ceil((rect.top + EDGE_ZONE_PX - y) / 4));
        } else if (y > rect.bottom - EDGE_ZONE_PX) {
            delta = Math.min(MAX_EDGE_SCROLL_PX, Math.ceil((y - (rect.bottom - EDGE_ZONE_PX)) / 4));
        }
        if (delta !== 0) sc.scrollTop += delta;
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
        const o = optsRef.current;
        if (o.enabled === false || session.current) return;
        if (e.button !== 0) return; // right-click must still reach onContextMenu
        const container = containerRef.current;
        if (!container) return;
        const row = (e.target as Element).closest<HTMLElement>('[data-voice-user]');
        if (!row || !container.contains(row)) return;

        const userId = Number(row.dataset.voiceUser);
        const fromChannelId = Number(row.dataset.voiceFrom);
        if (!Number.isFinite(userId) || !Number.isFinite(fromChannelId)) return;

        const isTouch = e.pointerType === 'touch';
        const s: Session = {
            subject: { userId, username: row.dataset.voiceUsername ?? '', fromChannelId },
            el: row,
            pointerId: e.pointerId,
            startClient: { x: e.clientX, y: e.clientY },
            lastClient: { x: e.clientX, y: e.clientY },
            lifted: !isTouch, // mouse/pen: threshold drag straight away
            dragging: false,
            over: null,
            holdTimer: null,
            raf: null,
            scroller: findScroller(container),
            cleanup: [],
        };
        session.current = s;

        if (isTouch) {
            s.holdTimer = window.setTimeout(() => {
                if (session.current === s) {
                    s.lifted = true;
                    s.el.style.opacity = '0.7'; // "held" — distinct from "dragging"
                }
            }, TOUCH_HOLD_MS);
        }

        const beginDrag = () => {
            s.dragging = true;
            s.el.style.opacity = '0.45';
            document.body.classList.add('voice-drag-active');
            setState({ dragging: s.subject, overChannelId: null });
        };

        const onMove = (ev: PointerEvent) => {
            if (ev.pointerId !== s.pointerId) return;
            s.lastClient = { x: ev.clientX, y: ev.clientY };
            if (!s.dragging) {
                const dist = Math.hypot(ev.clientX - s.startClient.x, ev.clientY - s.startClient.y);
                if (!s.lifted) {
                    // Still waiting out the touch hold: real movement is a scroll.
                    if (dist > TOUCH_CANCEL_SLOP_PX) teardown(false);
                    return;
                }
                if (dist <= DRAG_THRESHOLD_PX) return;
                beginDrag();
            }
            updateTarget(s);
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
        // Focus loss aborts. Without it, alt-tabbing mid-drag and releasing the
        // button in another application means the pointerup never arrives:
        // `session.current` stays set, the rAF loop below spins elementFromPoint
        // every frame forever, the body keeps `voice-drag-active` (global
        // grabbing cursor, text selection off), and onPointerDown's
        // `if (session.current) return` makes the feature dead until this
        // component remounts.
        const onBlur = () => teardown(false);
        // Once a drag is live, stop the browser turning the gesture into a
        // scroll. Needs a NON-passive touchmove listener to be allowed to
        // preventDefault at all.
        const onTouchMove = (ev: TouchEvent) => {
            if (s.dragging) ev.preventDefault();
        };
        // Mid-drag long-press: preventDefault kills the native menu, and
        // stopPropagation on the capture phase keeps the event from ever
        // reaching the row's React onContextMenu.
        const onCtx = (ev: Event) => {
            if (s.dragging) { ev.preventDefault(); ev.stopPropagation(); }
        };

        // Capture routes every later event for this pointer to the row and
        // guarantees a pointercancel if the browser takes the gesture away.
        // Wrapped: it throws on a synthetic pointerId (test harnesses and the
        // virtual mouse pad both produce them) and must not kill the drag.
        try { row.setPointerCapture(e.pointerId); } catch { /* not fatal */ }

        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        window.addEventListener('keydown', onKey);
        window.addEventListener('blur', onBlur);
        window.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('contextmenu', onCtx, { capture: true });
        s.cleanup.push(
            () => window.removeEventListener('pointermove', onMove),
            () => window.removeEventListener('pointerup', onUp),
            () => window.removeEventListener('pointercancel', onCancel),
            () => window.removeEventListener('keydown', onKey),
            () => window.removeEventListener('blur', onBlur),
            () => window.removeEventListener('touchmove', onTouchMove),
            () => window.removeEventListener('contextmenu', onCtx, { capture: true }),
            () => document.body.classList.remove('voice-drag-active'),
            () => { try { row.releasePointerCapture(e.pointerId); } catch { /* already gone */ } },
        );

        // rAF loop: keeps edge auto-scroll flowing while the pointer holds
        // still inside the edge zone, where no pointermove events fire.
        const loop = () => {
            if (session.current !== s) return;
            if (s.dragging) updateTarget(s);
            s.raf = requestAnimationFrame(loop);
        };
        s.raf = requestAnimationFrame(loop);
    }, [teardown, updateTarget]);

    // Abort any live session on unmount.
    useEffect(() => () => teardown(false), [teardown]);

    return { setContainer, state, onPointerDown };
}
