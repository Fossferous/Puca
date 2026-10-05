/**
 * Decrypted attachments as blob: URLs that can be taken back AT ONCE.
 *
 * Chromium keeps a page's blobs in memory only up to a limit and writes the
 * rest to disk as they are, in `<profile>/Default/blob_storage` — plaintext,
 * since a blob is just bytes to it. Measured 2026-10-05:
 *  - Android WebView: the limit is 1% of the phone's RAM (`max_blob_in_memory_space
 *    = memory / 100`), about 15 MB usable on a 2 GB emulator, so every
 *    decrypted video and nearly every picture a channel shows is written to
 *    `app_webview/Default/blob_storage` (79 of 85 MB in a channel of three
 *    videos, three pictures and a song; each file held the original bytes).
 *  - Desktop (Edge, WebView2): 2 GB in memory, nothing on disk — until the
 *    system reports memory pressure, when EVERY blob is written out (300 MB in
 *    under 3 s, simulated moderate pressure).
 *  - The files go when the blob is released: on a normal close of the app,
 *    and at the next start after a crash or a kill (not before). But a blob
 *    the page made is released when the page's garbage collector frees the
 *    Blob, not when its URL is revoked: a revoked 20 MB blob's file was still
 *    there 21 s later in the WebView, gone straight after a forced GC.
 *
 * So the page never keeps these blobs. It makes each Blob and hands it at
 * once to a small worker (api/plaintextHost.worker.ts), which makes the
 * blob: URL the page then uses like any other; the page keeps no reference
 * of its own. Taking one back (`release`) terminates the worker once nothing
 * else lives in it, which lets go of every blob it registered. One more
 * thing still holds the bytes then: the Blob object the page made, garbage
 * since it was handed over but alive until the page collects garbage, which
 * an idle page (or one in the background) does not do for minutes. So a
 * moment after the last worker of a batch goes, the page is made to collect
 * (nudgeCollection): files gone within 2 s, measured in headless Edge and in
 * the Android WebView; without it, still there.
 *
 * A file of BIG_LEASE_BYTES or more gets a worker of its own; smaller ones
 * share one, a few at a time, so a channel of pictures does not start a
 * worker per picture (an idle worker is about 0.75 MB in the WebView;
 * started in parallel, 20 took 171 ms on the emulator). A small one taken
 * back while others in its worker are still shown lives until they go too.
 *
 * The page makes the Blob, not the worker, for memory: bytes that ever pass
 * through a worker stay resident in it until it is terminated (measured in
 * the WebView, 3 x 22 MB: +66 MB of renderer memory however the worker
 * built or dropped them, even with no Blob at all; with the page building
 * the Blob and the worker only registering it, nothing extra).
 *
 * Where there is no Worker (tests under jsdom, a very old engine) or the
 * worker cannot start, the page makes the blob itself, as before.
 */

export interface PlainLease {
    readonly url: string;
    /** Take the URL back. Call only once nothing on the page uses it. Twice
     *  does nothing. */
    release(): void;
}

/**
 * Give an ArrayBuffer's memory back NOW: detach it (the ES2024
 * `transfer(0)`), which the engine frees at once, rather than whenever the
 * page next collects garbage (measured in the Android WebView: four 22 MB
 * buffers detached this way, -88 MB of renderer memory with no GC; merely
 * dropped, -10 MB). Only for a buffer nothing else will read. A no-op where
 * the engine has no `transfer`, or on a buffer already detached.
 */
export function freeNow(buf: ArrayBuffer | null | undefined): void {
    try {
        (buf as (ArrayBuffer & { transfer?: (n: number) => ArrayBuffer }) | null | undefined)?.transfer?.(0);
    } catch { /* already detached */ }
}

/**
 * Make the page collect garbage soon. There is no API for it; what V8 does
 * is start a full collection when the memory held outside its heap grows by
 * more than its soft limit (64 MB) since the last one, so this asks for
 * 6 x 16 MB of buffers, touching one byte each, and frees them at once
 * (freeNow). Measured: 80 MB this way, every page-made Blob garbage-
 * collected within 2 s in headless Edge and in the Android WebView; 48 MB,
 * none; 9-13 ms of the main thread on the emulator, a few pages of memory.
 */
