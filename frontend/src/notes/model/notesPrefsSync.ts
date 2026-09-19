/**
 * Púca Notes — colour, labels and archive follow the account.
 *
 * The UI reads a synchronous snapshot (notesPrefs.ts, localStorage-backed).
 * This module keeps that snapshot in step with ONE sealed-to-self document on
 * the server (`GET/PUT /sealed-blobs/notes-prefs`, api/sealedBlobs.ts), sealed
 * with its own key and AAD (api/e2ee.ts sealAccountBlob). The server stores
 * ciphertext and a revision; it never sees a colour, a label or which notes
 * are archived.
 *
 * THE MERGE RULES, which are the whole of the correctness here:
 *
 *  - A local copy that has NEVER synced (made before this existed, or while
 *    the backend had no route) is merged into the server's ONCE: labels are
 *    unioned per note, the server's colour wins, archive flags are unioned.
 *    That migrates existing users without losing what only this browser had.
 *  - After that the SERVER WINS for everything this device did not change.
 *    The last synced document (`base`) is kept beside the local copy, and a
 *    merge is three-way per note: a field this device changed since `base`
 *    keeps the local value (labels by added/removed set), anything else takes
 *    the server's. Unioning on every load instead would resurrect a label
 *    removed, or a note unarchived, on another device.
 *  - A write names the revision it was built on; a 409 hands back the newer
 *    document, the local changes are replayed onto it the same three-way way,
 *    and the write is retried. Because `base` is persisted, changes made
 *    offline survive a reload and replay the same way.
 *
 * DEFENCES. The plaintext carries its own revision, which must equal the
 * server's; and the highest revision seen is remembered, so a server serving
 * an OLDER document (a rollback) is refused rather than applied. That record
 * is scrubbed at sign-out with the rest of Notes' per-account state, so the
 * rollback check starts fresh on each sign-in (docs/SECURITY_MODEL.md). A
 * refused rollback is not a dead end: after a restored backup the user
 * chooses the server's copy (acceptServer) or this device's
 * (overwriteServer), and either restarts the floor at the server's revision.
 *
 * NOT SYNCED: grid/list and sort are per device, on purpose.
 *
 * FAILURE IS LOUD, DATA IS KEPT. Too large, unreadable, a refused rollback:
 * each is a status the shell shows, and the local copy is never dropped.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { currentUserIdFromToken } from '../../api/auth';
import { getActiveIdentity, openAccountBlob, sealAccountBlob, type Identity } from '../../api/e2ee';
import { isNetworkError } from '../../api/client';
import { getSealedBlob, putSealedBlob, type GetBlobResult, type PutBlobResult } from '../../api/sealedBlobs';
import { writeNotesUnsynced } from '../../api/notesCacheScrub';
import { MAX_LABELS_PER_NOTE, type NotesNoteState } from './notesModel';
import { dedupeLabels, getNotesPrefs, parseNotesPrefs, replaceNoteState, subscribeNotesPrefs } from './notesPrefs';

export const PREFS_BLOB_NAME = 'notes-prefs' as const;
const RECORD_PREFIX = 'pucaNotesPrefsSync';
const MAX_ATTEMPTS = 4;
export const PUSH_DEBOUNCE_MS = 500;

export const EMPTY_NOTE_STATE: NotesNoteState = Object.freeze({ colors: {}, labels: {}, archived: {} }) as NotesNoteState;

// --- Pure: shape, compare, merge ---------------------------------------------------

export function noteStateOf(p: NotesNoteState): NotesNoteState {
    return { colors: p.colors, labels: p.labels, archived: p.archived };
}

function canon(s: NotesNoteState): string {
    const sortObj = <T,>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
    return JSON.stringify({ c: sortObj(s.colors), l: sortObj(s.labels), a: sortObj(s.archived) });
}

export function sameNoteState(a: NotesNoteState, b: NotesNoteState): boolean {
    return canon(a) === canon(b);
}

/** The document inside the envelope. */
export function encodePrefsDoc(rev: number, state: NotesNoteState): string {
    return JSON.stringify({ v: 1, rev, prefs: noteStateOf(state) });
}

