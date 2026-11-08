/**
 * Where a floating stage cluster sits, and how it is dragged there: restore
 * the parked spot, keep at least its grip on screen through rotation and
 * resize, drag by the grip, remember where it was left.
 *
 * Lifted out of DeviceStageVirtualMouse.tsx unchanged so the pinned keys
 * (DeviceStagePinnedKeys.tsx) park, clamp and remember exactly the way the
 * mouse pad's two clusters do — "same placement rules" is one implementation,
 * not two that drift.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface PadPos { left: number; top: number }

/** Keep a cluster reachable: at least its grip corner inside the viewport.
 *  Clamped against the MEASURED rect — the first version clamped a restored
 *  position against a made-up 80x60 footprint, and the real pad could still
 *  hang mostly off the right edge. */
export function clampTo(p: PadPos, rect: { width: number; height: number }): PadPos {
    return {
        left: Math.min(Math.max(p.left, 4), Math.max(4, window.innerWidth - rect.width - 4)),
        top: Math.min(Math.max(p.top, 4), Math.max(4, window.innerHeight - rect.height - 4)),
    };
}

export function readSavedPos(key: string, estimate: { width: number; height: number }): PadPos | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const p = JSON.parse(raw) as PadPos;
        if (typeof p.left !== 'number' || typeof p.top !== 'number') return null;
        // Rough pre-paint clamp only — the layout effect below re-clamps
        // against the measured cluster the moment it exists. Per cluster,
        // because the two are different shapes now: the button ROW is wide
        // and short, the scroll COLUMN narrow and tall, and one shared guess
        // over-clamps whichever it does not describe.
        return clampTo(p, estimate);
    } catch {
        return null;
    }
}

/** Capture without trusting it: jsdom has no setPointerCapture at all, and a
 *  real engine THROWS (InvalidPointerId) when the pointer was already
 *  released — either way the press itself must still go through. */
export function capture(e: React.PointerEvent): void {
    try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
        // No capture, no harm: the up/cancel handlers still fire on the pad.
    }
}

/**
 * One draggable cluster's position: restore, keep on screen, drag by the grip.
 *
 * The position to SAVE is tracked in the drag record itself, not read back
 * from React state — state commits lag the event, so a quick flick used to
 * save nothing (or the previous frame's spot) depending on when the up landed.
 */
export function usePadPos(
    storageKey: string,
    ref: React.RefObject<HTMLDivElement | null>,
    estimate: { width: number; height: number },
    /** Anything whose change can change the cluster's SIZE (the pinned keys'
     *  count): the clamp runs again then, as it does on a resize, so a row
     *  that grew past the edge is pulled back in with its grip. */
    sizeKey?: string | number,
) {
    const [pos, setPos] = useState<PadPos | null>(() => readSavedPos(storageKey, estimate));

    // Keep it reachable across rotation and resize: a portrait position near
    // the bottom is past the edge of a landscape viewport, and with the grip
    // off-screen there is no way to drag it back.
    useLayoutEffect(() => {
        const reclamp = () => {
            setPos(p => {
                const rect = ref.current?.getBoundingClientRect();
                if (!rect) return p;
                if (!p) {
                    // The CSS default is bottom-anchored and predates the
                    // stacked column: on a short landscape viewport the taller
                    // cluster can start ABOVE the screen with its grip — the
                    // only way to move it — clipped off the top. Adopt a
                    // clamped position only when the measured default actually
                    // leaves the viewport (rect.height > 0 keeps jsdom, which
                    // measures everything as zero at 0,0, on the CSS default).
                    return rect.height > 0 && rect.top < 4
                        ? clampTo({ left: rect.left, top: rect.top }, rect)
                        : p;
                }
                const c = clampTo(p, rect);
                return c.left === p.left && c.top === p.top ? p : c;
            });
        };
        reclamp();
        window.addEventListener('resize', reclamp);
        window.addEventListener('orientationchange', reclamp);
        return () => {
            window.removeEventListener('resize', reclamp);
            window.removeEventListener('orientationchange', reclamp);
        };
    }, [ref, sizeKey]);

    const drag = useRef<{ id: number; dx: number; dy: number; at: PadPos | null } | null>(null);
    const onPointerDown = useCallback((e: React.PointerEvent) => {
        const rect = ref.current?.getBoundingClientRect();
        if (!rect) return;
        drag.current = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top, at: null };
        capture(e);
        e.preventDefault();
    }, [ref]);
    const onPointerMove = useCallback((e: React.PointerEvent) => {
        const d = drag.current;
        const rect = ref.current?.getBoundingClientRect();
        if (!d || d.id !== e.pointerId || !rect) return;
        const next = clampTo({ left: e.clientX - d.dx, top: e.clientY - d.dy }, rect);
        d.at = next;
        setPos(next);
    }, [ref]);
    const onPointerUp = useCallback((e: React.PointerEvent) => {
        const d = drag.current;
        if (d?.id !== e.pointerId) return;
        drag.current = null;
        try {
            if (d.at) localStorage.setItem(storageKey, JSON.stringify(d.at));
        } catch {
            // Storage unavailable; the position still holds for this session.
        }
    }, [storageKey]);

    return {
        style: pos
            ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto', transform: 'none' }
            : undefined,
        gripHandlers: {
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
        },
    };
}
