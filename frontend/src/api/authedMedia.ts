/**
 * Authenticated media fetching.
 *
 * `GET /files/:id` used to be a public route "for embedding in messages",
 * which meant anyone on the internet holding a UUID could pull any avatar,
 * emoji, server icon, sound clip or attachment with no account at all. It is
 * authenticated now — but a plain `<img src>` cannot send an Authorization
 * header, which is exactly why it was public in the first place.
 *
 * So: fetch the bytes with the header and hand `<img>` a URL made from them.
 * Chosen over the alternatives deliberately —
 *   - a token in the query string leaks a credential into access logs,
 *     Referer headers and browser history;
 *   - a cookie would need SameSite=None across three different shells (web,
 *     Tauri's custom origin, Capacitor) and adds CSRF surface;
 *   - a service worker cannot see the identity seed and none is registered.
 *
 * A `data:` URL, NOT a blob: URL (fetchFileUrl). These are kept for the whole
 * session (avatars, server icons, custom emoji: up to MAX_CACHED of them),
 * and a Blob kept that long keeps DECRYPTED ATTACHMENTS on disk: Chromium
 * writes the blobs it pages out several to a file in
 * `<profile>/Default/blob_storage` and deletes a file only once every blob
 * in it is gone (measured 2026-10-05: an avatar's blob written into the same
 * file as two pictures kept their plaintext there after they were let go,
 * on screen, in the background and after a kill, in the Android WebView and
 * in Edge under memory pressure; revoking the avatars removed it at once).
 * A data: URL is never a blob, so it is never in that folder at all: it lives
 * in the page's memory (as text, a third larger than the file; bounded by
 * MAX_CACHED_CHARS) and the image decoder's, and nowhere else. Every shell's
 * policy allows `img-src data:`. A data: URL is also inert as a document: a
 * top-level navigation to one is blocked, and one that loads gets an opaque
 * origin, never this app's.
 *
 * `<audio>` is the exception: the Android and web policies do not allow
 * `media-src data:`, so a sound is played from a blob: URL that lives only
 * while it plays (fetchFileObjectUrl).
 *
 * URLs are cached by file id, so a 50-message list showing the same avatar
 * fetches once, not fifty times.
 *
 * ONE FAILED GET USED TO BE FOR THE WHOLE SESSION (field report 2026-11-19: a
 * member's desktop app drew the owner's and another member's pictures as
 * initials while the owner saw both, and the server served them). Any answer
 * but a 200 resolved null, the hook asked again only for a new file id, and a
 * member-list row stays mounted (keyed by member id) through every members
 * poll, so a single 503 from the server's per-address download ceiling
 * (src/upload_handlers.rs get_file: 32 at once, `Retry-After: 2` past it), a
 * 429 from the API limiter or a dropped connection left initials until a
 * reload. Now:
 *   - a TRANSIENT failure (the fetch threw, 408, 425, 429, a 5xx other than
 *     501/505: Cloudflare's 52x is the origin restarting) is tried again
 *     inside the one shared job, so concurrent callers of one id still share
 *     one request at a time and one schedule: 2 s, 4 s, 8 s, 16 s, 30 s (plus
 *     up to a fifth more, so a crowd that failed together does not come back
 *     together), never sooner than a `Retry-After` asks (seconds or an HTTP
 *     date, read by api/client.ts retryAfterMsOf, at most a minute), and at
 *     most FILE_ATTEMPTS attempts, with no wait begun once FILE_RETRY_TOTAL_MS
 *     have passed since the first request went out (queueing for a slot is
 *     not counted). The waits come to a minute; an attempt itself can take up
 *     to FILE_ANSWER_TIMEOUT_MS to answer, so a server that never answers is
 *     given up on after about a minute and a half, and the extra tries below
 *     can add to that;
 *   - a DEFINITE one (401, 403, 404, 410, any other 4xx) is final at once,
 *     and nobody signed in means no request at all;
 *   - a job nobody waits for any more (every hook that asked unmounted) stops
 *     at once if it is queued or waiting, or after the request it is making;
 *   - after a job gave up, a later chance (the browser's `online`, the page
 *     shown again, the app's socket connecting again: `wsConnected`, which is
 *     what tells of a server that went away and came back, where the network
 *     never did) makes every component still showing its fallback for a
 *     transient reason ask again, once per such event and still one job per
 *     id (onFileRecoveryChance). The same event cuts short the part of a
 *     wait that is our own backoff (never what the server asked for), and one
 *     arriving while an attempt is out makes its failure try again as soon as
 *     the server allows, past the job's limits if need be (at most
 *     FILE_EXTRA_ATTEMPTS times): that attempt may have begun before the way
 *     was clear, and a component on its fallback listens only after a give-up;
 *   - at most MAX_FILE_FETCHES of these requests run at once, the rest queued
 *     in order, so a page's first paint (every avatar in the member list,
 *     every server icon, every emoji: one render's effects) cannot fill the
 *     server's per-address ceiling by itself. Production sits behind a CDN
 *     on HTTP/2, where the browser's six-connections-per-host limit does not
 *     apply and a hundred requests leave at once; the ceiling is also shared
 *     with the attachment loader (its own 2 + 4, api/attachments.ts) and with
 *     every other device behind the same address. So a request whose answer
 *     has not begun within FILE_ANSWER_TIMEOUT_MS, or whose body has sent
 *     nothing for as long, is let go and tried again, rather than hold a slot
 *     (and everything queued behind it) until a CDN gives up on its origin;
 *   - a give-up, a refusal and a load that took more than one attempt each
 *     write one `[media-diag]` line (the console, and puca.log through the
 *     desktop shell): the status and the attempts, a short prefix of the file
 *     id, never a token or a URL. At most DIAG_LINES_PER_MINUTE of them.
 */
