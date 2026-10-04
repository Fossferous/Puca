/**
 * How fast a phone save goes, without giving back the bound that keeps it
 * from crashing the app (saveToDeviceBounded.test.ts).
 *
 * Owner report 2026-10-04: Android downloads "took very long". Measured on the
 * emulator, every phone save paid ~7-11 MB/s through the base64/JSON bridge,
 * and ~40% of that was the JavaScript base64 loop; saving an attachment also
 * read the WHOLE decrypted file back out of its blob before the first write
 * (2 of 4.5 s for a 22.5 MB video), holding a second full copy in memory.
 *
 *   1. bytesToBase64 hands the work to the engine's Uint8Array.toBase64 when
 *      there is one (WebView 151 has it; Node 24, which runs these tests, does
 *      not — so the fallback is what the other suites exercise).
 *   2. saveBytesToDevice reads the blob as a stream, one slice ahead of the
 *      writes: the first write happens long before the last byte is read, the
 *      read never runs more than a few slices ahead, and the file on disk is
 *      the input byte for byte.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fakeCapacitorFs, patternBytes } from './fixtures/fakeCapacitorFs';

const h = vi.hoisted(() => ({
    fs: null as ReturnType<typeof import('./fixtures/fakeCapacitorFs').fakeCapacitorFs> | null,
    /** Bytes the blob stream had handed out at each bridge write. */
    pulledAtWrite: [] as number[],
    pulled: 0,
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'android',
        isPluginAvailable: (n: string) => n === 'Filesystem',
        isNativePlatform: () => true,
    },
    registerPlugin: () => ({}),
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        writeFile: (o: never) => { h.pulledAtWrite.push(h.pulled); return h.fs!.api.writeFile(o); },
        appendFile: (o: never) => { h.pulledAtWrite.push(h.pulled); return h.fs!.api.appendFile(o); },
        deleteFile: (o: never) => h.fs!.api.deleteFile(o),
        rename: (o: never) => h.fs!.api.rename(o),
    },
    Directory: { Documents: 'DOCUMENTS' },
    Encoding: { UTF8: 'utf8' },
}));

const { bytesToBase64, saveBytesToDevice, sliceReader, DEVICE_WRITE_CHUNK_BYTES } = await import('../api/saveToDevice');

describe('bytesToBase64 — the engine does the encoding when it can', () => {
    const proto = Uint8Array.prototype as Uint8Array & { toBase64?: () => string };
    const had = Object.prototype.hasOwnProperty.call(proto, 'toBase64');
    const original = proto.toBase64;
    afterEach(() => {
        if (had) proto.toBase64 = original; else delete proto.toBase64;
    });

    it('uses Uint8Array.prototype.toBase64 when the engine has it', () => {
        const native = vi.fn(function (this: Uint8Array) { return `native:${this.byteLength}`; });
        proto.toBase64 = native;
        const bytes = new Uint8Array(3 * 1024 * 1024).subarray(5, 1029);
        expect(bytesToBase64(bytes)).toBe('native:1024');
        expect(native).toHaveBeenCalledTimes(1);
        expect(native.mock.contexts[0]).toBe(bytes); // the view itself, not its whole buffer
    });

    it('falls back to the loop when it does not, with the same output as btoa', () => {
        delete proto.toBase64;
        const big = new Uint8Array(0x8000 * 2 + 5).map((_, i) => (i * 7) % 251);
        expect(bytesToBase64(big)).toBe(btoa(Array.from(big, b => String.fromCharCode(b)).join('')));
    });
});

/** A pull stream over `bytes` in ragged chunks, counting what it has handed out. */
function raggedStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
    let off = 0;
    let k = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (off >= bytes.length) { controller.close(); return; }
            const n = Math.min(bytes.length - off, [65536, 1, 300_000, 4093, 2 * 1024 * 1024][k++ % 5]);
            controller.enqueue(bytes.slice(off, off + n));
            off += n;
            h.pulled = off;
        },
    }, { highWaterMark: 0 });
}

describe('sliceReader — a stream re-cut into exact slices', () => {
    it('exact sizes whatever the chunking, the last one shorter, then null; nothing lost or repeated', async () => {
        const input = patternBytes(10 * 1024 * 1024 + 7, 9);
        const next = sliceReader(raggedStream(input).getReader(), DEVICE_WRITE_CHUNK_BYTES);
        const slices: Uint8Array[] = [];
        for (let s = await next(); s; s = await next()) slices.push(s);
        expect(slices.map(s => s.byteLength)).toEqual([DEVICE_WRITE_CHUNK_BYTES, DEVICE_WRITE_CHUNK_BYTES, DEVICE_WRITE_CHUNK_BYTES, 1024 * 1024 + 7]);
        expect(Buffer.concat(slices.map(s => Buffer.from(s))).equals(Buffer.from(input))).toBe(true);
        expect(await next()).toBeNull();
    });
    it('an empty stream is no slices at all', async () => {
        const next = sliceReader(raggedStream(new Uint8Array(0)).getReader(), 16);
        expect(await next()).toBeNull();
    });
});

describe('saveBytesToDevice — read one slice ahead of the writes', () => {
    let disk: ReturnType<typeof fakeCapacitorFs>;
    beforeEach(() => {
        disk = fakeCapacitorFs();
        h.fs = disk;
        h.pulledAtWrite.length = 0;
        h.pulled = 0;
    });

    it('writes long before the whole file is read, never reads far ahead, and saves it byte for byte', async () => {
        const input = patternBytes(20 * 1024 * 1024 + 7, 4);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(raggedStream(input))));
        try {
            const r = await saveBytesToDevice('Puca', 'video.mp4', 'blob:test/1');
            const onDisk = disk.read(r.where.replace(/^Documents\//, ''));
            expect(onDisk!.equals(Buffer.from(input))).toBe(true);
        } finally {
            vi.unstubAllGlobals();
        }
        // The first bridge write went out with most of the file still unread
        // (the old code read every byte before writing one).
        expect(h.pulledAtWrite[0]).toBeLessThan(input.length / 2);
        // Write k carries raw bytes up to (k+1) slices (the first slice is held
        // back until the second arrives, so writes 0 and 1 go out together);
        // the stream is never more than three slices (+ one chunk) ahead.
        h.pulledAtWrite.forEach((pulled, k) => {
            expect(pulled, `bytes read at write ${k}`).toBeLessThanOrEqual((k + 4) * DEVICE_WRITE_CHUNK_BYTES);
        });
    }, 60_000);
});
