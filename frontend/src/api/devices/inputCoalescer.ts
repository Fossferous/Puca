/**
 * Collapse a burst of pointer motion into the fewest events that still say the
 * same thing.
 *
 * WHY THE DEVICE PATH NEEDS THIS. Every event here costs an AES-GCM seal, a
 * WebSocket frame through the relay, and — on the host — a BLOCKING named-pipe
 * round trip to the agent under a process-global mutex whose own documentation
 * says it assumes "a handful per session". A finger dragging across a phone
 * produces sixty to a hundred and twenty of them a second. Nothing on this path
 * coalesced anything, so the cost was paid per event and the queue behind it
 * grew: felt as lag that gets worse the more you move.
 *
 * Only MOTION is dropped, and only motion that a later event supersedes: the
 * cursor ends up in the same place either way, because an absolute move says
 * where to be rather than how far to go. Everything else — buttons, keys,
 * wheel, clipboard — passes through untouched.
 *
 * THE ORDERING RULE IS LOAD-BEARING. A state-changing event FLUSHES pending
 * motion first, synchronously, before it is emitted. Without that a click can
 * overtake the move that positioned it and land wherever the pointer used to
 * be — on someone else's machine, on whatever happens to be under it. That is
 * far worse than the latency this class exists to remove, so it is the property
 * the tests pin hardest.
 *
 * The algorithm and its constants come from the voice-channel screen-share
 * path (`frontend/src/api/remoteControl.ts`), which has run them in production
 * for a long time. The difference is ownership: that path is a module-level
 * singleton because it supports exactly one session, and the device path
 * supports several at once, so this is a class with per-session state.
 */

/** The shape the coalescer needs to recognise; everything else is opaque. */
interface MotionEvent {
    t?: string;
    dx?: number;
    dy?: number;
}

/** How long an absolute move may wait for a better one to replace it.
 *
 *  ~60/s. Below this the wire cost dominates; above it a drag starts to feel
 *  notchy, because the cursor visibly steps rather than glides. */
export const MOVE_INTERVAL_MS = 16;

/** How long relative motion accumulates before it is emitted as one delta. */
export const RMOVE_FLUSH_MS = 8;

export class InputCoalescer {
    private readonly emit: (event: unknown) => void;
    private readonly now: () => number;
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    private readonly cancel: (h: ReturnType<typeof setTimeout>) => void;

    /** The most recent absolute move not yet sent. */
    private pendingMove: unknown = null;
    private lastMoveSent = 0;
    /** Summed relative motion not yet sent. */
    private rdx = 0;
    private rdy = 0;
    private rmovePending = false;
    private lastRmoveSent = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    /** When the armed timer will fire — lets a shorter deadline preempt it. */
    private timerDeadline = 0;

    /** When present and returning false, MOTION is held (kept pending,
     *  superseding/summing as usual) instead of emitted — the sender's
     *  backpressure valve. State events are never gated, and a state event's
     *  ordering flush forces held motion out ahead of it, so a click can
     *  never land at a position the wire never saw. Holding rather than
     *  dropping is the point: a dropped move is a click teleport waiting to
     *  happen, a held one is just late. */
    private readonly motionGate: (() => boolean) | null;

    constructor(
        emit: (event: unknown) => void,
        clock?: {
            now?: () => number;
            schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
            cancel?: (h: ReturnType<typeof setTimeout>) => void;
        },
        motionGate?: () => boolean,
    ) {
        this.emit = emit;
        this.now = clock?.now ?? (() => Date.now());
        this.schedule = clock?.schedule ?? ((fn, ms) => setTimeout(fn, ms));
        this.cancel = clock?.cancel ?? (h => clearTimeout(h));
        this.motionGate = motionGate ?? null;
    }

