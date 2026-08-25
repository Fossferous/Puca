/**
 * Peer-to-peer file transfer engine — the byte pump.
 *
 * See docs/P2P_FILE_TRANSFER_PLAN.md. This module deliberately knows nothing
 * about WebRTC negotiation, the WS, or React: it moves bytes over anything
 * shaped like a data channel, so the parts that are easy to get wrong
 * (backpressure, chunk framing, resume offsets, integrity) can be tested
 * without a browser or a second peer.
 *
 * WIRE FORMAT. Every chunk is a 4-byte big-endian chunk index followed by its
 * payload. The index is what makes resume verifiable rather than hopeful: the
 * receiver can assert that what arrived is the chunk it expected next, instead
 * of trusting a stream position after a reconnect and silently corrupting the
 * file at the join.
 */
import { sha256 } from '@noble/hashes/sha2.js';

/** 16 KiB is the payload size every SCTP implementation handles without
 *  fragmentation games. Bigger chunks buy little and start to fail on some
 *  stacks. */
export const CHUNK_SIZE = 16 * 1024;

/**
 * Read granularity for the pre-offer hash pass — NOT the wire chunk size.
 * CHUNK_SIZE exists for SCTP framing; hashing at it meant one async disk
 * round trip per 16 KiB, which is ~65,000 awaits for a single-gigabyte file
 * and was most of why an offer took so long to appear. Hashing has no framing
 * constraint, so it reads in far larger slices; 4 MiB keeps peak memory
 * trivial while cutting the round trips by 256x.
 */
export const HASH_READ_SIZE = 4 * 1024 * 1024;

/** Header: one uint32 chunk index. */
export const CHUNK_HEADER_BYTES = 4;

/**
 * Stop writing once this much sits unsent in the channel, resume when it drains
 * below `LOW_WATER`. Without this the send loop runs at memory speed while the
 * uplink runs at uplink speed, and the difference accumulates in the channel's
 * buffer until the tab dies. This is THE thing that goes wrong in data-channel
 * implementations, and it does not show up on localhost.
 */
export const HIGH_WATER = 1024 * 1024;
export const LOW_WATER = 512 * 1024;

/** The subset of RTCDataChannel this engine needs — kept narrow so tests can
 *  supply a fake with a real buffer model. */
export interface ChannelLike {
    readonly bufferedAmount: number;
    bufferedAmountLowThreshold: number;
    readyState: 'connecting' | 'open' | 'closing' | 'closed';
    send(data: ArrayBuffer): void;
    addEventListener(type: 'bufferedamountlow', cb: () => void): void;
    removeEventListener(type: 'bufferedamountlow', cb: () => void): void;
}

/** Where received bytes go. Desktop writes to a file; a test collects them. */
export interface ByteSink {
    write(chunk: Uint8Array): Promise<void> | void;
    close(): Promise<void> | void;
}

export interface TransferProgress {
    bytes: number;
    total: number;
    /** 0..1 */
    fraction: number;
}

export type TransferErrorCode = 'cancelled' | 'channel-closed' | 'bad-chunk' | 'hash-mismatch';

export class TransferError extends Error {
    readonly code: TransferErrorCode;

    constructor(message: string, code: TransferErrorCode) {
        super(message);
        this.name = 'TransferError';
        this.code = code;
    }
}

/** Frame one chunk: [uint32 index][payload]. */
export function encodeChunk(index: number, payload: Uint8Array): ArrayBuffer {
    const out = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
    new DataView(out.buffer).setUint32(0, index, false);
    out.set(payload, CHUNK_HEADER_BYTES);
    return out.buffer;
}

/** Inverse of `encodeChunk`. Throws on a frame too short to hold a header. */
export function decodeChunk(buf: ArrayBuffer): { index: number; payload: Uint8Array } {
    if (buf.byteLength < CHUNK_HEADER_BYTES) {
        throw new TransferError('chunk shorter than its header', 'bad-chunk');
    }
    const index = new DataView(buf).getUint32(0, false);
    return { index, payload: new Uint8Array(buf, CHUNK_HEADER_BYTES) };
}

/** Which chunk index a byte offset begins at. Resume only ever restarts on a
 *  chunk boundary, so a partial chunk is re-sent rather than spliced. */