/** Parse an opened document; null for anything else. Every field is
 *  re-validated through parseNotesPrefs (a malformed entry is dropped, never
 *  trusted). */
export function decodePrefsDoc(text: string): { rev: number; state: NotesNoteState } | null {
    let o: unknown;
    try { o = JSON.parse(text); } catch { return null; }
    if (typeof o !== 'object' || o === null) return null;
    const d = o as { v?: unknown; rev?: unknown; prefs?: unknown };
    if (d.v !== 1 || typeof d.rev !== 'number' || !Number.isSafeInteger(d.rev) || d.rev < 1) return null;
    if (typeof d.prefs !== 'object' || d.prefs === null) return null;
    return { rev: d.rev, state: noteStateOf(parseNotesPrefs(JSON.stringify(d.prefs))) };
}

const lower = (l: string) => l.toLocaleLowerCase();

/** The ONE-TIME merge of a never-synced local copy into the server's. */
export function unionMerge(local: NotesNoteState, server: NotesNoteState): NotesNoteState {
    const colors = { ...local.colors, ...server.colors };
    const labels: Record<string, string[]> = {};
    for (const k of new Set([...Object.keys(local.labels), ...Object.keys(server.labels)])) {
        const merged = dedupeLabels([...(server.labels[k] ?? []), ...(local.labels[k] ?? [])]);
        if (merged.length > 0) labels[k] = merged;
    }
    const archived = { ...local.archived, ...server.archived };
    return { colors, labels, archived };
}

/** Three-way, per note and field: what this device changed since `base`
 *  wins; everything else is the server's. */
export function threeWayMerge(base: NotesNoteState, local: NotesNoteState, server: NotesNoteState): NotesNoteState {
    const scalar = <T,>(b: Record<string, T>, l: Record<string, T>, s: Record<string, T>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const k of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(s)])) {
            const v = l[k] !== b[k] ? l[k] : s[k];
            if (v !== undefined) out[k] = v;
        }
        return out;
    };
    const labels: Record<string, string[]> = {};
    for (const k of new Set([...Object.keys(base.labels), ...Object.keys(local.labels), ...Object.keys(server.labels)])) {
        const b = new Set((base.labels[k] ?? []).map(lower));
        const l = local.labels[k] ?? [];
        const lSet = new Set(l.map(lower));
        const removed = new Set([...b].filter(x => !lSet.has(x)));
        const added = l.filter(x => !b.has(lower(x)));
        const kept = (server.labels[k] ?? []).filter(x => !removed.has(lower(x)));
        const merged = dedupeLabels([...kept, ...added]).slice(0, MAX_LABELS_PER_NOTE);
        if (merged.length > 0) labels[k] = merged;
    }
    return {
        colors: scalar(base.colors, local.colors, server.colors),
        labels,
        archived: scalar(base.archived, local.archived, server.archived),
    };
}

// --- The per-account sync record ------------------------------------------------------

export interface SyncRecord {
    /** The server revision `base` is. 0 = nothing on the server yet. */
    rev: number;
    /** The last document this device synced (null = never synced). */
    base: NotesNoteState | null;
    /** Highest revision ever seen for this account on this device. */
    maxRev: number;
}

function recordKey(uid: number): string {
    return `${RECORD_PREFIX}:${uid}`;
}

export const localRecordStore = {
    load(uid: number): SyncRecord | null {
        try {
            const raw = localStorage.getItem(recordKey(uid));
            if (!raw) return null;
            const o = JSON.parse(raw) as { rev?: unknown; base?: unknown; maxRev?: unknown };
            if (typeof o.rev !== 'number' || typeof o.maxRev !== 'number') return null;
            const base = o.base === null || o.base === undefined ? null : noteStateOf(parseNotesPrefs(JSON.stringify(o.base)));
            return { rev: o.rev, base, maxRev: o.maxRev };
        } catch {
            return null;
        }
    },
    save(uid: number, r: SyncRecord): void {
        try { localStorage.setItem(recordKey(uid), JSON.stringify(r)); } catch { /* private mode: in-memory next time */ }
    },
};

// --- The engine --------------------------------------------------------------------------

