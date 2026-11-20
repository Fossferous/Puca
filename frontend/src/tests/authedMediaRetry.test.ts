// @vitest-environment jsdom
/**
 * One failed GET /files/<id> used to be for the whole session (field report
 * 2026-11-19: a member's desktop app drew two people's pictures as initials
 * while the server served them; api/authedMedia.ts's header). These pin the
 * shared job's half, through fetchFileUrl as every caller had it before:
 *   - a transient answer (thrown, 408/425/429/5xx) is tried again, never
 *     sooner than a Retry-After asks, otherwise 2, 4, 8, 16, 30 s, at most six
 *     attempts, and the give-up writes a line with the status and attempts;
 *   - a definite one (401/403/404/410/other 4xx) is ONE request, null;
 *   - concurrent callers during a retry share one request at a time;
 *   - nobody signed in is no request at all, and signing out ends a job;
 *   - at most six requests out at once, the rest in order;
 *   - `online` (and the other chances) cuts our own wait short, never one the
 *     server asked for, and one arriving during an attempt retries its failure
 *     at once.
 * The hook's half (asking again after a give-up, stopping on unmount):
 * authedFileUrlRecovery.test.tsx. A real browser: e2e/avatar-retry-real-browser.mjs.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({ token: 'tok' as string | null }));
vi.mock('../api/auth', async (orig) => ({ ...(await orig<typeof import('../api/auth')>()), getToken: () => h.token }));

import { fetchFileUrl, cachedFileUrl, clearFileCache } from '../api/authedMedia';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
type Script = (n: number, url: string) => Response | Promise<Response> | Error;
/** Every request, with the fake clock's time it was made at. */
let calls: { url: string; at: number; auth: string | null }[] = [];
let script: Script = () => ok();
let fetchSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: MockInstance<typeof console.info>;
let t0 = 0;
/** Each test starts two minutes after the last one ended: the module's line
 *  limit counts per minute, and must not carry from one test into the next. */
let clock = new Date('2026-11-20T12:00:00Z').getTime();

