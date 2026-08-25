import { describe, it, expect } from 'vitest';
import { SerialQueue } from '../api/devices/serialQueue';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('SerialQueue', () => {
    /**
     * THE PROPERTY. A slow first job must still finish before a fast second one
     * starts, or the signalling counter it guards is worthless: n=1 would reach
     * the peer ahead of n=0 and the peer would drop n=0 as a replay.
     *
     * The first job is deliberately much slower, so this fails without the queue
     * rather than passing by luck of scheduling.
     */
    it('runs jobs in call order even when the first is slower', async () => {
        const q = new SerialQueue();
        const order: number[] = [];

        await Promise.all([
            q.run(async () => { await wait(30); order.push(1); }),
            q.run(async () => { await wait(0); order.push(2); }),
            q.run(async () => { order.push(3); }),
        ]);

        expect(order).toEqual([1, 2, 3]);
    });

    /** Jobs must not overlap — the next starts only after the previous settles. */
    it('never runs two jobs at once', async () => {
        const q = new SerialQueue();
        let running = 0;
        let maxConcurrent = 0;

        await Promise.all(Array.from({ length: 6 }, () => q.run(async () => {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            await wait(5);
            running--;
        })));

        expect(maxConcurrent).toBe(1);
    });

    /**
     * A rejecting job must not wedge the queue. One failed send would otherwise
     * silently kill every later signal on that session — the session would look
     * alive and simply stop negotiating.
     */
    it('keeps running after a job rejects', async () => {
        const q = new SerialQueue();
        const order: string[] = [];

        const failed = q.run(async () => { throw new Error('boom'); });
        await expect(failed).rejects.toThrow('boom');

        await q.run(async () => { order.push('after'); });
        expect(order).toEqual(['after']);
    });

    /** The caller gets its own result back, not the previous job's. */
    it('resolves with each job value', async () => {
        const q = new SerialQueue();
        const [a, b] = await Promise.all([
            q.run(async () => { await wait(10); return 'first'; }),
            q.run(async () => 'second'),
        ]);
        expect([a, b]).toEqual(['first', 'second']);
    });
});
