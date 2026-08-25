/**
 * The trackpad gesture machine, every transition.
 *
 * These are the behaviours the mobile menu ADVERTISES, three of which did
 * nothing before: drag (the enabling flag was never set), three-finger wheel
 * (unimplemented), and long-press right-click (unimplemented). Plus the two
 * bugs the working gestures had: a cursor that teleported after every pinch,
 * and a cancelled touch that released a button it never pressed.
 *
 * The machine is pure and driven on an injected clock, so a "held for 500ms"
 * or "a second tap within 300ms" is a fact the test sets rather than a delay it
 * waits out.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TouchGestures, type GestureSink } from '../api/devices/touchGestures';

type Call =
    | { k: 'move'; x: number; y: number }
    | { k: 'button'; button: number; down: boolean }
    | { k: 'wheel'; dy: number }
    | { k: 'cursor'; x: number; y: number };

function rig() {
    const calls: Call[] = [];
    const sink: GestureSink = {
        move: (x, y) => calls.push({ k: 'move', x, y }),
        button: (button, down) => calls.push({ k: 'button', button, down }),
        wheel: dy => calls.push({ k: 'wheel', dy }),
        cursor: (x, y) => calls.push({ k: 'cursor', x, y }),
    };

    let now = 10_000;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextId = 1;
    const clock = {
        now: () => now,
        schedule: (fn: () => void, ms: number) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        cancel: (h: number) => { timers.delete(h); },
    };

    // 400px-wide picture, so a delta divides to an easy fraction.
    const g = new TouchGestures(sink, clock, { sensitivity: 1 });
    g.setSurface({ dispW: 400, dispH: 400 });
    g.reset(0.5, 0.5);
    calls.length = 0;

    return {
        g,
        calls,
        buttons: () => calls.filter((c): c is Extract<Call, { k: 'button' }> => c.k === 'button'),
        moves: () => calls.filter((c): c is Extract<Call, { k: 'move' }> => c.k === 'move'),
        wheels: () => calls.filter((c): c is Extract<Call, { k: 'wheel' }> => c.k === 'wheel'),
        advance(ms: number) {
            now += ms;
            for (const [id, t] of [...timers]) {
                if (t.at <= now) { timers.delete(id); t.fn(); }
            }
        },
    };
}

let r: ReturnType<typeof rig>;
beforeEach(() => { r = rig(); });

const P = (id: number, x: number, y: number) => ({ id, x, y });

describe('taps and clicks', () => {
    it('a still tap is a left click, however slow', () => {
        r.g.down(P(1, 100, 100));
        r.advance(450);            // well past any old time bound, no move
        r.g.up(P(1, 100, 100));
        expect(r.buttons()).toEqual([
            { k: 'button', button: 0, down: true },
            { k: 'button', button: 0, down: false },
        ]);
    });

    it('a touch alone does not move the pointer (trackpad, not touchscreen)', () => {
        r.g.down(P(1, 300, 50));   // far from centre
        expect(r.moves()).toHaveLength(0);
        r.g.up(P(1, 300, 50));
        // The click happens at the pointer's existing position, not the touch.
        expect(r.moves().at(-1)).toEqual({ k: 'move', x: 0.5, y: 0.5 });
    });

    it('holding still fires a right click and suppresses the left', () => {
        r.g.down(P(1, 100, 100));
        r.advance(500);            // long-press fires
        r.g.up(P(1, 100, 100));
        const b = r.buttons();
        expect(b).toEqual([
            { k: 'button', button: 2, down: true },
            { k: 'button', button: 2, down: false },
        ]);
    });
});

describe('pointer movement', () => {
    it('moves the pointer by a scaled delta over the picture', () => {
        r.g.down(P(1, 100, 100));
        r.g.move(P(1, 140, 100));  // +40px over a 400px picture = +0.1
        expect(r.moves().at(-1)).toEqual({ k: 'move', x: 0.6, y: 0.5 });
    });

    it('a moved finger is a drag-less glide, not a click', () => {
        r.g.down(P(1, 100, 100));
        r.g.move(P(1, 160, 100));  // > slop
        r.g.up(P(1, 160, 100));
        expect(r.buttons()).toEqual([]); // no click after a glide
    });
});

describe('drag', () => {
    it('double-tap-and-hold presses, drags, and releases', () => {
        // First tap.
        r.g.down(P(1, 100, 100));
        r.g.up(P(1, 100, 100));   // a left click
        // Second tap within the window, held.
        r.advance(100);
        r.g.down(P(2, 105, 102));
        r.g.move(P(2, 205, 102));  // drag right by 100px = +0.25
        r.g.up(P(2, 205, 102));

        const b = r.buttons();
        // ...click from tap 1, then down (drag start), then up (drag end).
        expect(b.at(-2)).toEqual({ k: 'button', button: 0, down: true });
        expect(b.at(-1)).toEqual({ k: 'button', button: 0, down: false });
        // The button was down BEFORE the drag move went out.
        const downIdx = r.calls.findIndex(c => c.k === 'button' && c.down && c.button === 0 && r.calls.indexOf(c) > 2);
        const lastMove = r.calls.map((c, i) => ({ c, i })).filter(x => x.c.k === 'move').at(-1)!.i;
        expect(downIdx).toBeLessThan(lastMove);
    });
});

describe('pinch', () => {
    it('does not teleport the pointer when a pinch drops to one finger', () => {
        r.g.down(P(1, 100, 100));
        r.g.down(P(2, 300, 100));  // second finger -> pinch
        r.g.up(P(1, 100, 100));    // back to one finger (id 2 at 300,100)
        r.calls.length = 0;

        // A small move of the surviving finger must be a SMALL pointer move,
        // not a jump computed against finger 1's stale position.
        r.g.move(P(2, 310, 100));  // +10px = +0.025
        const m = r.moves().at(-1)!;
        expect(Math.abs(m.x - 0.5)).toBeLessThan(0.03);
    });
});

describe('three-finger wheel', () => {
    it('sends the first notch immediately, batches the rest, loses nothing', () => {
        r.g.down(P(1, 100, 200));
        r.g.down(P(2, 150, 200));  // pinch
        r.g.down(P(3, 200, 200));  // wheel
        // Primary finger (id 1) moves up 20px: the FIRST notch of a scroll
        // rides the leading edge — 50ms of nothing at scroll start was
        // visible lag — so it goes out synchronously.
        r.g.move(P(1, 100, 180));
        let w = r.wheels();
        expect(w).toHaveLength(1);
        expect(w[0].dy).toBeGreaterThan(0); // fingers up -> positive
        // 10px more inside the window: batches rather than spamming.
        r.g.move(P(1, 100, 170));
        expect(r.wheels()).toHaveLength(1); // still held
        r.advance(50);             // window closes -> remainder flushes
        w = r.wheels();
        expect(w).toHaveLength(2);
        // Distance is conserved across however many events carried it:
        // 30px of finger travel x WHEEL_SCALE(2) = 60 wheel units.
        expect(w.reduce((a, e) => a + e.dy, 0)).toBe(60);
    });
});

describe('cancel', () => {
    it('sends NO button up when nothing was pressed', () => {
        r.g.down(P(1, 100, 100));  // pressed, no down sent
        r.g.cancel(P(1, 100, 100));
        expect(r.buttons()).toEqual([]);
    });

    // POSITIVE CONTROL for the test above: a cancel DURING a drag must release
    // the button, so "no up" is a real property, not a machine that never sends
    // ups at all.
    it('DOES send one button up when a drag is cancelled', () => {
        r.g.down(P(1, 100, 100));
        r.g.up(P(1, 100, 100));    // tap 1
        r.advance(50);
        r.g.down(P(2, 102, 101));  // double-tap-hold -> drag, button down
        r.calls.length = 0;
        r.g.cancel(P(2, 102, 101));
        expect(r.buttons()).toEqual([{ k: 'button', button: 0, down: false }]);
    });

    /** A cancelled gesture must not become a click on the way out.
     *
     *  With two fingers down, cancelling one leaves the other in `pressed`;
     *  clearing the moved flag on cancel made that finger's eventual lift fire
     *  a left click the user never made. */
    it('does not turn the surviving finger into a click after a cancel', () => {
        r.g.down(P(1, 100, 100));
        r.g.down(P(2, 300, 100));   // pinch
        r.g.cancel(P(1, 100, 100)); // one finger cancelled, id 2 survives
        r.calls.length = 0;
        r.g.up(P(2, 300, 100));
        expect(r.buttons(), 'a cancelled gesture must not end in a click').toEqual([]);
    });

    it('does not leave a long-press timer able to fire after cancel', () => {
        r.g.down(P(1, 100, 100));
        r.g.cancel(P(1, 100, 100));
        r.advance(1000);           // the 500ms long-press would fire here
        expect(r.buttons()).toEqual([]);
    });
});

describe('dispose', () => {
    it('stops a pending long-press from firing', () => {
        r.g.down(P(1, 100, 100));
        r.g.dispose();
        r.advance(1000);
        expect(r.buttons()).toEqual([]);
    });
});
