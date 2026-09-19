/**
 * Which notes have a write of THIS page's in flight or queued — so a refetch
 * (a live event, a focus, a poll) does not land server state over an
 * optimistic edit the server has not seen yet and make it flicker back.
 *
 * Keys are note keys (`list:5`, `channel:9`), plus two for the note-level
 * state: `lists` (create / rename / delete a note) and `prefs` (pins, order).
 *
 * A leaf module on purpose: the outbox marks, the event stream and the query
 * client read, and neither has to import the other.
 */

export const LISTS_KEY = 'lists';
export const PREFS_KEY = 'prefs';

const inFlight = new Map<string, number>();
let queued: ReadonlySet<string> = new Set();
const settledWaiters = new Map<string, Array<() => void>>();

export function isNoteBusy(key: string): boolean {
    return (inFlight.get(key) ?? 0) > 0 || queued.has(key);
}

/** True while anything at all is queued offline (focus/reconnect refetches
 *  wait for the flush, which re-reads everything when it is done). */
export function anythingQueued(): boolean {
    return queued.size > 0;
}

function maybeSettled(key: string): void {
    if (isNoteBusy(key)) return;
    const waiters = settledWaiters.get(key);
    if (!waiters) return;
    settledWaiters.delete(key);
    for (const w of waiters) w();
}

export function beginNoteWrite(key: string): () => void {
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    let done = false;
    return () => {
        if (done) return;
        done = true;
        const n = (inFlight.get(key) ?? 1) - 1;
        if (n <= 0) inFlight.delete(key); else inFlight.set(key, n);
        maybeSettled(key);
    };
}

/** The outbox's current set of notes with queued changes. */
export function setQueuedNotes(keys: Iterable<string>): void {
    const before = queued;
    queued = new Set(keys);
    for (const k of before) if (!queued.has(k)) maybeSettled(k);
}

/** Run `fn` once `key` is no longer busy (now, if it is not). */
export function whenNoteSettled(key: string, fn: () => void): void {
    if (!isNoteBusy(key)) { fn(); return; }
    const list = settledWaiters.get(key) ?? [];
    // One deferred refetch per note is enough, however many events arrived.
    if (list.length === 0) list.push(fn);
    settledWaiters.set(key, list);
}

/** Tests only. */
export function resetNoteBusy(): void {
    inFlight.clear();
    queued = new Set();
    settledWaiters.clear();
}