function defaultNudge(): void {
    const held: ArrayBuffer[] = [];
    try {
        for (let i = 0; i < 6; i++) {
            const a = new ArrayBuffer(16 * 1024 * 1024);
            new Uint8Array(a)[0] = 1;
            held.push(a);
        }
    } catch { /* address space is short (a 32-bit phone): what we got */ }
    for (const a of held) freeNow(a);
}

/** After the last release in a burst... */
const NUDGE_AFTER_MS = 1000;
/** ...and not more often than this while the app is on screen. */
const NUDGE_EVERY_MS = 5000;

let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
let lastNudge = -Infinity;
let nudge: () => void = defaultNudge;
/** Tests only: what a nudge does (null: the real one), from a clean slate. */
export function __setCollectionNudge(f: (() => void) | null): void {
    nudge = f ?? defaultNudge;
    if (nudgeTimer !== null) clearTimeout(nudgeTimer);
    nudgeTimer = null;
    lastNudge = -Infinity;
}

/** Plaintext was let go: nudge the collector once things settle. */
function scheduleCollection(): void {
    if (nudgeTimer !== null) clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(function run() {
        nudgeTimer = null;
        const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const wait = lastNudge + NUDGE_EVERY_MS - Date.now();
        if (!hidden && wait > 0) { nudgeTimer = setTimeout(run, wait); return; }
        lastNudge = Date.now();
        try { nudge(); } catch { /* best effort */ }
    }, NUDGE_AFTER_MS);
}

/** A file this large or larger gets a worker of its own. */
export const BIG_LEASE_BYTES = 4 * 1024 * 1024;
/** Smaller files share a worker, up to this many... */
export const SHARED_LEASES_PER_WORKER = 16;
/** ...or this many bytes, whichever comes first. */
export const SHARED_BYTES_PER_WORKER = 16 * 1024 * 1024;

type WorkerLike = Pick<Worker, 'postMessage' | 'terminate' | 'addEventListener'>;

interface Host {
    worker: WorkerLike;
    ready: Promise<void>;
    /** Leases handed out and not yet taken back. */
    live: number;
    /** Leases ever accepted (a shared worker stops taking new ones). */
    accepted: number;
    acceptedBytes: number;
    shared: boolean;
    pending: Map<number, { resolve: (url: string) => void; reject: (e: Error) => void }>;
    dead: boolean;
}

const defaultFactory = (): WorkerLike | null =>
    typeof Worker === 'undefined' ? null : new Worker(new URL('./plaintextHost.worker.ts', import.meta.url), { type: 'module' });
let factory: () => WorkerLike | null = defaultFactory;
/** A worker failed to start: every later file is made on the page. */
let workersBroken = false;
const hosts = new Set<Host>();
let sharedHost: Host | null = null;
let nextId = 0;
/** Leases made on the page (no worker), for stats and dropAllPlaintext. */
const pageLeases = new Map<string, number>();
let liveBytes = 0;
/** Bumped by dropAllPlaintext: a host that answers after it is ignored. */
let epoch = 0;

/** Tests only: how workers are made (null: the real one). */
export function __setPlaintextWorkerFactory(f: (() => WorkerLike | null) | null): void {
    factory = f ?? defaultFactory;
    workersBroken = false;
}

function retire(h: Host): void {
    if (h.dead) return;
    h.dead = true;
    hosts.delete(h);
    if (sharedHost === h) sharedHost = null;
    try { h.worker.terminate(); } catch { /* already gone */ }
    scheduleCollection();
    for (const p of h.pending.values()) p.reject(new Error('plaintext host stopped'));
    h.pending.clear();
}

function startHost(shared: boolean): Host | null {
    if (workersBroken) return null;
    let worker: WorkerLike | null = null;
    try { worker = factory(); } catch { worker = null; }
    if (!worker) { workersBroken = true; return null; }
    const w = worker;
    let ready!: () => void;
    let failed!: (e: Error) => void;
    const h: Host = {
        worker: w, live: 0, accepted: 0, acceptedBytes: 0, shared, pending: new Map(), dead: false,
        ready: new Promise<void>((res, rej) => { ready = res; failed = rej; }),
    };
    h.ready.catch(() => { /* handled by whoever awaits it */ });
    let started = false;
    w.addEventListener('message', (ev: Event) => {
        const d = (ev as MessageEvent).data as { ready?: true; id?: number; url?: string; error?: string };
        if (d.ready) { started = true; ready(); return; }
        if (typeof d.id !== 'number') return;
        const p = h.pending.get(d.id);
        if (!p) return;
        h.pending.delete(d.id);
        if (typeof d.url === 'string') p.resolve(d.url);
        else p.reject(new Error(d.error || 'plaintext host failed'));
    });
    w.addEventListener('error', () => {
        // Never started (the script could not load): the page makes this
        // and every later URL itself.
        if (!started) { workersBroken = true; failed(new Error('plaintext host did not start')); }
        retire(h);
    });
    hosts.add(h);
    return h;
}