export type PrefsSyncStatus =
    | 'idle'          // signed out / not started
    | 'locked'        // no identity to seal with (yet)
    | 'local-only'    // the backend has no /sealed-blobs route: device-local, as before
    | 'synced'
    | 'offline'       // a network failure; retried on focus / online
    | 'too-large'     // the sealed document exceeds the server's cap; kept here
    | 'unreadable'    // the server's document cannot be opened by this identity
    | 'rollback'      // the server offered an older revision than already seen
    | 'error';

export interface PrefsSyncDeps {
    uid: () => number | null;
    identity: () => Identity | null;
    get: () => Promise<GetBlobResult>;
    put: (expectedRev: number, blob: string) => Promise<PutBlobResult>;
    readLocal: () => NotesNoteState;
    writeLocal: (s: NotesNoteState) => void;
    records: { load(uid: number): SyncRecord | null; save(uid: number, r: SyncRecord): void };
}

export interface PrefsSync {
    pull(): Promise<PrefsSyncStatus>;
    push(): Promise<PrefsSyncStatus>;
    /** Replace the server's document (unreadable, or an older revision than
     *  this device has seen) with this device's copy. A user action. */
    overwriteServer(): Promise<PrefsSyncStatus>;
    /** Take the server's document as it is (a refused rollback: the operator
     *  restored a backup) — this device's copy is replaced by it. A user
     *  action. */
    acceptServer(): Promise<PrefsSyncStatus>;
    /** Whether this device holds colours, labels or archive flags the
     *  account's document does not (a sign-out would lose them). */
    unsynced(): boolean;
    status(): PrefsSyncStatus;
    subscribe(cb: () => void): () => void;
    /** Called after EVERY operation settles, whether or not the status
     *  changed ('synced' -> 'synced' still moves `base`, which is what
     *  unsynced() compares against). */
    subscribeSettled(cb: () => void): () => void;
}

