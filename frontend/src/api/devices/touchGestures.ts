/**
 * Touch gestures for driving a remote pointer from a phone — the trackpad.
 *
 * WHY THIS IS A MODULE AND NOT A HANDFUL OF HANDLERS. The behaviour it encodes
 * is a state machine with three timers and five gestures, and it lived inline
 * in the component as a set of `if (isMobile && isMouseMode)` branches that
 * could not be tested without mounting a video element and faking pointer
 * events. The bugs that produced were not subtle: the cursor teleported after
 * every pinch because the finger position was never cleared when one of two
 * fingers lifted; a cancelled gesture sent a mouse-up that had no matching
 * mouse-down; and three of the six gestures the UI advertised — drag, wheel,
 * right-click — did nothing at all, because the flag that enables dragging was
 * never once set to true.
 *
 * TRACKPAD, NOT TOUCHSCREEN. A finger moves the pointer BY a delta rather than
 * jumping it TO where you touched. Touching the screen must not move the
 * pointer at all, exactly like a laptop trackpad — that is the whole complaint
 * this addresses ("each touch resets the position of the mouse").
 *
 * WHAT GOES ON THE WIRE, and why it is absolute. The pointer position is kept
 * here, as a fraction of the picture, and sent as an absolute `move`. Relative
 * `rmove` would be the obvious choice for a trackpad and is the wrong one here:
 * the host clamps at its screen edges and there is no channel telling us where
 * its pointer actually ended up, so the dot we draw and the pointer they see
 * would drift apart permanently with nothing able to resynchronise them. Owning
 * the position locally means the drawn cursor IS the truth, and it costs
 * nothing — the host already maps normalised coordinates onto whichever screen
 * it is capturing, including the composited one.
 */

/** What the machine can ask the outside world to do. */
export interface GestureSink {
    /** Absolute pointer position, 0..1 over the captured picture. */
    move(x: number, y: number): void;
    /** DOM button order: 0 left, 1 middle, 2 right. */
    button(button: number, down: boolean): void;
    /** Positive scrolls up/away, matching the desktop wheel path. */
    wheel(dy: number): void;
    /** Where to draw the cursor. Same coordinates as `move`. */
    cursor(x: number, y: number): void;
}

/** Injected so tests drive time instead of waiting for it. */
export interface GestureClock {
    now(): number;
    schedule(fn: () => void, ms: number): number;
    cancel(handle: number): void;
}

export interface GestureOptions {
    /** How far the pointer travels per unit of finger travel. */
    sensitivity?: number;
}

/** A finger, in the coordinates the browser reports. */
export interface Contact {
    id: number;
    x: number;
    y: number;
}

/** How far the picture is drawn, so finger travel scales to pointer travel. */
export interface Surface {
    dispW: number;
    dispH: number;
}

/** Movement past this is a drag, not a tap. Roughly Android's touch slop. */
const TAP_SLOP_PX = 12;
/** Hold this long without moving and it is a right-click. */
const LONG_PRESS_MS = 500;
/** A second tap within this window (and this distance) starts a drag. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 40;
/** Wheel deltas accumulate this long before being sent as one event. */
const WHEEL_FLUSH_MS = 50;
/** Finger pixels to wheel units. */
const WHEEL_SCALE = 2;

type Phase = 'idle' | 'pressed' | 'dragging' | 'longpressed' | 'pinch' | 'wheel';

/** Goes nowhere until the component wires a real one up. */
const NO_SINK: GestureSink = {
    move: () => {},
    button: () => {},
    wheel: () => {},
    cursor: () => {},
};

export class TouchGestures {
    private sink: GestureSink;
    private readonly clock: GestureClock;
    private readonly sensitivity: number;

