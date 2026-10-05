/**
 * Where the attachment cache keeps the CIPHERTEXT of copies nobody is
 * showing (api/attachments.ts): a file in the origin-private file system
 * (OPFS), or memory where there is none.
 *
 * Not a Blob, on purpose. Chromium pages blobs to disk by grouping several
 * of them into one file, oldest first, and a file goes only once every blob
 * in it has: a decrypted picture written into the same page file as a cached
 * ciphertext stays on disk for as long as the ciphertext is cached, whatever
 * happens to the picture (measured 2026-10-05 in the Android WebView: with
 * the ciphertext kept as Blobs, a picture's plaintext was still on disk 20 s
 * after the app went to the background and let it go, in a page file it
 * shared with ciphertext; in headless Edge under memory pressure, the same
 * for a picture and a video chunk). An OPFS file is its own file, outside
 * blob_storage, and holds only what the server holds anyway.
 *
 * Each file is written by a worker of its own (api/cipherWriter.worker.ts,
 * which says why), one file at a time; where that cannot run, by the page.
 * Measured on the 2 GB emulator: 22 MB written in about 0.4 s and read back
 * in 0.15 s. Until its file is written a copy is in memory, so nothing waits
 * for the disk; reading it back (and decrypting it) is what showing a copy
 * again costs: it is never downloaded again.
 *
 * Each page has its own directory, held by a Web Lock for as long as the
 * page lives; a page sweeps every other directory whose lock nobody holds
 * (left by a page that closed or crashed). Sign-out empties its own.
 */
import { freeNow } from './plaintextHost';

export interface CipherCopy {
    /** nonce(12) || AES-GCM ciphertext, as fetched: a copy the caller owns
     *  (and may free with freeNow once it is done with it). */
    read(): Promise<Uint8Array>;
    /** Forget it (its file is removed). Twice does nothing. */
    drop(): void;
}

const ROOT = 'puca-attachment-cache';
const LOCK_PREFIX = `${ROOT}:`;

/** What TypeScript's DOM lib leaves out of a directory handle (the async
 *  iterator lives in DOM.AsyncIterable, which this build does not load). */
type ListableDir = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> };

interface Session { base: FileSystemDirectoryHandle; dir: FileSystemDirectoryHandle; name: string; unlock: () => void }
let dirP: Promise<Session | null> | null = null;
let disabled = false;
let seq = 0;
/** The writes, one after another (keepCipher). */
let writes: Promise<void> = Promise.resolve();

type WriterLike = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener'>;
const defaultWriter = (): WriterLike | null =>
    typeof Worker === 'undefined' ? null : new Worker(new URL('./cipherWriter.worker.ts', import.meta.url), { type: 'module' });
let writerFactory: () => WriterLike | null = defaultWriter;
/** A writer worker could not start, or could not write: the page writes. */
let writersBroken = false;

/** Tests only: no OPFS (copies stay in memory), or back to normal (null). */
export function __setCipherStoreDisabled(v: boolean | null): void {
    disabled = !!v;
    dirP = null;
}
/** Tests only: how writer workers are made (null: the real one). */
export function __setCipherWriterFactory(f: (() => WriterLike | null) | null): void {
    writerFactory = f ?? defaultWriter;
    writersBroken = false;
}

