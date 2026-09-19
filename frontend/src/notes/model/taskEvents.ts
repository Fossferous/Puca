/**
 * Púca Notes — live updates from `GET /events/tasks` (src/task_events.rs).
 *
 * The server says only WHAT changed, by id: a list, a channel checklist, the
 * set of lists, pins/order, the sealed prefs blob. Each event just marks the
 * matching query stale; the data itself is fetched (and decrypted) through the
 * same queries as always. Nothing about content ever rides this stream.
 *
 * Still NO WEBSOCKET (notesQueries.ts has why): this is a separate stream with
 * its own server-side registry.
 *
 * TRANSPORT. `fetch()` with a streaming body, not EventSource: EventSource
 * cannot send an Authorization header, and the token must not go in a URL.
 * Works in browsers and the Android WebView alike.
 *
 * FAILURE IS THE OLD BEHAVIOUR. A 404 (a backend without the route), repeated
 * failures, or an eviction (a fifth stream of the same account) leave Notes
 * exactly as it was before this existed — refetch on focus plus the 30 s poll
 * of an open shared note — and the poll is only switched off while the stream
 * is actually live. A 401 is the session ending: the app's one auth-expired
 * signal handles it.
 *
 * WRITES IN FLIGHT. An event for a note this page is itself writing (or has
 * queued offline) is deferred until the write settles (noteBusy.ts), so a
 * refetch cannot land the server's pre-write state over the optimistic edit.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { API_BASE_URL } from '../../api/config';
import { getToken, storeRenewedToken } from '../../api/auth';
import { signalAuthExpired } from '../../api/client';
import { LISTS_KEY, PREFS_KEY, whenNoteSettled } from './noteBusy';
import { pullNotesPrefs } from './notesPrefsSync';

export type TaskEventMsg =
    | { t: 'hello' }
    | { t: 'list'; id: number }
    | { t: 'channel'; id: number }
    | { t: 'lists' }
    | { t: 'prefs' }
    | { t: 'blob'; name: string }
    | { t: 'resync' }
    | { t: 'evicted' }
    | { t: 'bye'; why: string };

/** Validate one `data:` payload; null for anything unexpected. */
export function parseTaskEvent(data: string): TaskEventMsg | null {
    let o: unknown;
    try { o = JSON.parse(data); } catch { return null; }
    if (typeof o !== 'object' || o === null) return null;
    const e = o as Record<string, unknown>;
    const id = typeof e.id === 'number' && Number.isSafeInteger(e.id) && e.id > 0 ? e.id : null;
    switch (e.t) {
        case 'hello': case 'lists': case 'prefs': case 'resync': case 'evicted':
            return { t: e.t };
        case 'list': case 'channel':
            return id === null ? null : { t: e.t, id };
        case 'blob':
            return typeof e.name === 'string' ? { t: 'blob', name: e.name } : null;
        case 'bye':
            return { t: 'bye', why: typeof e.why === 'string' ? e.why : '' };
        default:
            return null;
    }
}

/**
 * Split buffered SSE text into complete events' `data` payloads. Whatever
 * follows the last blank line is an incomplete event and is handed back as
 * `rest`. Comment lines (the server's keep-alives) carry nothing.
 */
export function takeSseEvents(buffer: string): { data: string[]; rest: string } {
    const text = buffer.replace(/\r\n?/g, '\n');
    const blocks = text.split('\n\n');
    const rest = blocks.pop() ?? '';
    const data: string[] = [];
    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, ''));
        if (lines.length > 0) data.push(lines.join('\n'));
    }
    return { data, rest };
}

export type StreamState = 'connecting' | 'live' | 'fallback' | 'unsupported' | 'stopped';

export interface TaskEventsOptions {
    url: string;
    token: () => string | null;
    onEvent: (ev: TaskEventMsg) => void;
    onState: (s: StreamState) => void;
    onRenewedToken?: (sentWith: string, renewed: string) => void;
    onUnauthorized?: () => void;
    fetchImpl?: typeof fetch;
    random?: () => number;
}

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** After an eviction: someone else (another tab of this account) needs the
 *  slot more; do not fight for it. */
export const EVICTED_RETRY_MS = 5 * 60_000;
/** A backend without the route: look again much later (it may be upgraded). */
export const UNSUPPORTED_RETRY_MS = 30 * 60_000;
/** No byte (not even a keep-alive, every 20 s) for this long = a dead path. */
export const WATCHDOG_MS = 60_000;

/**
 * Run the stream until stop(). Reconnects with jittered exponential backoff;
 * `kick()` fires a parked retry now (coming back to the page), keeping the
 * attempt count so a server that accepts and drops is not hammered.
 */