const ok = () => new Response(PNG.slice(), { headers: { 'Content-Type': 'image/png' } });
const status = (code: number, headers: Record<string, string> = {}) => new Response('nope', { status: code, headers });
const now = () => Date.now() - t0;
/** Real macrotask turns (setImmediate is not faked): lets fetch bodies and
 *  the job's promise chain run. */
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const advance = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await settle(); };
const requestsFor = (id: string) => calls.filter((c) => c.url.endsWith(`/files/${id}`));
const diagLines = () => infoSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[media-diag]'));

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(clock);
    t0 = Date.now();
    vi.spyOn(Math, 'random').mockReturnValue(0);   // no jitter: exact schedules
    h.token = 'tok';
    calls = [];
    script = () => ok();
    clearFileCache();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        const auth = new Headers((init as RequestInit | undefined)?.headers).get('authorization');
        calls.push({ url, at: now(), auth });
        const r = script(requestsFor(url.split('/files/')[1]).length, url);
        if (r instanceof Error) throw r;
        return r;
    });
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    clearFileCache();
    clock = Date.now() + 120_000;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('a transient failure is tried again inside the job', () => {
    it('a 503 with Retry-After: 2 and then a 200 resolves the URL, the second request not before 2 s', async () => {
        script = (n) => (n === 1 ? status(503, { 'Retry-After': '2' }) : ok());
        let got: string | null | undefined;
        void fetchFileUrl('av').then((u) => { got = u; });
        await settle();
        expect(requestsFor('av')).toHaveLength(1);
        expect(got, 'still trying, not given up').toBeUndefined();
        await advance(1999);
        expect(requestsFor('av'), 'not sooner than the server asked').toHaveLength(1);
        await advance(1);
        expect(requestsFor('av')).toHaveLength(2);
        expect(requestsFor('av')[1].at).toBe(2000);
        expect(got).toMatch(/^data:image\/png;base64,/);
        expect(cachedFileUrl('av')).toBe(got);
    });

    it('a Retry-After longer than our own backoff is the wait (7 s, not 2)', async () => {
        script = (n) => (n === 1 ? status(429, { 'Retry-After': '7' }) : ok());
        const p = fetchFileUrl('av');
        await advance(6999);
        expect(requestsFor('av')).toHaveLength(1);
        await advance(1);
        expect(requestsFor('av')).toHaveLength(2);
        expect(await p).toMatch(/^data:/);
    });

    it('a Retry-After as an HTTP date is honoured too', async () => {
        const at = new Date(Date.now() + 5000).toUTCString();
        script = (n) => (n === 1 ? status(503, { 'Retry-After': at }) : ok());
        const p = fetchFileUrl('av');
        await advance(4999);
        expect(requestsFor('av')).toHaveLength(1);
        await advance(1);
        expect(requestsFor('av')).toHaveLength(2);
        expect(await p).toMatch(/^data:/);
    });

    it('a bogus Retry-After (an hour) parks nothing: the job gives up rather than wait it out', async () => {
        script = () => status(503, { 'Retry-After': '3600' });
        let got: string | null | undefined;
        void fetchFileUrl('av').then((u) => { got = u; });
        await advance(61_000);
        // Clamped to a minute: one more try at 60 s, and the next wait would pass the job's 90 s.
        expect(requestsFor('av')).toHaveLength(2);
        expect(got).toBeNull();
        await advance(10 * 60_000);
        expect(requestsFor('av')).toHaveLength(2);
    });

    it('with no Retry-After the waits grow (2, 4, 8, 16, 30 s) and it gives up after six attempts, with a line saying so', async () => {
        script = () => status(500);
        let got: string | null | undefined;
        void fetchFileUrl('a1b2c3d4-e5f6-7890-abcd-ef0123456789').then((u) => { got = u; });
        await advance(5 * 60_000);
        expect(requestsFor('a1b2c3d4-e5f6-7890-abcd-ef0123456789').map((c) => c.at)).toEqual([0, 2000, 6000, 14000, 30000, 60000]);
        expect(got).toBeNull();
        await advance(30 * 60_000);
        expect(calls, 'nothing after giving up').toHaveLength(6);
        const lines = diagLines();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('gave up');
        expect(lines[0]).toContain('last=500');
        expect(lines[0]).toContain('attempts=6');
        expect(lines[0]).toContain('file=a1b2c3d4');
        expect(lines[0], 'never the whole id, the URL or the token').not.toMatch(/e5f6|\/files\/|tok|Bearer/);
    });

    it('a fetch that threw (the network) is tried again', async () => {
        script = (n) => (n === 1 ? new TypeError('Failed to fetch') : ok());
        const p = fetchFileUrl('av');
        await advance(2000);
        expect(requestsFor('av')).toHaveLength(2);
        expect(await p).toMatch(/^data:/);
        expect(diagLines().join('\n')).toContain('attempt 2 after network');
    });

    it.each([408, 425, 429, 500, 502, 503, 504, 522])('%i is transient: tried again', async (code) => {
        script = (n) => (n === 1 ? status(code) : ok());
        const p = fetchFileUrl('av');
        await advance(2000);
        expect(requestsFor('av')).toHaveLength(2);
        expect(await p).toMatch(/^data:/);
    });
});

describe('a definite answer is final', () => {
    it.each([401, 403, 404, 410, 400, 422, 501])('%i resolves null with exactly one request', async (code) => {
        script = () => status(code);
        let got: string | null | undefined;
        void fetchFileUrl('gone').then((u) => { got = u; });
        await settle();
        expect(got).toBeNull();
        await advance(10 * 60_000);
        expect(calls).toHaveLength(1);
    });

    it('a refusal writes one line with its status', async () => {
        script = () => status(404);
        await fetchFileUrl('deadbeef-0000');
        expect(diagLines()).toEqual(['[media-diag] picture refused: status=404 attempts=1 file=deadbeef']);
    });

    it('the lines are capped at ten a minute, and the next one says how many were not written', async () => {
        script = () => status(404);
        for (let i = 0; i < 15; i++) await fetchFileUrl(`gone-${i}`);
        expect(diagLines()).toHaveLength(10);
        await advance(60_000);
        await fetchFileUrl('gone-last');
        expect(diagLines()).toHaveLength(11);
        expect(diagLines()[10]).toContain('(+5 not logged)');
    });
});

