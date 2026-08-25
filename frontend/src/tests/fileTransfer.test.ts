import { describe, it, expect, vi } from 'vitest';
import {
    CHUNK_SIZE,
    HASH_READ_SIZE,
    HIGH_WATER,
    LOW_WATER,
    encodeChunk,
    decodeChunk,
    chunkIndexForOffset,
    offsetForChunkIndex,
    sendFile,
    TransferReceiver,
    TransferError,
    sha256Hex,
    sha256OfBlob,
    type ChannelLike,
    type ByteSink,
} from '../api/fileTransfer';

// jsdom's Blob implements no arrayBuffer(), though every target we ship to
// (WebView2, Chromium, Android WebView) and Node itself do. Shim it via
// FileReader so the engine's real `slice(...).arrayBuffer()` path is exercised
// rather than replaced.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (Blob.prototype as any).arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result as ArrayBuffer);
            fr.onerror = () => reject(fr.error);
            fr.readAsArrayBuffer(this);
        });
    };
}

/**
 * A data channel with a REAL buffer model: bytes accumulate in `bufferedAmount`
 * and only leave when the test drains them, exactly like a socket bound by an
 * uplink. Backpressure bugs are invisible against a fake that swallows
 * everything instantly — which is also why localhost proves nothing here.
 */
class FakeChannel implements ChannelLike {
    bufferedAmount = 0;
    bufferedAmountLowThreshold = 0;
    readyState: ChannelLike['readyState'] = 'open';
    sent: ArrayBuffer[] = [];
    /** Highest bufferedAmount ever reached — the number that must stay bounded. */
    peak = 0;
    private listeners = new Set<() => void>();

    send(data: ArrayBuffer): void {
        if (this.readyState !== 'open') throw new Error('send on closed channel');
        this.sent.push(data);
        this.bufferedAmount += data.byteLength;
        this.peak = Math.max(this.peak, this.bufferedAmount);
    }
    addEventListener(_t: 'bufferedamountlow', cb: () => void): void { this.listeners.add(cb); }
    removeEventListener(_t: 'bufferedamountlow', cb: () => void): void { this.listeners.delete(cb); }

    /** Pretend the network moved `n` bytes, firing the low-water event. */
    drain(n = Infinity): void {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - n);
        if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
            for (const cb of [...this.listeners]) cb();
        }
    }
    /** Drain continuously at a bounded RATE, as a real uplink does. The rate
     *  matters: a fake that empties the buffer instantly hides missing
     *  backpressure entirely, because the producer never gets ahead. */
    autoDrain(bytesPerTick = LOW_WATER): void {
        const tick = () => {
            if (this.bufferedAmount > 0) this.drain(bytesPerTick);
            if (this.readyState === 'open') setTimeout(tick, 0);
        };
        setTimeout(tick, 0);
    }
}

function collectingSink(): ByteSink & { bytes: () => Uint8Array; closed: boolean } {
    const parts: Uint8Array[] = [];
    return {
        closed: false,
        write(chunk) { parts.push(new Uint8Array(chunk)); },
        close() { this.closed = true; },
        bytes() {
            const total = parts.reduce((n, p) => n + p.byteLength, 0);
            const out = new Uint8Array(total);
            let at = 0;
            for (const p of parts) { out.set(p, at); at += p.byteLength; }
            return out;
        },
    };
}

function blobOf(bytes: number): Blob {
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) data[i] = i % 251; // non-uniform, so order matters
    return new Blob([data]);
}

describe('chunk framing', () => {
    it('round-trips an index and payload', () => {
        const payload = new Uint8Array([1, 2, 3, 4, 5]);
        const { index, payload: out } = decodeChunk(encodeChunk(7, payload));
        expect(index).toBe(7);
        expect([...out]).toEqual([1, 2, 3, 4, 5]);
    });

    it('survives an index beyond 16 bits (a large file has many chunks)', () => {
        // 4 GB at 16 KiB per chunk is ~262 000 chunks: a uint16 would wrap and
        // silently misroute every chunk after the 65 536th.
        const { index } = decodeChunk(encodeChunk(300_000, new Uint8Array([9])));
        expect(index).toBe(300_000);
    });

    it('rejects a frame too short to hold a header', () => {
        expect(() => decodeChunk(new ArrayBuffer(2))).toThrow(TransferError);
    });
});

describe('resume alignment', () => {
    it('maps offsets to chunk boundaries and back', () => {
        expect(chunkIndexForOffset(0)).toBe(0);
        expect(chunkIndexForOffset(CHUNK_SIZE - 1)).toBe(0);
        expect(chunkIndexForOffset(CHUNK_SIZE)).toBe(1);
        expect(offsetForChunkIndex(3)).toBe(3 * CHUNK_SIZE);
    });

    it('rounds a mid-chunk resume DOWN, re-sending the partial chunk', () => {
        // Resuming mid-chunk and appending would splice a partial chunk onto a
        // whole one — the file then differs from the sender's only inside, and
        // only the hash would ever notice.
        const offset = CHUNK_SIZE * 2 + 500;
        expect(offsetForChunkIndex(chunkIndexForOffset(offset))).toBe(CHUNK_SIZE * 2);
    });
});

