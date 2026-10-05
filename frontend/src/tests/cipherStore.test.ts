/**
 * api/cipherStore.ts: where the attachment cache keeps the ciphertext of
 * copies nobody is showing. Not a Blob: Chromium writes several blobs into
 * one page file and keeps the file while any of them lives, so a cached
 * ciphertext Blob kept a picture's PLAINTEXT on disk after the picture had
 * gone (measured in the Android WebView and in Edge, 2026-10-05). An OPFS
 * file of its own instead, written by a worker that is then terminated.
 *
 * jsdom has no OPFS and no Worker: both are stood in here (an in-memory
 * directory tree with the same calls, Web Locks, a writer that does what
 * cipherWriter.worker.ts does). The real ones, on a real disk:
 * e2e/plaintext-disk-real-browser.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { keepCipher, dropAllCiphertext, __setCipherStoreDisabled, __setCipherWriterFactory } from '../api/cipherStore';
import { type FakeDir, type FakeFileHandle, fakeOpfsNavigator, sessionDirsOf, filesInOf } from './fixtures/fakeOpfs';

// ---- an in-memory OPFS (fixtures/fakeOpfs.ts) ------------------------------
let root: FakeDir;
let held: Set<string>;
const sessionDirs = () => sessionDirsOf(root);
const filesIn = (name: string) => filesInOf(root, name);

// ---- the writer worker, doing what cipherWriter.worker.ts does --------------
type Listener = (e: Event) => void;
class FakeWriter {
    static all: FakeWriter[] = [];
    static mode: 'ok' | 'fail-start' | 'fail-write' | 'cannot-clone' = 'ok';
    static hold: Promise<void> | null = null;
    terminated = false;
    private ls: Record<string, Listener[]> = { message: [], error: [] };
    constructor() {
        FakeWriter.all.push(this);
        const mode = FakeWriter.mode;
        setTimeout(() => {
            if (mode === 'fail-start') this.emit('error', new Event('error'));
            else this.reply({ ready: true });
        }, 0);
    }
    addEventListener(t: string, l: Listener) { this.ls[t].push(l); }
    private emit(t: string, e: Event) { for (const l of this.ls[t]) l(e); }
    private reply(data: unknown) { this.emit('message', Object.assign(new Event('message'), { data })); }
    postMessage(m: { handle: FakeFileHandle; buf: ArrayBuffer; offset: number; length: number }, transfer: ArrayBuffer[]) {
        // An engine that cannot hand a file handle to a worker throws here,
        // before anything is transferred (the buffer stays the page's).
        if (FakeWriter.mode === 'cannot-clone') throw new DOMException('FileSystemFileHandle could not be cloned.', 'DataCloneError');
        // Transferred: the page's buffer is detached from here on.
        const buf = structuredClone(m.buf, { transfer });
        void (async () => {
            if (FakeWriter.hold) await FakeWriter.hold;
            if (FakeWriter.mode === 'fail-write') { this.reply({ ok: false, error: 'no sync access handles' }); return; }
            m.handle.data = new Uint8Array(buf, m.offset, m.length).slice();
            this.reply({ ok: true });
        })();
    }
    terminate() { this.terminated = true; }
}

const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const bytes = (...xs: number[]) => new Uint8Array(xs);

beforeEach(() => {
    const opfs = fakeOpfsNavigator();
    root = opfs.root;
    held = opfs.held;
    FakeWriter.all = [];
    FakeWriter.mode = 'ok';
    FakeWriter.hold = null;
    vi.stubGlobal('navigator', opfs.navigator);
    __setCipherStoreDisabled(null); // a new session directory per test
    __setCipherWriterFactory(() => new FakeWriter() as unknown as Worker);
});

afterEach(() => {
    __setCipherWriterFactory(null);
    __setCipherStoreDisabled(null);
    vi.unstubAllGlobals();
});

describe('the ciphertext cache', () => {
    it('writes each copy to a file of its own through a writer worker, terminated after, and the page keeps no copy', async () => {
        const sealed = bytes(1, 2, 3, 4);
        const copy = keepCipher(sealed);
        await settle();
        const [session] = sessionDirs();
        expect(filesIn(session).map((f) => Array.from(f.data))).toEqual([[1, 2, 3, 4]]);
        expect(FakeWriter.all).toHaveLength(1);
        expect(FakeWriter.all[0].terminated).toBe(true);
        expect(sealed.byteLength).toBe(0); // handed to the writer
        expect(Array.from(await copy.read())).toEqual([1, 2, 3, 4]);
    });

    it('one writer per copy, one at a time', async () => {
        keepCipher(bytes(1));
        keepCipher(bytes(2));
        keepCipher(bytes(3));
        await settle(40);
        expect(FakeWriter.all).toHaveLength(3);
        expect(FakeWriter.all.every((w) => w.terminated)).toBe(true);
        expect(filesIn(sessionDirs()[0]).map((f) => f.data[0]).sort()).toEqual([1, 2, 3]);
    });

    it('a read while the bytes are with the writer waits for the file', async () => {
        let finish!: () => void;
        FakeWriter.hold = new Promise<void>((r) => { finish = r; });
        const copy = keepCipher(bytes(7, 8));
        await settle();
        let got: number[] | null = null;
        void copy.read().then((b) => { got = Array.from(b); });
        await settle();
        expect(got).toBeNull();
        finish();
        await settle();
        expect(got).toEqual([7, 8]);
    });

    it('a read before its write starts gets a copy of the bytes (the original stays the store\'s)', async () => {
        let finish!: () => void;
        FakeWriter.hold = new Promise<void>((r) => { finish = r; });
        keepCipher(bytes(1)); // takes the one writer slot and waits
        const second = keepCipher(bytes(9, 9));
        const b = await second.read();
        expect(Array.from(b)).toEqual([9, 9]);
        b[0] = 0; // the caller owns what it got
        finish();
        await settle(40);
        expect(Array.from(await second.read())).toEqual([9, 9]);
    });

    it('with no writer worker, the page writes it and frees its own copy', async () => {
        __setCipherWriterFactory(() => null);
        const sealed = bytes(5, 6);
        const copy = keepCipher(sealed);
        await settle();
        expect(filesIn(sessionDirs()[0]).map((f) => Array.from(f.data))).toEqual([[5, 6]]);
        expect(sealed.byteLength).toBe(0); // freed once the file had it
        expect(Array.from(await copy.read())).toEqual([5, 6]);
    });

    it('a writer that cannot start loses nothing: the page writes it, and every later one', async () => {
        FakeWriter.mode = 'fail-start';
        const copy = keepCipher(bytes(4, 2));
        await settle();
        expect(Array.from(await copy.read())).toEqual([4, 2]);
        FakeWriter.mode = 'ok';
        keepCipher(bytes(1));
        await settle();
        expect(FakeWriter.all).toHaveLength(1); // no second try
        expect(filesIn(sessionDirs()[0])).toHaveLength(2);
    });

    it('a writer that cannot be handed the file loses nothing: the page writes it, and every later one', async () => {
        // postMessage throws (a DataCloneError) before it transfers anything:
        // the bytes are still the page's, so this copy must not count as lost,
        // and no later copy may be lost the same way (review finding, 2026-10-05).
        FakeWriter.mode = 'cannot-clone';
        const copy = keepCipher(bytes(6, 1));
        await settle();
        expect(Array.from(await copy.read())).toEqual([6, 1]);
        expect(filesIn(sessionDirs()[0]).map((f) => Array.from(f.data))).toEqual([[6, 1]]);
        expect(FakeWriter.all[0].terminated).toBe(true);
        const later = keepCipher(bytes(2));
        await settle();
        expect(FakeWriter.all).toHaveLength(1); // the page writes from now on
        expect(Array.from(await later.read())).toEqual([2]);
        expect(filesIn(sessionDirs()[0])).toHaveLength(2);
    });

    it('a writer that fails with the bytes: that copy is gone, and read says so (the cache downloads it again)', async () => {
        FakeWriter.mode = 'fail-write';
        const copy = keepCipher(bytes(3));
        await settle();
        await expect(copy.read()).rejects.toThrow(/gone/);
        expect(filesIn(sessionDirs()[0])).toHaveLength(0);
    });

    it('a dropped copy\'s file is removed', async () => {
        const copy = keepCipher(bytes(1, 1));
        await settle();
        copy.drop();
        await settle();
        expect(filesIn(sessionDirs()[0])).toHaveLength(0);
        await expect(copy.read()).rejects.toThrow();
    });

    it('sweeps the directories no live page holds, and leaves a held one alone', async () => {
        const base = await root.getDirectoryHandle('puca-attachment-cache', { create: true });
        await (await base.getDirectoryHandle('s-crashed', { create: true })).getFileHandle('c1', { create: true });
        await base.getDirectoryHandle('s-other-tab', { create: true });
        held.add('puca-attachment-cache:s-other-tab');
        keepCipher(bytes(1));
        await settle();
        expect(sessionDirs()).not.toContain('s-crashed');
        expect(sessionDirs()).toContain('s-other-tab');
        expect(sessionDirs()).toHaveLength(2);
    });

    it('sign-out removes this page\'s directory and lets its lock go', async () => {
        keepCipher(bytes(1));
        await settle();
        const [mine] = sessionDirs();
        expect(held.has(`puca-attachment-cache:${mine}`)).toBe(true);
        dropAllCiphertext();
        await settle();
        expect(sessionDirs()).toEqual([]);
        expect(held.size).toBe(0);
    });

    it('with no OPFS, a copy stays in memory and a read hands back a copy of it', async () => {
        vi.stubGlobal('navigator', {});
        __setCipherStoreDisabled(null);
        const sealed = bytes(2, 4);
        const copy = keepCipher(sealed);
        await settle();
        const b = await copy.read();
        expect(Array.from(b)).toEqual([2, 4]);
        expect(b).not.toBe(sealed);
        expect(sealed.byteLength).toBe(2);
    });
});