import { API_BASE_URL } from './config';
import { getToken } from './auth';
import { safeBlobType } from './attachments';
import { bytesToB64 } from './parkedMedia';
import { retryAfterMsOf } from './client';
import { createPriorityLimiter } from './priorityLimiter';
import { isTauri } from './platform';

/** Resolved data: URLs, keyed by file id. */
const cache = new Map<string, string>();
/** Characters held by `cache` (a data: URL is about 4/3 of the file). */
let cachedChars = 0;

/** Cap the number of cached URLs: a busy server has far more emoji and
 *  avatars than fit comfortably in a long session... */
const MAX_CACHED = 250;
/** ...and the text they take, which is page memory (32 MB of files). An
 *  avatar is cropped to 512 px on upload; an emoji or icon is usually far
 *  smaller. The newest one is kept even if it alone is larger. */
const MAX_CACHED_CHARS = 44 * 1024 * 1024;

/** How many GET /files/<id> fetchFileUrl has out at once (see the top). Six:
 *  the attachment loader's six beside it make twelve from one page, against a
 *  server ceiling of 32 per address shared by every device behind it. */
export const MAX_FILE_FETCHES = 6;
/** Attempts in one job, the first included. */
export const FILE_ATTEMPTS = 6;
/** The first wait after a transient failure; each later one doubles... */
export const FILE_RETRY_BASE_MS = 2000;
/** ...up to this. */
export const FILE_RETRY_MAX_BACKOFF_MS = 30_000;
/** A Retry-After is honoured up to this (a bogus header must not park a job). */
export const FILE_RETRY_MAX_ASKED_MS = 60_000;
/** A job never runs longer than this, whatever the server asks... */
export const FILE_RETRY_TOTAL_MS = 90_000;
/** ...except for this many attempts more, each right after a chance to
 *  recover arrived while the attempt before it was out (that one's failure
 *  may be from before the way was clear again, and a component still on its
 *  fallback listens for chances only once the job has given up). */