    private phase: Phase = 'idle';
    private pointers = new Map<number, Contact>();
    /** Pointer position, 0..1 over the picture. Starts centred. */
    private px = 0.5;
    private py = 0.5;
    /** The tracked finger's last position, or null when it must be re-seeded. */
    private last: { x: number; y: number } | null = null;
    /** Where the tracked finger first landed, for tap-versus-drag. */
    private origin: { x: number; y: number } | null = null;
    private movedFar = false;
    private downSent = false;
    private longPress: number | null = null;
    private lastTap: { at: number; x: number; y: number } | null = null;
    /** Logged once, not per dropped move — a stuck trackpad otherwise floods. */
    private warnedNoSurface = false;
    private wheelLastY = 0;
    private wheelAccum = 0;
    private wheelTimer: number | null = null;
    /** Leading-edge gate: the first notch after a quiet spell sends at once. */
    private lastWheelFlush = 0;
    /** Null until the picture's size is known. */
    private surface: Surface | null = null;

    constructor(sink?: GestureSink, clock?: Partial<GestureClock>, opts?: GestureOptions) {
        this.sink = sink ?? NO_SINK;
        this.clock = {
            now: clock?.now ?? (() => Date.now()),
            schedule: clock?.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number),
            cancel: clock?.cancel ?? (h => clearTimeout(h as unknown as ReturnType<typeof setTimeout>)),
        };
        this.sensitivity = opts?.sensitivity ?? 1.5;
    }

    /** Point the machine at where its events should go.
     *
     *  Settable so the owner can build the machine ONCE and re-wire it as its
     *  own callbacks change — a machine that had to be rebuilt to pick up a new
     *  send function would drop the gesture in progress. */
    setSink(sink: GestureSink): void {
        this.sink = sink;
    }

    /** Tell the machine how large the picture is drawn, for delta scaling.
     *
     *  `null` means "no picture yet" and is remembered as such: a placeholder
     *  size would make one pixel of finger travel sweep the whole remote
     *  screen. */
    setSurface(surface: Surface | null): void {
        this.surface = surface && surface.dispW > 0 && surface.dispH > 0 ? surface : null;
    }

    /** Current pointer position, for rendering. */
    position(): { x: number; y: number } {
        return { x: this.px, y: this.py };
    }

    /** A finger is on the pad right now. `reset` mid-gesture forgets a drag's
     *  sent button-down without releasing it (stranding it on the host) and
     *  eats the rest of the gesture — callers with a live user, like the
     *  monitor-hop's pointer seed, must check this and stand down. */
    busy(): boolean {
        return this.pointers.size > 0;
    }

    /** Place the pointer without sending anything — for a fresh session. */
    reset(x = 0.5, y = 0.5): void {
        this.cancelLongPress();
        this.cancelWheel();
        this.pointers.clear();
        this.phase = 'idle';
        this.last = null;
        this.movedFar = false;
        this.downSent = false;
        this.lastTap = null;
        this.px = x;
        this.py = y;
        this.sink.cursor(x, y);
    }

    down(c: Contact): void {
        this.pointers.set(c.id, c);

        if (this.pointers.size === 1) {
            this.last = { x: c.x, y: c.y };
            this.origin = { x: c.x, y: c.y };
            this.movedFar = false;
            const tap = this.lastTap;
            const near =
                tap &&
                this.clock.now() - tap.at <= DOUBLE_TAP_MS &&
                Math.hypot(c.x - tap.x, c.y - tap.y) <= DOUBLE_TAP_SLOP_PX;
            if (near) {
                // Second tap of a double tap, held: this is a drag. The button
                // goes down NOW and stays down while the finger moves — the
                // gesture the menu has always advertised and that nothing
                // implemented, because the flag enabling it was never set.
                this.lastTap = null;
                this.phase = 'dragging';
                this.sink.move(this.px, this.py);
                this.sink.button(0, true);
                this.downSent = true;
                return;
            }
            this.phase = 'pressed';
            this.armLongPress();
            return;
        }

        if (this.pointers.size === 2) {
            this.cancelLongPress();
            // A second finger ends any drag cleanly rather than leaving the
            // button stuck down through a pinch.
            this.releaseButton();
            this.last = null;
            this.phase = 'pinch';
            return;
        }

        if (this.pointers.size === 3) {
            this.cancelLongPress();
            this.releaseButton();
            this.wheelLastY = c.y;
            this.wheelAccum = 0;
            this.phase = 'wheel';
        }
    }

    move(c: Contact): void {
        if (!this.pointers.has(c.id)) return;
        const prev = this.pointers.get(c.id)!;
        this.pointers.set(c.id, c);

        if (this.phase === 'wheel') {
            // Three fingers vertically: scroll. Fingers up scrolls the content
            // up, matching the desktop path's sign convention.
            const primary = this.primaryId();
            if (c.id !== primary) return;
            this.wheelAccum += (prev.y - c.y) * WHEEL_SCALE;
            // Leading edge: the first notch of a scroll goes out immediately
            // instead of waiting out the full accumulation window — 50ms of
            // nothing at the start of every scroll was visible lag. Further
            // motion inside the window still batches.
            const sinceWheel = this.clock.now() - this.lastWheelFlush;
            if (sinceWheel >= WHEEL_FLUSH_MS) {
                this.flushWheel();
            } else {
                this.armWheel(WHEEL_FLUSH_MS - sinceWheel);
            }
            return;
        }

        if (this.phase === 'pinch') return; // the component owns zoom/pan

        if (this.phase !== 'pressed' && this.phase !== 'dragging') return;
        if (!this.last) {
            // Re-seed rather than jump: this is the frame after a pinch ended,
            // and treating the surviving finger's position as a delta from the
            // OTHER finger's last position is exactly the teleport that made
            // the trackpad unusable.
            this.last = { x: c.x, y: c.y };
            return;
        }

        const dx = c.x - this.last.x;
        const dy = c.y - this.last.y;
        this.last = { x: c.x, y: c.y };

        // Measured from where the finger LANDED, not step by step: a slow drag
        // in small increments is still a drag, and summing per-move distance
        // would also count a finger that wandered and came back.
        if (!this.movedFar && this.origin) {
            if (Math.hypot(c.x - this.origin.x, c.y - this.origin.y) > TAP_SLOP_PX) {
                this.movedFar = true;
                this.cancelLongPress();
            }
        }

        // No picture, no pointer movement. Tracking still updates above, so
        // the first move after the first frame arrives is a normal small step
        // rather than a jump from wherever the finger started.
        if (!this.surface) {
            // A silently inert trackpad ("touch does nothing except zoom") is
            // exactly this branch firing forever with nothing in the log —
            // warn once so it is diagnosable instead of guessed at.
            if (!this.warnedNoSurface) {
                this.warnedNoSurface = true;
                console.warn('[touch] dropping move: no surface set yet (video has no size)');
            }
            return;
        }
        this.warnedNoSurface = false;

        // Scaled over the PICTURE, not the element: dividing by the element
        // meant vertical travel was out by the letterbox ratio — 3.5x on a
        // phone in portrait showing a widescreen desktop.
        this.px = clamp01(this.px + (dx * this.sensitivity) / this.surface.dispW);
        this.py = clamp01(this.py + (dy * this.sensitivity) / this.surface.dispH);
        this.sink.cursor(this.px, this.py);
        this.sink.move(this.px, this.py);
    }

    up(c: Contact): void {
        const had = this.pointers.delete(c.id);
        if (!had) return;

        if (this.phase === 'wheel') {
            this.flushWheel();
            this.phase = this.pointers.size >= 2 ? 'pinch' : 'pressed';
            this.last = null;
            this.movedFar = true; // never a tap on the way out of a gesture
            if (this.pointers.size === 0) this.phase = 'idle';
            return;
        }

        if (this.phase === 'pinch') {
            if (this.pointers.size >= 2) return;
            // Down to one finger. Re-seed from the SURVIVOR — the whole bug.
            const survivor = [...this.pointers.values()][0];
            this.last = survivor ? { x: survivor.x, y: survivor.y } : null;
            this.movedFar = true;
            this.phase = this.pointers.size === 1 ? 'pressed' : 'idle';
            return;
        }

        if (this.phase === 'dragging') {
            this.releaseButton();
            this.phase = this.pointers.size === 0 ? 'idle' : 'pressed';
            this.last = null;
            return;
        }

        if (this.phase === 'longpressed') {
            this.phase = this.pointers.size === 0 ? 'idle' : 'pressed';
            this.last = null;
            return;
        }

        // phase === 'pressed'
        this.cancelLongPress();
        if (!this.movedFar) {
            // A tap. No time limit: a slow, still finger is still a tap, and
            // the old 500ms cap silently swallowed unhurried ones.
            this.sink.move(this.px, this.py);
            this.click(0);
            this.lastTap = { at: this.clock.now(), x: c.x, y: c.y };
        }
        this.last = null;
        this.phase = this.pointers.size === 0 ? 'idle' : 'pressed';
    }

    /**
     * The browser took the gesture away (a scroll, a system edge swipe).
     *
     * Sends an `up` ONLY if a `down` was actually sent. The old handler sent
     * one unconditionally, so a cancelled touch that never pressed anything
     * still released a button on the remote machine — a phantom click on
     * whatever happened to be under the pointer.
     */
    cancel(c?: Contact): void {
        if (c) this.pointers.delete(c.id);
        else this.pointers.clear();
        this.cancelLongPress();
        this.flushWheel();
        this.releaseButton();
        this.last = null;
        // NOT false. A cancelled gesture must never look like a tap on the way
        // out: with two fingers down, cancelling one leaves the other in
        // `pressed`, and clearing this made its eventual lift fire a left click
        // the user never made — on a machine they are not looking at.
        this.movedFar = true;
        this.lastTap = null;
        if (this.pointers.size === 0) this.phase = 'idle';
        else if (this.pointers.size >= 2) this.phase = 'pinch';
        else this.phase = 'pressed';
    }

    /** Release any timer that could still fire after teardown. */
    dispose(): void {
        this.cancelLongPress();
        this.cancelWheel();
    }

    // --- internals ---------------------------------------------------------

    private primaryId(): number | undefined {
        return this.pointers.keys().next().value;
    }

    private armLongPress(): void {
        this.cancelLongPress();
        this.longPress = this.clock.schedule(() => {
            this.longPress = null;
            if (this.phase !== 'pressed' || this.movedFar) return;
            // Held still: right-click, and the eventual lift must NOT also
            // fire a left click.
            this.sink.move(this.px, this.py);
            this.click(2);
            this.phase = 'longpressed';
        }, LONG_PRESS_MS);
    }

    private cancelLongPress(): void {
        if (this.longPress !== null) {
            this.clock.cancel(this.longPress);
            this.longPress = null;
        }
    }

    private armWheel(ms: number): void {
        if (this.wheelTimer !== null) return;
        this.wheelTimer = this.clock.schedule(() => {
            this.wheelTimer = null;
            this.flushWheel();
        }, Math.max(0, ms));
    }

    private cancelWheel(): void {
        if (this.wheelTimer !== null) {
            this.clock.cancel(this.wheelTimer);
            this.wheelTimer = null;
        }
        this.wheelAccum = 0;
    }

    private flushWheel(): void {
        if (this.wheelTimer !== null) {
            this.clock.cancel(this.wheelTimer);
            this.wheelTimer = null;
        }
        if (this.wheelAccum !== 0) {
            // Stamp only when something went out: gesture transitions call
            // this with an empty accumulator, and stamping those burned the
            // leading edge for the NEXT scroll's first notch.
            this.lastWheelFlush = this.clock.now();
            this.sink.wheel(this.wheelAccum);
            this.wheelAccum = 0;
        }
    }

    private releaseButton(): void {
        if (this.downSent) {
            this.sink.button(0, false);
            this.downSent = false;
        }
    }

    private click(button: number): void {
        this.sink.button(button, true);
        this.sink.button(button, false);
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
