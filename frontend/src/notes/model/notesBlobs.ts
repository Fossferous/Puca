/**
 * Púca Notes — pictures and files waiting on this device for a connection.
 *
 * A photo taken with no signal is encrypted THE MOMENT IT IS TAKEN
 * (api/noteMedia.ts `sealNoteMedia`), and only the ciphertext is kept here,
 * in store `'m'` of the same per-account database as the query cache and the
 * offline queue (notesCache.ts). Each record — the ciphertext, the key that
 * opens it, its name and its real type — is itself sealed with the account's
 * seed (api/e2ee.ts `sealLocal`), exactly as the queue is: a copied database
 * file reads as noise, and the sign-out scrub deletes the whole database
 * (api/notesCacheScrub.ts), so nothing here outlives the account on this
 * browser.
 *
 * THE KEY IS IN THE RECORD, which is the reason the outer seal is not
 * optional: ciphertext plus its key is the plaintext. Never write one of
 * these anywhere else — not plain IndexedDB, not @capacitor/filesystem, not
 * the Cache API.
 *
 * A HARD CAP, because the device is not a server. Parking stops at
 * MAX_PARKED_MEDIA_BYTES — or sooner, when `navigator.storage.estimate()`
 * says the ORIGIN has less room than that, which an Android WebView's quota
 * may well have — and says so rather than filling the disk, and the browser
 * may evict the origin's storage anyway (`requestPersistentStorage` is a
 * request, not a promise) — docs/NOTES.md says all of it plainly.
 *
 * ORPHANS. Bytes are only worth keeping while an op names them: the outbox
 * deletes a dropped op's records, and `sweep` at load removes anything no
 * queued op names, so one bad afternoon cannot leave tens of MiB behind.
 *
 * ...EXCEPT WHAT WAS JUST PARKED. Parking and queueing the op that names it
 * are two steps, and the queue's own load (which is what sweeps) can fall
 * between them — a sweep with no grace would delete the photo a user took a
 * moment ago, before its op existed. So a record parked within
 * PARK_GRACE_MS is kept whatever the queue says; a leftover survives at most
 * one load longer, and a live photo survives.
 */
import { currentUserIdFromToken } from '../../api/auth';
import { getActiveIdentity, openLocal, sealLocal, seedMatchesCurrentAccount, type Identity } from '../../api/e2ee';
import { type SealedMedia } from '../../api/noteMedia';
import { revokeParkedPreviews, setParkedReader } from '../../api/parkedPreview';
import { idbStore, type KV } from './notesCache';

/** How much sealed media may wait on this device at once. */
export const MAX_PARKED_MEDIA_BYTES = 64 * 1024 * 1024;

/** How long a just-parked record is kept even if no op names it yet. */
export const PARK_GRACE_MS = 60_000;

/** The record holding the byte total, so the banner does not have to open
 *  (and hold in memory) every parked picture to count them. */
const INDEX = 'index';
const RECORD = (id: string) => `b:${id}`;

interface ParkedIndex {
    /** parked id -> its ciphertext size and when it was parked. */
    items: Record<string, { bytes: number; at: number }>;
}

const EMPTY: ParkedIndex = { items: {} };

export class ParkedMediaFullError extends Error {
    constructor() {
        super('There is no more room on this device for pictures waiting to be sent. Connect to send what is waiting, or remove a picture that has not synced.');
        this.name = 'ParkedMediaFullError';
    }
}

export interface ParkedStoreDeps {
    sub: () => number | null;
    identity: () => Identity | null;
    store: (sub: number) => KV | null;
}

export interface ParkedStore {
    /** Seal and keep these records; throws ParkedMediaFullError over the cap
     *  (and keeps NOTHING of this call, so a note never gets half its
     *  pictures). */
    park(records: SealedMedia[]): Promise<void>;
    /** The records for these ids, in the order asked; a missing one is
     *  skipped (it was swept, or the database was cleared). */
    read(ids: string[]): Promise<SealedMedia[]>;
    remove(ids: string[]): Promise<void>;
    /** Delete everything `keep` does not name, except what was parked within
     *  `graceMs` (see the header). */
    sweep(keep: ReadonlySet<string>, graceMs?: number, now?: number): Promise<void>;
    /** Bytes waiting, and how many items. */
    waiting(): Promise<{ bytes: number; items: number }>;
}

/**
 * Does the ORIGIN have room for this much more? MAX_PARKED_MEDIA_BYTES is
 * our own limit; the browser has its own, and on a WebView it can be the
 * smaller of the two. Asking first turns a quota failure part-way through a
 * park — which the user reads as “Couldn’t add the picture”, as though the
 * picture were at fault — into the honest refusal that says what to do.
 *
 * True whenever the browser will not say (the API is absent, or it answers
 * without numbers): a guess must never refuse a picture the device could
 * hold. The sealed record is bigger than the ciphertext in it, so the
 * headroom asked for is twice what is being added.
 */
async function roomFor(bytes: number): Promise<boolean> {
    try {
        const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
        if (!storage || typeof storage.estimate !== 'function') return true;
        const { quota, usage } = await storage.estimate();
        if (typeof quota !== 'number' || typeof usage !== 'number') return true;
        return quota - usage > bytes * 2;
    } catch {
        return true;
    }
}

