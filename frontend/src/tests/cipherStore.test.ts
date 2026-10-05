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

// ---- an in-memory OPFS ------------------------------------------------------
class FakeFileHandle {
    readonly kind = 'file';
    data = new Uint8Array(0);
    readonly name: string;
    constructor(name: string) { this.name = name; }
    async createWritable() {
        const parts: Uint8Array[] = [];
        return {
            write: async (d: Uint8Array) => { parts.push(new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))); },
            close: async () => {
                const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
                let o = 0;
                for (const p of parts) { out.set(p, o); o += p.length; }
                this.data = out;
            },
        };
    }
    async getFile() {
        const d = this.data;
        return { size: d.length, arrayBuffer: async () => d.slice().buffer } as unknown as File;
    }
}
class FakeDir {
    readonly kind = 'directory';
    entries = new Map<string, FakeDir | FakeFileHandle>();
    readonly name: string;
    constructor(name: string) { this.name = name; }
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
        let d = this.entries.get(n);
        if (!d) { if (!o?.create) throw new DOMException('no such directory', 'NotFoundError'); d = new FakeDir(n); this.entries.set(n, d); }
        return d as FakeDir;
    }
    async getFileHandle(n: string, o?: { create?: boolean }) {
        let f = this.entries.get(n);
        if (!f) { if (!o?.create) throw new DOMException('no such file', 'NotFoundError'); f = new FakeFileHandle(n); this.entries.set(n, f); }
        return f as FakeFileHandle;
    }
    async removeEntry(n: string) {
        if (!this.entries.delete(n)) throw new DOMException('no such entry', 'NotFoundError');
    }
    async *keys() { for (const k of [...this.entries.keys()]) yield k; }
}
let root: FakeDir;
const held = new Set<string>();
const cacheDir = () => root.entries.get('puca-attachment-cache') as FakeDir | undefined;
const sessionDirs = () => [...(cacheDir()?.entries.keys() ?? [])];
const filesIn = (name: string) => [...((cacheDir()?.entries.get(name) as FakeDir | undefined)?.entries.values() ?? [])] as FakeFileHandle[];

// ---- the writer worker, doing what cipherWriter.worker.ts does --------------
type Listener = (e: Event) => void;
class FakeWriter {
    static all: FakeWriter[] = [];
    static mode: 'ok' | 'fail-start' | 'fail-write' = 'ok';
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
    root = new FakeDir('');
    held.clear();
    FakeWriter.all = [];
    FakeWriter.mode = 'ok';
    FakeWriter.hold = null;
    vi.stubGlobal('navigator', {
        storage: { getDirectory: async () => root },
        locks: {
            request: (name: string, cb: () => Promise<void>) => { held.add(name); return cb().then(() => { held.delete(name); }); },
            query: async () => ({ held: [...held].map((name) => ({ name })) }),
        },
    });
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
