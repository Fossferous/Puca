/**
 * Message attachments still load by themselves, but not all at once
 * (components/attachmentZone.ts, api/attachments.ts acquireAttachmentUrl).
 *
 * The owner, 2026-10-04: "big video attachments should still load
 * automatically if theres no downside". Measured 2026-10-05 with a channel of
 * 12 x 22.5 MB videos, loading every one the moment the channel rendered:
 * the videos on screen finished LAST (24 s in Edge at 100 Mbit; 53-95 s on
 * the Android emulator), the renderer grew by up to 770 MB, and nothing was
 * ever given back before sign-out (+257 MB per such channel). So, still with
 * no click: the ones that stay on screen first, then the closest, two big
 * files at a time; the far ones after that, one at a time and only into
 * their own budget (shown once they come near); and a decrypted copy given
 * back when it scrolls far off or its channel is left (kept within a budget,
 * the newest of each channel first, so coming back is instant); and at most
 * four live players, the closest (a player for every video near the screen
 * left the browser 0.4-0.6 GB heavier after a reader scrolled through them).
 *
 * Everything below runs through the REAL attachments module (fetch, AES-GCM,
 * the cache); only the network, the layout (each message has a fake y) and
 * IntersectionObserver are stood in. Nothing ever plays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => 'tok' }));

import { MessageContent } from '../components/MessageContent';
import { clearBlobCache, decryptToBlobUrl, acquireAttachmentUrl, attachmentCacheStats, __setRetainedAttachmentBudget, __setAheadAttachmentBudget } from '../api/attachments';
import { isAbortError } from '../api/priorityLimiter';
import { MAX_UPLOAD_BYTES } from '../api/uploads';
import { MAX_LIVE_PLAYERS, __attachmentZoneWatchCount } from '../components/attachmentZone';

const VH = 900; // the message list's visible height
const VIDEO_H = 320; // a loaded video's card (player + download chip)

// ---- layout: every element sits at its message's data-y ------------------
function rectOf(el: Element): DOMRect {
    const mk = (top: number, h: number, w = 400) => ({ top, bottom: top + h, height: h, width: w, left: 0, right: w, x: 0, y: top, toJSON() { return this; } }) as DOMRect;
    if ((el as HTMLElement).dataset?.scroller !== undefined) return mk(0, VH);
    const msg = el.closest<HTMLElement>('[data-y]');
    if (!msg) return mk(0, 0, 0);
    const y = Number(msg.dataset.y);
    const styled = (el as HTMLElement).style?.height;
    if (styled) return mk(y, parseFloat(styled));
    if (el.matches('.message-video')) return mk(y, VIDEO_H);
    if (el.matches('.message-image img')) return mk(y, 200, 300);
    return mk(y, 30);
}
const near = (el: Element) => { const r = rectOf(el); return r.bottom > -2 * VH && r.top < VH + 2 * VH; };

// ---- IntersectionObserver, driven by the fake layout ------------------------
class FakeIO {
    static all = new Set<FakeIO>();
    observed = new Set<Element>();
    private cb: IntersectionObserverCallback;
    opts?: IntersectionObserverInit;
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) { this.cb = cb; this.opts = opts; FakeIO.all.add(this); }
    observe(el: Element) {
        this.observed.add(el);
        // A real observer reports every new target once, soon after observe().
        setTimeout(() => { if (this.observed.has(el)) this.report([el]); }, 0);
    }
    unobserve(el: Element) { this.observed.delete(el); }
    disconnect() { this.observed.clear(); FakeIO.all.delete(this); }
    takeRecords() { return []; }
    report(els: Element[]) {
        this.cb(els.map((target) => ({ target, isIntersecting: near(target), boundingClientRect: rectOf(target) }) as unknown as IntersectionObserverEntry), this as unknown as IntersectionObserver);
    }
}
/** The reader scrolled: every observer reports every target again. */
function reportAll() { for (const io of FakeIO.all) io.report([...io.observed]); }

// ---- the network: each /files/<id> answers when the test says ---------------
let served: Map<string, Uint8Array>;
let keys: Map<string, string>;
let gates: Map<string, () => void>;
let requested: string[];
let inFlight = 0, mostInFlight = 0;
let created: string[];
let revoked: string[];
let seq = 0;
const origCreate = URL.createObjectURL;
const origRevoke = URL.revokeObjectURL;