describe('sendFile backpressure', () => {
    it('never lets the send buffer run away, even for a file far larger than it', async () => {
        const ch = new FakeChannel();
        // Drain one chunk per tick: slower than the producer, like a real link.
        ch.autoDrain(CHUNK_SIZE);
        // ~4 MB against a 1 MB high-water mark: without backpressure the whole
        // file lands in the buffer at memory speed.
        await sendFile(ch, blobOf(CHUNK_SIZE * 256));
        expect(ch.peak).toBeLessThanOrEqual(HIGH_WATER + CHUNK_SIZE);
    });

    it('stops writing while the buffer is full and continues once it drains', async () => {
        const ch = new FakeChannel();
        const done = vi.fn();
        const p = sendFile(ch, blobOf(CHUNK_SIZE * 200)).then(done);

        // Let it fill the buffer, with nothing draining. Reading each chunk is
        // asynchronous, so give it as long as it needs to reach the high-water
        // mark rather than assuming a single tick is enough.
        for (let i = 0; i < 500 && ch.bufferedAmount < HIGH_WATER; i++) {
            await new Promise(r => setTimeout(r, 0));
        }
        const stalledAt = ch.sent.length;
        expect(ch.bufferedAmount).toBeGreaterThanOrEqual(HIGH_WATER);
        await new Promise(r => setTimeout(r, 5));
        expect(ch.sent.length).toBe(stalledAt);   // genuinely blocked, not spinning
        expect(done).not.toHaveBeenCalled();

        ch.autoDrain();
        await p;
        expect(ch.sent.length).toBeGreaterThan(stalledAt);
    });

    it('aborts promptly when cancelled', async () => {
        const ch = new FakeChannel();
        ch.autoDrain();
        const signal = { aborted: false };
        const p = sendFile(ch, blobOf(CHUNK_SIZE * 100), { signal });
        signal.aborted = true;
        await expect(p).rejects.toThrow(TransferError);
    });

    it('fails loudly if the channel closes mid-transfer', async () => {
        const ch = new FakeChannel();
        ch.autoDrain();
        const p = sendFile(ch, blobOf(CHUNK_SIZE * 100));
        ch.readyState = 'closed';
        await expect(p).rejects.toMatchObject({ code: 'channel-closed' });
    });

    it('resumes from a chunk boundary rather than restarting', async () => {
        const ch = new FakeChannel();
        ch.autoDrain();
        await sendFile(ch, blobOf(CHUNK_SIZE * 10), { resumeFrom: CHUNK_SIZE * 4 });
        expect(ch.sent).toHaveLength(6);
        expect(decodeChunk(ch.sent[0]).index).toBe(4);
    });
});

describe('streaming hash', () => {
    /**
     * Integrity rests entirely on this agreeing with a real SHA-256, so check
     * it against the platform's own implementation rather than against itself.
     * Chunk boundaries are where a hand-fed incremental hasher goes wrong, so
     * the sizes deliberately straddle them.
     */
    it('matches crypto.subtle for sizes around the chunk boundary', async () => {
        for (const size of [0, 1, 1000, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 3 + 7]) {
            const data = new Uint8Array(size);
            for (let i = 0; i < size; i++) data[i] = (i * 31 + 7) % 256;
            const streamed = await sha256OfBlob(new Blob([data]));
            expect(streamed, `size ${size}`).toBe(await sha256Hex(data));
        }
    });

    it('is order-sensitive: the same bytes rearranged hash differently', async () => {
        const a = await sha256OfBlob(new Blob([new Uint8Array([1, 2, 3, 4])]));
        const b = await sha256OfBlob(new Blob([new Uint8Array([4, 3, 2, 1])]));
        expect(a).not.toBe(b);
    });

    it('never holds more than one read slice while digesting', async () => {
        // A blob spanning several hash-read slices, digested with no full-file
        // buffer anywhere. The guarantee is structural (one slice at a time),
        // so this mostly documents intent and would catch a regression to
        // `await blob.arrayBuffer()`.
        const size = HASH_READ_SIZE * 2 + 7;
        const data = new Uint8Array(size);
        const reads: number[] = [];
        const digest = await sha256OfBlob(new Blob([data]), n => reads.push(n));
        expect(digest).toBe(await sha256Hex(data));
        expect(reads.length).toBe(3); // read in slices, not one gulp
    });

    it('stops between slices when the signal aborts', async () => {
        const size = HASH_READ_SIZE * 4;
        const signal = { aborted: false };
        const reads: number[] = [];
        await expect(sha256OfBlob(
            new Blob([new Uint8Array(size)]),
            n => { reads.push(n); signal.aborted = true; },   // cancel after the first slice
            signal,
        )).rejects.toMatchObject({ code: 'cancelled' });
        expect(reads.length).toBe(1); // it did not digest the rest first
    });
});

