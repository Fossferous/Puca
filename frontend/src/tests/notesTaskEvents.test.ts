/**
 * The live stream client (notes/model/taskEvents.ts): parsing, reconnect
 * policy, the fallbacks that keep today's behaviour, and the rule that an
 * event for a note this page is writing waits for the write.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

vi.mock('../api/auth', () => ({ getToken: () => 'tok', storeRenewedToken: vi.fn(), currentUserIdFromToken: () => 1 }));
vi.mock('../notes/model/notesPrefsSync', () => ({ pullNotesPrefs: vi.fn() }));

const {
    parseTaskEvent, takeSseEvents, startTaskEvents, applyTaskEvent,
    EVICTED_RETRY_MS, UNSUPPORTED_RETRY_MS, WATCHDOG_MS,
} = await import('../notes/model/taskEvents');
const { beginNoteWrite, resetNoteBusy } = await import('../notes/model/noteBusy');
const { pullNotesPrefs } = await import('../notes/model/notesPrefsSync');

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

describe('parsing', () => {
    it('splits SSE into data payloads across chunk boundaries, ignoring keep-alives', () => {
        let r = takeSseEvents(':k\n\ndata: {"t":"hello"}\n\ndata: {"t":"li');
        expect(r.data).toEqual(['{"t":"hello"}']);
        r = takeSseEvents(r.rest + 'st","id":5}\r\n\r\n');
        expect(r.data).toEqual(['{"t":"list","id":5}']);
        expect(r.rest).toBe('');
    });

    it('accepts only the known shapes with positive ids', () => {
        expect(parseTaskEvent('{"t":"list","id":5}')).toEqual({ t: 'list', id: 5 });
        expect(parseTaskEvent('{"t":"channel","id":9}')).toEqual({ t: 'channel', id: 9 });
        expect(parseTaskEvent('{"t":"blob","name":"notes-prefs"}')).toEqual({ t: 'blob', name: 'notes-prefs' });
        for (const bad of ['{"t":"list"}', '{"t":"list","id":-1}', '{"t":"nope"}', 'x', '[]', '{"t":"channel","id":"5"}']) {
            expect(parseTaskEvent(bad), bad).toBeNull();
        }
    });
});

/** A fetch whose streams the test feeds. */
function streamingFetch() {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const calls: { url: string; auth: string }[] = [];
    let next: { status: number; headers?: Record<string, string> } = { status: 200 };
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(url), auth: (init?.headers as Record<string, string>).Authorization });
        const { status, headers } = next;
        if (status !== 200) return new Response('', { status, headers });
        const body = new ReadableStream<Uint8Array>({ start(c) { streams.push(c); } });
        init?.signal?.addEventListener('abort', () => { try { streams[streams.length - 1].error(new Error('aborted')); } catch { /* closed */ } });
        return new Response(body, { status: 200, headers });
    });
    const send = (text: string) => streams[streams.length - 1].enqueue(new TextEncoder().encode(text));
    const end = () => streams[streams.length - 1].close();
    return { impl: impl as unknown as typeof fetch, calls, send, end, respond: (n: typeof next) => { next = n; } };
}