export const FILE_EXTRA_ATTEMPTS = 2;
/** An attempt whose answer has not BEGUN to arrive by now, or whose body has
 *  sent nothing for this long, is given up as a network failure (and tried
 *  again): a request that hangs (a CDN holds one up to 100 s for an origin
 *  that does not answer) must not hold one of the MAX_FILE_FETCHES slots and
 *  every picture queued behind it. A body that keeps arriving is never cut
 *  off, however long it takes: a mode's background is a big picture and a
 *  phone's link a slow one. */
export const FILE_ANSWER_TIMEOUT_MS = 30_000;

function remember(fileId: string, url: string): void {
    // Oldest-first eviction (Map preserves insertion order).
    while (cache.size > 0 && (cache.size >= MAX_CACHED || cachedChars + url.length > MAX_CACHED_CHARS)) {
        const oldest = cache.keys().next().value as string;
        cachedChars -= cache.get(oldest)?.length ?? 0;
        cache.delete(oldest);
    }
    cache.set(fileId, url);
    cachedChars += url.length;
    // Anyone still drawing a fallback for this id has it now.
    const waiting = chances.get(fileId);
    if (waiting) for (const cb of [...waiting]) cb();
}

/** Already-resolved URL for this id, if we have one. Synchronous. */
export function cachedFileUrl(fileId: string): string | null {
    return cache.get(fileId) ?? null;
}

/**
 * Is this status one that may pass by itself? 408 (the request timed out),
 * 425 (too early), 429 (the API limiter) and a 5xx other than 501 and 505
 * (502/503/504 from a proxy or the download ceiling, 500 from a handler, and
 * a CDN's 52x while the origin restarts). Everything else, every other 4xx
 * above all, is the server's answer about this file and this account.
 */
export function isTransientStatus(status: number): boolean {
    if (status === 408 || status === 425 || status === 429) return true;
    return status >= 500 && status <= 599 && status !== 501 && status !== 505;
}

/** What one GET /files/<id> came to. `status` 0: it never got an answer. */
type Answer =
    | { kind: 'ok'; bytes: Uint8Array<ArrayBuffer>; type: string }
    | { kind: 'refused'; status: number }
    | { kind: 'transient'; status: number; retryAfterMs?: number }
    | { kind: 'signed-out' };

/** One request for the file's bytes and its (normalised) type. `stop` ends
 *  it (a sign-out). */
async function getFile(fileId: string, stop?: AbortSignal): Promise<Answer> {
    const token = getToken();
    if (!token) return { kind: 'signed-out' };
    const request = new AbortController();
    const onStop = () => request.abort();
    if (stop?.aborted) request.abort();
    else stop?.addEventListener('abort', onStop, { once: true });
    try {
        return await answerOf(fileId, token, request);
    } finally {
        stop?.removeEventListener('abort', onStop);
    }
}