describe('receiving', () => {
    it('reassembles a file byte-for-byte and verifies its hash', async () => {
        const size = CHUNK_SIZE * 3 + 17; // deliberately not chunk-aligned
        const source = blobOf(size);
        const expected = new Uint8Array(await source.arrayBuffer());

        const ch = new FakeChannel();
        ch.autoDrain();
        await sendFile(ch, source);

        const sink = collectingSink();
        const rx = new TransferReceiver(sink, {
            expectedSha256: await sha256Hex(expected),
            total: size,
        });
        for (const frame of ch.sent) await rx.accept(frame);
        await rx.finish();

        expect(sink.closed).toBe(true);
        expect(rx.offset).toBe(size);
        expect([...sink.bytes()]).toEqual([...expected]);
    });

    it('refuses an out-of-order chunk instead of writing it', async () => {
        const sink = collectingSink();
        const rx = new TransferReceiver(sink, { expectedSha256: 'unused', total: CHUNK_SIZE * 3 });
        await rx.accept(encodeChunk(0, new Uint8Array([1, 2, 3])));
        // Chunk 1 was lost. Accepting 2 here would leave a hole that only the
        // final hash could detect — after the whole transfer had run.
        await expect(rx.accept(encodeChunk(2, new Uint8Array([4])))).rejects.toMatchObject({
            code: 'bad-chunk',
        });
        expect([...sink.bytes()]).toEqual([1, 2, 3]);
    });

    it('rejects a file whose contents do not match the sender hash', async () => {
        const sink = collectingSink();
        const rx = new TransferReceiver(sink, {
            expectedSha256: 'f'.repeat(64), // not the real digest
            total: 3,
        });
        await rx.accept(encodeChunk(0, new Uint8Array([1, 2, 3])));
        await expect(rx.finish()).rejects.toMatchObject({ code: 'hash-mismatch' });
    });

    /**
     * `total` comes from the SENDER — another user's client — so it is a claim.
     * A peer that keeps sending past the declared end would otherwise fill the
     * receiver's disk one accepted chunk at a time.
     */
    it('refuses bytes past the size that was offered', async () => {
        const sink = collectingSink();
        const rx = new TransferReceiver(sink, { expectedSha256: 'unused', total: 10 });
        await rx.accept(encodeChunk(0, new Uint8Array(8)));
        await expect(rx.accept(encodeChunk(1, new Uint8Array(8)))).rejects.toMatchObject({
            code: 'bad-chunk',
        });
        expect(rx.offset).toBe(8);          // the overshoot was never written
        expect(sink.bytes().byteLength).toBe(8);
    });

    it('accepts a final chunk that lands exactly on the declared size', async () => {
        const sink = collectingSink();
        const rx = new TransferReceiver(sink, { expectedSha256: 'unused', total: 10 });
        await rx.accept(encodeChunk(0, new Uint8Array(6)));
        await expect(rx.accept(encodeChunk(1, new Uint8Array(4)))).resolves.toBeUndefined();
        expect(rx.offset).toBe(10);
    });

    /**
     * A data channel delivers chunks far faster than a disk write completes, so
     * the manager must serialize them. This pins the receiver half of that
     * contract: writes land in arrival order even when the sink is slow, and
     * nothing is reordered or dropped.
     */
    it('keeps bytes in order when the sink is slower than the arrivals', async () => {
        const written: number[] = [];
        const slowSink: ByteSink = {
            async write(chunk) {
                // Deliberately inverted delays: chunk 0 is slowest. Anything
                // that does not await in order will interleave here.
                await new Promise(r => setTimeout(r, chunk[0] === 0 ? 6 : 1));
                written.push(chunk[0]);
            },
            close() { /* nothing */ },
        };
        const rx = new TransferReceiver(slowSink, { expectedSha256: 'unused', total: 3 });

        // Serialized exactly as the manager does it.
        let chain: Promise<void> = Promise.resolve();
        for (let i = 0; i < 3; i++) {
            const frame = encodeChunk(i, new Uint8Array([i]));
            chain = chain.then(() => rx.accept(frame));
        }
        await chain;

        expect(written).toEqual([0, 1, 2]);
        expect(rx.offset).toBe(3);
    });

    it('reports an offset a resume can restart from', async () => {
        const sink = collectingSink();
        const rx = new TransferReceiver(sink, { expectedSha256: 'unused', total: CHUNK_SIZE * 4 });
        await rx.accept(encodeChunk(0, new Uint8Array(CHUNK_SIZE)));
        await rx.accept(encodeChunk(1, new Uint8Array(CHUNK_SIZE)));
        expect(rx.offset).toBe(CHUNK_SIZE * 2);
    });

    it('starts a resumed receive at the right chunk and skips the in-memory hash', async () => {
        // A resumed transfer's hash covers bytes this process never saw, so
        // finish() must not "verify" against a partial buffer and fail a file
        // that is actually fine — the caller re-hashes from disk instead.
        const sink = collectingSink();
        const rx = new TransferReceiver(sink, {
            expectedSha256: 'f'.repeat(64),
            total: CHUNK_SIZE * 4,
            resumeFrom: CHUNK_SIZE * 2,
        });
        expect(rx.offset).toBe(CHUNK_SIZE * 2);
        await rx.accept(encodeChunk(2, new Uint8Array(CHUNK_SIZE)));
        await expect(rx.finish()).resolves.toBeUndefined();
    });
});