describe('one job per id', () => {
    it('callers that arrive during the wait share the one request stream and the one answer', async () => {
        script = (n) => (n === 1 ? status(503, { 'Retry-After': '2' }) : ok());
        const first = fetchFileUrl('av');
        await settle();
        const second = fetchFileUrl('av');
        await advance(1000);
        const third = fetchFileUrl('av');
        await settle();
        expect(requestsFor('av'), 'nobody started a request of their own').toHaveLength(1);
        await advance(1000);
        const [a, b, c] = await Promise.all([first, second, third]);
        expect(requestsFor('av')).toHaveLength(2);
        expect(a).toMatch(/^data:/);
        expect(b).toBe(a);
        expect(c).toBe(a);
    });
});

describe('signed out', () => {
    it('a caller with no token makes no request at all and gets null', async () => {
        h.token = null;
        expect(await fetchFileUrl('av')).toBeNull();
        await advance(60_000);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('signing out during a wait ends the job: no further request, null', async () => {
        script = () => status(503);
        let got: string | null | undefined;
        void fetchFileUrl('av').then((u) => { got = u; });
        await settle();
        h.token = null;
        clearFileCache();
        await settle();
        expect(got).toBeNull();
        await advance(5 * 60_000);
        expect(calls).toHaveLength(1);
    });

    it('an answer that lands after the sign-out is not cached for the next account', async () => {
        let answer: (r: Response) => void = () => {};
        script = () => new Promise<Response>((r) => { answer = r; });
        const p = fetchFileUrl('av');
        await settle();
        clearFileCache();
        answer(ok());
        await settle();
        expect(await p).toBeNull();
        expect(cachedFileUrl('av')).toBeNull();
    });
});

describe('at most six at once', () => {
    it('the seventh waits for a free slot, and they go in the order asked', async () => {
        const held: ((r: Response) => void)[] = [];
        script = () => new Promise<Response>((r) => { held.push(r); });
        const ids = Array.from({ length: 9 }, (_, i) => `f${i}`);
        const all = Promise.all(ids.map((id) => fetchFileUrl(id)));
        await settle();
        expect(calls.map((c) => c.url.split('/files/')[1])).toEqual(ids.slice(0, 6));
        held[0](ok());
        await settle();
        expect(calls).toHaveLength(7);
        expect(calls[6].url).toContain('/files/f6');
        for (let i = 1; i < 9; i++) {
            await settle();
            expect(calls.length, 'never more than six out').toBeLessThanOrEqual(i + 6);
            held[i](ok());
        }
        const urls = await all;
        expect(urls.every((u) => u?.startsWith('data:'))).toBe(true);
        expect(calls.map((c) => c.url.split('/files/')[1])).toEqual(ids);
    });

    it('a job waiting to try again holds no slot', async () => {
        script = (n, url) => (url.endsWith('/busy') && n === 1 ? status(503, { 'Retry-After': '10' }) : ok());
        void fetchFileUrl('busy');
        await settle();
        const others = Array.from({ length: 6 }, (_, i) => fetchFileUrl(`o${i}`));
        await settle();
        expect(calls).toHaveLength(7);
        expect((await Promise.all(others)).every((u) => u?.startsWith('data:'))).toBe(true);
    });
});

describe('a chance to recover', () => {
    it('`online` during our own backoff tries at once', async () => {
        script = (n) => (n === 1 ? new TypeError('Failed to fetch') : ok());
        const p = fetchFileUrl('av');
        await advance(500);
        expect(requestsFor('av')).toHaveLength(1);
        window.dispatchEvent(new Event('online'));
        await settle();
        expect(requestsFor('av')).toHaveLength(2);
        expect(requestsFor('av')[1].at).toBe(500);
        expect(await p).toMatch(/^data:/);
    });

    it('the socket connecting again does the same', async () => {
        script = (n) => (n === 1 ? status(502) : ok());
        const p = fetchFileUrl('av');
        await advance(300);
        window.dispatchEvent(new CustomEvent('wsConnected'));
        await settle();
        expect(requestsFor('av')).toHaveLength(2);
        expect(await p).toMatch(/^data:/);
    });

    it('but never cuts short a wait the server asked for', async () => {
        script = (n) => (n === 1 ? status(503, { 'Retry-After': '2' }) : ok());
        const p = fetchFileUrl('av');
        await advance(500);
        window.dispatchEvent(new Event('online'));
        await settle();
        expect(requestsFor('av')).toHaveLength(1);
        await advance(1500);
        expect(requestsFor('av')).toHaveLength(2);
        expect(await p).toMatch(/^data:/);
    });

    it('a page going HIDDEN is no chance', async () => {
        script = (n) => (n === 1 ? status(503) : ok());
        void fetchFileUrl('av');
        await advance(500);
        let vis: DocumentVisibilityState = 'hidden';
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vis });
        try {
            document.dispatchEvent(new Event('visibilitychange'));
            await settle();
            expect(requestsFor('av')).toHaveLength(1);
            vis = 'visible';
            document.dispatchEvent(new Event('visibilitychange'));
            await settle();
            expect(requestsFor('av')).toHaveLength(2);
        } finally {
            delete (document as { visibilityState?: unknown }).visibilityState;
        }
    });

    it('a chance that arrives while an attempt is out makes its failure try again at once', async () => {
        let fail: (e: Error) => void = () => {};
        script = (n) => (n === 1 ? new Promise<Response>((_, reject) => { fail = reject; }) : ok());
        const p = fetchFileUrl('av');
        await settle();
        window.dispatchEvent(new Event('online'));
        fail(new TypeError('Failed to fetch'));
        await settle();
        expect(requestsFor('av')).toHaveLength(2);
        expect(requestsFor('av')[1].at).toBe(0);
        expect(await p).toMatch(/^data:/);
    });

    it('a chance while the request still queued for a slot is no reason to skip the wait: it went out after', async () => {
        const held: ((r: Response) => void)[] = [];
        script = (_n, url) => (url.endsWith('/queued') ? status(503) : new Promise<Response>((r) => { held.push(r); }));
        const busy = Array.from({ length: 6 }, (_, i) => fetchFileUrl(`b${i}`));
        void fetchFileUrl('queued');
        await settle();
        expect(requestsFor('queued'), 'six out, this one waits for a slot').toHaveLength(0);
        window.dispatchEvent(new Event('online'));
        held[0](ok());
        await settle();
        expect(requestsFor('queued')).toHaveLength(1);
        await advance(1999);
        expect(requestsFor('queued'), 'its own backoff, not at once').toHaveLength(1);
        await advance(1);
        expect(requestsFor('queued')).toHaveLength(2);
        for (const r of held.slice(1)) r(ok());
        await Promise.all(busy);
    });

    it('the listeners are there only while a job runs', async () => {
        const added: string[] = [];
        const removed: string[] = [];
        for (const target of [window, document] as EventTarget[]) {
            const add = target.addEventListener.bind(target);
            const remove = target.removeEventListener.bind(target);
            vi.spyOn(target, 'addEventListener').mockImplementation((type, fn, o) => { added.push(type); add(type, fn, o); });
            vi.spyOn(target, 'removeEventListener').mockImplementation((type, fn, o) => { removed.push(type); remove(type, fn, o); });
        }
        script = (n) => (n === 1 ? status(503) : ok());
        const p = fetchFileUrl('av');
        await settle();
        expect(added.sort()).toEqual(['online', 'visibilitychange', 'wsConnected']);
        expect(removed).toEqual([]);
        await advance(2000);
        await p;
        expect(removed.sort()).toEqual(['online', 'visibilitychange', 'wsConnected']);
    });
});