function randomName(): string {
    const b = crypto.getRandomValues(new Uint8Array(8));
    return 's-' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function sweep(base: FileSystemDirectoryHandle, mine: string): Promise<void> {
    const locks = navigator.locks;
    if (!locks) return; // without locks another tab's directory cannot be told from a dead one's
    const held = new Set(((await locks.query()).held ?? []).map((l) => l.name));
    const doomed: string[] = [];
    for await (const name of (base as ListableDir).keys()) {
        if (name !== mine && !held.has(LOCK_PREFIX + name)) doomed.push(name);
    }
    for (const name of doomed) await base.removeEntry(name, { recursive: true }).catch(() => { /* in use or gone */ });
}

function sessionDir(): Promise<Session | null> {
    if (disabled) return Promise.resolve(null);
    dirP ??= (async () => {
        try {
            if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
            const root = await navigator.storage.getDirectory();
            const base = await root.getDirectoryHandle(ROOT, { create: true });
            const name = randomName();
            let unlock = () => { /* no lock held */ };
            if (navigator.locks) {
                // Held until this page goes (or sign-out lets it go): another
                // page's sweep leaves this directory alone while it is.
                await new Promise<void>((granted) => {
                    navigator.locks.request(LOCK_PREFIX + name, () => new Promise<void>((release) => { unlock = release; granted(); }))
                        .catch(() => granted()); // no lock to be had: carry on without one
                });
            }
            const dir = await base.getDirectoryHandle(name, { create: true });
            void sweep(base, name).catch(() => { /* best effort */ });
            return { base, dir, name, unlock };
        } catch {
            return null;
        }
    })();
    return dirP;
}

/**
 * Write `data` into `fh` from a writer worker of its own, and terminate it.
 * Resolves true once the file holds it; false when no worker could start or
 * take it (`data` is untouched then, for the page to write). Rejects when the
 * worker took the bytes and failed (`data` is gone then: it was transferred).
 * `handingOver` runs as soon as `data` has been transferred.
 */
async function writeInWorker(fh: FileSystemFileHandle, data: Uint8Array, handingOver: () => void): Promise<boolean> {
    if (writersBroken) return false;
    let w: WriterLike | null = null;
    try { w = writerFactory(); } catch { w = null; }
    if (!w) { writersBroken = true; return false; }
    const worker = w;
    try {
        const started = await new Promise<boolean>((resolve) => {
            worker.addEventListener('message', (ev: Event) => { if ((ev as MessageEvent).data?.ready) resolve(true); });
            worker.addEventListener('error', () => resolve(false));
        });
        if (!started) { writersBroken = true; return false; }
        const done = new Promise<{ ok: boolean; error?: string }>((resolve) => {
            worker.addEventListener('message', (ev: Event) => { const d = (ev as MessageEvent).data; if (d && 'ok' in d) resolve(d); });
            worker.addEventListener('error', () => resolve({ ok: false, error: 'writer stopped' }));
        });
        const buf = data.buffer as ArrayBuffer;
        try {
            worker.postMessage({ handle: fh, buf, offset: data.byteOffset, length: data.byteLength }, [buf]);
        } catch {
            // Refused before anything was transferred (a DataCloneError: an
            // engine that cannot hand a file handle to a worker): the bytes
            // are still the page's, which writes this copy and every later one.
            writersBroken = true;
            return false;
        }
        // Transferred now (postMessage returned): no longer the page's.
        handingOver();
        const r = await done;
        if (!r.ok) {
            // No sync access handles here, as it turns out: the page writes
            // from now on (this copy is gone with the worker).
            writersBroken = true;
            throw new Error(r.error || 'could not write the cached attachment');
        }
        return true;
    } finally {
        worker.terminate();
    }
}

/** The page's own write (no writer worker): copies the bytes once more. */
async function writeInPage(fh: FileSystemFileHandle, data: Uint8Array): Promise<void> {
    const w = await fh.createWritable();
    await w.write(data as BufferSource);
    await w.close();
}

/**
 * Keep `sealed` (nonce || ciphertext). Returns at once: the bytes stay in
 * memory until they are written to a file of their own, then only the file
 * is kept. `sealed`'s buffer is the store's from now on (it is freed, or
 * handed to the writer, once written).
 */
export function keepCipher(sealed: Uint8Array): CipherCopy {
    let mem: Uint8Array | null = sealed;
    let file: File | null = null;
    let dropped = false;
    let remove: (() => void) | null = null;
    /** While the bytes are with the writer (not in `mem`, not yet a file). */
    let handedOver: Promise<void> | null = null;
    const name = `c${++seq}`;
    const write = async () => {
        // Only this task holds the bytes while they are written: the closures
        // returned below reach them through `mem`, which lets go once the
        // file is there. (Naming `sealed` in here would keep them alive in
        // the closures' shared scope for as long as the copy is cached.)
        const data = mem;
        const s = await sessionDir();
        if (!s || dropped || !data) return;
        const gone = () => { void s.dir.removeEntry(name).catch(() => { /* already gone */ }); };
        remove = gone;
        let written = () => { /* nothing handed over */ };
        try {
            const fh = await s.dir.getFileHandle(name, { create: true });
            let inWorker: boolean;
            try {
                inWorker = await writeInWorker(fh, data, () => {
                    mem = null;
                    handedOver = new Promise<void>((r) => { written = r; });
                });
            } catch {
                // The worker had the bytes and failed with them: this copy is
                // gone (read() says so, and the cache downloads it again).
                gone();
                return;
            }
            if (!inWorker) await writeInPage(fh, data);
            const f = await fh.getFile();
            if (dropped) { gone(); return; }
            file = f;
            mem = null;
            // The file has it: the page's copy goes now, not at the next
            // garbage collection (read() never handed this buffer out).
            if (!inWorker) freeNow(data.buffer as ArrayBuffer);
        } catch {
            // No room, or no OPFS after all: it stays in memory (unless the
            // writer took it, above).
            gone();
            remove = null;
        } finally {
            written();
        }
    };
    // One write at a time: each has its own copy on the way to the disk.
    writes = writes.then(write, write);
    return {
        read: async () => {
            // With the writer right now: wait for its file.
            if (handedOver) await handedOver;
            if (mem) return mem.slice();
            if (!file) throw new Error('cached attachment is gone');
            return new Uint8Array(await file.arrayBuffer());
        },
        drop: () => {
            if (dropped) return;
            dropped = true;
            mem = null;
            file = null;
            remove?.();
        },
    };
}

/** Sign-out: this page's directory and every file in it go; the next copy
 *  starts a new one. */
export function dropAllCiphertext(): void {
    const p = dirP;
    dirP = null;
    void p?.then((s) => {
        if (!s) return;
        void s.base.removeEntry(s.name, { recursive: true }).catch(() => { /* gone */ }).finally(() => s.unlock());
    });
}
