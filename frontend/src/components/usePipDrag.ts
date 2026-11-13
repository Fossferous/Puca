import { useCallback, useEffect, useRef, useState } from 'react';

/** How far a press moves before it is a drag rather than a tap. */
export const PIP_DRAG_SLOP = 8;

/** How long after a touch the mouse events it brings with it are its own. */
const TOUCH_MOUSE_MS = 800;

/**
 * The self-view's drag (VoicePanel's camera window): where it is, whether it
 * is being dragged, the handlers for its container, and `isTap` for the click
 * that opens its menu.
 *
 * - A press is only a drag once it has moved PIP_DRAG_SLOP px; short of that
 *   it is a tap. (Every press used to start a drag at once, and the mouse
 *   half of a touch set it again after touchend had cleared it: on the
 *   Android emulator real taps on the self-view opened its options once in
 *   thirteen.)
 * - Only a press that STARTED on the container moves it. The Flip button
 *   inside keeps its touchstart to itself, but its touchmove still bubbles
 *   here; measured from a start point left over from an earlier drag (or the
 *   top-left corner), one slightly moving press on Flip threw the window
 *   across the screen.
 * - A click a key made (detail 0) is always a press: a drag that ended with
 *   no click of its own must not swallow the next Enter or Space.
 */
export function usePipDrag(initial: { x: number; y: number } = { x: 20, y: 100 }) {
    const [position, setPosition] = useState(initial);
    const [isDragging, setIsDragging] = useState(false);
    const positionRef = useRef(position);
    useEffect(() => { positionRef.current = position; }, [position]);
    /** The press under way, from its start; null when there is none. */
    const press = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
    const moved = useRef(false);
    /** When the last touch press ended: the mousedown/mouseup a browser sends
     *  after a touch it still counts as a tap are that touch, not a press of
     *  their own (one reset `moved`, and a short drag then opened the menu). */
    const lastTouchAt = useRef(-Infinity);

    const place = useCallback((x: number, y: number) => {
        setPosition({
            x: Math.max(0, Math.min(window.innerWidth - 150, x)),
            y: Math.max(0, Math.min(window.innerHeight - 200, y)),
        });
    }, []);

    const moveTo = useCallback((clientX: number, clientY: number) => {
        const p = press.current;
        if (!p) return;
        const dx = clientX - p.x;
        const dy = clientY - p.y;
        if (!moved.current && Math.hypot(dx, dy) < PIP_DRAG_SLOP) return;
        moved.current = true;
        setIsDragging(true);
        place(p.startX + dx, p.startY + dy);
    }, [place]);

    const start = useCallback((clientX: number, clientY: number) => {
        press.current = { x: clientX, y: clientY, startX: positionRef.current.x, startY: positionRef.current.y };
        moved.current = false;
    }, []);

    const end = useCallback(() => {
        press.current = null;
        setIsDragging(false);
    }, []);

    const onTouchStart = useCallback((e: React.TouchEvent) => {
        const t = e.touches[0];
        lastTouchAt.current = Date.now();
        if (t) start(t.clientX, t.clientY);
    }, [start]);

    const onTouchEnd = useCallback(() => {
        lastTouchAt.current = Date.now();
        end();
    }, [end]);

    const onTouchMove = useCallback((e: React.TouchEvent) => {
        const t = e.touches[0];
        if (t) moveTo(t.clientX, t.clientY);
    }, [moveTo]);

    // The mouse's listeners go on with the press itself, not from an effect
    // after the next render.
    const onMouseDown = useCallback((e: React.MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        if (Date.now() - lastTouchAt.current < TOUCH_MOUSE_MS) return; // the touch's own
        start(e.clientX, e.clientY);
        const move = (ev: MouseEvent) => moveTo(ev.clientX, ev.clientY);
        const up = () => {
            document.removeEventListener('mousemove', move);
            document.removeEventListener('mouseup', up);
            end();
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
    }, [start, moveTo, end]);

    /** Whether this click on the self-view is a tap (open its menu) rather
     *  than the end of a drag. */
    const isTap = useCallback((e: { detail: number }) => {
        if (e.detail === 0) return true;
        if (moved.current) {
            moved.current = false;
            return false;
        }
        return true;
    }, []);

    return {
        position,
        isDragging,
        handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: onTouchEnd, onMouseDown },
        isTap,
    };
}
