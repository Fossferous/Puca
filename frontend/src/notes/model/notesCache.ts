/**
 * Púca Notes — the on-device cache: what Notes last showed, available offline
 * and on a cold start with no network.
 *
 * WHAT IS STORED. Each `notes` query's DECRYPTED result (lists, pins, servers,
 * channels, members, every note's tasks), one IndexedDB record per query,
 * each sealed with AES-GCM under a key derived from the account's own seed
 * with the account id in the salt, and the record's query as AAD
 * (api/e2ee.ts sealLocal). Decrypted, because channel keys live in memory
 * only — cached ciphertext could not be opened offline. Sealed, so a copied
 * database file or a skipped scrub reads as noise without the seed; the same
 * at-rest trust as the seed itself (docs/SECURITY_MODEL.md). A result holding
 * a decrypt-failure marker is never written: a locked moment must not become
 * the offline copy.
 *
 * ONE DATABASE PER ACCOUNT (`pucaNotesCache:<user id>`), deleted at sign-out
 * from either page (api/notesCacheScrub.ts). The offline edit queue lives in
 * the same database (notesOutbox.ts).
 *
 * DEGRADES TO ONLINE-ONLY. No IndexedDB (a private window that refuses it, an
 * old WebView), a read that takes too long, a record that will not open: each
 * is skipped and Notes behaves exactly as it did before this existed.
 */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { currentUserIdFromToken } from '../../api/auth';
import { getActiveIdentity, openLocal, sealLocal, seedMatchesCurrentAccount, type Identity } from '../../api/e2ee';
import { isUndecryptable } from '../../api/decryptMarkers';
import { isAttachmentsLocked, type Task, type TaskList } from '../../api/tasks';
import { notesCacheDbName, registerNotesCacheDb } from '../../api/notesCacheScrub';

// --- A tiny key-value store over IndexedDB (and one in memory, for tests) --------

export interface KV {
    all(): Promise<Array<[string, string]>>;
    get(key: string): Promise<string | undefined>;
    put(key: string, value: string): Promise<void>;
    del(key: string): Promise<void>;
}

export type StoreName = 'q' | 'o';

const dbs = new Map<string, Promise<IDBDatabase>>();

function openDb(name: string): Promise<IDBDatabase> {
    let p = dbs.get(name);
    if (!p) {
        p = new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(name, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('q')) db.createObjectStore('q');
                if (!db.objectStoreNames.contains('o')) db.createObjectStore('o');
            };
            req.onsuccess = () => {
                const db = req.result;
                // A sign-out in another tab deletes this database: let it.
                db.onversionchange = () => { db.close(); dbs.delete(name); };
                resolve(db);
            };
            req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
            req.onblocked = () => reject(new Error('indexedDB.open blocked'));
        });
        dbs.set(name, p);
        p.catch(() => dbs.delete(name));
        registerNotesCacheDb(name);
    }
    return p;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
    });
}

export function idbStore(sub: number, store: StoreName): KV | null {
    if (typeof indexedDB === 'undefined') return null;
    const name = notesCacheDbName(sub);
    const tx = async (mode: IDBTransactionMode) => (await openDb(name)).transaction(store, mode).objectStore(store);
    return {
        async all() {
            const s = await tx('readonly');
            const [keys, values] = await Promise.all([reqP(s.getAllKeys()), reqP(s.getAll())]);
            return keys.map((k, i) => [String(k), String(values[i])] as [string, string]);
        },
        async get(key) {
            const v = await reqP((await tx('readonly')).get(key));
            return v === undefined ? undefined : String(v);
        },
        async put(key, value) { await reqP((await tx('readwrite')).put(value, key)); },
        async del(key) { await reqP((await tx('readwrite')).delete(key)); },
    };
}

export function memoryStore(): KV & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
        map,
        async all() { return [...map.entries()]; },
        async get(k) { return map.get(k); },
        async put(k, v) { map.set(k, v); },
        async del(k) { map.delete(k); },
    };
}

// --- What may be cached ------------------------------------------------------------

/** False for a result that holds a decrypt-failure marker anywhere. */
export function safeToPersist(queryKey: readonly unknown[], data: unknown): boolean {
    if (queryKey[0] !== 'notes' || data === undefined) return false;
    if (queryKey[1] === 'tasks') {
        if (!Array.isArray(data)) return false;
        return (data as Task[]).every(t => !isUndecryptable(t.description) && !(t.attachments && isAttachmentsLocked(t.attachments)));
    }
    if (queryKey[1] === 'lists') {
        if (!Array.isArray(data)) return false;
        return (data as TaskList[]).every(l => !isUndecryptable(l.title));
    }
    return true;
}

