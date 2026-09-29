/**
 * writesInFlight — what a task view's Refresh asks before it reads: is a
 * write still out, has one started since, and has everything landed yet
 * (within a bound, so a save that never answers cannot hold Refresh).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_WAIT_MS, writesInFlight } from '../components/writesInFlight';

/** A write the test lands (or fails) by hand. */
function pending() {
    let land!: () => void;
    let fail!: (e: unknown) => void;
    const p = new Promise<void>((res, rej) => { land = res; fail = rej; });
    return { p, land, fail };
}

afterEach(() => { vi.useRealTimers(); });

describe('writesInFlight', () => {
    it('with nothing out, it is settled at once and nothing has started', async () => {
        const w = writesInFlight();
        const mark = w.mark();
        expect(await w.settled(SAVE_WAIT_MS)).toBe(true);
        expect(w.since(mark)).toBe(false);
    });

    it('a write counts from its call until it settles, and its own promise is handed back', async () => {
        const w = writesInFlight();
        const mark = w.mark();
        const one = pending();
        const got = w.run(() => one.p.then(() => 'saved'));
        expect(w.since(mark)).toBe(true);
        one.land();
        expect(await got).toBe('saved');
        // Landed, but it STARTED after the mark: an answer read from before
        // it is still older than the screen.
        expect(w.since(mark)).toBe(true);
        expect(w.since(w.mark())).toBe(false);
    });

    it('a write still out counts against a mark taken after it started', async () => {
        const w = writesInFlight();
        const one = pending();
        void w.run(() => one.p);
        const mark = w.mark();
        expect(w.since(mark)).toBe(true);
        one.land();
        await one.p;
        await new Promise(r => setTimeout(r, 0));
        expect(w.since(mark)).toBe(false);
    });

    it('settled waits for every write out, and for one that starts while it waits', async () => {
        const w = writesInFlight();
        const first = pending();
        const second = pending();
        void w.run(() => first.p);
        let done: boolean | null = null;
        const waiting = w.settled(SAVE_WAIT_MS).then(v => { done = v; });
        void w.run(() => second.p);
        first.land();
        await new Promise(r => setTimeout(r, 0));
        expect(done).toBeNull();
        second.land();
        await waiting;
        expect(done).toBe(true);
    });

    it('a write that fails is no longer out, and the failure is the caller\'s to see', async () => {
        const w = writesInFlight();
        const one = pending();
        const got = w.run(() => one.p);
        one.fail(new Error('refused'));
        await expect(got).rejects.toThrow('refused');
        expect(await w.settled(SAVE_WAIT_MS)).toBe(true);
        expect(w.since(w.mark())).toBe(false);
    });

    it('a write that never answers ends the wait at the bound, as not settled', async () => {
        vi.useFakeTimers();
        const w = writesInFlight();
        void w.run(() => new Promise<void>(() => {}));
        let done: boolean | null = null;
        void w.settled(SAVE_WAIT_MS).then(v => { done = v; });
        await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
        expect(done).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(false);
    });
});