export function createPrefsSync(deps: PrefsSyncDeps): PrefsSync {
    let current: PrefsSyncStatus = 'idle';
    const listeners = new Set<() => void>();
    const settledListeners = new Set<() => void>();
    const set = (s: PrefsSyncStatus): PrefsSyncStatus => {
        if (s !== current) { current = s; for (const cb of listeners) cb(); }
        return s;
    };
    // One operation at a time: a pull and a push interleaving would each
    // write a record built on the other's stale view.
    let chain: Promise<unknown> = Promise.resolve();
    const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn, fn);
        chain = next.catch(() => undefined);
        return next;
    };
    const fail = (err: unknown): PrefsSyncStatus => {
        if (isNetworkError(err)) return set('offline');
        console.warn('[notes] syncing colours and labels failed:', err);
        return set('error');
    };

    /** Open a server document and check it is a real, current one. */
    const open = async (id: Identity, uid: number, rev: number, blob: string | null, rec: SyncRecord | null) => {
        if (blob === null) return { bad: 'unreadable' as const };
        const text = await openAccountBlob(id, uid, PREFS_BLOB_NAME, blob);
        const doc = text === null ? null : decodePrefsDoc(text);
        if (!doc || doc.rev !== rev) return { bad: 'unreadable' as const };
        if (rec && rev < rec.maxRev) return { bad: 'rollback' as const };
        return { state: doc.state };
    };

    const pushOnce = async (uid: number, id: Identity): Promise<PrefsSyncStatus> => {
        let rec = deps.records.load(uid);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            if (!rec || rec.base === null) return pullOnce(uid, id);
            const local = deps.readLocal();
            if (sameNoteState(local, rec.base)) return set('synced');
            const sealed = await sealAccountBlob(id, uid, PREFS_BLOB_NAME, encodePrefsDoc(rec.rev + 1, local));
            const res = await deps.put(rec.rev, sealed);
            if (res.kind === 'unsupported') return set('local-only');
            if (res.kind === 'too-large') return set('too-large');
            if (res.kind === 'written') {
                deps.records.save(uid, { rev: res.rev, base: noteStateOf(local), maxRev: Math.max(rec.maxRev, res.rev) });
                return set('synced');
            }
            // Conflict: somebody else wrote first.
            const cur = res.current;
            if (cur.rev === 0) {
                // The server has no document at all (restored, cleaned): this
                // device's copy is all there is — upload it whole.
                rec = { rev: 0, base: EMPTY_NOTE_STATE, maxRev: rec.maxRev };
                deps.records.save(uid, rec);
                continue;
            }
            const opened = await open(id, uid, cur.rev, cur.blob, rec);
            if ('bad' in opened) return set(opened.bad!);
            // Re-read: `local` was taken before three awaits (seal, PUT,
            // open), and an edit made during that round trip must be merged,
            // not written over.
            const live = deps.readLocal();
            const merged = threeWayMerge(rec.base, live, opened.state);
            if (!sameNoteState(merged, live)) deps.writeLocal(merged);
            rec = { rev: cur.rev, base: opened.state, maxRev: Math.max(rec.maxRev, cur.rev) };
            deps.records.save(uid, rec);
        }
        return set('error');
    };

    const pullOnce = async (uid: number, id: Identity): Promise<PrefsSyncStatus> => {
        const res = await deps.get();
        if (res.kind === 'unsupported') return set('local-only');
        const rec = deps.records.load(uid);
        const { rev, blob } = res.doc;
        if (rev === 0) {
            // Nothing on the server: this device's copy (never synced, or one
            // the server lost) goes up as revision 1.
            deps.records.save(uid, { rev: 0, base: EMPTY_NOTE_STATE, maxRev: rec?.maxRev ?? 0 });
            return pushOnce(uid, id);
        }
        const opened = await open(id, uid, rev, blob, rec);
        if ('bad' in opened) return set(opened.bad!);
        const local = deps.readLocal();
        const merged = rec === null || rec.base === null
            ? unionMerge(local, opened.state)          // the one-time migration
            : threeWayMerge(rec.base, local, opened.state);
        if (!sameNoteState(merged, local)) deps.writeLocal(merged);
        deps.records.save(uid, { rev, base: opened.state, maxRev: Math.max(rec?.maxRev ?? 0, rev) });
        return sameNoteState(merged, opened.state) ? set('synced') : pushOnce(uid, id);
    };

    const guarded = (fn: (uid: number, id: Identity) => Promise<PrefsSyncStatus>) => serial(async () => {
        const uid = deps.uid();
        if (uid === null) return set('idle');
        const id = deps.identity();
        if (!id) return set('locked');
        try {
            return await fn(uid, id);
        } catch (err) {
            return fail(err);
        } finally {
            for (const cb of settledListeners) cb();
        }
    });

    return {
        pull: () => guarded(pullOnce),
        push: () => guarded(pushOnce),
        overwriteServer: () => guarded(async (uid, id) => {
            const res = await deps.get();
            if (res.kind === 'unsupported') return set('local-only');
            // Adopt the server's revision with an EMPTY base, so the whole
            // local copy counts as this device's change and goes up as is.
            // maxRev restarts at the server's revision: the user has chosen
            // this lineage, and keeping a higher one would refuse this very
            // write's successor as a rollback forever.
            deps.records.save(uid, { rev: res.doc.rev, base: EMPTY_NOTE_STATE, maxRev: res.doc.rev });
            return pushOnce(uid, id);
        }),
        acceptServer: () => guarded(async (uid, id) => {
            const res = await deps.get();
            if (res.kind === 'unsupported') return set('local-only');
            const { rev, blob } = res.doc;
            if (rev === 0) {
                // Nothing there at all: there is no "server's copy" to take.
                deps.records.save(uid, { rev: 0, base: EMPTY_NOTE_STATE, maxRev: 0 });
                return pushOnce(uid, id);
            }
            // Opened WITHOUT the rollback check (that is the point), but it
            // must still be a real, current document for this account.
            const opened = await open(id, uid, rev, blob, null);
            if ('bad' in opened) return set(opened.bad!);
            deps.writeLocal(opened.state);
            deps.records.save(uid, { rev, base: opened.state, maxRev: rev });
            return set('synced');
        }),
        unsynced: () => {
            const uid = deps.uid();
            if (uid === null) return false;
            const local = deps.readLocal();
            const rec = deps.records.load(uid);
            if (sameNoteState(local, EMPTY_NOTE_STATE)) {
                // Nothing held here — unless the last synced copy held
                // something: clearing the last colour or label offline is a
                // change too, and a sign-out would lose it (the old ones
                // come back at the next sign-in).
                return !!rec && rec.base !== null && !sameNoteState(rec.base, EMPTY_NOTE_STATE);
            }
            if (current === 'unreadable' || current === 'rollback' || current === 'local-only') return true;
            return !rec || rec.base === null || !sameNoteState(local, rec.base);
        },
        status: () => current,
        subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        subscribeSettled: cb => { settledListeners.add(cb); return () => { settledListeners.delete(cb); }; },
    };
}

