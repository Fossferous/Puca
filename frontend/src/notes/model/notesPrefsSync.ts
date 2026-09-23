/**
 * Púca Notes — colour, labels, archive and the reminder times follow the
 * account.
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
 * THE REMINDER TIMES ride in the same document, merged per field the same
 * three-way way. One asymmetry, deliberate: a document with NO `times` at all
 * is a document written by a build that predates the setting (or by one
 * today, since `parseNotesPrefs` in an older build drops what it does not
 * know). Absent therefore means UNKNOWN, never "cleared" — the local times
 * survive it, and the next push puts them back. That is why the document
 * version stays 1: bumping it would only make every shipped build show the
 * unreadable banner.
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
import { registerLogoutCleanup } from '../../api/logoutHooks';
import { getSealedBlob, putSealedBlob, type GetBlobResult, type PutBlobResult } from '../../api/sealedBlobs';
import { writeNotesUnsynced, writeNotesUnsyncedPrefs } from '../../api/notesCacheScrub';
import { DEFAULT_REMINDER_TIMES, REMINDER_TIME_KEYS, isReminderTime, type ReminderTimes } from '../../api/reminderTimes';
import { MAX_LABELS_PER_NOTE, type NotesNoteState } from './notesModel';
import { dedupeLabels, getNotesPrefs, parseNotesPrefs, replaceNoteState, subscribeNotesPrefs } from './notesPrefs';

export const PREFS_BLOB_NAME = 'notes-prefs' as const;
const RECORD_PREFIX = 'pucaNotesPrefsSync';
const MAX_ATTEMPTS = 4;
export const PUSH_DEBOUNCE_MS = 500;

export const EMPTY_NOTE_STATE: NotesNoteState = Object.freeze({ colors: {}, labels: {}, archived: {} }) as NotesNoteState;

// --- Pure: shape, compare, merge ---------------------------------------------------

export function noteStateOf(p: NotesNoteState): NotesNoteState {
    const out: NotesNoteState = { colors: p.colors, labels: p.labels, archived: p.archived };
    if (p.times) out.times = p.times;
    return out;
}

function canon(s: NotesNoteState): string {
    const sortObj = <T,>(o: Record<string, T>) => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
    // Absent times compare EQUAL to the defaults: a document that predates
    // the setting is not a difference worth pushing, while a time the user
    // actually changed is (which is what heals a document an older build
    // stripped).
    const t = s.times ?? DEFAULT_REMINDER_TIMES;
    return JSON.stringify({ c: sortObj(s.colors), l: sortObj(s.labels), a: sortObj(s.archived), t: REMINDER_TIME_KEYS.map(k => t[k]) });
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
    const state = noteStateOf(parseNotesPrefs(JSON.stringify(d.prefs)));
    // parseNotesPrefs fills the times in; a document that CARRIED none must
    // stay carrying none, or the merge cannot tell unknown from cleared. A
    // present-but-unreadable `times` (not an object, or an object with not one
    // usable field) counts as carrying none too: parsed it is indistinguishable
    // from "the user chose the defaults", and that would let a corrupt document
    // overwrite another device's real times.
    const raw = (d.prefs as { times?: unknown }).times;
    const carried = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        && REMINDER_TIME_KEYS.some(k => isReminderTime((raw as Record<string, unknown>)[k]));
    if (!carried) delete state.times;
    return { rev: d.rev, state };
}

const lower = (l: string) => l.toLocaleLowerCase();

/** The ONE-TIME merge of a never-synced local copy into the server's. */
export function unionMerge(local: NotesNoteState, server: NotesNoteState): NotesNoteState {
    const colors = { ...local.colors, ...server.colors };
    const times = server.times ?? local.times;
    const labels: Record<string, string[]> = {};
    for (const k of new Set([...Object.keys(local.labels), ...Object.keys(server.labels)])) {
        const merged = dedupeLabels([...(server.labels[k] ?? []), ...(local.labels[k] ?? [])]);
        if (merged.length > 0) labels[k] = merged;
    }
    const archived = { ...local.archived, ...server.archived };
    return { colors, labels, archived, ...(times ? { times } : {}) };
}

/** Per field: what this device changed since `base` wins, else the server's —
 *  and a server that carries no times at all changes nothing. */
