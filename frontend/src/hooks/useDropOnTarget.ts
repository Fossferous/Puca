/**
 * Drag an item onto a TARGET (a calendar day or time slot) — two-axis, hit-
 * tested with elementFromPoint, unlike useDragReorder which is a one-axis
 * list reorder. Mouse drags after a few pixels; touch lifts only after a
 * long press (a plain swipe keeps scrolling), with the same hold and
 * cancel-slop constants as the Tasks tab bar.
 *
 * Draggables carry `data-drag-id`; targets carry `data-drop-target` (its
 * value is handed to onDrop). The body class `drop-drag-live` is refcounted
 * like useDragReorder's, so text selection is off during a drag.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const MOUSE_SLOP_PX = 5;
const TOUCH_HOLD_MS = 350;
const TOUCH_CANCEL_SLOP_PX = 10;

let liveCount = 0;
function setLive(on: boolean): void {
    liveCount = Math.max(0, liveCount + (on ? 1 : -1));
    document.body.classList.toggle('drop-drag-live', liveCount > 0);
}

export interface DropState {
    /** The id being dragged, once the drag has started. */
    dragging: string | null;
    /** The target under the pointer, if any. */
    over: string | null;
    x: number;
    y: number;
}

export function useDropOnTarget(opts: {
    enabled: boolean;
    canDrag: (id: string) => boolean;
    onDrop: (id: string, target: string) => void;
}): { state: DropState; onPointerDown: (e: React.PointerEvent) => void } {
    const [state, setState] = useState<DropState>({ dragging: null, over: null, x: 0, y: 0 });
    const optsRef = useRef(opts);
    useEffect(() => { optsRef.current = opts; });
    const cleanup = useRef<(() => void) | null>(null);
    useEffect(() => () => cleanup.current?.(), []);

    const onPointerDown = useCallback((e: React.PointerEvent) => {
        if (!optsRef.current.enabled || e.button !== 0) return;
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-drag-id]');
        const id = el?.dataset.dragId;
        if (!id || !optsRef.current.canDrag(id)) return;
        const touch = e.pointerType === 'touch';
        const sx = e.clientX;
        const sy = e.clientY;
        let started = false;
        let over: string | null = null;
        let holdTimer: number | null = null;

        const targetAt = (x: number, y: number): string | null => {
            const hit = document.elementFromPoint(x, y) as HTMLElement | null;
            return hit?.closest<HTMLElement>('[data-drop-target]')?.dataset.dropTarget ?? null;
        };
        const start = () => {
            started = true;
            setLive(true);
            setState({ dragging: id, over: targetAt(sx, sy), x: sx, y: sy });
        };
        const move = (ev: PointerEvent) => {
            const dx = ev.clientX - sx;
            const dy = ev.clientY - sy;
            if (!started) {
                if (touch) {
                    if (Math.hypot(dx, dy) > TOUCH_CANCEL_SLOP_PX) end();   // a scroll, not a hold
                    return;
                }
                if (Math.hypot(dx, dy) < MOUSE_SLOP_PX) return;
                start();
            }
            ev.preventDefault();
            over = targetAt(ev.clientX, ev.clientY);
            setState({ dragging: id, over, x: ev.clientX, y: ev.clientY });
        };
        const up = (ev: PointerEvent) => {
            if (started) {
                ev.preventDefault();
                const target = targetAt(ev.clientX, ev.clientY);
                end();
                if (target) optsRef.current.onDrop(id, target);
                // Swallow the click that follows a drag so the chip does not
                // also open.
                const swallow = (ce: MouseEvent) => { ce.stopPropagation(); ce.preventDefault(); };
                window.addEventListener('click', swallow, { capture: true, once: true });
                window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
                return;
            }
            end();
        };
        const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') end(); };
        const end = () => {
            if (holdTimer !== null) window.clearTimeout(holdTimer);
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', end);
            window.removeEventListener('keydown', key);
            if (started) setLive(false);
            started = false;
            cleanup.current = null;
            setState({ dragging: null, over: null, x: 0, y: 0 });
        };
        if (touch) holdTimer = window.setTimeout(start, TOUCH_HOLD_MS);
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', end);
        window.addEventListener('keydown', key);
        cleanup.current = end;
    }, []);

    return { state, onPointerDown };
}