// --- The app's instance + the hook the shell mounts ---------------------------------------

const appSync = createPrefsSync({
    uid: currentUserIdFromToken,
    identity: getActiveIdentity,
    get: () => getSealedBlob(PREFS_BLOB_NAME),
    put: (rev, blob) => putSealedBlob(PREFS_BLOB_NAME, rev, blob),
    readLocal: () => noteStateOf(getNotesPrefs()),
    writeLocal: replaceNoteState,
    records: localRecordStore,
});

/** Re-read the server's copy now (a live `blob` event, a manual refresh). */
export function pullNotesPrefs(): void {
    void appSync.pull();
}

/** Replace the server's copy with this device's (a user action). */
export function overwriteServerNotesPrefs(): void {
    void appSync.overwriteServer();
}

/** Take the server's copy as it is (a user action after a refused rollback). */
export function acceptServerNotesPrefs(): void {
    void appSync.acceptServer();
}

/** Colours, labels or archive flags on this device that the account's
 *  document does not hold. A sign-out deletes the local copy, so the sign-out
 *  confirm asks about these (NotesApp.tsx). */
export function prefsUnsynced(): boolean {
    return appSync.unsynced();
}

/**
 * Keep Púca's view of "what a Notes sign-out would lose" current
 * (api/notesCacheScrub.ts): republished on every local write and after every
 * sync operation — a push that lands leaves the status at 'synced' as it
 * was, so the status alone cannot say the flag is stale.
 */
export function useNotesUnsyncedFlag(outboxPending: number): void {
    useEffect(() => {
        const publish = () => {
            const uid = currentUserIdFromToken();
            if (uid !== null) writeNotesUnsynced(uid, { ops: outboxPending, prefs: appSync.unsynced() });
        };
        publish();
        const offSettled = appSync.subscribeSettled(publish);
        const offLocal = subscribeNotesPrefs(publish);
        return () => { offSettled(); offLocal(); };
    }, [outboxPending]);
}

/**
 * Push what is pending now, bounded: a sign-out's last chance to save it.
 * Resolves with whether anything is STILL unsynced afterwards.
 */
export async function flushNotesPrefs(timeoutMs = 3000): Promise<boolean> {
    if (!appSync.unsynced()) return false;
    await Promise.race([appSync.push(), new Promise(r => setTimeout(r, timeoutMs))]);
    return appSync.unsynced();
}

/**
 * Keep the shared copy in step while the shell is up: pull on mount, on focus
 * and when the account changes; push (debounced) after every local write and
 * when the connection comes back. Returns the status for the shell to show.
 */
export function useNotesPrefsSync(): PrefsSyncStatus {
    const status = useSyncExternalStore(appSync.subscribe, appSync.status, appSync.status);
    useEffect(() => {
        void appSync.pull();
        let timer: number | undefined;
        const schedule = () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(() => { void appSync.push(); }, PUSH_DEBOUNCE_MS);
        };
        const unsub = subscribeNotesPrefs(schedule);
        const onFocus = () => { void appSync.pull(); };
        const onOnline = () => { void appSync.push(); };
        window.addEventListener('focus', onFocus);
        window.addEventListener('online', onOnline);
        return () => {
            unsub();
            window.clearTimeout(timer);
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('online', onOnline);
        };
    }, []);
    return status;
}
