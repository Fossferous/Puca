/**
 * The Android streaming sink that removes the 100 MB download cap.
 *
 * Two properties decide whether this is an improvement at all, and neither is
 * visible by reading the happy path:
 *
 *  - It must BATCH. Chunks arrive at 16 KiB; one `appendFile` per chunk is a
 *    bridge round trip plus a media-scanner pass each, ~64 of both per MiB, so
 *    an unbatched "uncapped" download would be slower than the capped one it
 *    replaces. These tests count the writes.
 *  - It must FALL BACK, never throw, when the device cannot stream — an APK
 *    too old to carry the plugin, Android below 11, or storage access not
 *    granted. Returning null is what keeps the capped memory sink working;
 *    throwing would turn a degraded case into a broken one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let platform = 'android';
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => platform,
        isPluginAvailable: () => true,
        isNativePlatform: () => true,
    },
    registerPlugin: () => ({}),
}));

let status: { hasAllFilesAccess: boolean; sdk: number } | null = { hasAllFilesAccess: true, sdk: 33 };
let roots: { label: string; path: string }[] = [{ label: 'Downloads', path: '/storage/emulated/0/Download' }];
vi.mock('../api/androidStorage', () => ({
    allFilesAccessStatus: async () => status,
    shareableRoots: async () => roots,
}));

/** An in-memory stand-in for the native filesystem, recording every call. */
const fsCalls: string[] = [];
const files = new Map<string, string>();      // path -> concatenated base64 payloads
const existing = new Set<string>();           // paths that stat() should find
// Double-buffer knobs: real latency makes overlap POSSIBLE (so its absence is
// a result, not an artifact of an instant mock), and the failure switch
// proves a mid-transfer error surfaces instead of silently shortening the
// file until the hash check at the very end.
let bridgeDelayMs = 0;
let bridgeBusy = false;
let bridgeOverlaps = 0;
let failNextAppend = false;

async function bridgeGate(kind: 'writeFile' | 'appendFile'): Promise<void> {
    if (bridgeBusy) bridgeOverlaps++;
    bridgeBusy = true;
    if (bridgeDelayMs) await new Promise(r => setTimeout(r, bridgeDelayMs));
    bridgeBusy = false;
    if (kind === 'appendFile' && failNextAppend) {
        failNextAppend = false;
        throw new Error('disk full');
    }
}

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        async mkdir() { fsCalls.push('mkdir'); },
        async stat({ path }: { path: string }) {
            if (!existing.has(path)) throw new Error('not found');
            return { size: 0, type: 'file' };
        },
        async writeFile({ path, data }: { path: string; data: string }) {
            await bridgeGate('writeFile');
            fsCalls.push('writeFile');
            files.set(path, data);
        },
        async appendFile({ path, data }: { path: string; data: string }) {
            await bridgeGate('appendFile');
            fsCalls.push('appendFile');
            files.set(path, (files.get(path) ?? '') + data);
        },
        async rename({ from, to }: { from: string; to: string }) {
            fsCalls.push('rename');
            files.set(to, files.get(from) ?? '');
            files.delete(from);
            existing.add(to);
        },
        async deleteFile({ path }: { path: string }) {
            fsCalls.push('deleteFile');
            files.delete(path);
        },
    },
}));

import { capacitorFileSink, safeDownloadName } from '../api/capacitorSink';
import type { TransferView } from '../api/fileTransferManager';