export function mergeTimes(base: ReminderTimes | undefined, local: ReminderTimes | undefined, server: ReminderTimes | undefined): ReminderTimes | undefined {
    if (!local) return server;
    if (!server) return local;
    const b = base ?? DEFAULT_REMINDER_TIMES;
    const out = {} as ReminderTimes;
    for (const k of REMINDER_TIME_KEYS) out[k] = local[k] !== b[k] ? local[k] : server[k];
    return out;
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
    const times = mergeTimes(base.times, local.times, server.times);
    return {
        colors: scalar(base.colors, local.colors, server.colors),
        labels,
        archived: scalar(base.archived, local.archived, server.archived),
        ...(times ? { times } : {}),
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
    /** Moves on every sign-out on this page. With the uid it is what an
     *  operation checks after each await to know it still belongs to the
     *  session that started it (a sign-out and back in as the SAME account
     *  keeps the uid but moves this). Absent = never moves. */
    epoch?: () => number;
    get: () => Promise<GetBlobResult>;
    put: (expectedRev: number, blob: string) => Promise<PutBlobResult>;
    readLocal: () => NotesNoteState;
    /** `uid` is the account the operation belongs to; the app's writer
     *  refuses to file the state under any other one. */
    writeLocal: (s: NotesNoteState, uid: number) => void;
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
    /** Whether this device holds colours, labels, archive flags or reminder
     *  times the account's document does not (a sign-out would lose them). */
    unsynced(): boolean;
    status(): PrefsSyncStatus;
    subscribe(cb: () => void): () => void;
    /** Called after EVERY operation settles, whether or not the status
     *  changed ('synced' -> 'synced' still moves `base`, which is what
     *  unsynced() compares against). */
    subscribeSettled(cb: () => void): () => void;
}

/** Thrown by an operation's `after` when the session that started it is gone. */
const ACCOUNT_CHANGED: unique symbol = Symbol('notes-prefs: account changed');

/** One running operation: the session it belongs to, and the re-check. */
interface Op {
    uid: number;
    id: Identity;
    /** Throws ACCOUNT_CHANGED unless the starting session is still the one signed in. */
    check: () => void;
    /** Await `p`, then check(). EVERY await in an operation goes through this. */
    after: <T>(p: Promise<T>) => Promise<T>;
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
    const open = async ({ uid, id, after }: Op, rev: number, blob: string | null, rec: SyncRecord | null) => {
        if (blob === null) return { bad: 'unreadable' as const };
        const text = await after(openAccountBlob(id, uid, PREFS_BLOB_NAME, blob));
        const doc = text === null ? null : decodePrefsDoc(text);
        if (!doc || doc.rev !== rev) return { bad: 'unreadable' as const };
        if (rec && rev < rec.maxRev) return { bad: 'rollback' as const };
        return { state: doc.state };
    };

    const pushOnce = async (op: Op): Promise<PrefsSyncStatus> => {
        const { uid, id, after } = op;
        let rec = deps.records.load(uid);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            op.check();
            if (!rec || rec.base === null) return pullOnce(op);
            const local = deps.readLocal();
            if (sameNoteState(local, rec.base)) return set('synced');
            // Checked after the seal and BEFORE the PUT: a PUT sent after a
            // switch would carry the old account's copy, sealed under the old
            // account's key, with the new account's token.
            const sealed = await after(sealAccountBlob(id, uid, PREFS_BLOB_NAME, encodePrefsDoc(rec.rev + 1, local)));
            const res = await after(deps.put(rec.rev, sealed));
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
            const opened = await after(open(op, cur.rev, cur.blob, rec));
            if ('bad' in opened) return set(opened.bad!);
            // Re-read: `local` was taken before three awaits (seal, PUT,
            // open), and an edit made during that round trip must be merged,
            // not written over.
            const live = deps.readLocal();
            const merged = threeWayMerge(rec.base, live, opened.state);
            if (!sameNoteState(merged, live)) deps.writeLocal(merged, uid);
            rec = { rev: cur.rev, base: opened.state, maxRev: Math.max(rec.maxRev, cur.rev) };
            deps.records.save(uid, rec);
        }
        return set('error');
    };

    const pullOnce = async (op: Op): Promise<PrefsSyncStatus> => {
        const { uid } = op;
        const res = await op.after(deps.get());
        if (res.kind === 'unsupported') return set('local-only');
        const rec = deps.records.load(uid);
        const { rev, blob } = res.doc;
        if (rev === 0) {
            // Nothing on the server: this device's copy (never synced, or one
            // the server lost) goes up as revision 1.
            deps.records.save(uid, { rev: 0, base: EMPTY_NOTE_STATE, maxRev: rec?.maxRev ?? 0 });
            return pushOnce(op);
        }
        const opened = await op.after(open(op, rev, blob, rec));
        if ('bad' in opened) return set(opened.bad!);
        const local = deps.readLocal();
        const merged = rec === null || rec.base === null
            ? unionMerge(local, opened.state)          // the one-time migration
            : threeWayMerge(rec.base, local, opened.state);
        if (!sameNoteState(merged, local)) deps.writeLocal(merged, uid);
        deps.records.save(uid, { rev, base: opened.state, maxRev: Math.max(rec?.maxRev ?? 0, rev) });
        return sameNoteState(merged, opened.state) ? set('synced') : pushOnce(op);
    };

    /*
     * THE ACCOUNT CAN CHANGE UNDER AN OPERATION. Neither app reloads on a
     * sign-out (NotesApp signOut, App.tsx handleLogout), and nothing cancels
     * a request in flight — the sign-out flush is only RACED against 3 s. So
     * an operation started for A can resolve on a page that is signed out, or
     * signed in as B, where readLocal/writeLocal and the request token all
     * resolve to whoever is signed in NOW. Unchecked, it merged A's labels,
     * colours and times into B's copy (and from there into B's document), and
     * re-created A's plaintext sync record after the sign-out scrubbed it.
     *
     * So every await in an operation goes through `after`, which re-checks
     * the session before handing control back; the synchronous side effects
     * that follow it (record saves, local writes, the next request) run for
     * the session that started the operation or not at all. The session is
     * the uid plus the sign-out epoch — never the Identity object:
     * getActiveIdentity may rebuild it for the SAME account (a stale seed
     * re-derived), and that must not abort a good operation. An aborted one
     * leaves the status alone — and so does one whose request FAILED after the
     * switch; the new session's own pull is already queued.
     */
    const guarded = (fn: (op: Op) => Promise<PrefsSyncStatus>) => serial(async () => {
        const uid = deps.uid();
        if (uid === null) return set('idle');
        const id = deps.identity();
        if (!id) return set('locked');
        const epoch = deps.epoch?.() ?? 0;
        const moved = () => deps.uid() !== uid || (deps.epoch?.() ?? 0) !== epoch;
        const check = () => {
            if (moved()) throw ACCOUNT_CHANGED;
        };
        const after = async <T,>(p: Promise<T>): Promise<T> => {
            const v = await p;
            check();
            return v;
        };
        try {
            return await fn({ uid, id, check, after });
        } catch (err) {
            // The account changed under the operation: it did nothing, and
            // the status belongs to the NEW session, not to this one. That
            // holds as much for a request that FAILED after the switch (its
            // rejection never reaches `after`'s check) as for one stopped by
            // the check: a stale 'offline' or 'error', and its console
            // warning, would land in the new session's shell.
            if (err === ACCOUNT_CHANGED || moved()) return current;
            return fail(err);
        } finally {
            for (const cb of settledListeners) cb();
        }
    });

    return {
        pull: () => guarded(pullOnce),
        push: () => guarded(pushOnce),
        overwriteServer: () => guarded(async op => {
            const { uid } = op;
            const res = await op.after(deps.get());
            if (res.kind === 'unsupported') return set('local-only');
            // Adopt the server's revision with an EMPTY base, so the whole
            // local copy counts as this device's change and goes up as is.
            // maxRev restarts at the server's revision: the user has chosen
            // this lineage, and keeping a higher one would refuse this very
            // write's successor as a rollback forever.
            deps.records.save(uid, { rev: res.doc.rev, base: EMPTY_NOTE_STATE, maxRev: res.doc.rev });
            return pushOnce(op);
        }),
        acceptServer: () => guarded(async op => {
            const { uid } = op;
            const res = await op.after(deps.get());
            if (res.kind === 'unsupported') return set('local-only');
            const { rev, blob } = res.doc;
            if (rev === 0) {
                // Nothing there at all: there is no "server's copy" to take.
                deps.records.save(uid, { rev: 0, base: EMPTY_NOTE_STATE, maxRev: 0 });
                return pushOnce(op);
            }
            // Opened WITHOUT the rollback check (that is the point), but it
            // must still be a real, current document for this account.
            const opened = await op.after(open(op, rev, blob, null));
            if ('bad' in opened) return set(opened.bad!);
            deps.writeLocal(opened.state, uid);
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

// Moves on every sign-out ON THIS PAGE (logout() drains the hooks). A
// sign-out in another tab changes the token this page reads, which the uid
// half of the check sees.
let signOutEpoch = 0;
registerLogoutCleanup(() => { signOutEpoch++; });

/** The sign-out epoch the app's instance checks (exported for the tests). */
export function notesPrefsSignOutEpoch(): number {
    return signOutEpoch;
}

/** The app's record store: it refuses to save a record for any account but
 *  the signed-in one. Defence in depth behind the per-await check — a record
 *  written after the sign-out scrub is the previous account's labels, in
 *  plaintext, left behind in a shared browser. */
export const accountRecordStore = {
    load: (uid: number): SyncRecord | null => localRecordStore.load(uid),
    save(uid: number, r: SyncRecord): void {
        if (currentUserIdFromToken() !== uid) return;
        localRecordStore.save(uid, r);
    },
};

const appSync = createPrefsSync({
    uid: currentUserIdFromToken,
    identity: getActiveIdentity,
    epoch: notesPrefsSignOutEpoch,
    get: () => getSealedBlob(PREFS_BLOB_NAME),
    put: (rev, blob) => putSealedBlob(PREFS_BLOB_NAME, rev, blob),
    readLocal: () => noteStateOf(getNotesPrefs()),
    writeLocal: (s, uid) => replaceNoteState(s, uid),
    records: accountRecordStore,
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
 * The same flag, published by PÚCA. Púca's Tasks view writes this document
 * too, so its sign-out warning has to be about its OWN unsent writes as well
 * as Notes' — but Púca has no outbox, so it publishes only the prefs half
 * (writeNotesUnsyncedPrefs) and leaves Notes' queued-edit count alone.
 *
 * Mounted at the top of the app, not in the Tasks view: a colour set and then
 * navigated away from within the push debounce leaves the view unmounted with
 * the write still local, and a publisher that unmounted with it would leave
 * the flag saying the opposite.
 *
 * It may RAISE the flag from anywhere, but it may only CLEAR it off the back
 * of a sync that actually SUCCEEDED here. The flag is one shared key that
 * Notes publishes too, from its own module state: unsynced() answers true
 * outright while the status is 'unreadable', 'rollback' or 'local-only', and
 * in the Púca bundle the status stays 'idle' until the Tasks view has been
 * opened at least once. A Púca tab in any other state therefore cannot tell a
 * clean document from a refused rollback the Notes tab is sitting on — so it
 * says nothing rather than writing false over Notes' true and dropping a real
 * warning. Over-warning is the safe side of this; under-warning loses data.
 */
export function useNotesPrefsUnsyncedFlag(): void {
    useEffect(() => {
        const publish = () => {
            const uid = currentUserIdFromToken();
            if (uid === null) return;
            const unsynced = appSync.unsynced();
            if (!unsynced && appSync.status() !== 'synced') return;
            writeNotesUnsyncedPrefs(uid, unsynced);
        };
        publish();
        const offSettled = appSync.subscribeSettled(publish);
        const offLocal = subscribeNotesPrefs(publish);
        return () => { offSettled(); offLocal(); };
    }, []);
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
            timer = window.setTimeout(() => { timer = undefined; void appSync.push(); }, PUSH_DEBOUNCE_MS);
        };
        const unsub = subscribeNotesPrefs(schedule);
        const onFocus = () => { void appSync.pull(); };
        const onOnline = () => { void appSync.push(); };
        window.addEventListener('focus', onFocus);
        window.addEventListener('online', onOnline);
        return () => {
            unsub();
            // A colour picked and then navigated away from inside the debounce
            // must still go out: this view unmounts, the write does not. Only
            // when one is genuinely outstanding — `timer` is cleared as it
            // fires, so an unmount long after the last edit asks for nothing.
            if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; void appSync.push(); }
            window.removeEventListener('focus', onFocus);
            window.removeEventListener('online', onOnline);
        };
    }, []);
    return status;
}
