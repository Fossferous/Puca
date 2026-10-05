/**
 * api/priorityLimiter.ts: at most N jobs at once, the most urgent waiting one
 * next, urgency asked when a slot frees (the reader may have scrolled since
 * it was queued), and an aborted wait never runs.
 */
import { describe, it, expect } from 'vitest';
import { createPriorityLimiter, isAbortError } from '../api/priorityLimiter';

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('createPriorityLimiter', () => {
    it('never runs more than `max` at once, and starts the next as one ends', async () => {
        const lim = createPriorityLimiter(2);
        const gates = Array.from({ length: 5 }, () => deferred());
        const started: number[] = [];
        let running = 0, most = 0;
        const done = gates.map((g, i) => lim.schedule({
            run: async () => { started.push(i); running++; most = Math.max(most, running); await g.promise; running--; return i; },
            urgency: () => 0,
        }));
        await tick();
        expect(started).toEqual([0, 1]);
        expect(lim.waiting).toBe(3);
        gates[1].resolve();
        await tick();
        expect(started).toEqual([0, 1, 2]);
        for (const g of gates) g.resolve();
        expect(await Promise.all(done)).toEqual([0, 1, 2, 3, 4]);
        expect(most).toBe(2);
        expect(lim.active).toBe(0);
    });

    it('starts the most urgent waiting job, judged when the slot frees, not when it was queued', async () => {
        const lim = createPriorityLimiter(1);
        const first = deferred();
        const started: string[] = [];
        // Queued in the order of their urgency then, so neither FIFO nor a
        // rank taken at queue time can pass this.
        const urgency: Record<string, number> = { a: 10, b: 20, c: 30 };
        const job = (name: string) => lim.schedule({ run: async () => { started.push(name); }, urgency: () => urgency[name] });
        const blocker = lim.schedule({ run: async () => { started.push('blocker'); await first.promise; }, urgency: () => 0 });
        const all = [job('a'), job('b'), job('c')];
        await tick();
        expect(started).toEqual(['blocker']);
        // Scrolled while they waited: `c` is on screen now, `a` far away.
        urgency.c = 0;
        urgency.a = 50;
        first.resolve();
        await blocker;
        await Promise.all(all);
        expect(started).toEqual(['blocker', 'c', 'b', 'a']);
    });

    it('jobs asked for in the same tick are ranked together: the most urgent wins although it asked last', async () => {
        // A channel's attachments all ask in one render, top of the list
        // first; the one on screen is the last to ask.
        const lim = createPriorityLimiter(2);
        const started: string[] = [];
        const gate = deferred();
        const job = (name: string, u: number) => lim.schedule({ run: async () => { started.push(name); await gate.promise; }, urgency: () => u });
        const all = [job('far', 900), job('nearer', 300), job('onscreen-1', 0), job('onscreen-2', 0)];
        await tick();
        expect(started).toEqual(['onscreen-1', 'onscreen-2']);
        gate.resolve();
        await Promise.all(all);
        expect(started).toEqual(['onscreen-1', 'onscreen-2', 'nearer', 'far']);
    });

    it('a job aborted while it waits never runs and rejects AbortError; one already running finishes', async () => {
        const lim = createPriorityLimiter(1);
        const gate = deferred();
        const ran: string[] = [];
        const runningAc = new AbortController();
        const running = lim.schedule({ run: async () => { ran.push('running'); await gate.promise; return 'done'; }, urgency: () => 0, signal: runningAc.signal });
        const waitingAc = new AbortController();
        const waiting = lim.schedule({ run: async () => { ran.push('waiting'); }, urgency: () => 0, signal: waitingAc.signal });
        await tick();
        waitingAc.abort();
        runningAc.abort();
        await expect(waiting).rejects.toSatisfy(isAbortError);
        gate.resolve();
        await expect(running).resolves.toBe('done');
        await tick();
        expect(ran).toEqual(['running']);
        expect(lim.waiting).toBe(0);
    });

    it('an already-aborted signal is refused at once; clear() drops everything waiting', async () => {
        const lim = createPriorityLimiter(1);
        const ac = new AbortController();
        ac.abort();
        await expect(lim.schedule({ run: async () => 1, urgency: () => 0, signal: ac.signal })).rejects.toSatisfy(isAbortError);
        const gate = deferred();
        const ran: number[] = [];
        const a = lim.schedule({ run: async () => { ran.push(1); await gate.promise; }, urgency: () => 0 });
        const b = lim.schedule({ run: async () => { ran.push(2); }, urgency: () => 0 });
        await tick();
        lim.clear();
        await expect(b).rejects.toSatisfy(isAbortError);
        gate.resolve();
        await a;
        expect(ran).toEqual([1]);
    });

    const jobs = (lim: ReturnType<typeof createPriorityLimiter>) => {
        const started: string[] = [];
        const gates: Record<string, { promise: Promise<void>; resolve: () => void }> = {};
        const all: Promise<void>[] = [];
        const job = (name: string, background: boolean) => {
            gates[name] = deferred();
            all.push(lim.schedule({ run: async () => { started.push(name); await gates[name].promise; }, urgency: () => 0, background }));
        };
        return { started, gates, all, job };
    };

    it('a background job never takes the last free slot: one is left for a file the reader scrolls to', async () => {
        const lim = createPriorityLimiter(2);
        const { started, gates, all, job } = jobs(lim);
        job('far-1', true); job('far-2', true); job('far-3', true);
        await tick();
        // Three far files wait to be loaded ahead: only one runs.
        expect(started).toEqual(['far-1']);
        // The reader scrolls to another: it starts at once, in the slot kept free.
        job('near', false);
        await tick();
        expect(started).toEqual(['far-1', 'near']);
        // far-1 ends while the near one still loads: the next far one waits,
        // so the slot stays free for whatever the reader scrolls to next.
        gates['far-1'].resolve();
        await tick();
        expect(started).toEqual(['far-1', 'near']);
        gates['near'].resolve();
        await tick();
        // Nothing near loading: the far ones go on, one at a time.
        expect(started).toEqual(['far-1', 'near', 'far-2']);
        gates['far-2'].resolve();
        await tick();
        expect(started).toEqual(['far-1', 'near', 'far-2', 'far-3']);
        gates['far-3'].resolve();
        await Promise.all(all);
        expect(lim.active).toBe(0);
    });

    it('while one near file loads, a far one waits: the file scrolled to next starts at once', async () => {
        // Review finding 2026-10-05: `activeBackground < max - 1` let a far
        // load start beside a near one, so both slots were busy and the next
        // file the reader scrolled to waited out a whole download (up to
        // 1.8 s for 22.5 MB at 100 Mbit, 12 s at 15).
        const lim = createPriorityLimiter(2);
        const { started, gates, all, job } = jobs(lim);
        job('near-1', false);
        await tick();
        job('far-1', true);
        await tick();
        expect(started).toEqual(['near-1']);
        job('scrolled-to', false);
        await tick();
        expect(started).toEqual(['near-1', 'scrolled-to']);
        gates['near-1'].resolve();
        gates['scrolled-to'].resolve();
        await tick();
        expect(started).toEqual(['near-1', 'scrolled-to', 'far-1']);
        gates['far-1'].resolve();
        await Promise.all(all);
    });

    it('with four slots, background jobs leave the fourth free; with one, they run only when it is idle', async () => {
        const four = jobs(createPriorityLimiter(4));
        for (let i = 1; i <= 5; i++) four.job(`far-${i}`, true);
        await tick();
        expect(four.started).toEqual(['far-1', 'far-2', 'far-3']);
        four.job('near', false);
        await tick();
        expect(four.started).toEqual(['far-1', 'far-2', 'far-3', 'near']);
        for (const g of Object.values(four.gates)) g.resolve();
        await tick();
        for (const g of Object.values(four.gates)) g.resolve();
        await Promise.all(four.all);

        const one = jobs(createPriorityLimiter(1));
        one.job('near', false);
        one.job('far', true);
        await tick();
        expect(one.started).toEqual(['near']);
        one.gates['near'].resolve();
        await tick();
        expect(one.started).toEqual(['near', 'far']);
        one.gates['far'].resolve();
        await Promise.all(one.all);
    });

    it('a job that throws frees its slot', async () => {
        const lim = createPriorityLimiter(1);
        const bad = lim.schedule({ run: async () => { throw new Error('boom'); }, urgency: () => 0 });
        const good = lim.schedule({ run: async () => 'ok', urgency: () => 0 });
        await expect(bad).rejects.toThrow('boom');
        await expect(good).resolves.toBe('ok');
    });
});