export function chunkIndexForOffset(offset: number): number {
    return Math.floor(offset / CHUNK_SIZE);
}

/** Byte offset a chunk index starts at — the offset a resume truncates to. */
export function offsetForChunkIndex(index: number): number {
    return index * CHUNK_SIZE;
}

/** Lowercase hex, matching what the offer carries and the server validates. */
export async function sha256Hex(bytes: BufferSource): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Incremental SHA-256, so neither side ever holds a whole file to hash it.
 *
 * `crypto.subtle.digest` takes one contiguous buffer, which for a 4 GB transfer
 * means 4 GB of RAM — exactly what the chunked read and write exist to avoid.
 * `@noble/hashes` is already a dependency here (the E2EE path uses it), so this
 * costs no new supply-chain surface.
 */
export class Sha256Stream {
    private readonly hasher = sha256.create();

    update(chunk: Uint8Array): this {
        this.hasher.update(chunk);
        return this;
    }

    /** Lowercase hex. The hasher must not be used after this. */
    hex(): string {
        return toHex(this.hasher.digest());
    }
}

/**
 * Digest a Blob by streaming it, never materialising more than one chunk.
 *
 * Used before offering a file: the digest goes in the offer so the receiver can
 * verify what it assembled, and so a resumed transfer can prove it is the same
 * file rather than assuming it.
 */
export async function sha256OfBlob(
    blob: Blob,
    onProgress?: (bytesRead: number) => void,
    /** Checked between slices, so cancelling a huge offer stops the read
     *  promptly instead of digesting the rest of the file first. */
    signal?: { aborted: boolean },
): Promise<string> {
    const stream = new Sha256Stream();
    for (let at = 0; at < blob.size; at += HASH_READ_SIZE) {
        if (signal?.aborted) throw new TransferError('cancelled by user', 'cancelled');
        const slice = blob.slice(at, Math.min(at + HASH_READ_SIZE, blob.size));
        stream.update(new Uint8Array(await slice.arrayBuffer()));
        onProgress?.(Math.min(at + HASH_READ_SIZE, blob.size));
    }
    return stream.hex();
}

/** Await room in the channel's send buffer. Resolves immediately when there is
 *  already room, so the common case costs nothing. */
function drain(channel: ChannelLike): Promise<void> {
    if (channel.bufferedAmount < HIGH_WATER) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const onLow = () => {
            channel.removeEventListener('bufferedamountlow', onLow);
            resolve();
        };
        if (channel.readyState !== 'open') {
            reject(new TransferError('channel closed while sending', 'channel-closed'));
            return;
        }
        channel.bufferedAmountLowThreshold = LOW_WATER;
        channel.addEventListener('bufferedamountlow', onLow);
    });
}

export interface SendOptions {
    /** Start here (a resume). Rounded DOWN to a chunk boundary. */
    resumeFrom?: number;
    onProgress?: (p: TransferProgress) => void;
    /** Checked between chunks so a cancel takes effect promptly. */
    signal?: { aborted: boolean };
    /**
     * Optional throughput ceiling in bytes/second, or null for unlimited.
     *
     * A FUNCTION, not a number, because it is read once per chunk: the user can
     * drag the limiter mid-transfer and the next chunk already respects it. A
     * value captured at the start would freeze the setting for the whole
     * transfer, which for a multi-gigabyte send is the entire point missed.
     */
    rateLimit?: () => number | null;
}

/**
 * Send-loop telemetry, for `__pucaTransferDiag()`.
 *
 * Exists to settle a question code reading could not: the measured ~4 MB/s
 * PC→phone has TWO candidate mechanisms that both predict it (this loop's
 * per-iteration cost × 16 KiB, and the Android sink's bridge round trip per
 * flush window), and every number in that analysis was back-solved from the
 * same observation. The buckets attribute each iteration's time to
 * drain-wait / blob-read / send / progress, and the bufferedAmount samples
 * are the decisive discriminator: pinned near HIGH_WATER means the RECEIVER
 * is the slow side (the channel is full, we are waiting), near zero means
 * this loop itself is the cap.
 */