const cat = (a: Uint8Array, b: Uint8Array) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
async function seal(id: string, size = 1000): Promise<string> {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const k = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, new Uint8Array(size).fill(7)));
    served.set(id, cat(nonce, ct));
    return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const videoRef = (id: string, key: string) => `[${id}.mp4](sovereign-enc:${id}?k=${key}&m=video%2Fmp4)`;

let container: HTMLDivElement;
let root: Root;
let play: ReturnType<typeof vi.spyOn>;

const settle = async () => {
    await act(async () => { for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0)); });
};
/** Let `id`'s download finish. */
async function deliver(id: string) {
    const g = gates.get(id);
    expect(g, `${id} was never requested`).toBeTruthy();
    g!();
    await settle();
}

type Msg = { id: string; y: number; content: string };
/** The list scrolled back up, away from its newest message (jsdom has no
 *  scrolling: every scroller otherwise reads as sitting at its end). */
const scrolledUp = (el: HTMLDivElement | null) => {
    if (!el) return;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 6000 });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VH });
    Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => 2000, set: () => {} });
};
/** A channel: one message per [id, y], in a scrolling list. */
function Channel({ msgs, up = false }: { msgs: Msg[]; up?: boolean }) {
    return (
        <div data-scroller="" style={{ overflowY: 'auto' }} ref={up ? scrolledUp : undefined}>
            {msgs.map((m) => (
                <div key={m.id} data-y={m.y}>
                    <MessageContent content={m.content} members={[]} />
                </div>
            ))}
        </div>
    );
}
async function renderChannel(spec: Array<[string, number]>, opts: { up?: boolean } = {}) {
    const msgs: Msg[] = [];
    // The same file keeps its key (and so its cache entry) if it is rendered again.
    for (const [id, y] of spec) {
        if (!keys.has(id)) keys.set(id, await seal(id));
        msgs.push({ id, y, content: videoRef(id, keys.get(id)!) });
    }
    await act(async () => { root.render(<Channel msgs={msgs} up={opts.up} />); });
    await settle();
    return async (moved: Array<[string, number]>, gone: string[] = []) => {
        // Scroll: the same messages at new positions (less any `gone`).
        const next = msgs.filter((m) => !gone.includes(m.id)).map((m) => ({ ...m, y: moved.find(([id]) => id === m.id)?.[1] ?? m.y }));
        await act(async () => { root.render(<Channel msgs={next} up={opts.up} />); });
        reportAll();
        container.querySelector('[data-scroller]')!.dispatchEvent(new Event('scroll'));
        await settle();
    };
}
const videoSrcs = () => [...container.querySelectorAll('video')].map((v) => v.getAttribute('src'));
const videoOf = (id: string) => container.querySelector<HTMLElement>(`[data-y] video[title="${id}.mp4"]`);

