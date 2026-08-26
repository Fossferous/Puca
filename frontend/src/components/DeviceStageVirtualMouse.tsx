/**
 * The virtual mouse pad: on-screen Left / Middle / Right buttons plus scroll
 * up / down for mouse mode on a phone. The trackpad
 * gestures cover taps, but a REAL right-drag, a middle click, or holding a
 * button while steering the cursor with the other thumb have no gesture — the
 * pad is what makes those possible.
 *
 * TWO CLUSTERS, PARKED SEPARATELY. It was one bar carrying all five controls,
 * and at ~290px that is most of a phone's width: wherever it sat it laid a
 * band across the remote screen, and the thing you most want to read is
 * usually the line it is covering. Split, each half is small enough to tuck
 * into a corner, and the two can straddle the content instead of crossing
 * it — buttons under one thumb, scroll under the other, which is also how
 * they are actually used. Each remembers its own position.
 *
 * Press semantics are a physical mouse's, deliberately: pointer DOWN on a
 * button presses it on the host, UP releases it. A quick tap is a click; a
 * hold is a hold, so hold-Left + move-cursor is a drag. The scroll buttons
 * fire one wheel notch per tap and auto-repeat while held.
 *
 * Everything press-shaped is keyed by POINTER, not by control: this surface
 * exists to be used with two thumbs, and the first version keyed state by
 * button — so a second finger brushing an already-held button released it for
 * the finger still pressing, and lifting one scroll arrow silently killed the
 * repeat the other, still-held arrow owned. The press maps are shared across
 * both clusters for the same reason: they are one hand's worth of state, not
 * one widget's.
 *
 * Owns no wire knowledge: the stage passes onButton/onWheel and keeps its own
 * record of what is pressed (its blur/session-end release-all covers the pad
 * too). The pad's only lifecycle duty is releasing what IT pressed when it
 * unmounts mid-hold — switching to touch mode with a finger down must not
 * strand a button down on the remote machine. A doubled release is harmless
 * (an unmatched button-up is a no-op on every host backend).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, GripIcon } from './Icons';

/** One wheel notch, in the units the host feeds straight to the OS; positive
 *  scrolls up, matching the desktop wheel path and the trackpad gesture. */
const WHEEL_NOTCH = 120;
/** Hold-to-repeat for the scroll buttons: familiar key-repeat pacing. */
const REPEAT_DELAY_MS = 350;
const REPEAT_EVERY_MS = 130;

/** Where the user last parked each cluster. Session-independent on purpose —
 *  a position that suited your thumb once suits it next time too. Separate
 *  keys, because they are now separately placeable; the single-bar key is
 *  deliberately not reused, so both start at their own sensible corner rather
 *  than stacked on the old bar's spot. */
const BUTTONS_POS_KEY = 'device-stage-virtual-mouse-buttons-pos';
const SCROLL_POS_KEY = 'device-stage-virtual-mouse-scroll-pos';

interface PadPos { left: number; top: number }

/** Keep a cluster reachable: at least its grip corner inside the viewport.
 *  Clamped against the MEASURED rect — the first version clamped a restored
 *  position against a made-up 80x60 footprint, and the real pad could still
 *  hang mostly off the right edge. */
function clampTo(p: PadPos, rect: { width: number; height: number }): PadPos {
    return {
        left: Math.min(Math.max(p.left, 4), Math.max(4, window.innerWidth - rect.width - 4)),
        top: Math.min(Math.max(p.top, 4), Math.max(4, window.innerHeight - rect.height - 4)),
    };
}

function readSavedPos(key: string): PadPos | null {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return null;
        const p = JSON.parse(raw) as PadPos;
        if (typeof p.left !== 'number' || typeof p.top !== 'number') return null;
        // Rough pre-paint clamp only — the layout effect below re-clamps
        // against the measured cluster the moment it exists. The estimate is
        // the STACKED buttons cluster (grip + three 46px buttons), the taller
        // of the two.
        return clampTo(p, { width: 60, height: 170 });
    } catch {
        return null;
    }
}

/** Capture without trusting it: jsdom has no setPointerCapture at all, and a
 *  real engine THROWS (InvalidPointerId) when the pointer was already
 *  released — either way the press itself must still go through. */
function capture(e: React.PointerEvent): void {
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
function usePadPos(storageKey: string, ref: React.RefObject<HTMLDivElement | null>) {
    const [pos, setPos] = useState<PadPos | null>(() => readSavedPos(storageKey));

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
    }, [ref]);

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