async function answerOf(fileId: string, token: string, request: AbortController): Promise<Answer> {
    let res: Response;
    const timer = setTimeout(() => request.abort(), FILE_ANSWER_TIMEOUT_MS);
    try {
        res = await fetch(`${API_BASE_URL}/files/${fileId}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: request.signal,
        });
    } catch {
        return { kind: 'transient', status: 0 };   // offline, reset, DNS, timed out
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        // An error body is a line of text (a proxy's page at most): read it so
        // the connection is free again, and for a JSON `retry_after_ms`.
        const text = await readAll(res, request).then((b) => new TextDecoder().decode(b), () => '');
        if (!isTransientStatus(res.status)) return { kind: 'refused', status: res.status };
        return { kind: 'transient', status: res.status, retryAfterMs: retryAfterMsOf(res.headers, text) };
    }
    // Re-type the bytes before they become a URL. The response Content-Type
    // is chosen by whoever uploaded the file — `src/upload_handlers.rs`
    // stores the multipart part's content_type verbatim and echoes it back. A
    // `blob:` document inherits THIS app's origin, so a `text/html` sound is
    // one careless consumer (an <a href> or window.open) away from script
    // execution beside the JWT and the E2EE seed. `safeBlobType` is the same
    // normalisation the decrypted-attachment path applies; every type these
    // callers actually render survives it unchanged.
    // Bytes, not `res.blob()`: wrapping one runtime's Blob in another's
    // constructor (undici's Response inside jsdom's Blob, on Node 20)
    // stringifies it to "[object Blob]" — 13 bytes of nothing. The browser
    // never hits that, but CI did, and bytes are the same everywhere (and a
    // Blob is what fetchFileUrl must not make). The type comes from the
    // header, parameters dropped.
    let bytes: Uint8Array<ArrayBuffer>;
    try {
        bytes = await readAll(res, request);
    } catch {
        return { kind: 'transient', status: 0 };   // the body broke off, or stalled
    }
    const declared = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    return { kind: 'ok', bytes, type: safeBlobType(declared) };
}

/**
 * The body's bytes, ending the request once FILE_ANSWER_TIMEOUT_MS pass with
 * NOTHING arriving (a body that stalls must not hold its slot either; one that
 * keeps arriving, however slowly, is never cut off).
 */
async function readAll(res: Response, request: AbortController): Promise<Uint8Array<ArrayBuffer>> {
    if (!res.body) return new Uint8Array(await res.arrayBuffer());
    const reader = res.body.getReader();
    // A real fetch's body errors when its signal ends; letting go of the
    // reader makes sure of it whatever stands behind the Response.
    const letGo = () => { void reader.cancel().catch(() => { /* already over */ }); };
    request.signal.addEventListener('abort', letGo, { once: true });
    const stall = () => setTimeout(() => request.abort(), FILE_ANSWER_TIMEOUT_MS);
    let timer = stall();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            clearTimeout(timer);
            if (done) break;
            parts.push(value);
            size += value.byteLength;
            timer = stall();
        }
    } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', letGo);
    }
    if (request.signal.aborted) throw new DOMException('The answer stalled.', 'AbortError');
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.byteLength; }
    return out;
}

/** What a caller of loadFileUrl gets. */
export interface FileUrlOutcome {
    /** The data: URL, or null when it cannot be had. */
    url: string | null;
    /** Null for a reason that may pass (the job gave up on a busy server or a
     *  network that was down), so it is worth asking again at the next chance
     *  (onFileRecoveryChance). False with a URL, and for a definite refusal,
     *  nobody signed in, or a sign-out meanwhile. */
    retryable: boolean;
}

const FINAL_NULL: FileUrlOutcome = Object.freeze({ url: null, retryable: false });
const RETRYABLE_NULL: FileUrlOutcome = Object.freeze({ url: null, retryable: true });

interface Job {
    fileId: string;
    promise: Promise<FileUrlOutcome>;
    settle: (o: FileUrlOutcome) => void;
    done: boolean;
    /** Callers still waiting for the answer. A caller with no signal never leaves. */
    waiters: number;
    phase: 'queued' | 'fetching' | 'sleeping';
    /** Ends the current wait at once (null while not waiting). */
    wake: (() => void) | null;
    /** The current wait is our own backoff, not one the server asked for. */
    wakeable: boolean;
    /** Takes the queued attempt out of the line. */
    unqueue: AbortController | null;
    /** Ends the request that is out (only a sign-out does: one that lands
     *  after everyone left is still worth its place in the cache). */
    request: AbortController | null;
}

/** Jobs running (queued, fetching or waiting to try again), by file id. */
const inflight = new Map<string, Job>();
const fileLimiter = createPriorityLimiter(MAX_FILE_FETCHES);

/** Counts the chances to recover (see the top) while anything listens. */
let recoverySeq = 0;
/** Components drawing a fallback for a transient reason, by file id. */
const chances = new Map<string, Set<() => void>>();
let chanceCount = 0;
let listening = false;

function finish(job: Job, outcome: FileUrlOutcome): void {
    if (job.done) return;
    job.done = true;
    if (inflight.get(job.fileId) === job) inflight.delete(job.fileId);
    job.wake?.();
    job.unqueue?.abort();
    job.request?.abort();
    job.settle(outcome);
    syncRecoveryListeners();
}

/** Nobody waits for it any more: stop now unless a request is out (its
 *  answer still lands in the cache), and then stop after it. */
function abandonIfUnwanted(job: Job): void {
    if (job.done || job.waiters > 0 || job.phase === 'fetching') return;
    finish(job, RETRYABLE_NULL);
}

function join(job: Job, signal: AbortSignal | undefined): void {
    job.waiters++;
    if (!signal) return;
    const leave = () => {
        if (job.done) return;
        job.waiters--;
        // Not at once: a list that unmounts a row and mounts its replacement
        // in one commit runs the cleanup first, and the new row should join
        // this job rather than find it gone.
        if (job.waiters === 0) queueMicrotask(() => abandonIfUnwanted(job));
    };
    if (signal.aborted) leave();
    else signal.addEventListener('abort', leave, { once: true });
}

const withJitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.2);

/** Wait `ms`; `wakeable`: a chance to recover may end it early. */
function sleep(job: Job, ms: number, wakeable: boolean): Promise<void> {
    job.phase = 'sleeping';
    job.wakeable = wakeable;
    return new Promise<void>((resolve) => {
        const end = () => { clearTimeout(timer); job.wake = null; resolve(); };
        const timer = setTimeout(end, ms);
        job.wake = end;
    });
}

/** `[media-diag] …` lines, at most this many a minute (a server that went
 *  away for everyone gives up on every picture at once). */
const DIAG_LINES_PER_MINUTE = 10;
let diagWindowStart = -Infinity;
let diagInWindow = 0;
let diagDropped = 0;

function logMediaDiag(line: string): void {
    const now = Date.now();
    // (A clock set back starts a new minute too.)
    if (now - diagWindowStart >= 60_000 || now < diagWindowStart) { diagWindowStart = now; diagInWindow = 0; }
    if (diagInWindow >= DIAG_LINES_PER_MINUTE) { diagDropped++; return; }
    diagInWindow++;
    const full = `[media-diag] ${line}${diagDropped ? ` (+${diagDropped} not logged)` : ''}`;
    diagDropped = 0;
    console.info(full);
    // A release WebView keeps no console; puca.log gets only what the shell is handed.
    if (!isTauri()) return;
    void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('log_stream_diag', { line: full }))
        .catch(() => { /* best effort: a missing line is not worth an error */ });
}

/** The file named in a diagnostic line: enough to tell lines apart, no more. */
const shortId = (fileId: string) => fileId.slice(0, 8);
const statusWord = (status: number) => (status === 0 ? 'network' : String(status));

async function runJob(job: Job): Promise<void> {
    const { fileId } = job;
    // When the first request went out: the time budget is the server's, and a
    // job queued behind a crowd for a slot (MAX_FILE_FETCHES) has spent none of it.
    let started: number | null = null;
    let backoff = FILE_RETRY_BASE_MS;
    let extra = FILE_EXTRA_ATTEMPTS;
    const seen: string[] = [];
    for (let attempt = 1; ; attempt++) {
        // The chances counted when the request goes out (not while it queues).
        let seq = recoverySeq;
        job.phase = 'queued';
        const unqueue = new AbortController();
        job.unqueue = unqueue;
        const request = new AbortController();
        job.request = request;
        let answer: Answer;
        try {
            answer = await fileLimiter.schedule({
                run: () => {
                    job.phase = 'fetching';
                    seq = recoverySeq;
                    started ??= Date.now();
                    return getFile(fileId, request.signal);
                },
                urgency: () => 0,
                signal: unqueue.signal,
            });
        } catch {
            // Taken out of the line (finished already: nobody waits, or signed
            // out), or the attempt itself threw: then end it here, or it would
            // never answer and its id would stay "running" for the session.
            finish(job, RETRYABLE_NULL);
            return;
        }
        job.unqueue = null;
        job.request = null;
        // Signed out while it was out: nothing of it is the next account's.
        if (job.done) return;
        if (answer.kind === 'ok') {
            const url = `data:${answer.type};base64,${bytesToB64(answer.bytes)}`;
            remember(fileId, url);
            if (attempt > 1) logMediaDiag(`picture loaded on attempt ${attempt} after ${seen.join(',')}: file=${shortId(fileId)}`);
            finish(job, { url, retryable: false });
            return;
        }
        if (answer.kind === 'signed-out') { finish(job, FINAL_NULL); return; }
        if (answer.kind === 'refused') {
            logMediaDiag(`picture refused: status=${answer.status} attempts=${attempt} file=${shortId(fileId)}`);
            finish(job, FINAL_NULL);
            return;
        }
        seen.push(statusWord(answer.status));
        if (job.waiters === 0) { finish(job, RETRYABLE_NULL); return; }
        // The server's wait, never cut short (at most a minute: a bogus header must not park the job).
        const floor = answer.retryAfterMs !== undefined ? Math.min(answer.retryAfterMs, FILE_RETRY_MAX_ASKED_MS) : 0;
        // Something said the way may be clear again while this attempt was out:
        // its failure may be from before, so try again as soon as the server
        // allows rather than after our own backoff.
        const chanced = recoverySeq !== seq;
        const wait = chanced ? floor : withJitter(Math.max(floor, backoff));
        backoff = Math.min(backoff * 2, FILE_RETRY_MAX_BACKOFF_MS);
        const since = Date.now() - (started ?? Date.now());
        const spent = attempt >= FILE_ATTEMPTS || since + wait > FILE_RETRY_TOTAL_MS;
        if (spent && !(chanced && extra > 0)) {
            logMediaDiag(`picture gave up: last=${statusWord(answer.status)} attempts=${attempt} after=${Math.round(since / 1000)}s seen=${seen.join(',')} file=${shortId(fileId)}`);
            finish(job, RETRYABLE_NULL);
            return;
        }
        if (spent) extra--;
        if (wait > 0) {
            const notBefore = Date.now() + floor;
            // A chance may end the part of the wait that is ours, and only that.
            await sleep(job, wait, wait > floor);
            if (job.done) return;
            const left = notBefore - Date.now();
            if (left > 0) {
                await sleep(job, left, false);
                if (job.done) return;
            }
        }
    }
}

function startJob(fileId: string): Job {
    let settle!: (o: FileUrlOutcome) => void;
    const promise = new Promise<FileUrlOutcome>((resolve) => { settle = resolve; });
    const job: Job = {
        fileId, promise, settle, done: false, waiters: 0,
        phase: 'queued', wake: null, wakeable: false, unqueue: null, request: null,
    };
    inflight.set(fileId, job);
    syncRecoveryListeners();
    void runJob(job).catch(() => finish(job, RETRYABLE_NULL));
    return job;
}

/**
 * The file as a `data:` URL for an `<img>` (never a Blob: see the top of this
 * file), and whether a null is worth asking again for. Concurrent callers of
 * one id share one job. Pass `signal` and abort it when the answer is no
 * longer wanted (the component went away): once every caller with a signal
 * has, and none came without one, the job stops trying.
 */
export function loadFileUrl(fileId: string, opts: { signal?: AbortSignal } = {}): Promise<FileUrlOutcome> {
    const hit = cache.get(fileId);
    if (hit) return Promise.resolve({ url: hit, retryable: false });
    // Signed out: no request, and nothing to ask again for.
    if (!getToken()) return Promise.resolve(FINAL_NULL);
    const job = inflight.get(fileId) ?? startJob(fileId);
    join(job, opts.signal);
    return job.promise;
}

/**
 * Fetch a file with the caller's credentials and return a `data:` URL for an
 * `<img>`, or null when it cannot be had (unauthenticated, deleted, or still
 * failing after the retries above). Callers render their fallback on null
 * rather than a broken image.
 */
export function fetchFileUrl(fileId: string): Promise<string | null> {
    return loadFileUrl(fileId).then((o) => o.url);
}

function onRecoveryEvent(e: Event): void {
    if (e.type === 'visibilitychange' && document.visibilityState !== 'visible') return;
    recoverySeq++;
    for (const job of [...inflight.values()]) {
        if (job.phase === 'sleeping' && job.wakeable) job.wake?.();
    }
    for (const set of [...chances.values()]) for (const cb of [...set]) cb();
}

/** The listeners are on only while something can use them: a job running, or
 *  a component waiting for a chance. */
function syncRecoveryListeners(): void {
    const want = inflight.size > 0 || chanceCount > 0;
    if (want === listening || typeof window === 'undefined') return;
    listening = want;
    if (want) {
        window.addEventListener('online', onRecoveryEvent);
        window.addEventListener('wsConnected', onRecoveryEvent);
        document.addEventListener('visibilitychange', onRecoveryEvent);
    } else {
        window.removeEventListener('online', onRecoveryEvent);
        window.removeEventListener('wsConnected', onRecoveryEvent);
        document.removeEventListener('visibilitychange', onRecoveryEvent);
    }
}

/**
 * Call `cb` at the next chance this file might be had after a job for it gave
 * up (loadFileUrl's `retryable`): the browser back online, the page shown
 * again, the socket connected again, or another caller having loaded it.
 * Every such event calls it once; the returned function stops it. The caller
 * asks again (loadFileUrl) from `cb`, which joins one job per id.
 */
export function onFileRecoveryChance(fileId: string, cb: () => void): () => void {
    let set = chances.get(fileId);
    if (!set) { set = new Set(); chances.set(fileId, set); }
    // One entry per subscription, even for the same function.
    const entry = () => cb();
    set.add(entry);
    chanceCount++;
    syncRecoveryListeners();
    let on = true;
    return () => {
        if (!on) return;
        on = false;
        const s = chances.get(fileId);
        if (s?.delete(entry)) {
            chanceCount--;
            if (s.size === 0) chances.delete(fileId);
        }
        syncRecoveryListeners();
    };
}

/**
 * A file for a one-off `<audio>` (a sound's preview): a blob: URL, because
 * `media-src` allows no `data:` on Android or the web. Not cached: call
 * `release()` once it has played (or failed), so its Blob is not kept for the
 * session (see the top of this file). Null when it cannot be had. One
 * attempt, outside the queue: it answers a press, and a sound that played a
 * minute after it would be worse than "Could not load that clip" and a
 * second press.
 */
export async function fetchFileObjectUrl(fileId: string): Promise<{ url: string; release: () => void } | null> {
    try {
        const f = await getFile(fileId);
        if (f.kind !== 'ok') return null;
        const url = URL.createObjectURL(new Blob([f.bytes], { type: f.type }));
        let held = true;
        return { url, release: () => { if (held) { held = false; URL.revokeObjectURL(url); } } };
    } catch {
        return null;
    }
}

/**
 * Forget every cached URL. MUST run on logout: the next account signing in
 * on the same running app must not inherit the previous one's media. Every
 * job ends now (null, not worth asking again for), a request already out
 * lands nowhere, and nothing queued goes out.
 */
export function clearFileCache(): void {
    cache.clear();
    cachedChars = 0;
    for (const job of [...inflight.values()]) finish(job, FINAL_NULL);
    inflight.clear();
    fileLimiter.clear();
    syncRecoveryListeners();
}
