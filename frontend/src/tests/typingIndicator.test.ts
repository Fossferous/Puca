/**
 * The typing list's pure updates (components/typingIndicator.ts): a ping, the
 * typer's own message ending it, the room it is shown in, and a ping that waited
 * while the page was stopped (RunClock). The real Chat is driven by
 * chatTypingIndicator.test.tsx.
 */
import { describe, it, expect } from 'vitest';
import {
    noteTyping, clearTyper, typersIn, TYPING_TTL_MS, RunClock, RUN_TICK_MS, STOPPED_GAP_MS, RESTART_MS,
    type TypingRow,
} from '../components/typingIndicator';
import { pruneExpiredTyping } from '../components/stableState';

/** A clock that has ticked every second from 0 to `until`. */
function runningUntil(until: number): RunClock {
    const c = new RunClock(0);
    for (let t = RUN_TICK_MS; t <= until; t += RUN_TICK_MS) c.tick(t);
    return c;
}

describe('typing rows', () => {
    it('a ping keeps its typer for TYPING_TTL_MS, in its room', () => {
        const m = noteTyping(new Map(), 2, 'bob', 'channel_7', 1_000);
        expect(m.get(2)).toEqual({ username: 'bob', room: 'channel_7', expiry: 1_000 + TYPING_TTL_MS });
        expect(typersIn(pruneExpiredTyping(m, 1_000 + TYPING_TTL_MS), 'channel_7')).toEqual(['bob']);
        expect(typersIn(pruneExpiredTyping(m, 1_001 + TYPING_TTL_MS), 'channel_7')).toEqual([]);
    });

    it('their message removes only them; someone not typing changes nothing (the SAME map)', () => {
        let m = noteTyping(new Map(), 2, 'bob', 'channel_7', 0);
        m = noteTyping(m, 3, 'cat', 'channel_7', 0);
        const same = clearTyper(m, 4);
        expect(same).toBe(m);
        const next = clearTyper(m, 2);
        expect(next).not.toBe(m);
        expect(typersIn(next, 'channel_7')).toEqual(['cat']);
        expect(m.size).toBe(2); // never mutates the previous state
    });

    it('names only the room asked about, and nobody with no room open', () => {
        let m = new Map<number, TypingRow>();
        m = noteTyping(m, 2, 'bob', 'channel_7', 0);
        m = noteTyping(m, 3, 'cat', 'channel_8', 0);
        expect(typersIn(m, 'channel_7')).toEqual(['bob']);
        expect(typersIn(m, 'channel_8')).toEqual(['cat']);
        expect(typersIn(m, null)).toEqual([]);
    });

    it('a ping counted from an earlier moment keeps only what is left of its five seconds', () => {
        const m = noteTyping(new Map(), 2, 'bob', 'channel_7', 10_000, 8_000);
        expect(m.get(2)?.expiry).toBe(8_000 + TYPING_TTL_MS);
    });

    it('a ping whose five seconds are already over adds nothing (the SAME map)', () => {
        const before = noteTyping(new Map(), 3, 'cat', 'channel_7', 40_000);
        const after = noteTyping(before, 2, 'bob', 'channel_7', 40_000, 10_000);
        expect(after).toBe(before);
        expect(typersIn(after, 'channel_7')).toEqual(['cat']);
        // Exactly five seconds is over too.
        expect(noteTyping(new Map(), 2, 'bob', 'channel_7', 15_000, 10_000).size).toBe(0);
    });
});

describe('RunClock: has the page just started again?', () => {
    it('while it runs, a frame is from now', () => {
        const c = runningUntil(60_000);
        expect(c.waitingSince(60_400)).toBe(60_400);
        // A busy page, or a hidden tab's timers aligned to the second: ticks a
        // little late are not a stop.
        c.tick(60_000 + STOPPED_GAP_MS);
        expect(c.waitingSince(60_000 + STOPPED_GAP_MS + 10)).toBe(60_000 + STOPPED_GAP_MS + 10);
    });

    it('stopped 30 s, a frame handled BEFORE the late tick is from when it stopped (what Edge does)', () => {
        const c = runningUntil(10_000);
        expect(c.waitingSince(40_000)).toBe(10_000);
        expect(c.waitingSince(40_002)).toBe(10_000);
    });

    it('stopped 30 s, a frame handled just AFTER the late tick is from when it stopped too', () => {
        const c = runningUntil(10_000);
        c.tick(40_000);
        expect(c.waitingSince(40_001)).toBe(10_000);
        expect(c.waitingSince(40_000 + RESTART_MS)).toBe(10_000);
        // ...and only just: after that the page is running again.
        expect(c.waitingSince(40_001 + RESTART_MS)).toBe(40_001 + RESTART_MS);
        c.tick(41_000);
        c.tick(42_000);
        expect(c.waitingSince(42_500)).toBe(42_500);
    });

    it('a second stop is measured from its own start', () => {
        const c = runningUntil(10_000);
        c.tick(40_000);
        for (let t = 41_000; t <= 50_000; t += 1_000) c.tick(t);
        expect(c.waitingSince(80_000)).toBe(50_000);
        c.tick(80_000);
        expect(c.waitingSince(80_100)).toBe(50_000);
    });

    it('a held ping after a held message does not bring its typer back (CONTROL: running, it does)', () => {
        const c = runningUntil(10_000);
        // The burst at 40 s: their message (clearTyper), then a ping sent at 11 s.
        let m = noteTyping(new Map(), 2, 'bob', 'channel_7', 9_500);
        m = clearTyper(m, 2);
        m = noteTyping(m, 2, 'bob', 'channel_7', 40_000, c.waitingSince(40_000));
        expect(typersIn(m, 'channel_7')).toEqual([]);
        const live = runningUntil(40_000);
        expect(typersIn(noteTyping(new Map(), 2, 'bob', 'channel_7', 40_000, live.waitingSince(40_000)), 'channel_7')).toEqual(['bob']);
    });

    it('stopped for less than a ping lasts, the ping is shown for what is left of it', () => {
        const c = runningUntil(10_000);
        const since = c.waitingSince(13_500);
        expect(since).toBe(10_000);
        const m = noteTyping(new Map(), 2, 'bob', 'channel_7', 13_500, since);
        expect(m.get(2)?.expiry).toBe(15_000);
    });
});
