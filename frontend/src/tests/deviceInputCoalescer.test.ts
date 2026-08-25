/**
 * Collapsing pointer motion must never reorder it against a click.
 *
 * The coalescer exists because every input event on the device path costs a
 * seal, a relayed WebSocket frame, and a blocking pipe round trip to the agent
 * — sixty to a hundred and twenty times a second while a finger is moving. But
 * dropping motion is only safe while the LAST motion still lands before
 * whatever depends on it. A click that overtakes its own positioning move is
 * injected wherever the pointer used to be, on a machine the user cannot see,
 * which is far worse than the lag this removes.
 *
 * So the tests here are mostly about order, and the first one is a positive
 * control: without proof that events are actually being collapsed, "they came
 * out in the right order" would also pass on a class that did nothing at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { InputCoalescer, MOVE_INTERVAL_MS, RMOVE_FLUSH_MS } from '../api/devices/inputCoalescer';

/** A coalescer on a clock the test drives. */
function rig(motionGate?: () => boolean) {
    const emitted: unknown[] = [];
    let now = 1_000;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextId = 1;

    const c = new InputCoalescer(e => emitted.push(e), {
        now: () => now,
        schedule: (fn, ms) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, fn });
            return id as unknown as ReturnType<typeof setTimeout>;
        },
        cancel: h => { timers.delete(h as unknown as number); },
    }, motionGate);

    return {
        emitted,
        push: (e: unknown) => c.push(e),
        flush: () => c.flush(),
        dispose: () => c.dispose(),
        /** Advance the clock and run anything that came due. */
        tick(ms: number) {
            now += ms;
            for (const [id, t] of [...timers]) {
                if (t.at <= now) {
                    timers.delete(id);
                    t.fn();
                }
            }
        },
        pendingTimers: () => timers.size,
    };
}

const move = (x: number, y: number) => ({ t: 'move', x, y });