export function DeviceStageVirtualMouse({ onButton, onWheel }: {
    onButton: (button: number, down: boolean) => void;
    onWheel: (dy: number) => void;
}) {
    // The refs are OWNED HERE and handed down, not returned from the hook:
    // a hook returning an object with a ref in it makes every property read
    // on that object look like a render-time ref access to eslint, and one of
    // those genuinely is a bug worth catching.
    const buttonsRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const buttonsPad = usePadPos(BUTTONS_POS_KEY, buttonsRef);
    const scrollPad = usePadPos(SCROLL_POS_KEY, scrollRef);

    // Live mirrors so the unmount cleanup releases through the CURRENT
    // callbacks, not the ones captured when the pad first mounted.
    const onButtonRef = useRef(onButton);
    useEffect(() => { onButtonRef.current = onButton; }, [onButton]);
    const onWheelRef = useRef(onWheel);
    useEffect(() => { onWheelRef.current = onWheel; }, [onWheel]);

    // Which pointer holds which mouse button. The host's button is down while
    // AT LEAST one pointer holds it; the ref is the truth, state is the paint.
    const buttonPointers = useRef<Map<number, number>>(new Map());
    const [heldView, setHeldView] = useState<ReadonlySet<number>>(new Set());
    const heldButtons = () => new Set(buttonPointers.current.values());

    const press = (pointerId: number, button: number) => {
        const alreadyDown = heldButtons().has(button);
        buttonPointers.current.set(pointerId, button);
        setHeldView(heldButtons());
        if (!alreadyDown) onButtonRef.current(button, true);
    };
    const release = (pointerId: number) => {
        const button = buttonPointers.current.get(pointerId);
        if (button === undefined) return;
        buttonPointers.current.delete(pointerId);
        setHeldView(heldButtons());
        // Only the LAST finger off the button releases it on the host.
        if (!heldButtons().has(button)) onButtonRef.current(button, false);
    };
    // Unmounting mid-hold (mode switch, checkbox off, session end) must not
    // strand a button down on the host.
    useEffect(() => () => {
        const held = new Set(buttonPointers.current.values());
        buttonPointers.current.clear();
        for (const b of held) onButtonRef.current(b, false);
    }, []);

    // Scroll: one repeat-timer pair serves the direction pressed most
    // recently, and releasing a pointer hands the repeat back to a direction
    // some other finger still holds instead of killing it outright.
    const scrollPointers = useRef<Map<number, 1 | -1>>(new Map());
    const delayTimer = useRef<number | null>(null);
    const repeatTimer = useRef<number | null>(null);
    const clearScrollTimers = () => {
        if (delayTimer.current !== null) { clearTimeout(delayTimer.current); delayTimer.current = null; }
        if (repeatTimer.current !== null) { clearInterval(repeatTimer.current); repeatTimer.current = null; }
    };
    const runRepeat = (dir: 1 | -1) => {
        clearScrollTimers();
        delayTimer.current = window.setTimeout(() => {
            repeatTimer.current = window.setInterval(
                () => onWheelRef.current(dir * WHEEL_NOTCH),
                REPEAT_EVERY_MS,
            );
        }, REPEAT_DELAY_MS);
    };
    const scrollPress = (pointerId: number, dir: 1 | -1) => {
        scrollPointers.current.set(pointerId, dir);
        onWheelRef.current(dir * WHEEL_NOTCH);
        runRepeat(dir);
    };
    const scrollRelease = (pointerId: number) => {
        if (!scrollPointers.current.delete(pointerId)) return;
        const remaining = [...scrollPointers.current.values()];
        if (remaining.length === 0) clearScrollTimers();
        else runRepeat(remaining[remaining.length - 1]);
    };
    useEffect(() => () => clearScrollTimers(), []);

    /** Down/up/cancel wiring for one mouse button. `pointercancel` counts as a
     *  release: the OS stole the pointer and no up is coming. */
    const buttonHandlers = (button: number) => ({
        onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            capture(e);
            press(e.pointerId, button);
        },
        onPointerUp: (e: React.PointerEvent) => release(e.pointerId),
        onPointerCancel: (e: React.PointerEvent) => release(e.pointerId),
    });
    const scrollHandlers = (dir: 1 | -1) => ({
        onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            capture(e);
            scrollPress(e.pointerId, dir);
        },
        onPointerUp: (e: React.PointerEvent) => scrollRelease(e.pointerId),
        onPointerCancel: (e: React.PointerEvent) => scrollRelease(e.pointerId),
    });

    return (
        <>
            <div
                ref={buttonsRef}
                className="device-stage-virtual-mouse vm-cluster-buttons"
                style={buttonsPad.style}
            >
                <div className="vm-grip" aria-label="Move the mouse buttons" {...buttonsPad.gripHandlers}>
                    <GripIcon />
                </div>
                <button type="button" className={`vm-btn ${heldView.has(0) ? 'vm-held' : ''}`} aria-label="Left mouse button" {...buttonHandlers(0)}>L</button>
                <button type="button" className={`vm-btn ${heldView.has(1) ? 'vm-held' : ''}`} aria-label="Middle mouse button" {...buttonHandlers(1)}>M</button>
                <button type="button" className={`vm-btn ${heldView.has(2) ? 'vm-held' : ''}`} aria-label="Right mouse button" {...buttonHandlers(2)}>R</button>
            </div>
            <div
                ref={scrollRef}
                className="device-stage-virtual-mouse vm-cluster-scroll"
                style={scrollPad.style}
            >
                <div className="vm-grip" aria-label="Move the scroll buttons" {...scrollPad.gripHandlers}>
                    <GripIcon />
                </div>
                <button type="button" className="vm-btn" aria-label="Scroll up" {...scrollHandlers(1)}><ChevronUpIcon /></button>
                <button type="button" className="vm-btn" aria-label="Scroll down" {...scrollHandlers(-1)}><ChevronDownIcon /></button>
            </div>
        </>
    );
}