    /** Offer one event. It is emitted now, later, or superseded. */
    push(event: unknown): void {
        const e = (event ?? {}) as MotionEvent;

        if (e.t === 'move') {
            this.pendingMove = event;
            // Rate-gate rather than always defer: a move that arrives after a
            // quiet moment goes straight out, so a single deliberate touch is
            // not held for 16ms for no reason. When it IS deferred, arm only
            // the REMAINDER of the window — arming the full interval from the
            // arrival time let the cadence drift to interval-plus-arrival-gap
            // and, worse, latch the host a persistent window behind after one
            // jitter-bunched pair.
            const sinceMove = this.now() - this.lastMoveSent;
            if (sinceMove >= MOVE_INTERVAL_MS) {
                this.flush();
            } else {
                this.arm(MOVE_INTERVAL_MS - sinceMove);
            }
            return;
        }

        if (e.t === 'rmove') {
            // Relative motion SUMS — dropping one would lose distance, not just
            // a sample, and the pointer would end up short.
            this.rdx += Number(e.dx) || 0;
            this.rdy += Number(e.dy) || 0;
            this.rmovePending = true;
            // Leading edge, same shape as 'move' above. The old
            // unconditional defer cost every isolated flick a full window at
            // EACH end (this class runs on the controller AND on the host's
            // receive side), which measured ~12-16ms of pure waiting per
            // relative move; arrivals in a sustained stream are already spaced
            // by the sender's own window, so batching them again bought
            // nothing.
            const sinceRmove = this.now() - this.lastRmoveSent;
            if (sinceRmove >= RMOVE_FLUSH_MS) {
                this.flush();
            } else {
                this.arm(RMOVE_FLUSH_MS - sinceRmove);
            }
            return;
        }

        // Anything that changes state: motion first, then this, in that order.
        // FORCED past the motion gate — the gate exists to shed stale motion
        // under backpressure, and motion a click depends on is not stale.
        this.flush(true);
        this.emit(event);
    }

    /** Send whatever motion is pending, now. `force` bypasses the motion
     *  gate (state-event ordering); an unforced flush against a closed gate
     *  HOLDS the motion and retries shortly. */
    flush(force = false): void {
        if (this.timer !== null) {
            this.cancel(this.timer);
            this.timer = null;
        }
        if (!force && this.motionGate && !this.motionGate()) {
            // Congested: keep pending (superseding/summing bounds the state
            // to one move + one delta pair) and retry. The next state event
            // force-flushes regardless, so ordering never depends on this.
            if (this.pendingMove !== null || this.rmovePending) {
                this.arm(RMOVE_FLUSH_MS);
            }
            return;
        }
        if (this.pendingMove !== null) {
            const move = this.pendingMove;
            this.pendingMove = null;
            this.lastMoveSent = this.now();
            this.emit(move);
        }
        if (this.rmovePending) {
            const [dx, dy] = [this.rdx, this.rdy];
            this.rdx = 0;
            this.rdy = 0;
            this.rmovePending = false;
            this.lastRmoveSent = this.now();
            this.emit({ t: 'rmove', dx, dy });
        }
    }

    /** Drop pending motion without sending it, and stop the timer.
     *
     *  For teardown: a session that has ended must not fire a stray move at
     *  whatever holds its id next. */
    dispose(): void {
        if (this.timer !== null) {
            this.cancel(this.timer);
            this.timer = null;
        }
        this.pendingMove = null;
        this.rdx = 0;
        this.rdy = 0;
        this.rmovePending = false;
    }

    private arm(ms: number): void {
        const deadline = this.now() + ms;
        if (this.timer !== null) {
            // Keep the EARLIER deadline. A timer armed for a 16ms move window
            // must not make an 8ms rmove wait it out — that inherited window
            // was a measured extra 8ms on mixed-motion streams.
            if (deadline >= this.timerDeadline) return;
            this.cancel(this.timer);
            this.timer = null;
        }
        this.timerDeadline = deadline;
        this.timer = this.schedule(() => {
            this.timer = null;
            this.flush();
        }, ms);
    }
}