const sendDiag = {
    iterations: 0,
    drainMs: 0,
    readMs: 0,
    sendMs: 0,
    progressMs: 0,
    maxIterMs: 0,
    /** channel.bufferedAmount sampled every 64th iteration; last 32 kept. */
    bufferedSamples: [] as number[],
};

export function transferSendDiag(): Record<string, unknown> {
    const d = sendDiag;
    const per = (v: number) => (d.iterations ? +(v / d.iterations).toFixed(3) : 0);
    return {
        iterations: d.iterations,
        avgDrainMs: per(d.drainMs),
        avgReadMs: per(d.readMs),
        avgSendMs: per(d.sendMs),
        avgProgressMs: per(d.progressMs),
        maxIterMs: +d.maxIterMs.toFixed(1),
        bufferedSamples: [...d.bufferedSamples],
        highWater: HIGH_WATER,
    };
}

/**
 * Pump a file into the channel, respecting backpressure.
 *
 * Reads one chunk at a time from the Blob rather than pulling the file into
 * memory: a 4 GB transfer must not cost 4 GB of RAM to send. The NEXT chunk's
 * read is started before the current one is awaited, so the blob/disk
 * round trip overlaps the send instead of serializing with it — the old
 * strictly serial shape made throughput exactly CHUNK_SIZE per event-loop
 * turn, which on a ~4 ms turn is the field-reported 4 MB/s on a gigabit LAN.
 * Order on the wire is untouched: reads may overlap, sends never do.
 */
export async function sendFile(
    channel: ChannelLike,
    file: Blob,
    opts: SendOptions = {},
): Promise<void> {
    const total = file.size;
    const startIndex = chunkIndexForOffset(opts.resumeFrom ?? 0);
    let sent = offsetForChunkIndex(startIndex);

    // Per-transfer diagnostics — a diagnosis reads THIS transfer, not the
    // session-lifetime mix of everything sent before it.
    sendDiag.iterations = 0;
    sendDiag.drainMs = 0;
    sendDiag.readMs = 0;
    sendDiag.sendMs = 0;
    sendDiag.progressMs = 0;
    sendDiag.maxIterMs = 0;
    sendDiag.bufferedSamples.length = 0;

    const readChunk = (index: number): Promise<Uint8Array> | null => {
        const start = offsetForChunkIndex(index);
        if (start >= total) return null;
        const slice = file.slice(start, Math.min(start + CHUNK_SIZE, total));
        return slice.arrayBuffer().then(b => new Uint8Array(b));
    };

    let pendingRead = readChunk(startIndex);
    try {
    for (let index = startIndex; sent < total && pendingRead; index++) {
        if (opts.signal?.aborted) throw new TransferError('cancelled by user', 'cancelled');
        if (channel.readyState !== 'open') {
            throw new TransferError('channel closed while sending', 'channel-closed');
        }
        const chunkStarted = Date.now();
        const t0 = performance.now();
        await drain(channel);
        const t1 = performance.now();
        const payload = await pendingRead; // usually already resolved (read-ahead)
        // Kick off the NEXT read before sending this one: it resolves while
        // the send and the following drain-wait happen.
        pendingRead = readChunk(index + 1);
        const t2 = performance.now();
        try {
            channel.send(encodeChunk(index, payload));
        } catch (err) {
            // The channel can close between the readyState check above and this
            // write — reading a chunk is asynchronous, so there is always a gap.
            // A real RTCDataChannel throws InvalidStateError there, which a
            // caller matching on our own error type would never recognise.
            throw new TransferError(
                `channel rejected a chunk: ${(err as Error)?.message ?? err}`,
                'channel-closed',
            );
        }
        const t3 = performance.now();

        sent = offsetForChunkIndex(index) + payload.byteLength;
        opts.onProgress?.({ bytes: sent, total, fraction: total ? sent / total : 1 });
        const t4 = performance.now();

        sendDiag.iterations++;
        sendDiag.drainMs += t1 - t0;
        sendDiag.readMs += t2 - t1;
        sendDiag.sendMs += t3 - t2;
        sendDiag.progressMs += t4 - t3;
        if (t4 - t0 > sendDiag.maxIterMs) sendDiag.maxIterMs = t4 - t0;
        if (sendDiag.iterations % 64 === 0) {
            sendDiag.bufferedSamples.push(channel.bufferedAmount);
            if (sendDiag.bufferedSamples.length > 32) sendDiag.bufferedSamples.shift();
        }

        // Pace to the requested ceiling. Sleep for however long this chunk
        // "should" have taken minus what it actually took, so the average
        // converges on the limit without stalling on a single slow chunk.
        // Backpressure above is a separate concern: it stops us overrunning the
        // channel's buffer, which says nothing about how fast the link runs.
        const limit = opts.rateLimit?.();
        if (limit && limit > 0) {
            const owedMs = (payload.byteLength / limit) * 1000 - (Date.now() - chunkStarted);
            if (owedMs > 0) await new Promise(r => setTimeout(r, owedMs));
        }
    }
    } finally {
        // Every early exit — abort, channel close, a send failure — leaves
        // the read-ahead promise with no consumer. Give it one, or a blob
        // read failing AFTER a deliberate cancel surfaces as an unhandled
        // rejection on a path the user chose.
        void pendingRead?.catch(() => undefined);
    }
}