describe('the stream client', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('goes live on hello, delivers events, and reconnects after the stream ends', async () => {
        const f = streamingFetch();
        const events: unknown[] = [];
        const states: string[] = [];
        const c = startTaskEvents({ url: 'https://api/events/tasks', token: () => 'tok', onEvent: e => events.push(e), onState: s => states.push(s), fetchImpl: f.impl, random: () => 1 });
        await flush();
        expect(f.calls[0].auth).toBe('Bearer tok');   // the token rides a header, never the URL
        expect(f.calls[0].url).not.toContain('tok');
        f.send('data: {"t":"hello"}\n\n:k\n\ndata: {"t":"list","id":3}\n\n');
        await flush();
        expect(states).toContain('live');
        expect(events).toEqual([{ t: 'hello' }, { t: 'list', id: 3 }]);
        f.end();
        await flush();
        expect(states[states.length - 1]).toBe('fallback');
        await vi.advanceTimersByTimeAsync(1_000);        // attempt 0: 1 s
        expect(f.calls.length).toBe(2);
        c.stop();
    });

    it('a 404 (old backend) is the fallback, and is not re-probed on every resume', async () => {
        const f = streamingFetch();
        f.respond({ status: 404 });
        const states: string[] = [];
        const c = startTaskEvents({ url: 'u', token: () => 't', onEvent: () => {}, onState: s => states.push(s), fetchImpl: f.impl });
        await flush();
        expect(states).toContain('unsupported');
        c.kick();                                        // coming back to the page
        await flush();
        expect(f.calls.length).toBe(1);
        await vi.advanceTimersByTimeAsync(UNSUPPORTED_RETRY_MS);
        expect(f.calls.length).toBe(2);
        c.stop();
    });

    it('a 401 hands over to the auth-expired signal and stops', async () => {
        const f = streamingFetch();
        f.respond({ status: 401 });
        const onUnauthorized = vi.fn();
        const c = startTaskEvents({ url: 'u', token: () => 't', onEvent: () => {}, onState: () => {}, fetchImpl: f.impl, onUnauthorized });
        await flush();
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(f.calls.length).toBe(1);
        c.stop();
    });

    it('a 401 for a token replaced while the request was out retries with the new one, and does not expire', async () => {
        // Púca Notes resumed: the stream reconnected on the stale token, then
        // the page adopted the background job's renewal.
        const f = streamingFetch();
        f.respond({ status: 401 });
        let tok = 'stale';
        const onUnauthorized = vi.fn();
        const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
            const r = await (f.impl as unknown as (u: RequestInfo | URL, i?: RequestInit) => Promise<Response>)(url, init);
            tok = 'renewed';
            f.respond({ status: 200 });
            return r;
        });
        const c = startTaskEvents({ url: 'u', token: () => tok, onEvent: () => {}, onState: () => {}, fetchImpl: impl as unknown as typeof fetch, onUnauthorized });
        await flush();
        await vi.advanceTimersByTimeAsync(0);
        expect(onUnauthorized).not.toHaveBeenCalled();
        expect(f.calls.map(x => x.auth)).toEqual(['Bearer stale', 'Bearer renewed']);
        c.stop();
    });

    it('an evicted stream backs off for minutes instead of fighting for the slot', async () => {
        const f = streamingFetch();
        const c = startTaskEvents({ url: 'u', token: () => 't', onEvent: () => {}, onState: () => {}, fetchImpl: f.impl, random: () => 1 });
        await flush();
        f.send('data: {"t":"hello"}\n\ndata: {"t":"evicted"}\n\n');
        f.end();
        await flush();
        await vi.advanceTimersByTimeAsync(EVICTED_RETRY_MS - 1_000);
        expect(f.calls.length).toBe(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(f.calls.length).toBe(2);
        c.stop();
    });

    it('a silent stream is dropped by the watchdog and reconnected', async () => {
        const f = streamingFetch();
        const c = startTaskEvents({ url: 'u', token: () => 't', onEvent: () => {}, onState: () => {}, fetchImpl: f.impl, random: () => 1 });
        await flush();
        f.send('data: {"t":"hello"}\n\n');
        await flush();
        await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 1_500);
        expect(f.calls.length).toBe(2);
        c.stop();
    });

    it('hands a renewed token on', async () => {
        const f = streamingFetch();
        f.respond({ status: 200, headers: { 'x-renewed-token': 'fresh' } });
        const onRenewedToken = vi.fn();
        const c = startTaskEvents({ url: 'u', token: () => 'old', onEvent: () => {}, onState: () => {}, fetchImpl: f.impl, onRenewedToken });
        await flush();
        expect(onRenewedToken).toHaveBeenCalledWith('old', 'fresh');
        c.stop();
    });
});