function hostFor(bytes: number): Host | null {
    if (bytes >= BIG_LEASE_BYTES) return startHost(false);
    const s = sharedHost;
    if (s && !s.dead && s.accepted < SHARED_LEASES_PER_WORKER && s.acceptedBytes + bytes <= SHARED_BYTES_PER_WORKER) return s;
    sharedHost = startHost(true);
    return sharedHost;
}

function pageLease(blob: Blob): PlainLease {
    const url = URL.createObjectURL(blob);
    const bytes = blob.size;
    pageLeases.set(url, bytes);
    liveBytes += bytes;
    let held = true;
    return {
        url,
        release: () => {
            if (!held) return;
            held = false;
            if (pageLeases.delete(url)) liveBytes -= bytes;
            URL.revokeObjectURL(url);
            scheduleCollection();
        },
    };
}

/**
 * A blob: URL for `buf` (typed `type`), registered by a plaintext host
 * worker. `buf` is copied into the Blob and then EMPTIED (freeNow): a
 * second plaintext copy is not left for the garbage collector.
 */
export async function hostPlaintext(buf: ArrayBuffer, type: string): Promise<PlainLease> {
    const blob = new Blob([buf], { type });
    freeNow(buf);
    return hostBlob(blob);
}

async function hostBlob(blob: Blob): Promise<PlainLease> {
    const bytes = blob.size;
    const myEpoch = epoch;
    const h = hostFor(bytes);
    if (!h) return pageLease(blob);
    // Counted now, so a shared worker is not retired (live 0) or given more
    // than its share while this one is on its way in.
    h.live++;
    h.accepted++;
    h.acceptedBytes += bytes;
    const id = ++nextId;
    let url: string;
    try {
        await h.ready;
    } catch {
        // It never started: the URL is made on the page.
        return pageLease(blob);
    }
    try {
        if (h.dead || myEpoch !== epoch) throw new Error('plaintext host stopped');
        // No closure here names `blob`: one that did would keep the page's
        // Blob (and its bytes on disk) alive in the scope it shares with the
        // lease, for as long as anything holds the lease (workerLease).
        const answered = new Promise<string>((resolve, reject) => { h.pending.set(id, { resolve, reject }); });
        h.worker.postMessage({ op: 'host', id, blob });
        url = await answered;
    } catch (e) {
        h.live = Math.max(0, h.live - 1);
        if (h.live === 0) retire(h);
        throw e;
    }
    if (myEpoch !== epoch || h.dead) throw new Error('plaintext host stopped');
    return workerLease(h, id, url, bytes);
}

function workerLease(h: Host, id: number, url: string, bytes: number): PlainLease {
    liveBytes += bytes;
    let held = true;
    return {
        url,
        release: () => {
            if (!held) return;
            held = false;
            liveBytes -= bytes;
            h.live = Math.max(0, h.live - 1);
            if (h.dead) return;
            // Its URL stops resolving now; its bytes go when the worker does.
            try { h.worker.postMessage({ op: 'drop', id }); } catch { /* gone */ }
            if (h.live === 0) retire(h);
        },
    };
}

/** Sign-out: every plaintext URL handed out stops working, and every host
 *  worker (with every blob in it) is gone. */
export function dropAllPlaintext(): void {
    epoch++;
    for (const h of [...hosts]) retire(h);
    sharedHost = null;
    for (const url of pageLeases.keys()) URL.revokeObjectURL(url);
    pageLeases.clear();
    liveBytes = 0;
    scheduleCollection();
}

/** What is hosted now (tests, diagnostics). */
export function plaintextHostStats(): { workers: number; pageLeases: number; liveBytes: number } {
    return { workers: hosts.size, pageLeases: pageLeases.size, liveBytes };
}