const PURPOSE = (hash: string) => `q:${hash}`;

interface CachedQuery {
    k: readonly unknown[];
    d: unknown;
    t: number;
}

/**
 * Put every cached query back into `qc` (before the first render). Bounded:
 * a database that does not answer in `timeoutMs` is skipped, never waited on.
 */
export async function hydrateNotesCache(
    qc: QueryClient,
    deps: { sub: number | null; identity: Identity | null; store: KV | null } = defaultDeps(),
    timeoutMs = 1_500,
): Promise<number> {
    const { sub, identity, store } = deps;
    if (sub === null || !identity || !store) return 0;
    let rows: Array<[string, string]>;
    try {
        rows = await Promise.race([
            store.all(),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('cache read timed out')), timeoutMs)),
        ]);
    } catch {
        return 0;
    }
    let n = 0;
    for (const [hash, sealed] of rows) {
        const text = await openLocal(identity, sub, PURPOSE(hash), sealed);
        if (text === null) continue;
        let c: CachedQuery;
        try { c = JSON.parse(text) as CachedQuery; } catch { continue; }
        if (!Array.isArray(c.k) || c.k[0] !== 'notes' || !safeToPersist(c.k, c.d)) continue;
        // Never over something fresher this page already has.
        if (qc.getQueryData(c.k) !== undefined) continue;
        qc.setQueryData(c.k, c.d, { updatedAt: typeof c.t === 'number' ? c.t : 0 });
        n++;
    }
    return n;
}

function defaultDeps() {
    const sub = currentUserIdFromToken();
    const identity = seedMatchesCurrentAccount() ? getActiveIdentity() : null;
    return { sub, identity, store: sub === null ? null : idbStore(sub, 'q') };
}

/**
 * Keep the store in step with the query cache: every successful `notes`
 * result (fetched or written optimistically) is sealed and written,
 * debounced. Records are NOT deleted when a query leaves memory — a sign-out
 * or an expiry clears the in-memory cache, and that must not wipe the copy
 * the next offline start needs; the sign-out scrub deletes the database.
 * Bound to ONE account: nothing is written once the signed-in account is not
 * the one this was started for. Returns the stop function.
 */
export function startNotesCachePersistence(
    qc: QueryClient,
    deps: { sub: number | null; currentSub: () => number | null; identity: () => Identity | null; store: KV | null } = appPersistDeps(),
    debounceMs = 800,
): () => void {
    const { sub, store } = deps;
    if (sub === null || !store) return () => {};
    const dirty = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const write = async () => {
        timer = null;
        const id = deps.identity();
        if (!id || deps.currentSub() !== sub) { dirty.clear(); return; }
        const hashes = [...dirty];
        dirty.clear();
        for (const hash of hashes) {
            const q = qc.getQueryCache().get(hash);
            try {
                if (!q || q.state.data === undefined) continue;
                if (!safeToPersist(q.queryKey, q.state.data)) continue;   // keep the last good copy
                const body: CachedQuery = { k: q.queryKey, d: q.state.data, t: q.state.dataUpdatedAt };
                await store.put(hash, await sealLocal(id, sub, PURPOSE(hash), JSON.stringify(body)));
            } catch {
                // quota / closed database: online-only for this record
            }
        }
    };
    const unsub = qc.getQueryCache().subscribe(ev => {
        const q = ev.query;
        if (q.queryKey[0] !== 'notes') return;
        if (!(ev.type === 'updated' && ev.action.type === 'success')) return;
        dirty.add(q.queryHash);
        if (!timer) timer = setTimeout(() => { void write(); }, debounceMs);
    });
    return () => {
        unsub();
        if (timer) { clearTimeout(timer); void write(); }
    };
}

function appPersistDeps() {
    const sub = currentUserIdFromToken();
    return {
        sub,
        currentSub: currentUserIdFromToken,
        identity: () => (seedMatchesCurrentAccount() ? getActiveIdentity() : null),
        store: sub === null ? null : idbStore(sub, 'q'),
    };
}

/** Ask the browser not to evict the cache under storage pressure (web only;
 *  a refusal just means eviction stays possible). */
export function requestPersistentStorage(): void {
    try {
        void navigator.storage?.persist?.();
    } catch { /* unsupported */ }
}

/** Mount once in the shell: persist while this account is signed in. */
export function useNotesCachePersistence(): void {
    const qc = useQueryClient();
    useEffect(() => startNotesCachePersistence(qc), [qc]);
}
