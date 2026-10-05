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

    it('a background job never takes the last free slot: one is left for a file the reader scrolls to', async () => {
        const lim = createPriorityLimiter(2);
        const started: string[] = [];
        const gates: Record<string, { promise: Promise<void>; resolve: () => void }> = {};
        const job = (name: string, background: boolean) => {
            gates[name] = deferred();
            return lim.schedule({ run: async () => { started.push(name); await gates[name].promise; }, urgency: () => 0, background });
        };
        const all = [job('far-1', true), job('far-2', true), job('far-3', true)];
        await tick();
        // Three far files wait to be loaded ahead: only one runs.
        expect(started).toEqual(['far-1']);
        // The reader scrolls to another: it starts at once, in the slot kept free.
        all.push(job('near', false));
        await tick();
        expect(started).toEqual(['far-1', 'near']);
        // A background slot frees: the next far file takes it, never two at once.
        gates['far-1'].resolve();
        await tick();
        expect(started).toEqual(['far-1', 'near', 'far-2']);
        gates['near'].resolve();
        await tick();
        expect(started).toEqual(['far-1', 'near', 'far-2']);
        gates['far-2'].resolve();
        await tick();
        expect(started).toEqual(['far-1', 'near', 'far-2', 'far-3']);
        gates['far-3'].resolve();
        await Promise.all(all);
        expect(lim.active).toBe(0);
    });

    it('a job that throws frees its slot', async () => {
        const lim = createPriorityLimiter(1);
        const bad = lim.schedule({ run: async () => { throw new Error('boom'); }, urgency: () => 0 });
        const good = lim.schedule({ run: async () => 'ok', urgency: () => 0 });
        await expect(bad).rejects.toThrow('boom');
        await expect(good).resolves.toBe('ok');
    });
});
