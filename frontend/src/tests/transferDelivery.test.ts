/**
 * `sendFile` resolves on QUEUED, not on DELIVERED — and the sender must not
 * close the transport until the bytes are actually across.
 *
 * THE BUG THIS PINS (reported from the first real two-machine transfer, a
 * 28.3 MB file): the sender did
 *
 *     await sendFile(...)        // last chunk handed to the channel
 *     ...
 *     finally { teardown() }     // channel.close() AND pc.close()
 *
 * `pc.close()` drops the DTLS/SCTP transport immediately, discarding anything
 * still sitting in `bufferedAmount`. The receiver saw the association abort and
 * reported "the data channel failed" on a transfer whose bytes had all been
 * sent.
 *
 * WHY THE LOOPBACK HARNESS COULD NOT CATCH IT: e2e/p2p-loopback.mjs runs both
 * peers inside one Chromium process, so delivery is effectively instantaneous
 * and `bufferedAmount` had always drained by the time the sender finished. Only
 * real network latency leaves a tail in the buffer. That is exactly the class
 * of bug an in-process harness cannot see, so it is pinned here instead —
 * against the property, not the transport.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendFile, CHUNK_SIZE } from '../api/fileTransfer';

/**
 * A channel that ACCEPTS chunks instantly but "delivers" nothing: everything
 * stays in bufferedAmount, like a real link with latency. Matches ChannelLike,
 * including the addEventListener pair the send loop waits on.
 */
function laggyChannel() {
    const queued: ArrayBuffer[] = [];
    const lowListeners = new Set<() => void>();
    return {
        readyState: 'open' as const,
        bufferedAmount: 0,
        bufferedAmountLowThreshold: 0,
        send(data: ArrayBuffer) {
            queued.push(data);
            this.bufferedAmount += data.byteLength;
        },
        addEventListener(_t: 'bufferedamountlow', cb: () => void) { lowListeners.add(cb); },
        removeEventListener(_t: 'bufferedamountlow', cb: () => void) { lowListeners.delete(cb); },
        /** Simulate the wire draining. */
        drain() {
            this.bufferedAmount = 0;
            for (const cb of [...lowListeners]) cb();
        },
        queued,
        lowListeners,
    };
}

/**
 * jsdom's Blob.slice() returns something without arrayBuffer(), so the real
 * send loop cannot read it. Minimal stand-in with the two members it uses.
 */
function fakeFile(size: number) {
    const data = new Uint8Array(size);
    return {
        size,
        slice(start: number, end: number) {
            const part = data.subarray(start, end);
            return {
                arrayBuffer: async () =>
                    part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength),
            };
        },
    };
}

describe('sendFile completion semantics', () => {
    it('resolves while bytes are STILL buffered — so resolution is not delivery', async () => {
        const ch = laggyChannel();
        // Small enough to never hit the high-water mark, so the send loop never
        // pauses and everything is still queued when sendFile returns.
        const file = fakeFile(CHUNK_SIZE * 3);

        await sendFile(ch as never, file);

        // THE POINT: sendFile is done, but nothing has been delivered.
        expect(ch.bufferedAmount).toBeGreaterThan(0);
        // Closing the transport here is what destroyed the tail.
    });

    it('every chunk was handed over, so the tail is real data not an artefact', async () => {
        const ch = laggyChannel();
        const size = CHUNK_SIZE * 3;
        await sendFile(ch as never, fakeFile(size));

        const bytesQueued = ch.queued.reduce((n, c) => n + c.byteLength, 0);
        // 4-byte big-endian index prefix on each chunk.
        expect(bytesQueued).toBe(size + ch.queued.length * 4);
        expect(ch.bufferedAmount).toBe(bytesQueued);
    });

    /**
     * The shape of the fix: wait for the buffer to drain before tearing down.
     * Pinned as a property so a future refactor that closes eagerly fails here.
     */
    it('draining is observable, so a sender CAN wait for it', async () => {
        const ch = laggyChannel();
        await sendFile(ch as never, fakeFile(CHUNK_SIZE * 2));
        expect(ch.bufferedAmount).toBeGreaterThan(0);

        const lowFired = vi.fn();
        ch.addEventListener('bufferedamountlow', lowFired);
        ch.drain();

        expect(ch.bufferedAmount).toBe(0);
        expect(lowFired).toHaveBeenCalled();
    });

    /**
     * Backpressure still has to work — the fix must not have turned the send
     * loop into an unbounded queue. With a channel that never drains, the loop
     * must stop rather than buffer the whole file.
     */
    it('still applies backpressure when the buffer never drains', async () => {
        const ch = laggyChannel();
        const big = fakeFile(CHUNK_SIZE * 400);   // ~6.5 MB
        const done = vi.fn();
        void sendFile(ch as never, big).then(done);

        // Let the loop run until it blocks on the high-water mark.
        await new Promise(r => setTimeout(r, 50));
        expect(done).not.toHaveBeenCalled();
        expect(ch.bufferedAmount).toBeLessThan(big.size);
    });
});