export function createParkedStore(deps: ParkedStoreDeps): ParkedStore {
    // Read-modify-write of the index is serialised on this page; two tabs
    // parking at the same instant can each see the other's bytes late, which
    // costs at most one over-cap record, never a lost one.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn, fn);
        chain = next.catch(() => undefined);
        return next;
    };

    const ctx = () => {
        const sub = deps.sub();
        const id = deps.identity();
        if (sub === null || !id) return null;
        const kv = deps.store(sub);
        return kv ? { sub, id, kv } : null;
    };

    const readIndex = async (c: { sub: number; id: Identity; kv: KV }): Promise<ParkedIndex> => {
        const sealed = await c.kv.get(INDEX);
        if (!sealed) return EMPTY;
        const text = await openLocal(c.id, c.sub, `m:${INDEX}`, sealed);
        if (text === null) return EMPTY;
        try {
            const parsed = JSON.parse(text) as ParkedIndex;
            return parsed && typeof parsed.items === 'object' && parsed.items !== null ? { items: parsed.items } : EMPTY;
        } catch {
            return EMPTY;
        }
    };
    const writeIndex = async (c: { sub: number; id: Identity; kv: KV }, ix: ParkedIndex) => {
        await c.kv.put(INDEX, await sealLocal(c.id, c.sub, `m:${INDEX}`, JSON.stringify(ix)));
    };

    return {
        park(records) {
            if (records.length === 0) return Promise.resolve();
            return serial(async () => {
                const c = ctx();
                if (!c) throw new Error('Not signed in: nothing to keep this under');
                const ix = await readIndex(c);
                const have = Object.values(ix.items).reduce((n, v) => n + v.bytes, 0);
                const adding = records.reduce((n, r) => n + r.bytes, 0);
                if (have + adding > MAX_PARKED_MEDIA_BYTES) throw new ParkedMediaFullError();
                if (!await roomFor(adding)) throw new ParkedMediaFullError();
                // The INDEX first, so a record is never on disk without a
                // parked-at time: a sweep racing this would otherwise see a
                // record it cannot date and delete a picture just taken.
                const at = Date.now();
                const items = { ...ix.items };
                for (const rec of records) items[rec.id] = { bytes: rec.bytes, at };
                await writeIndex(c, { items });
                const written: string[] = [];
                try {
                    for (const rec of records) {
                        await c.kv.put(RECORD(rec.id), await sealLocal(c.id, c.sub, `m:${rec.id}`, JSON.stringify(rec)));
                        written.push(rec.id);
                    }
                } catch (err) {
                    // Out of quota part-way: leave nothing half-parked, and
                    // give the reserved bytes back.
                    for (const id of written) await c.kv.del(RECORD(id)).catch(() => undefined);
                    await writeIndex(c, ix).catch(() => undefined);
                    throw err;
                }
            });
        },

        async read(ids) {
            const c = ctx();
            if (!c) return [];
            const out: SealedMedia[] = [];
            for (const id of ids) {
                const sealed = await c.kv.get(RECORD(id));
                if (!sealed) continue;
                const text = await openLocal(c.id, c.sub, `m:${id}`, sealed);
                if (text === null) continue;
                try {
                    out.push(JSON.parse(text) as SealedMedia);
                } catch { /* unreadable: treat as gone */ }
            }
            return out;
        },

        remove(ids) {
            if (ids.length === 0) return Promise.resolve();
            revokeParkedPreviews(ids);
            return serial(async () => {
                const c = ctx();
                if (!c) return;
                for (const id of ids) await c.kv.del(RECORD(id)).catch(() => undefined);
                const ix = await readIndex(c);
                const items = { ...ix.items };
                for (const id of ids) delete items[id];
                await writeIndex(c, { items });
            });
        },

        sweep(keep, graceMs = PARK_GRACE_MS, now = Date.now()) {
            return serial(async () => {
                const c = ctx();
                if (!c) return;
                // The STORE is the truth, not the index: a record written by a
                // page that died is an orphan even if the index forgot it.
                const rows = await c.kv.all();
                const ix = await readIndex(c);
                const items: ParkedIndex['items'] = {};
                const seen = new Set<string>();
                for (const [key, value] of rows) {
                    if (key === INDEX) continue;
                    if (!key.startsWith('b:')) continue;
                    const id = key.slice(2);
                    seen.add(id);
                    const entry = ix.items[id];
                    const fresh = entry !== undefined && now - entry.at < graceMs;
                    // A kept record whose index entry is gone is re-indexed
                    // from what is ON DISK. Recorded as 0 it would occupy the
                    // device and count nothing, and enough of them would stop
                    // the cap biting at all; the sealed string is longer than
                    // the ciphertext in it, so this errs toward refusing
                    // sooner, never toward filling the disk.
                    if (keep.has(id) || fresh) items[id] = entry ?? { bytes: value.length, at: now };
                    else await c.kv.del(key).catch(() => undefined);
                }
                // An index entry whose record never landed (a park that died
                // between the two writes) keeps its reservation only while it
                // is fresh, so the cap cannot be leaked away.
                for (const [id, entry] of Object.entries(ix.items)) {
                    if (seen.has(id)) continue;
                    if (now - entry.at < graceMs) items[id] = entry;
                }
                await writeIndex(c, { items });
            });
        },

        async waiting() {
            const c = ctx();
            if (!c) return { bytes: 0, items: 0 };
            const ix = await readIndex(c);
            const values = Object.values(ix.items);
            return { bytes: values.reduce((n, v) => n + v.bytes, 0), items: values.length };
        },
    };
}

export const appParkedStore: ParkedStore = createParkedStore({
    sub: currentUserIdFromToken,
    identity: () => (seedMatchesCurrentAccount() ? getActiveIdentity() : null),
    store: sub => idbStore(sub, 'm'),
});

// The shared picture components show a parked picture through this
// (api/parkedPreview.ts); registering here keeps the store out of Púca's
// Tasks view, which has no offline queue and no parked bytes.
setParkedReader(async id => {
    const [rec] = await appParkedStore.read([id]);
    return rec ? { data: rec.data, key: rec.key, mime: rec.mime } : null;
});