describe('input coalescing', () => {
    /** POSITIVE CONTROL. If this fails, every ordering assertion below is
     *  vacuous — they would pass on a class that forwarded everything. */
    it('collapses a burst of motion into far fewer events', () => {
        const r = rig();
        // The first goes out immediately (nothing has been sent yet), the rest
        // land inside one interval and collapse to the latest.
        for (let i = 0; i < 20; i++) {
            r.push(move(i / 20, 0.5));
            r.tick(1);
        }
        r.tick(MOVE_INTERVAL_MS);
        expect(r.emitted.length).toBeLessThanOrEqual(3);
        expect(r.emitted.length).toBeGreaterThan(0);
    });

    it('keeps the LAST position, not an earlier one', () => {
        const r = rig();
        r.push(move(0.1, 0.1));   // immediate
        r.push(move(0.2, 0.2));
        r.push(move(0.9, 0.9));   // supersedes 0.2
        r.tick(MOVE_INTERVAL_MS);
        expect(r.emitted.at(-1)).toEqual(move(0.9, 0.9));
    });

    /** THE ORDERING RULE. A click must never overtake the move that placed it. */
    it('flushes pending motion before a button, synchronously', () => {
        const r = rig();
        r.push(move(0.1, 0.1));            // goes out at once
        r.push(move(0.5, 0.5));            // held
        r.push({ t: 'down', button: 0 });  // must flush the held move first

        expect(r.emitted).toEqual([
            move(0.1, 0.1),
            move(0.5, 0.5),
            { t: 'down', button: 0 },
        ]);
        // Synchronously: no timer had to fire for the click to be correct.
        expect(r.pendingTimers()).toBe(0);
    });

    it('flushes before keys and wheel too', () => {
        for (const state of [
            { t: 'key', code: 'KeyA', down: true },
            { t: 'wheel', dy: 120 },
            { t: 'up', button: 2 },
        ]) {
            const r = rig();
            r.push(move(0.1, 0.1));
            r.push(move(0.4, 0.4));
            r.push(state);
            expect(r.emitted.at(-1)).toEqual(state);
            expect(r.emitted.at(-2)).toEqual(move(0.4, 0.4));
        }
    });

    /** Relative motion SUMS: dropping a sample would lose distance, so the
     *  pointer would end up short of where the finger went. The first delta
     *  after a quiet moment rides the leading edge; the rest of the burst
     *  sums behind it — and the TOTAL distance is exact either way. */
    it('sums relative motion rather than keeping the latest', () => {
        const r = rig();
        r.push({ t: 'rmove', dx: 3, dy: -1 });   // leading edge: out at once
        r.push({ t: 'rmove', dx: 4, dy: -2 });   // held
        r.push({ t: 'rmove', dx: 3, dy: 0 });    // sums with the held one
        r.tick(RMOVE_FLUSH_MS);
        expect(r.emitted).toEqual([
            { t: 'rmove', dx: 3, dy: -1 },
            { t: 'rmove', dx: 7, dy: -2 },
        ]);
    });

    it('does not hold a lone flick waiting for company', () => {
        // The old unconditional 8ms defer cost an isolated relative move a
        // full window at EACH end of the wire. Leading edge: synchronous.
        const r = rig();
        r.push({ t: 'rmove', dx: 5, dy: 2 });
        expect(r.emitted).toEqual([{ t: 'rmove', dx: 5, dy: 2 }]);
        expect(r.pendingTimers()).toBe(0);
    });

    /** POSITIVE CONTROL for the leading edge: it must not have destroyed
     *  batching — a sustained stream still emits at most once per window. */
    it('still caps a sustained rmove stream at one emit per window', () => {
        const r = rig();
        for (let i = 0; i < 32; i++) {
            r.push({ t: 'rmove', dx: 1, dy: 0 });
            r.tick(2); // 500Hz input for 64ms
        }
        r.tick(RMOVE_FLUSH_MS);
        // 64ms / 8ms window = 8 full windows, +1 for the leading edge and
        // timer phase. The 32-event burst must not have produced 32 sends.
        expect(r.emitted.length).toBeLessThanOrEqual(10);
        // Distance is conserved exactly across however many emits happened.
        const total = (r.emitted as Array<{ dx: number }>).reduce((a, e) => a + e.dx, 0);
        expect(total).toBe(32);
    });

    it('keeps a steady cadence when arrivals are off-phase from the window', () => {
        // Arming the FULL interval from each arrival let the cadence drift to
        // interval+phase (~24ms at 120Hz input). Residual arming pins it: the
        // gap between consecutive emits never exceeds the window.
        const r = rig();
        const emitTimes: number[] = [];
        let clock = 0;
        const orig = r.emitted;
        const record = () => { emitTimes.push(clock); };
        // Track emit times by watching the array grow while we drive the clock.
        for (let i = 0; i < 40; i++) {
            const before = orig.length;
            r.push(move(i / 40, 0.5));
            if (orig.length > before) record();
            const beforeTick = orig.length;
            r.tick(6); // 6ms arrivals: off-phase with the 16ms window
            clock += 6;
            if (orig.length > beforeTick) record();
        }
        const gaps = emitTimes.slice(1).map((t, i) => t - emitTimes[i]);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(MOVE_INTERVAL_MS + 2);
    });

    it('lets an rmove preempt a longer already-armed move window', () => {
        // A shared timer must not make an 8ms rmove wait out a 16ms move
        // window that was armed first. Both types are made RECENT first so
        // neither rides the leading edge — this exercises the timer
        // re-arm itself, which an earlier version of this test never did.
        const r = rig();
        r.push(move(0.1, 0.1));                 // immediate; lastMoveSent = t0
        r.push({ t: 'rmove', dx: 9, dy: 9 });   // leading edge; lastRmoveSent = t0
        r.tick(2);
        r.push(move(0.2, 0.2));                 // held; timer armed for t0+16
        r.tick(2);
        r.push({ t: 'rmove', dx: 1, dy: 1 });   // held; must re-arm to t0+8
        const before = r.emitted.length;
        r.tick(4);                              // t0+8: the PREEMPTED deadline
        expect(r.emitted.length).toBeGreaterThan(before);
        expect(r.emitted.slice(before)).toEqual([
            move(0.2, 0.2),
            { t: 'rmove', dx: 1, dy: 1 },
        ]);
    });

    it('holds motion while the gate is closed and force-flushes it before a click', () => {
        // Backpressure must HOLD, never drop: a dropped positioning move is a
        // click teleport on a machine the user cannot see.
        let gateOpen = true;
        const r = rig(() => gateOpen);
        r.push(move(0.1, 0.1));                 // gate open: immediate
        gateOpen = false;
        r.tick(20);
        r.push(move(0.5, 0.5));                 // would ride the leading edge — held instead
        r.tick(50);                             // retries keep holding
        expect(r.emitted).toEqual([move(0.1, 0.1)]);
        r.push({ t: 'down', button: 0 });       // state event FORCES the held motion first
        expect(r.emitted).toEqual([
            move(0.1, 0.1),
            move(0.5, 0.5),
            { t: 'down', button: 0 },
        ]);
    });

    it('sends held motion when the gate reopens', () => {
        let gateOpen = false;
        const r = rig(() => gateOpen);
        r.push(move(0.3, 0.3));                 // held from the start
        expect(r.emitted).toEqual([]);
        gateOpen = true;
        r.tick(8);                              // retry timer finds the gate open
        expect(r.emitted).toEqual([move(0.3, 0.3)]);
    });

    it('passes anything it does not understand straight through', () => {
        const r = rig();
        const clip = { t: 'clip', data: 'hello' };
        r.push(clip);
        expect(r.emitted).toEqual([clip]);
    });

    it('sends nothing more after dispose', () => {
        const r = rig();
        r.push(move(0.1, 0.1));   // immediate
        r.push(move(0.7, 0.7));   // held
        r.dispose();
        r.tick(1000);
        expect(r.emitted).toEqual([move(0.1, 0.1)]);
        expect(r.pendingTimers()).toBe(0);
    });

    it('does not hold a lone move waiting for company', () => {
        // A single deliberate touch after a quiet moment must not be delayed.
        const r = rig();
        r.push(move(0.3, 0.3));
        expect(r.emitted).toEqual([move(0.3, 0.3)]);
    });
});

describe('the real timer path', () => {
    it('uses timers when no clock is injected', async () => {
        vi.useFakeTimers();
        try {
            const emitted: unknown[] = [];
            const c = new InputCoalescer(e => emitted.push(e));
            c.push(move(0.1, 0.1));   // immediate
            c.push(move(0.6, 0.6));   // held behind the real 16ms gate
            expect(emitted).toHaveLength(1);
            await vi.advanceTimersByTimeAsync(MOVE_INTERVAL_MS + 1);
            expect(emitted).toEqual([move(0.1, 0.1), move(0.6, 0.6)]);
        } finally {
            vi.useRealTimers();
        }
    });
});
