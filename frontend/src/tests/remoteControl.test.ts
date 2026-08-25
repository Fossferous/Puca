import { describe, it, expect } from 'vitest';
import {
    validEvent,
    bumpDenial,
    cooldownRemainingMs,
    computeRmoveScale,
    splitRmoveDelta,
    DENIAL_STEPS_MS,
    DENIAL_DECAY_MS,
    type DenialRecord,
} from '../api/remoteControl';

// The host injects real OS input, so the payload validator is a security gate:
// it must accept only well-formed control events and reject everything else.
describe('remoteControl validEvent', () => {
    it('accepts well-formed events', () => {
        expect(validEvent({ t: 'move', x: 0.5, y: 0.5 })).toBe(true);
        expect(validEvent({ t: 'rmove', dx: -3, dy: 7 })).toBe(true);
        expect(validEvent({ t: 'wheel', dy: 120 })).toBe(true);
        expect(validEvent({ t: 'down', button: 0 })).toBe(true);
        expect(validEvent({ t: 'up', button: 2 })).toBe(true);
        expect(validEvent({ t: 'key', code: 'KeyW', down: true })).toBe(true);
    });

    it('rejects non-finite / NaN numbers', () => {
        expect(validEvent({ t: 'move', x: Infinity, y: 0 })).toBe(false);
        expect(validEvent({ t: 'move', x: NaN, y: 0 })).toBe(false);
        expect(validEvent({ t: 'rmove', dx: 1, dy: -Infinity })).toBe(false);
    });

    it('bounds mouse buttons to 0..2', () => {
        expect(validEvent({ t: 'down', button: 3 })).toBe(false);
        expect(validEvent({ t: 'down', button: -1 })).toBe(false);
        expect(validEvent({ t: 'up', button: 99 })).toBe(false);
    });

    it('rejects malformed shapes and unknown types', () => {
        expect(validEvent(null)).toBe(false);
        expect(validEvent(42)).toBe(false);
        expect(validEvent('move')).toBe(false);
        expect(validEvent({})).toBe(false);
        expect(validEvent({ t: 'bogus', x: 1 })).toBe(false);
        expect(validEvent({ t: 'move', x: '1', y: 2 })).toBe(false);
        expect(validEvent({ t: 'key', code: 123, down: true })).toBe(false);
        expect(validEvent({ t: 'key', code: 'A', down: 'yes' })).toBe(false);
    });

    it('rejects absurdly long key codes', () => {
        expect(validEvent({ t: 'key', code: 'x'.repeat(64), down: true })).toBe(false);
    });
});

// Denied-request cooldown: each denial grows the wait (spam can't repop the
// host's approval prompt), and the history decays after a long quiet gap.
describe('remoteControl denial cooldown ladder', () => {
    const PEER = 7;

    it('grows through the steps and caps at the last one', () => {
        const map = new Map<number, DenialRecord>();
        let now = 1_000_000;
        const seen: number[] = [];
        for (let i = 0; i < DENIAL_STEPS_MS.length + 2; i++) {
            seen.push(bumpDenial(map, PEER, now));
            now += 1_000; // re-denied quickly each time
        }
        expect(seen.slice(0, DENIAL_STEPS_MS.length)).toEqual(DENIAL_STEPS_MS);
        const cap = DENIAL_STEPS_MS[DENIAL_STEPS_MS.length - 1];
        expect(seen[DENIAL_STEPS_MS.length]).toBe(cap);
        expect(seen[DENIAL_STEPS_MS.length + 1]).toBe(cap);
    });

    it('reports remaining time that counts down and hits zero', () => {
        const map = new Map<number, DenialRecord>();
        const t0 = 5_000_000;
        bumpDenial(map, PEER, t0); // first denial → 10s
        expect(cooldownRemainingMs(map, PEER, t0)).toBe(10_000);
        expect(cooldownRemainingMs(map, PEER, t0 + 4_000)).toBe(6_000);
        expect(cooldownRemainingMs(map, PEER, t0 + 10_000)).toBe(0);
    });

    it('forgets the ladder after the decay window of quiet', () => {
        const map = new Map<number, DenialRecord>();
        const t0 = 9_000_000;
        bumpDenial(map, PEER, t0);
        bumpDenial(map, PEER, t0 + 1_000); // count = 2 → next would be 60s
        // A denial long after the decay window starts back at step one.
        const later = t0 + 1_000 + DENIAL_DECAY_MS;
        expect(cooldownRemainingMs(map, PEER, later)).toBe(0); // also purges
        expect(bumpDenial(map, PEER, later)).toBe(DENIAL_STEPS_MS[0]);
    });

    it('tracks peers independently', () => {
        const map = new Map<number, DenialRecord>();
        const t0 = 42;
        bumpDenial(map, 1, t0);
        bumpDenial(map, 1, t0 + 1); // peer 1 at step 2 (30s)
        expect(bumpDenial(map, 2, t0 + 2)).toBe(DENIAL_STEPS_MS[0]); // peer 2 fresh
        expect(cooldownRemainingMs(map, 1, t0 + 2)).toBeGreaterThan(cooldownRemainingMs(map, 2, t0 + 2));
    });
});

