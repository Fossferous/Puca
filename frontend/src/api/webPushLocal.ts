/**
 * The web app's push state on THIS browser, as a leaf: no app imports, so
 * Púca Notes' sign-out can drop it too without pulling Púca in
 * (api/webPush.ts is the rest of the feature).
 *
 * TWO pieces of state, deliberately apart:
 *  - the OPT-IN, kept PER ACCOUNT (by user id) in localStorage. A per-browser
 *    switch carried one person's "notify me" to whoever signed in next on a
 *    shared browser, whose names then reached the lock screen without them
 *    ever tapping it. Now each account opts in for itself, and the server
 *    refuses to move a browser's push address to another account without
 *    that account's tap (`takeover`, push_web_handlers.rs).
 *  - what the service worker reads (public/sw.js): the API address, the
 *    subscription id and its secret, in IndexedDB.
 */

export const PUSH_DB = 'puca-push';
export const PUSH_STORE = 'cfg';
export const PUSH_KEY = 'subscription';
export const SW_SCOPE = '/';
const OPT_IN_KEY = 'puca_web_push_opt_in';
/** Fired on window when an account's opt-in changes (Settings re-reads it). */
export const OPT_IN_EVENT = 'webPushOptInChanged';

/** What the worker needs, in IndexedDB. `endpoint` and `key` let a later
 *  start notice that the browser's subscription or the server's key changed. */
export interface WorkerConfig {
    api: string;
    id: number;
    secret: string;
    endpoint: string;
    key: string;
}

function readOptIns(): number[] {
    try {
        const raw = localStorage.getItem(OPT_IN_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((n): n is number => Number.isSafeInteger(n)) : [];
    } catch {
        return [];
    }
}

/** Has account `uid` turned on notifications on this browser? */
export function webPushOptedIn(uid: number | null): boolean {
    return uid !== null && readOptIns().includes(uid);
}

export function setWebPushOptIn(uid: number | null, on: boolean): void {
    if (uid === null) return;
    const now = readOptIns().filter((n) => n !== uid);
    if (on) now.push(uid);
    try {
        localStorage.setItem(OPT_IN_KEY, JSON.stringify(now));
    } catch { /* storage off: the switch simply does not stick */ }
    try {
        window.dispatchEvent(new CustomEvent(OPT_IN_EVENT));
    } catch { /* no DOM */ }
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(PUSH_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(PUSH_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

export async function readWorkerConfig(): Promise<WorkerConfig | null> {
    try {
        const db = await openDb();
        try {
            return await new Promise((resolve) => {
                const get = db.transaction(PUSH_STORE, 'readonly').objectStore(PUSH_STORE).get(PUSH_KEY);
                get.onsuccess = () => resolve((get.result as WorkerConfig | undefined) ?? null);
                get.onerror = () => resolve(null);
            });
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

export async function writeWorkerConfig(cfg: WorkerConfig | null): Promise<void> {
    try {
        const db = await openDb();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(PUSH_STORE, 'readwrite');
                if (cfg) tx.objectStore(PUSH_STORE).put(cfg, PUSH_KEY);
                else tx.objectStore(PUSH_STORE).delete(PUSH_KEY);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    } catch {
        /* a browser with storage off: the worker shows the generic text */
    }
}

/**
 * Make this browser unaddressable: unsubscribe its push subscription and
 * forget the worker's secret. Returns the endpoint it had, for a caller that
 * can still tell the server. Local only, so it works with the session gone.
 */
export async function dropLocalWebPush(): Promise<string | null> {
    let endpoint: string | null = null;
    try {
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
            const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
            const sub = (await reg?.pushManager.getSubscription()) ?? null;
            endpoint = sub?.endpoint ?? null;
            try { await sub?.unsubscribe(); } catch { /* best effort */ }
        }
    } catch { /* no worker: nothing subscribed */ }
    const cfg = await readWorkerConfig();
    await writeWorkerConfig(null);
    return endpoint ?? cfg?.endpoint ?? null;
}

/**
 * An explicit sign-out (Púca's, or Púca Notes' — the same browser): account
 * `uid` is opted out here, and the browser stops being addressable. The
 * server deletes the signed-out session's row itself (/auth/logout-session).
 */
export async function signOutWebPush(uid: number | null): Promise<string | null> {
    setWebPushOptIn(uid, false);
    return dropLocalWebPush();
}