// Positive controls for the path-traversal fix: the SENDER controls t.name, and
// it is concatenated into `${dir}/${name}`. Any directory component would let a
// remote peer write outside Downloads/Sovereign. safeDownloadName must reduce
// every hostile shape to a plain basename. These FAIL against the pre-fix code,
// which used t.name verbatim.
describe('safeDownloadName confines the peer-chosen filename', () => {
    it('strips relative traversal to a basename', () => {
        expect(safeDownloadName('../../../../sdcard/evil.txt')).toBe('evil.txt');
        expect(safeDownloadName('a/b/c/clip.mp4')).toBe('clip.mp4');
    });
    it('strips absolute and Windows-style paths', () => {
        expect(safeDownloadName('/sdcard/Download/x.bin')).toBe('x.bin');
        expect(safeDownloadName('C:\\Windows\\System32\\evil.dll')).toBe('evil.dll');
        expect(safeDownloadName('..\\..\\secret.key')).toBe('secret.key');
    });
    it('refuses pure-traversal / empty names with a safe default', () => {
        expect(safeDownloadName('..')).toBe('download');
        expect(safeDownloadName('.')).toBe('download');
        expect(safeDownloadName('foo/..')).toBe('download');
        expect(safeDownloadName('')).toBe('download');
        expect(safeDownloadName('/')).toBe('download');
    });
    it('drops control characters and NUL', () => {
        expect(safeDownloadName('ev\u0000il.txt')).toBe('evil.txt');
        expect(safeDownloadName('a\tb\nc.txt')).toBe('abc.txt');
    });
    it('never yields a name containing a path separator', () => {
        for (const raw of ['../x', '/x', 'a\\b', 'a/b/c', '....//x']) {
            const out = safeDownloadName(raw);
            expect(out.includes('/')).toBe(false);
            expect(out.includes('\\')).toBe(false);
        }
    });
    it('keeps an ordinary name (incl. legit dotfiles and literal %2f) intact', () => {
        expect(safeDownloadName('report 2026.pdf')).toBe('report 2026.pdf');
        expect(safeDownloadName('.gitignore')).toBe('.gitignore');
        expect(safeDownloadName('a%2fb.txt')).toBe('a%2fb.txt');
    });
});

const view = (name: string, size: number) => ({ id: 'x', name, size } as TransferView);