// FPS-mode delta scaling: viewer CSS px → host source px, letterbox-corrected.
// Without this a full mouse sweep over a small video tile became a tiny host
// movement (deltas were sent 1:1 in viewer pixels).
describe('remoteControl computeRmoveScale', () => {
    it('scales up when a wide video letterboxes in a shorter-but-wide element', () => {
        // 1920x1080 source in a 960x700 element → content is 960x540 (bars top/
        // bottom), so 1 viewer px of travel = 2 host px.
        expect(computeRmoveScale(1920, 1080, 960, 700)).toBeCloseTo(2);
    });

    it('scales by the limiting axis for pillarboxed tall video', () => {
        // 1080x1920 source in a 900x480 element → height-limited: content is
        // 270x480 (bars left/right) → 1080 / 270 = 4.
        expect(computeRmoveScale(1080, 1920, 900, 480)).toBeCloseTo(4);
    });

    it('is 1 when the content renders at native size', () => {
        expect(computeRmoveScale(1920, 1080, 1920, 1080)).toBeCloseTo(1);
    });

    it('scales down when the element is larger than the source', () => {
        // 1280x720 source filling a 2560x1440 element → 0.5 host px per viewer px.
        expect(computeRmoveScale(1280, 720, 2560, 1440)).toBeCloseTo(0.5);
    });

    it('falls back to 1 on degenerate sizes', () => {
        expect(computeRmoveScale(0, 1080, 960, 540)).toBe(1);   // video metadata not loaded
        expect(computeRmoveScale(1920, 0, 960, 540)).toBe(1);
        expect(computeRmoveScale(1920, 1080, 0, 540)).toBe(1);  // element not laid out
        expect(computeRmoveScale(1920, 1080, 960, 0)).toBe(1);
        expect(computeRmoveScale(NaN, 1080, 960, 540)).toBe(1);
    });
});

// Fractional-residual carry: scaled deltas are floats; each flush sends the
// integer part and keeps the remainder, so slow low-sensitivity aiming
// (sub-pixel per flush) accumulates instead of truncating to zero forever.
describe('remoteControl splitRmoveDelta', () => {
    it('sends the integer part and carries the fraction', () => {
        const { send, carry } = splitRmoveDelta({ dx: 3.75, dy: -2.25 });
        expect(send).toEqual({ dx: 3, dy: -2 });
        expect(carry.dx).toBeCloseTo(0.75);
        expect(carry.dy).toBeCloseTo(-0.25);
    });

    it('sends nothing for sub-pixel motion but keeps it all as carry', () => {
        const { send, carry } = splitRmoveDelta({ dx: 0.25, dy: -0.5 });
        expect(send).toEqual({ dx: 0, dy: 0 }); // -0 is normalized to 0
        expect(carry.dx).toBeCloseTo(0.25);
        expect(carry.dy).toBeCloseTo(-0.5);
    });

    it('truncates toward zero for negative motion', () => {
        const { send, carry } = splitRmoveDelta({ dx: -2.75, dy: -1.5 });
        expect(send).toEqual({ dx: -2, dy: -1 });
        expect(carry.dx).toBeCloseTo(-0.75);
        expect(carry.dy).toBeCloseTo(-0.5);
    });

    it('accumulated sub-pixel deltas eventually cross into whole pixels', () => {
        // Four flushes of +0.25px each: the first three send 0, the fourth 1,
        // and nothing is lost overall.
        let acc = { dx: 0, dy: 0 };
        let sent = 0;
        for (let i = 0; i < 4; i++) {
            acc = { dx: acc.dx + 0.25, dy: acc.dy };
            const { send, carry } = splitRmoveDelta(acc);
            sent += send.dx;
            acc = carry;
        }
        expect(sent).toBe(1);
        expect(acc.dx).toBeCloseTo(0);
    });

    it('never loses motion across many fractional flushes (sum preserved)', () => {
        // 60 flushes of an awkward float delta: total sent + final carry must
        // equal the total input to within float noise.
        const step = 0.3;
        let acc = { dx: 0, dy: 0 };
        let sent = 0;
        for (let i = 0; i < 60; i++) {
            acc = { dx: acc.dx + step, dy: acc.dy };
            const { send, carry } = splitRmoveDelta(acc);
            sent += send.dx;
            acc = carry;
        }
        expect(sent + acc.dx).toBeCloseTo(60 * step, 6);
        expect(Math.abs(acc.dx)).toBeLessThan(1); // carry stays sub-pixel
    });
});
