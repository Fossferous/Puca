/**
 * A long press on a touch screen (for bulk selection on a phone), as pointer
 * handlers for one element. Movement past a small slop cancels it (that was a
 * scroll), and the click that follows a completed long press is swallowed so
 * it does not also open the note.
 *
 * Android Chromium ALSO fires `contextmenu` on a long press; `wasTouch()`
 * lets the caller turn that into the same action (whichever comes first
 * wins, the other is ignored). iOS Safari fires no contextmenu — the timer
 * is what works there.
 */
import { useCallback, useEffect, useRef } from 'react';

export const LONG_PRESS_MS = 500;
const SLOP_PX = 10;

export function useLongPress(onLongPress: (() => void) | undefined) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const start = useRef<{ x: number; y: number } | null>(null);
    const fired = useRef(false);
    const touch = useRef(false);
    const cb = useRef(onLongPress);
    useEffect(() => { cb.current = onLongPress; });
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const cancel = useCallback(() => {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        start.current = null;
    }, []);
    const fire = useCallback(() => {
        cancel();
        if (fired.current || !cb.current) return;
        fired.current = true;
        cb.current();
    }, [cancel]);

    const handlers = {
        onPointerDown: (e: React.PointerEvent) => {
            touch.current = e.pointerType === 'touch' || e.pointerType === 'pen';
            fired.current = false;
            if (!touch.current || !cb.current) return;
            start.current = { x: e.clientX, y: e.clientY };
            timer.current = setTimeout(fire, LONG_PRESS_MS);
        },
        onPointerMove: (e: React.PointerEvent) => {
            const s = start.current;
            if (s && (Math.abs(e.clientX - s.x) > SLOP_PX || Math.abs(e.clientY - s.y) > SLOP_PX)) cancel();
        },
        onPointerUp: cancel,
        onPointerCancel: cancel,
    };
    return {
        handlers,
        fire,
        wasTouch: () => touch.current && !!cb.current,
        /** True (once) for the click that ends a completed long press. */
        swallowClick: () => {
            if (!fired.current) return false;
            fired.current = false;
            return true;
        },
    };
}