/** Decode everything written to a path back into bytes. */
function bytesAt(path: string): Uint8Array {
    const b64 = files.get(path) ?? '';
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

beforeEach(() => {
    platform = 'android';
    status = { hasAllFilesAccess: true, sdk: 33 };
    roots = [{ label: 'Downloads', path: '/storage/emulated/0/Download' }];
    fsCalls.length = 0;
    files.clear();
    existing.clear();
    bridgeDelayMs = 0;
    bridgeBusy = false;
    bridgeOverlaps = 0;
    failNextAppend = false;
});

describe('falling back instead of failing', () => {
    it.each([
        ['iOS', () => { platform = 'ios'; }],
        ['an APK with no plugin', () => { status = null; }],
        ['Android 10', () => { status = { hasAllFilesAccess: true, sdk: 29 }; }],
        ['storage access not granted', () => { status = { hasAllFilesAccess: false, sdk: 34 }; }],
        ['no shareable folders', () => { roots = []; }],
    ])('returns null on %s', async (_label, arrange) => {
        arrange();
        await expect(capacitorFileSink(view('a.bin', 10))).resolves.toBeNull();
    });
});

describe('streaming to disk', () => {
    it('BATCHES many small chunks into few filesystem writes', async () => {
        const prepared = await capacitorFileSink(view('big.bin', 4 * 1024 * 1024));
        expect(prepared).not.toBeNull();

        // 256 x 16 KiB = 4 MiB, exactly the shape both transfer paths produce.
        const chunk = new Uint8Array(16 * 1024).fill(7);
        for (let i = 0; i < 256; i++) await prepared!.sink.write(chunk);
        await prepared!.sink.close();

        const writes = fsCalls.filter(c => c === 'writeFile' || c === 'appendFile').length;
        expect(writes, 'must not be one write per 16 KiB chunk').toBeLessThan(10);
        expect(writes, 'but must actually write').toBeGreaterThan(0);
        expect(fsCalls).toContain('rename');
    });

    it('writes the bytes it was given, in order, byte-for-byte', async () => {
        const prepared = await capacitorFileSink(view('data.bin', 0));
        // Straddle the 1 MiB flush boundary so the batching path is exercised.
        const a = new Uint8Array(700 * 1024).fill(1);
        const b = new Uint8Array(700 * 1024).fill(2);
        await prepared!.sink.write(a);
        await prepared!.sink.write(b);
        await prepared!.sink.close();

        const out = bytesAt('/storage/emulated/0/Download/Puca/data.bin');
        expect(out.length).toBe(a.length + b.length);
        expect(out[0]).toBe(1);
        expect(out[a.length - 1]).toBe(1);
        expect(out[a.length]).toBe(2);
        expect(out[out.length - 1]).toBe(2);
    });

    it('promotes the .part only on close, so a failed transfer leaves no real file', async () => {
        const prepared = await capacitorFileSink(view('half.bin', 999));
        await prepared!.sink.write(new Uint8Array(32).fill(9));
        // Force the buffered bytes out so there is a .part on disk to abandon.
        expect(files.has('/storage/emulated/0/Download/Puca/half.bin')).toBe(false);

        await prepared!.abort!(false);
        expect(
            files.has('/storage/emulated/0/Download/Puca/half.bin'),
            'an aborted download must never wear the real name',
        ).toBe(false);
    });

    it('does not overwrite a file that is already there', async () => {
        existing.add('/storage/emulated/0/Download/Puca/clip.mp4');
        const prepared = await capacitorFileSink(view('clip.mp4', 10));
        expect(prepared!.describeDestination()).toBe('/storage/emulated/0/Download/Puca/clip (2).mp4');
    });

    it('still produces a file for a zero-byte transfer', async () => {
        const prepared = await capacitorFileSink(view('empty.txt', 0));
        await prepared!.sink.close();
        expect(files.has('/storage/emulated/0/Download/Puca/empty.txt')).toBe(true);
    });
});

describe('the double-buffered bridge (0.8.47)', () => {
    // 1.5 MiB: divisible by 3, so every flushed batch base64-encodes without
    // internal padding when the mock concatenates segments.
    const CHUNK = 1536 * 1024;

    it('keeps filesystem writes strictly serial while overlapping with arrival', async () => {
        bridgeDelayMs = 3; // real latency: overlap is POSSIBLE, so zero is a result
        const prepared = await capacitorFileSink(view('serial.bin', 9 * CHUNK));
        for (let i = 0; i < 6; i++) {
            const part = new Uint8Array(CHUNK).fill(i + 1);
            await prepared!.sink.write(part);
        }
        await prepared!.sink.close();

        expect(bridgeOverlaps, 'two bridge calls must never be in flight together').toBe(0);
        // First write truncates, everything after appends — whatever the
        // in-flight interleaving was.
        const writes = fsCalls.filter(c => c === 'writeFile' || c === 'appendFile');
        expect(writes[0]).toBe('writeFile');
        expect(writes.slice(1).every(c => c === 'appendFile')).toBe(true);
        // Byte order across flush boundaries survives the pipelining.
        const out = bytesAt('/storage/emulated/0/Download/Puca/serial.bin');
        expect(out.length).toBe(6 * CHUNK);
        expect(out[0]).toBe(1);
        expect(out[3 * CHUNK]).toBe(4);
        expect(out[6 * CHUNK - 1]).toBe(6);
    });

    it('an aborted sink stays dead — late writes and close cannot resurrect the file', async () => {
        // The corruption this pins (found in review, never shipped): frames
        // already queued on the manager's writeChain at cancel time kept
        // feeding the sink AFTER abort() deleted the .part — appendFile
        // re-created it holding only the tail, close() renamed that fragment
        // over the real filename, and the transfer reported COMPLETE.
        bridgeDelayMs = 2;
        const prepared = await capacitorFileSink(view('cancelme.bin', 0));
        await prepared!.sink.write(new Uint8Array(3 * CHUNK).fill(1)); // flush queued
        await prepared!.abort!(false);                                  // user cancels
        await prepared!.sink.write(new Uint8Array(3 * CHUNK).fill(2)); // straggler: must no-op
        await expect(prepared!.sink.close()).rejects.toThrow('cancelled');
        expect(files.has('/storage/emulated/0/Download/Puca/cancelme.bin')).toBe(false);
        expect(files.has('/storage/emulated/0/Download/Puca/cancelme.bin.part')).toBe(false);
        expect(fsCalls).not.toContain('rename');
    });

    it('a failed in-flight append surfaces on the next interaction, never silently', async () => {
        bridgeDelayMs = 2;
        const prepared = await capacitorFileSink(view('fail.bin', 0));
        const window = new Uint8Array(3 * CHUNK).fill(1); // one full flush window
        await prepared!.sink.write(window);   // flush 1: writeFile, queued
        failNextAppend = true;
        await prepared!.sink.write(window);   // flush 2: appendFile, will fail in flight
        // The NEXT interaction must throw the stored failure — a silently
        // short file would otherwise only be caught by the hash check at the
        // very end, after every remaining byte had been transferred for
        // nothing.
        await expect(prepared!.sink.close()).rejects.toThrow('disk full');
    });
});
