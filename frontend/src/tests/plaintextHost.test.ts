/**
 * api/plaintextHost.ts: a decrypted attachment's blob lives in a worker, and
 * taking it back terminates that worker as soon as nothing else lives in it,
 * which frees the blob — and any plaintext file Chromium paged it to — at
 * once. A blob the page keeps itself waits for the page's garbage
 * collector, revoked or not (measured in the Android WebView 2026-10-05: a
 * revoked 20 MB blob's file was on disk 21 s later; registered by a worker
 * that was then terminated, gone within 1 s). The real worker in a real
 * browser: e2e/plaintext-disk-real-browser.mjs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    hostPlaintext, dropAllPlaintext, plaintextHostStats, __setPlaintextWorkerFactory, __setCollectionNudge,
    BIG_LEASE_BYTES, SHARED_LEASES_PER_WORKER, SHARED_BYTES_PER_WORKER,
} from '../api/plaintextHost';

type Listener = (e: Event) => void;
class FakeWorker {
    static all: FakeWorker[] = [];
    static failToStart = false;
    terminated = false;
    hosted = new Map<number, string>();
    dropped: number[] = [];
    transfers: unknown[][] = [];
    private ls: Record<string, Listener[]> = { message: [], error: [] };
    readonly n: number;
    constructor() {
        this.n = FakeWorker.all.push(this);
        const fail = FakeWorker.failToStart;
        setTimeout(() => {
            if (this.terminated) return;
            if (fail) this.emit('error', new Event('error'));
            else this.reply({ ready: true });
        }, 0);
    }
    addEventListener(type: string, l: Listener) { this.ls[type].push(l); }
    private emit(type: string, e: Event) { for (const l of this.ls[type]) l(e); }
    private reply(data: unknown) { this.emit('message', Object.assign(new Event('message'), { data })); }
    blobs: Blob[] = [];
    postMessage(m: { op: string; id: number; blob?: Blob }, transfer?: unknown[]) {
        if (this.terminated) return;
        this.transfers.push(transfer ?? []);
        if (m.blob) this.blobs.push(m.blob);
        if (m.op === 'host') {
            const url = `blob:w${this.n}-${m.id}`;
            this.hosted.set(m.id, url);
            setTimeout(() => { if (!this.terminated) this.reply({ id: m.id, url }); }, 0);
        } else if (m.op === 'drop') this.dropped.push(m.id);
    }
    terminate() { this.terminated = true; }
}

const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;
let pageMade: string[];
let pageRevoked: string[];

beforeEach(() => {
    FakeWorker.all = [];
    FakeWorker.failToStart = false;
    pageMade = [];
    pageRevoked = [];
    __setPlaintextWorkerFactory(() => new FakeWorker() as unknown as Worker);
    URL.createObjectURL = (() => { const u = `blob:page-${pageMade.length + 1}`; pageMade.push(u); return u; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => { pageRevoked.push(u); }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
    dropAllPlaintext();
    __setPlaintextWorkerFactory(null);
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
});

const bytes = (n: number) => new ArrayBuffer(n);

describe('plaintext hosts', () => {
    it('a big file gets a worker of its own, and taking it back terminates that worker at once', async () => {
        const buf = bytes(BIG_LEASE_BYTES);
        const lease = await hostPlaintext(buf, 'video/mp4');
        expect(FakeWorker.all).toHaveLength(1);
        const w = FakeWorker.all[0];
        expect(lease.url).toBe(`blob:w1-${[...w.hosted.keys()][0]}`);
        // The page made the Blob (typed) and the worker the URL; no bytes
        // passed through the worker, and the page made no URL.
        expect(w.transfers[0]).toEqual([]);
        expect(w.blobs[0].size).toBe(BIG_LEASE_BYTES);
        expect(w.blobs[0].type).toBe('video/mp4');
        expect(pageMade).toEqual([]);
        const other = await hostPlaintext(bytes(BIG_LEASE_BYTES + 1), 'video/mp4');
        expect(FakeWorker.all).toHaveLength(2);
        lease.release();
        expect(w.terminated).toBe(true);
        expect(FakeWorker.all[1].terminated).toBe(false);
        lease.release(); // twice: nothing more
        other.release();
        expect(FakeWorker.all[1].terminated).toBe(true);
        expect(plaintextHostStats()).toEqual({ workers: 0, pageLeases: 0, liveBytes: 0 });
    });

    it('small files share a worker, which goes when the last of them is taken back', async () => {
        const a = await hostPlaintext(bytes(1000), 'image/png');
        const b = await hostPlaintext(bytes(1000), 'image/jpeg');
        expect(FakeWorker.all).toHaveLength(1);
        const w = FakeWorker.all[0];
        a.release();
        // a's URL is dropped in the worker; its bytes go with the worker.
        expect(w.dropped).toHaveLength(1);
        expect(w.terminated).toBe(false);
        b.release();
        expect(w.terminated).toBe(true);
        // The next small file starts a new one.
        const c = await hostPlaintext(bytes(1000), 'image/png');
        expect(FakeWorker.all).toHaveLength(2);
        c.release();
        expect(FakeWorker.all[1].terminated).toBe(true);
    });

    it(`a shared worker takes at most ${SHARED_LEASES_PER_WORKER} files or ${SHARED_BYTES_PER_WORKER / 1048576} MiB`, async () => {
        const leases = [];
        for (let i = 0; i < SHARED_LEASES_PER_WORKER + 1; i++) leases.push(await hostPlaintext(bytes(10), 'image/png'));
        expect(FakeWorker.all).toHaveLength(2);
        const big = BIG_LEASE_BYTES - 1;
        for (let i = 0; i < 5; i++) leases.push(await hostPlaintext(bytes(big), 'image/png'));
        // Three of them fit beside the small one in 16 MiB; the other two start a third.
        expect(FakeWorker.all).toHaveLength(3);
        for (const l of leases) l.release();
        expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    });

    it('a worker that cannot start loses nothing: the page makes the blob itself, and every later one', async () => {
        FakeWorker.failToStart = true;
        const lease = await hostPlaintext(bytes(BIG_LEASE_BYTES), 'video/mp4');
        expect(lease.url).toBe('blob:page-1');
        // Nothing was handed to the worker before it said it had started.
        expect(FakeWorker.all[0].blobs).toEqual([]);
        FakeWorker.failToStart = false;
        const next = await hostPlaintext(bytes(10), 'image/png');
        expect(next.url).toBe('blob:page-2');
        expect(FakeWorker.all).toHaveLength(1);
        lease.release();
        next.release();
        expect(pageRevoked).toEqual(['blob:page-1', 'blob:page-2']);
    });

    it('with no Worker at all (jsdom, an old engine), the page makes it, and revokes it when taken back', async () => {
        __setPlaintextWorkerFactory(() => null);
        const lease = await hostPlaintext(bytes(10), 'image/png');
        expect(lease.url).toBe('blob:page-1');
        expect(plaintextHostStats()).toEqual({ workers: 0, pageLeases: 1, liveBytes: 10 });
        lease.release();
        expect(pageRevoked).toEqual(['blob:page-1']);
        expect(plaintextHostStats().liveBytes).toBe(0);
    });

    it('sign-out terminates every worker and revokes every page blob; a file still on its way is never handed out', async () => {
        const a = await hostPlaintext(bytes(BIG_LEASE_BYTES), 'video/mp4');
        const b = await hostPlaintext(bytes(10), 'image/png');
        const late = hostPlaintext(bytes(10), 'image/png');
        expect(a.url).toMatch(/^blob:w/);
        expect(b.url).toMatch(/^blob:w/);
        dropAllPlaintext();
        expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
        await expect(late).rejects.toThrow();
        expect(plaintextHostStats()).toEqual({ workers: 0, pageLeases: 0, liveBytes: 0 });
        // Taking back what sign-out already took is harmless.
        a.release();
        b.release();
    });
});

describe('making the page let go of what it made', () => {
    // The page makes each Blob before a worker registers it, and that Blob
    // keeps its bytes (and its file) until the page collects garbage, which
    // an idle page does not do for minutes (measured). So once a batch of
    // plaintext has been let go, the page is nudged to collect.
    it('one nudge a second after the last release of a burst, then at most one every 5 s on screen', async () => {
        vi.useFakeTimers();
        try {
            const nudges: number[] = [];
            __setCollectionNudge(() => { nudges.push(Date.now()); });
            __setPlaintextWorkerFactory(() => null);
            const t0 = Date.now();
            const a = await hostPlaintext(bytes(10), 'image/png');
            const b = await hostPlaintext(bytes(10), 'image/png');
            a.release();
            vi.advanceTimersByTime(500);
            b.release();
            vi.advanceTimersByTime(999);
            expect(nudges).toEqual([]);
            vi.advanceTimersByTime(1);
            expect(nudges).toEqual([t0 + 1500]);
            // Another release soon after: waits out the 5 s.
            const c = await hostPlaintext(bytes(10), 'image/png');
            c.release();
            vi.advanceTimersByTime(1000);
            expect(nudges).toHaveLength(1);
            vi.advanceTimersByTime(3999);
            expect(nudges).toHaveLength(1);
            vi.advanceTimersByTime(1);
            expect(nudges).toEqual([t0 + 1500, t0 + 6500]);
        } finally {
            __setCollectionNudge(null);
            vi.useRealTimers();
        }
    });

    it('in the background it does not wait: a phone may kill the app any moment', async () => {
        vi.useFakeTimers();
        const vis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
        try {
            const nudges: number[] = [];
            __setCollectionNudge(() => { nudges.push(Date.now()); });
            __setPlaintextWorkerFactory(() => null);
            (await hostPlaintext(bytes(10), 'image/png')).release();
            vi.advanceTimersByTime(1000);
            expect(nudges).toHaveLength(1);
            Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
            (await hostPlaintext(bytes(10), 'image/png')).release();
            vi.advanceTimersByTime(1000);
            expect(nudges).toHaveLength(2);
        } finally {
            delete (document as { visibilityState?: unknown }).visibilityState;
            if (vis) expect(Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')).toBeTruthy();
            __setCollectionNudge(null);
            vi.useRealTimers();
        }
    });

    it('a terminated worker counts as a release', async () => {
        vi.useFakeTimers();
        try {
            let nudged = 0;
            __setCollectionNudge(() => { nudged++; });
            const p = hostPlaintext(bytes(BIG_LEASE_BYTES), 'video/mp4');
            await vi.advanceTimersByTimeAsync(10);
            const lease = await p;
            lease.release();
            expect(FakeWorker.all[0].terminated).toBe(true);
            await vi.advanceTimersByTimeAsync(6000);
            expect(nudged).toBe(1);
        } finally {
            __setCollectionNudge(null);
            vi.useRealTimers();
        }
    });
});