export interface ReceiveOptions {
    expectedSha256: string;
    total: number;
    /** Bytes already on disk from a previous attempt (chunk-aligned). */
    resumeFrom?: number;
    onProgress?: (p: TransferProgress) => void;
}

/**
 * Assemble incoming chunks into a sink, verifying order as they land.
 *
 * The hash is computed over what was actually written and compared at the end.
 * A transfer that runs for twenty minutes and lands corrupt with no way to tell
 * is worse than one that fails loudly, so `finish()` rejects on a mismatch and
 * the caller is expected to discard the partial file.
 */
export class TransferReceiver {
    private expectedIndex: number;
    private received: number;
    /** Hashed as chunks land. Retaining them to hash at the end would hold the
     *  whole file in memory — the exact cost the streaming sink avoids. */
    private readonly digest = new Sha256Stream();

    private readonly sink: ByteSink;
    private readonly opts: ReceiveOptions;

    constructor(sink: ByteSink, opts: ReceiveOptions) {
        this.sink = sink;
        this.opts = opts;
        this.expectedIndex = chunkIndexForOffset(opts.resumeFrom ?? 0);
        this.received = offsetForChunkIndex(this.expectedIndex);
    }

    /** Byte offset to resume from if this attempt dies now. */
    get offset(): number {
        return this.received;
    }

    async accept(frame: ArrayBuffer): Promise<void> {
        const { index, payload } = decodeChunk(frame);
        // Out-of-order or duplicated frames mean the stream is not what we
        // think it is. Reassembling anyway is how a resume silently corrupts a
        // file that then passes every check except the hash.
        if (index !== this.expectedIndex) {
            throw new TransferError(
                `expected chunk ${this.expectedIndex}, received ${index}`,
                'bad-chunk',
            );
        }
        // Never write past the size that was offered. The sender is another
        // user's client, so `total` is a claim, not a fact — without this a
        // peer could keep sending after the declared end and fill the disk,
        // one accepted chunk at a time, long after the UI said "complete".
        if (this.received + payload.byteLength > this.opts.total) {
            throw new TransferError(
                `sender exceeded the declared size of ${this.opts.total} bytes`,
                'bad-chunk',
            );
        }
        await this.sink.write(payload);
        this.digest.update(payload);
        this.expectedIndex++;
        this.received += payload.byteLength;
        this.opts.onProgress?.({
            bytes: this.received,
            total: this.opts.total,
            fraction: this.opts.total ? this.received / this.opts.total : 1,
        });
    }

    /**
     * Close the sink and verify integrity. Only valid for a transfer that ran
     * from offset 0 — a resumed transfer's hash covers bytes this process never
     * saw, so the caller must hash the completed file on disk instead.
     */
    async finish(): Promise<void> {
        await this.sink.close();
        if ((this.opts.resumeFrom ?? 0) > 0) return; // caller re-hashes from disk
        const actual = this.digest.hex();
        if (actual !== this.opts.expectedSha256) {
            throw new TransferError(
                'the assembled file does not match the sender\'s hash',
                'hash-mismatch',
            );
        }
    }
}
