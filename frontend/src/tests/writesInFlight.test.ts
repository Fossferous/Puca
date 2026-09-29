/**
 * writesInFlight — what a task view's Refresh asks before it reads: is a
 * write still out, has one started since, and has everything landed yet
 * (within a bound, so a save that never answers cannot hold Refresh).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAVE_WAIT_MS, uncounted, within, writesInFlight } from '../components/writesInFlight';

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

describe('settled with a first wait (a note\'s text save): one bound for all of it', () => {
    it('waits for the first wait, then the writes, and is settled when both are', async () => {
        const w = writesInFlight();
        const note = pending();
        const item = pending();
        void w.run(() => item.p);
        let done: boolean | null = null;
        const waiting = w.settled(SAVE_WAIT_MS, note.p).then(v => { done = v; });
        item.land();
        await new Promise(r => setTimeout(r, 0));
        expect(done).toBeNull();
        note.land();
        await waiting;
        expect(done).toBe(true);
    });

    it('a first wait that takes most of the bound leaves the writes only the rest of it', async () => {
        vi.useFakeTimers();
        const w = writesInFlight();
        const note = pending();
        void w.run(() => new Promise<void>(() => {}));
        let done: boolean | null = null;
        void w.settled(SAVE_WAIT_MS, note.p).then(v => { done = v; });
        setTimeout(note.land, SAVE_WAIT_MS - 5_000);
        await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
        expect(done).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(false);
    });

    it('a first wait that never answers ends at the bound', async () => {
        vi.useFakeTimers();
        const w = writesInFlight();
        let done: boolean | null = null;
        void w.settled(SAVE_WAIT_MS, new Promise(() => {})).then(v => { done = v; });
        await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
        expect(done).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(false);
    });
});

describe('within — the bound for a wait that is not a counted write (a note\'s text save)', () => {
    it('true when the promise settles in time, either way', async () => {
        expect(await within(Promise.resolve('saved'), SAVE_WAIT_MS)).toBe(true);
        expect(await within(Promise.reject(new Error('refused')), SAVE_WAIT_MS)).toBe(true);
    });

    it('false at the bound for one that never answers, and at once with no time left', async () => {
        vi.useFakeTimers();
        let done: boolean | null = null;
        void within(new Promise(() => {}), SAVE_WAIT_MS).then(v => { done = v; });
        await vi.advanceTimersByTimeAsync(SAVE_WAIT_MS - 1);
        expect(done).toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(false);
        expect(await within(new Promise(() => {}), 0)).toBe(false);
    });

    it('uncounted runs the write as it is, and hands its promise back', async () => {
        expect(await uncounted(async () => 'saved')).toBe('saved');
    });
});