beforeEach(() => {
    served = new Map(); keys = new Map(); gates = new Map(); requested = []; created = []; revoked = [];
    inFlight = 0; mostInFlight = 0;
    FakeIO.all.clear();
    vi.stubGlobal('IntersectionObserver', FakeIO);
    // The players are re-ranked on the next frame after a scroll.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number);
    vi.stubGlobal('cancelAnimationFrame', (h: number) => clearTimeout(h));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rectOf(this); });
    play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const id = String(input).split('/files/')[1];
        requested.push(id);
        inFlight++; mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise<void>((r) => gates.set(id, r));
        inFlight--;
        const body = served.get(id);
        return body ? new Response(body.slice()) : new Response('', { status: 404 });
    });
    URL.createObjectURL = (() => { const u = `blob:test-${++seq}`; created.push(u); return u; }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = ((u: string) => {
        // Never while anything on the page still uses it.
        expect(container.querySelector(`[src="${u}"]`), `${u} was revoked while still in the DOM`).toBeNull();
        revoked.push(u);
    }) as typeof URL.revokeObjectURL;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    expect(play).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
    container.remove();
    for (const g of gates.values()) g();
    clearBlobCache();
    __setRetainedAttachmentBudget(null);
    __setAheadAttachmentBudget(null);
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// Real AES-GCM and React under jsdom: a few hundred ms per delivered file.
describe('a channel full of big videos', { timeout: 30000 }, () => {
    it('loads the ones on screen first, two at a time, then the nearest, then the far ones one at a time, kept but not shown', async () => {
        await renderChannel([['far1', -6000], ['far2', -3000], ['up2', -1500], ['up1', -600], ['shown1', 100], ['shown2', 500]]);
        // Nothing is clicked: the two on screen have started by themselves
        // (the newer, lower one first: see the next test).
        expect(requested).toEqual(['shown2', 'shown1']);
        await deliver('shown1');
        expect(videoOf('shown1')?.getAttribute('src')).toMatch(/^blob:test-/);
        expect(requested).toEqual(['shown2', 'shown1', 'up1']);
        await deliver('shown2');
        await deliver('up1');
        // Everything near is here or on its way: the nearer far one starts...
        expect(requested).toEqual(['shown2', 'shown1', 'up1', 'up2', 'far2']);
        await deliver('up2');
        // ...and only one far one at a time: a slot stays free for whatever
        // the reader scrolls to.
        expect(requested).toEqual(['shown2', 'shown1', 'up1', 'up2', 'far2']);
        await deliver('far2');
        expect(requested).toEqual(['shown2', 'shown1', 'up1', 'up2', 'far2', 'far1']);
        await deliver('far1');
        expect(mostInFlight).toBe(2);
        // The far ones are here but not shown, and not held: they wait in the
        // cache's budget for the reader to come to them.
        expect(videoSrcs().filter(Boolean)).toHaveLength(4);
        expect(container.querySelectorAll('.message-attachment.loading')).toHaveLength(2);
        expect(attachmentCacheStats()).toMatchObject({ heldBytes: 4000, aheadBytes: 2000, retainedBytes: 0 });
    });

    it('at the newest message with every chip on screen, the newest load first: they are the ones left in view', async () => {
        // A channel opening: nothing has loaded, so every attachment is a
        // small chip and all of them fit on screen at once. Each file that
        // arrives grows its row and, the list being pinned to its end, pushes
        // the rows above it up and out; the newest stay.
        await renderChannel([['m1', 100], ['m2', 200], ['m3', 300], ['m4', 400], ['m5', 500], ['m6', 600]]);
        expect(requested).toEqual(['m6', 'm5']);
        await deliver('m6');
        expect(requested).toEqual(['m6', 'm5', 'm4']);
        for (const id of ['m5', 'm4']) await deliver(id);
        expect(requested).toEqual(['m6', 'm5', 'm4', 'm3', 'm2']);
    });

    it('scrolled back up, the highest on screen loads first: the browser holds that part still', async () => {
        await renderChannel([['m1', 100], ['m2', 200], ['m3', 300], ['m4', 400]], { up: true });
        expect(requested).toEqual(['m1', 'm2']);
        await deliver('m1');
        expect(requested).toEqual(['m1', 'm2', 'm3']);
    });

    it('a far one that was loaded ahead is shown the moment the reader scrolls to it, with no second fetch', async () => {
        const scroll = await renderChannel([['old', -4000], ['new', 100]]);
        await deliver('new');
        expect(requested).toEqual(['new', 'old']);
        await deliver('old');
        expect(videoOf('old')).toBeNull();
        await scroll([['old', 200], ['new', 3300]]);
        expect(requested).toEqual(['new', 'old']);
        expect(videoOf('old')?.getAttribute('src')).toMatch(/^blob:test-/);
    });

    it('one still waiting for its turn when it scrolls far away is still loaded ahead, later', async () => {
        // Measured in Edge: when the rows above grew as their videos arrived,
        // a row waiting for a slot was pushed out of range; its wait was
        // dropped and the load ahead that replaced it rode on that dying wait
        // and gave up with it, so two of twelve videos never loaded.
        const scroll = await renderChannel([['x', -1000], ['a', 100], ['b', 500]]);
        expect(requested).toEqual(['b', 'a']);
        await scroll([['x', -5000], ['a', 100], ['b', 500]]);
        await deliver('a');
        expect(requested).toEqual(['b', 'a', 'x']);
        await deliver('x');
        await deliver('b');
        expect(attachmentCacheStats()).toMatchObject({ heldBytes: 2000, aheadBytes: 1000 });
    });

    it("the same file near and far: the near one does not wait on the far one's load ahead when that finds no room", async () => {
        __setAheadAttachmentBudget(0);
        const key = await seal('dup');
        // The same file posted twice: once far up, once on screen.
        const msgs: Msg[] = [
            { id: 'far', y: -5000, content: videoRef('dup', key) },
            { id: 'near', y: 100, content: videoRef('dup', key) },
        ];
        await act(async () => { root.render(<Channel msgs={msgs} />); });
        await settle();
        // Fetched now, for the one on screen, not after a retry 2 s later.
        expect(requested).toEqual(['dup']);
        await deliver('dup');
        expect(container.querySelectorAll('video[src^="blob:"]')).toHaveLength(1);
    });

    it("loads ahead only while the budget has room for the page's own copies, and never pushes one out", async () => {
        // Room for two more files loaded ahead, beyond one largest file.
        __setAheadAttachmentBudget(MAX_UPLOAD_BYTES + 1500);
        await renderChannel([['f3', -9000], ['f2', -7000], ['f1', -5000], ['new', 100]]);
        await deliver('new');
        await deliver('f1');
        await deliver('f2');
        await settle();
        // f3's turn came with no room left: skipped, not fetched.
        expect(requested).toEqual(['new', 'f1', 'f2']);
        expect(revoked).toEqual([]);
        expect(attachmentCacheStats()).toMatchObject({ heldBytes: 1000, aheadBytes: 2000 });
    });

    it('a copy the reader has seen is never pushed out to load ahead', async () => {
        // Room for one copy seen, and for two loaded ahead.
        __setRetainedAttachmentBudget(1000);
        __setAheadAttachmentBudget(MAX_UPLOAD_BYTES + 1500);
        await renderChannel([['seen', 100]]);
        await deliver('seen');
        const seenUrl = videoOf('seen')!.getAttribute('src');
        // Another channel: its far ones are loaded ahead, filling their budget.
        await act(async () => { root.render(<div />); });
        await settle();
        await renderChannel([['f2', -7000], ['f1', -5000], ['new', 100]]);
        await deliver('new');
        await deliver('f1');
        await deliver('f2');
        expect(attachmentCacheStats()).toMatchObject({ aheadBytes: 2000, retainedBytes: 1000 });
        // The copy seen in the first channel is still there for coming back.
        expect(revoked).not.toContain(seenUrl);
    });

    it('with no room to load ahead, a far one loads as the reader scrolls toward it, with no click', async () => {
        __setAheadAttachmentBudget(0);
        const scroll = await renderChannel([['old', -4000], ['new', 100]]);
        await deliver('new');
        expect(requested).toEqual(['new']);
        await scroll([['old', -1200], ['new', 3000]]);
        expect(requested).toEqual(['new', 'old']);
        await deliver('old');
        expect(videoOf('old')?.getAttribute('src')).toMatch(/^blob:test-/);
    });

    it('one that scrolls far away gives its copy back only after its player left the page, and keeps its space', async () => {
        __setRetainedAttachmentBudget(0); // so the release is seen as a revoke
        const scroll = await renderChannel([['v', 100]]);
        await deliver('v');
        const url = videoOf('v')!.getAttribute('src')!;
        await scroll([['v', -5000]]);
        expect(videoOf('v')).toBeNull();
        // revokeObjectURL itself asserts the URL had left the DOM first.
        expect(revoked).toEqual([url]);
        const reserve = container.querySelector<HTMLElement>('.message-video.attachment-reserve');
        expect(reserve?.style.height).toBe(`${VIDEO_H}px`);
        // Back on screen: fetched again, and until it arrives the placeholder
        // still holds the player's space (no jump while it downloads), with
        // the download's progress in it.
        await scroll([['v', 200]]);
        expect(requested).toEqual(['v', 'v']);
        const back = container.querySelector<HTMLElement>('.message-video.attachment-reserve');
        expect(back?.style.height).toBe(`${VIDEO_H}px`);
        expect(back?.querySelector('.message-attachment.loading')).not.toBeNull();
        await deliver('v');
        expect(videoOf('v')?.getAttribute('src')).toMatch(/^blob:test-/);
    });

    it('within the budget, coming back costs nothing: no second fetch', async () => {
        const scroll = await renderChannel([['v', 100]]);
        await deliver('v');
        const url = videoOf('v')!.getAttribute('src');
        await scroll([['v', -5000]]);
        expect(videoOf('v')).toBeNull();
        expect(revoked).toEqual([]);
        expect(attachmentCacheStats().retainedBytes).toBe(1000);
        await scroll([['v', 200]]);
        expect(requested).toEqual(['v']);
        expect(videoOf('v')?.getAttribute('src')).toBe(url);
    });

    it('a video that is playing keeps its player and its copy, however far it scrolls', async () => {
        __setRetainedAttachmentBudget(0);
        const scroll = await renderChannel([['v', 100]]);
        await deliver('v');
        await act(async () => { videoOf('v')!.dispatchEvent(new Event('play')); });
        await scroll([['v', -5000]]);
        expect(videoOf('v')).not.toBeNull();
        expect(revoked).toEqual([]);
        // Paused out there: now it goes.
        await act(async () => { videoOf('v')!.dispatchEvent(new Event('pause')); });
        await settle();
        expect(videoOf('v')).toBeNull();
        expect(revoked).toHaveLength(1);
    });

    it(`mounts at most ${MAX_LIVE_PLAYERS} players, the closest to the screen, and every one on screen`, async () => {
        const spec: Array<[string, number]> = [['a', -1700], ['b', -1300], ['c', -900], ['d', -500], ['e', 100], ['f', 500]];
        const scroll = await renderChannel(spec);
        for (const id of ['e', 'f', 'd', 'c', 'b', 'a']) await deliver(id);
        const live = () => ['a', 'b', 'c', 'd', 'e', 'f'].filter((id) => videoOf(id));
        expect(live()).toEqual(['c', 'd', 'e', 'f']);
        // The two without a player show the chip until they are among the closest.
        expect(container.querySelectorAll('.message-attachment.loading')).toHaveLength(2);
        // Scrolled up: a and b come on screen, e and f go furthest away and
        // keep their space.
        await scroll([['a', 100], ['b', 500], ['c', 900], ['d', 1300], ['e', 1900], ['f', 2300]]);
        expect(live()).toEqual(['a', 'b', 'c', 'd']);
        expect([...container.querySelectorAll<HTMLElement>('.message-video.attachment-reserve')].map((r) => r.style.height)).toEqual([`${VIDEO_H}px`, `${VIDEO_H}px`]);
        // Nothing was fetched twice for it.
        expect(requested.filter((id) => id === 'e')).toHaveLength(1);
    });

    it('a playing video keeps its player with four others closer to the screen', async () => {
        const ids = ['p', 'b', 'c', 'd', 'e'];
        const scroll = await renderChannel(ids.map((id, i) => [id, 100 + i * 150] as [string, number]));
        for (const id of [...ids].reverse()) await deliver(id);
        await act(async () => { videoOf('p')!.dispatchEvent(new Event('play')); });
        // p scrolls up out of view, still near; the other four are on screen.
        await scroll([['p', -1700], ['b', 100], ['c', 300], ['d', 500], ['e', 700]]);
        expect(ids.filter((id) => videoOf(id))).toEqual(ids);
    });

    it('more on screen than the cap: every one on screen still plays', async () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
        await renderChannel(ids.map((id, i) => [id, i * 140] as [string, number]));
        for (const id of [...ids].reverse()) await deliver(id);
        expect(ids.filter((id) => videoOf(id))).toEqual(ids);
    });

    it('leaving the channel gives every copy back: the newest kept up to the budget (what is on screen on the way back), the rest revoked', async () => {
        await renderChannel([['a', -800], ['b', -400], ['c', 100]]);
        for (const id of ['c', 'b', 'a']) await deliver(id);
        expect(attachmentCacheStats().heldBytes).toBe(3000);
        const oldest = videoOf('a')!.getAttribute('src');
        __setRetainedAttachmentBudget(2000);
        await act(async () => { root.render(<div />); });
        await settle();
        const s = attachmentCacheStats();
        expect(s.heldBytes).toBe(0);
        expect(s.retainedBytes).toBe(2000);
        // All three were given back in the same millisecond; the one revoked
        // is the oldest message's, not whichever the clock happened to pick.
        expect(revoked).toEqual([oldest]);
        expect(__attachmentZoneWatchCount()).toBe(0);
    });

    it('leaving one channel and then another keeps the newest of EACH, not just the last one left', async () => {
        __setRetainedAttachmentBudget(4000); // room for four copies seen
        const ids = (c: string) => [1, 2, 3, 4].map((n) => `${c}${n}`);
        const open = async (c: string) => {
            await renderChannel(ids(c).map((id, i) => [id, -1500 + i * 500] as [string, number]));
            for (const id of [...ids(c)].reverse()) if (!requested.includes(id) || gates.has(id)) await deliver(id);
            return Object.fromEntries(ids(c).map((id) => [id, videoOf(id)!.getAttribute('src')!]));
        };
        const leave = async () => { await act(async () => { root.render(<div />); }); await settle(); };
        const a = await open('a');
        await leave();
        const b = await open('b');
        await leave();
        // Eight copies, room for four: each channel's two oldest messages go.
        expect([...revoked].sort()).toEqual([a.a1, a.a2, b.b1, b.b2].sort());
        // Back to the first: what is on screen there (the newest) is instant.
        await renderChannel([['a3', -500], ['a4', 100]]);
        expect(requested.filter((id) => id.startsWith('a'))).toEqual(['a4', 'a3', 'a2', 'a1']);
        expect(videoOf('a4')?.getAttribute('src')).toBe(a.a4);
    });

    it('a copy nothing on the page shows any more goes before one the reader may scroll back to', async () => {
        // Room for one file given back (and none to load ahead).
        __setRetainedAttachmentBudget(1000);
        const scroll = await renderChannel([['kept', 100], ['gone', 500]]);
        await deliver('gone');
        await deliver('kept');
        const keptUrl = videoOf('kept')!.getAttribute('src');
        const goneUrl = videoOf('gone')!.getAttribute('src');
        // 'kept' scrolls far up: given back, and it fits.
        await scroll([['kept', -5000], ['gone', 500]]);
        expect(revoked).toEqual([]);
        // 'gone' leaves the page (its message went), given back LATER than
        // 'kept'. Room for one: the one nothing on the page shows goes.
        await scroll([['kept', -5000]], ['gone']);
        expect(revoked).toEqual([goneUrl]);
        // The reader scrolls back up to 'kept': there at once, not refetched.
        await scroll([['kept', 200]], ['gone']);
        expect(requested).toEqual(['gone', 'kept']);
        expect(videoOf('kept')?.getAttribute('src')).toBe(keptUrl);
    });

    it("a Task's or a note's copy (decryptToBlobUrl) is never revoked to make room", async () => {
        __setRetainedAttachmentBudget(0);
        const key = await seal('pinned');
        const p = decryptToBlobUrl('pinned', key, 'video/mp4');
        await settle();
        await deliver('pinned');
        const pinnedUrl = await p;
        const scroll = await renderChannel([['v', 100]]);
        await deliver('v');
        await scroll([['v', -5000]]);
        expect(revoked).toHaveLength(1);
        expect(revoked).not.toContain(pinnedUrl);
        expect(attachmentCacheStats().pinnedBytes).toBe(1000);
    });
});

