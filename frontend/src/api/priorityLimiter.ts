/**
 * Run at most `max` async jobs at once, starting the most urgent waiting job
 * whenever a slot frees.
 *
 * Built for encrypted attachments (api/attachments.ts `acquireAttachmentUrl`):
 * a channel used to fetch and decrypt every attachment in its history at the
 * same moment, so the video on screen finished LAST — measured 2026-10-05 in
 * headless Edge at 100 Mbit, the newest (on-screen) of 12 videos took 24 s,
 * the oldest 12.6 s — and the renderer held all twelve downloads at once
 * (it grew by up to 770 MB). Urgency is a function, asked when a slot frees
 * rather than when the job was queued: the reader may have scrolled since,
 * and where an attachment is relative to the screen is what decides.
 *
 * A job whose signal aborts while it waits is dropped and rejects with an
 * AbortError; one that has started runs to completion (its result is still
 * worth having — it lands in the cache).
 *
 * A `background` job (a file far from the screen, loaded ahead of the reader)
 * never takes the last free slot: one is always left for a file the reader
 * scrolls to, which would otherwise wait out a whole download it does not
 * need — 1.8 s for a 22.5 MB video at 100 Mbit, 12 s at 15.
 */

export interface LimiterJob<T> {
    run: () => Promise<T>;
    /** Lower runs first. Asked each time a slot frees. Ties keep queue order. */
    urgency: () => number;
    signal?: AbortSignal;
    /** Never takes the last free slot (see above). */
    background?: boolean;
}

export interface PriorityLimiter {
    schedule<T>(job: LimiterJob<T>): Promise<T>;
    /** Reject every job still waiting (sign-out). Running jobs finish. */
    clear(): void;
    readonly active: number;
    readonly waiting: number;
}

interface Waiting {
    job: LimiterJob<unknown>;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    onAbort?: () => void;
}

export function abortError(): Error {
    const e = new Error('The operation was aborted.');
    e.name = 'AbortError';
    return e;
}

export function isAbortError(e: unknown): boolean {
    return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError';
}

export function createPriorityLimiter(max: number): PriorityLimiter {
    let active = 0;
    let activeBackground = 0;
    const maxBackground = Math.max(1, max - 1);
    const queue: Waiting[] = [];
    // A free slot is filled a microtask AFTER the job that found it, not
    // during schedule(): a channel's attachments all ask in the same tick
    // (one render's effects), top of the list first, and the first two to ask
    // would otherwise take both slots before the one on screen had asked.
    let pumpQueued = false;
    const pumpSoon = () => {
        if (pumpQueued) return;
        pumpQueued = true;
        queueMicrotask(() => { pumpQueued = false; pump(); });
    };

    const detach = (w: Waiting) => {
        if (w.onAbort) w.job.signal?.removeEventListener('abort', w.onAbort);
    };

    const urgencyOf = (w: Waiting): number => {
        try {
            const u = w.job.urgency();
            return Number.isFinite(u) ? u : Number.MAX_SAFE_INTEGER;
        } catch {
            return Number.MAX_SAFE_INTEGER;
        }
    };

    const pump = () => {
        while (active < max && queue.length > 0) {
            const backgroundFull = activeBackground >= maxBackground;
            let best = -1;
            let bestU = 0;
            for (let i = 0; i < queue.length; i++) {
                if (backgroundFull && queue[i].job.background) continue;
                const u = urgencyOf(queue[i]);
                if (best < 0 || u < bestU) { best = i; bestU = u; }
            }
            if (best < 0) return; // only background jobs wait, and they may not take this slot
            const [w] = queue.splice(best, 1);
            detach(w);
            const background = !!w.job.background;
            active++;
            if (background) activeBackground++;
            let p: Promise<unknown>;
            try {
                p = w.job.run();
            } catch (e) {
                p = Promise.reject(e);
            }
            p.then(w.resolve, w.reject).finally(() => {
                active--;
                if (background) activeBackground--;
                pump();
            });
        }
    };

    return {
        schedule<T>(job: LimiterJob<T>): Promise<T> {
            if (job.signal?.aborted) return Promise.reject(abortError());
            return new Promise<T>((resolve, reject) => {
                const w: Waiting = { job: job as LimiterJob<unknown>, resolve: resolve as (v: unknown) => void, reject };
                if (job.signal) {
                    w.onAbort = () => {
                        const i = queue.indexOf(w);
                        if (i >= 0) {
                            queue.splice(i, 1);
                            detach(w);
                            reject(abortError());
                        }
                    };
                    job.signal.addEventListener('abort', w.onAbort);
                }
                queue.push(w);
                pumpSoon();
            });
        },
        clear() {
            for (const w of queue.splice(0)) {
                detach(w);
                w.reject(abortError());
            }
        },
        get active() { return active; },
        get waiting() { return queue.length; },
    };
}