describe('events -> queries', () => {
    beforeEach(() => { resetNoteBusy(); vi.mocked(pullNotesPrefs).mockClear(); });

    it('marks exactly the named note stale', () => {
        const qc = new QueryClient();
        const spy = vi.spyOn(qc, 'invalidateQueries');
        applyTaskEvent(qc, { t: 'list', id: 4 }, false);
        expect(spy).toHaveBeenCalledWith({ queryKey: ['notes', 'tasks', 'list', 4] });
        applyTaskEvent(qc, { t: 'channel', id: 8 }, false);
        expect(spy).toHaveBeenLastCalledWith({ queryKey: ['notes', 'tasks', 'channel', 8] });
        applyTaskEvent(qc, { t: 'blob', name: 'notes-prefs' }, false);
        expect(pullNotesPrefs).toHaveBeenCalledTimes(1);
    });

    it('waits for this page’s own write on that note to settle', () => {
        const qc = new QueryClient();
        const spy = vi.spyOn(qc, 'invalidateQueries');
        const done = beginNoteWrite('list:4');
        applyTaskEvent(qc, { t: 'list', id: 4 }, false);
        applyTaskEvent(qc, { t: 'list', id: 4 }, false);
        expect(spy).not.toHaveBeenCalled();
        // Positive control: another note is not held up.
        applyTaskEvent(qc, { t: 'list', id: 5 }, false);
        expect(spy).toHaveBeenCalledTimes(1);
        done();
        expect(spy).toHaveBeenCalledTimes(2);           // one deferred refetch, not two
        expect(spy).toHaveBeenLastCalledWith({ queryKey: ['notes', 'tasks', 'list', 4] });
    });

    it('a lists event refreshes the trash with the listing, in the same deferred refetch', () => {
        const qc = new QueryClient();
        const spy = vi.spyOn(qc, 'invalidateQueries');
        applyTaskEvent(qc, { t: 'lists' }, false);
        expect(spy.mock.calls.map(c => c[0])).toEqual([{ queryKey: ['notes', 'lists'] }, { queryKey: ['notes', 'trash'] }]);
        spy.mockClear();
        // While this page is creating/deleting a note, both wait for it...
        const done = beginNoteWrite('lists');
        applyTaskEvent(qc, { t: 'lists' }, false);
        applyTaskEvent(qc, { t: 'lists' }, false);
        expect(spy).not.toHaveBeenCalled();
        done();
        // ...and then both run, once each (one waiter per key must carry both).
        expect(spy.mock.calls.map(c => c[0])).toEqual([{ queryKey: ['notes', 'lists'] }, { queryKey: ['notes', 'trash'] }]);
    });

    it('re-reads everything on a resync and on a reconnect’s hello, not on the first hello', () => {
        const qc = new QueryClient();
        const spy = vi.spyOn(qc, 'invalidateQueries');
        applyTaskEvent(qc, { t: 'hello' }, false);
        expect(spy).not.toHaveBeenCalled();
        applyTaskEvent(qc, { t: 'hello' }, true);
        applyTaskEvent(qc, { t: 'resync' }, false);
        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenCalledWith({ queryKey: ['notes'] });
    });
});

describe('a create racing the stream', () => {
    it('a note the stream already refetched is not added a second time', async () => {
        const { withCreatedList } = await import('../notes/model/notesModel');
        const created = { id: 4, title: 'Groceries', total_tasks: 3 };
        // The {"t":"lists"} refetch landed between the create and the write.
        const refetched = [{ id: 1, title: 'Old', total_tasks: 0 }, { id: 4, title: 'Groceries', total_tasks: 0 }];
        const out = withCreatedList(refetched, created);
        expect(out.filter(l => l.id === 4)).toEqual([created]);
        expect(out.map(l => l.id)).toEqual([1, 4]);
        // Positive control: with no refetch in between it is simply appended.
        expect(withCreatedList([{ id: 1, title: 'Old', total_tasks: 0 }], created).map(l => l.id)).toEqual([1, 4]);
        expect(withCreatedList(undefined, created)).toEqual([created]);
    });
});