describe('the cache under them', { timeout: 30000 }, () => {
    it("a Task's copy that joined a message attachment's waiting load still arrives when that row scrolls away", async () => {
        const [ka, kb, kx] = [await seal('a'), await seal('b'), await seal('x')];
        // Two big files take both slots; x, a row further off, waits.
        const a = acquireAttachmentUrl('a', ka, 'video/mp4');
        const b = acquireAttachmentUrl('b', kb, 'video/mp4');
        const row = new AbortController();
        const x = acquireAttachmentUrl('x', kx, 'video/mp4', undefined, { signal: row.signal });
        const rowDone = Promise.allSettled([x]);
        await settle();
        expect(requested).toEqual(['a', 'b']);
        // A Task shows the same file (decryptToBlobUrl): it rides on x's wait.
        const task = decryptToBlobUrl('x', kx, 'video/mp4');
        const taskDone = Promise.allSettled([task]);
        await settle();
        // The row scrolls away while x still waits: its wait is dropped...
        row.abort();
        const [rowResult] = await rowDone;
        expect(rowResult.status === 'rejected' && isAbortError(rowResult.reason)).toBe(true);
        await settle();
        // ...but the Task still wants the file, and gets it.
        expect(requested).toEqual(['a', 'b', 'x']);
        await deliver('x');
        const [taskResult] = await taskDone;
        expect(taskResult.status).toBe('fulfilled');
        expect(attachmentCacheStats().pinnedBytes).toBe(1000);
        await deliver('a');
        await deliver('b');
        (await a).release();
        (await b).release();
    });

    it('signing out drops what waits, and caches nothing that was still downloading', async () => {
        const [ka, kb, kc] = [await seal('a'), await seal('b'), await seal('c')];
        const all = Promise.allSettled([
            acquireAttachmentUrl('a', ka, 'video/mp4'),
            acquireAttachmentUrl('b', kb, 'video/mp4'),
            acquireAttachmentUrl('c', kc, 'video/mp4'),
        ]);
        await settle();
        expect(requested).toEqual(['a', 'b']);
        clearBlobCache();
        await deliver('a');
        await deliver('b');
        // c, still waiting at sign-out, is never fetched afterwards...
        expect(requested).toEqual(['a', 'b']);
        const results = await all;
        expect(results.every((r) => r.status === 'rejected' && isAbortError(r.reason))).toBe(true);
        // ...and a and b, which landed after it, were never turned into URLs.
        expect(created).toEqual([]);
        expect(attachmentCacheStats().entries).toBe(0);
    });
});