export function startTaskEvents(o: TaskEventsOptions): { stop(): void; kick(): void } {
    const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const random = o.random ?? Math.random;
    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let connected = false;
    /** Parked on purpose (evicted, or no route): a resume must not re-probe. */
    let parkedLong = false;

    const setState = (s: StreamState) => { if (!stopped || s === 'stopped') o.onState(s); };
    const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
    const armWatchdog = () => {
        clearWatchdog();
        watchdog = setTimeout(() => controller?.abort(), WATCHDOG_MS);
    };
    const schedule = (ms: number, long = false) => {
        if (stopped) return;
        parkedLong = long;
        if (retry) clearTimeout(retry);
        retry = setTimeout(() => { retry = null; void connect(); }, ms);
    };
    const backoff = () => {
        const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt) * (0.5 + random() / 2);
        attempt = Math.min(attempt + 1, 16);
        return ms;
    };

    async function connect(): Promise<void> {
        if (stopped) return;
        const token = o.token();
        if (!token) { setState('stopped'); return; }
        controller = new AbortController();
        setState('connecting');
        let res: Response;
        try {
            res = await doFetch(o.url, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
                cache: 'no-store',
                signal: controller.signal,
            });
        } catch {
            setState('fallback');
            schedule(backoff());
            return;
        }
        const renewed = res.headers.get('x-renewed-token');
        if (renewed) o.onRenewedToken?.(token, renewed);
        if (res.status === 404) {
            setState('unsupported');
            schedule(UNSUPPORTED_RETRY_MS, true);
            return;
        }
        if (res.status === 401) {
            o.onUnauthorized?.();
            stopped = true;
            setState('stopped');
            return;
        }
        if (!res.ok || !res.body) {
            setState('fallback');
            schedule(backoff());
            return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let evicted = false;
        armWatchdog();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                armWatchdog();
                buf += decoder.decode(value, { stream: true });
                const { data, rest } = takeSseEvents(buf);
                buf = rest;
                for (const d of data) {
                    const ev = parseTaskEvent(d);
                    if (!ev) continue;
                    if (ev.t === 'hello') {
                        attempt = 0;
                        connected = true;
                        setState('live');
                    }
                    if (ev.t === 'evicted') evicted = true;
                    if (!stopped) o.onEvent(ev);
                }
            }
        } catch {
            // aborted (watchdog / stop) or the connection dropped
        } finally {
            clearWatchdog();
            try { reader.releaseLock(); } catch { /* already released */ }
        }
        connected = false;
        if (stopped) return;
        setState('fallback');
        if (evicted) schedule(EVICTED_RETRY_MS, true);
        else schedule(backoff());
    }

    void connect();
    return {
        stop() {
            stopped = true;
            if (retry) clearTimeout(retry);
            clearWatchdog();
            controller?.abort();
            o.onState('stopped');
        },
        kick() {
            if (stopped || connected || !retry || parkedLong) return;
            clearTimeout(retry);
            retry = null;
            void connect();
        },
    };
}

// --- The live flag (the shared-note poll switches off while this is true) ---------

let liveState: StreamState = 'stopped';
const liveListeners = new Set<() => void>();
function setLiveState(s: StreamState): void {
    if (s === liveState) return;
    liveState = s;
    for (const cb of liveListeners) cb();
}
function subscribeLive(cb: () => void): () => void {
    liveListeners.add(cb);
    return () => { liveListeners.delete(cb); };
}
export function taskEventsLive(): boolean {
    return liveState === 'live';
}
export function useTaskEventsLive(): boolean {
    return useSyncExternalStore(subscribeLive, taskEventsLive, () => false);
}

// --- Events -> query invalidation ---------------------------------------------------

/** Mark what an event names as stale, deferring a note this page is writing. */
export function applyTaskEvent(qc: QueryClient, ev: TaskEventMsg, isReconnect: boolean): void {
    const invalidate = (key: string, queryKey: readonly unknown[]) =>
        whenNoteSettled(key, () => { void qc.invalidateQueries({ queryKey }); });
    switch (ev.t) {
        case 'list':
        case 'channel': {
            const kind = ev.t;
            invalidate(`${kind}:${ev.id}`, ['notes', 'tasks', kind, ev.id]);
            break;
        }
        case 'lists':
            invalidate(LISTS_KEY, ['notes', 'lists']);
            break;
        case 'prefs':
            invalidate(PREFS_KEY, ['notes', 'prefs']);
            break;
        case 'blob':
            pullNotesPrefs();
            break;
        case 'hello':
        case 'resync':
            // A REconnect may have missed events while the stream was down;
            // the first hello of the page has nothing to catch up on.
            if (ev.t === 'hello' && !isReconnect) break;
            void qc.invalidateQueries({ queryKey: ['notes'] });
            pullNotesPrefs();
            break;
        default:
            break;
    }
}

/** Mount once in the shell. */
export function useTaskEvents(): void {
    const qc = useQueryClient();
    useEffect(() => {
        let hellos = 0;
        const client = startTaskEvents({
            url: `${API_BASE_URL}/events/tasks`,
            token: getToken,
            onEvent: ev => {
                if (ev.t === 'hello') hellos++;
                applyTaskEvent(qc, ev, ev.t === 'hello' && hellos > 1);
            },
            onState: setLiveState,
            onRenewedToken: storeRenewedToken,
            onUnauthorized: signalAuthExpired,
        });
        const kick = () => { if (document.visibilityState === 'visible') client.kick(); };
        document.addEventListener('visibilitychange', kick);
        window.addEventListener('online', kick);
        window.addEventListener('focus', kick);
        return () => {
            document.removeEventListener('visibilitychange', kick);
            window.removeEventListener('online', kick);
            window.removeEventListener('focus', kick);
            client.stop();
        };
    }, [qc]);
}
