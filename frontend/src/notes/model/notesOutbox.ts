/**
 * Púca Notes — edits made while offline, kept and replayed.
 *
 * Every note action goes through `sendNoteOp`. Online with nothing queued, it
 * simply runs the op — through the SAME api/tasks.ts functions as before, so
 * sealing, envelopes and permissions are exactly what they were. When the
 * request never reaches the server (a network error, or the browser says it
 * is offline), the op is QUEUED instead and the optimistic state stays on
 * screen; any other failure is the server saying no, and the caller rolls
 * back as it always did.
 *
 * THE QUEUE holds INTENTS in order ("tick item 57", "create an item under
 * note -3 with this text"), sealed at rest in the same per-account database
 * as the cache (api/e2ee.ts sealLocal). Content is sealed FOR THE SERVER only
 * at replay, so a channel key fetched or rotated in the meantime is used.
 * Replay is strictly first-in-first-out, one op at a time, under a lock so
 * two tabs never replay the same op; while anything is queued, new ops queue
 * behind it rather than overtaking it.
 *
 * TEMPORARY IDS. A note or item created offline gets a negative id. The
 * create's replay records the real one, later ops are rewritten through that
 * map, and an op whose temp parent failed is dropped with it (never sent with
 * a negative id).
 *
 * WHAT A REPLAY FAILURE DOES. A network error stops the replay (retried on
 * reconnect, focus, a successful fetch, or a backoff timer). 401 stops it
 * too (the session is over; the queue waits for the same account to sign in
 * again). 5xx/429 retry a few times. Anything else — 403, 404, 409 (lost
 * access, a note deleted elsewhere, an envelope refusal) — drops the op, and
 * one toast lists what did not save, in the words the user typed.
 *
 * LAST WRITE WINS for item edits: the task API has no revision field, so a
 * change replayed hours later overwrites a newer edit of the SAME field made
 * elsewhere in the meantime (docs/NOTES.md says so). Pins and order are
 * replayed as intents against the server's CURRENT set, never as a stale
 * full replace.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { currentUserIdFromToken } from '../../api/auth';
import { ApiError, isNetworkError } from '../../api/client';
import { getActiveIdentity, openLocal, sealLocal, seedMatchesCurrentAccount, type Identity } from '../../api/e2ee';
import {
    type Task, type TaskList, type TaskTabPref, type TaskTabRef,
    createTask, createListTask, createTaskList, renameTaskList, deleteTaskList,
    updateTask, updateChannelTask, updateListTask, deleteTask, moveTask, reorderTask,
    getTaskTabPrefs, putTaskTabPrefs, isFavoriteTab, toggleFavoritePrefs, buildPrefsForOrder,
} from '../../api/tasks';
import { pokeTaskReminders } from '../../api/taskReminders';
import { pushMessageToast } from '../../components/messageToastBus';
import { beginNoteWrite, LISTS_KEY, PREFS_KEY, setQueuedNotes } from './noteBusy';
import { idbStore, type KV } from './notesCache';
import { noteKey, type NoteRef } from './notesModel';

// --- Ops --------------------------------------------------------------------------

export type PrefsIntent =
    | { type: 'pin'; tab: TaskTabRef; favorite: boolean }
    | { type: 'order'; keys: string[] };

type OpBody =
    | { k: 'createList'; tempId: number; title: string }
    | { k: 'renameList'; listId: number; title: string }
    | { k: 'deleteList'; listId: number }
    | { k: 'createTask'; note: NoteRef; tempId: number; description: string; parentId?: number }
    | { k: 'editTask'; note: NoteRef; taskId: number; description: string; createdBy: number }
    | { k: 'updateTask'; note: NoteRef; taskId: number; updates: { is_completed?: boolean; due_at?: string } }
    | { k: 'moveTask'; note: NoteRef; taskId: number; direction: 'up' | 'down' }
    | { k: 'reorderTask'; note: NoteRef; taskId: number; afterId: number | null; reparent?: { parentId: number | null } }
    | { k: 'deleteTask'; note: NoteRef; taskId: number }
    | { k: 'prefs'; prefs: TaskTabPref[]; intent: PrefsIntent };

export type NoteOp = OpBody & {
    /** Unique per op (replay removes by id, never by position). */
    oid: string;
    /** What the user did, in their words — only ever shown on this device. */
    label: string;
    attempts?: number;
};

let opSeq = 0;
function withMeta(body: OpBody, label: string): NoteOp {
    return { ...body, oid: `${Date.now().toString(36)}-${(opSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label };
}

/** A fresh temporary (negative) id, unique on this device. */
export function newTempId(): number {
    return -(Date.now() * 100 + (opSeq++ % 100));
}

const q = (s: string) => `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`;

export const ops = {
    createList: (tempId: number, title: string) => withMeta({ k: 'createList', tempId, title }, `new note ${q(title)}`),
    renameList: (listId: number, title: string) => withMeta({ k: 'renameList', listId, title }, `rename to ${q(title)}`),
    deleteList: (listId: number, title: string) => withMeta({ k: 'deleteList', listId }, `delete ${q(title)}`),
    createTask: (note: NoteRef, tempId: number, description: string, parentId?: number) =>
        withMeta({ k: 'createTask', note, tempId, description, parentId }, `new item ${q(description)}`),
    editTask: (note: NoteRef, task: Task, description: string) =>
        withMeta({ k: 'editTask', note, taskId: task.id, description, createdBy: task.created_by }, `edit ${q(description)}`),
    toggle: (note: NoteRef, task: Task, completed: boolean) =>
        withMeta({ k: 'updateTask', note, taskId: task.id, updates: { is_completed: completed } }, `${completed ? 'tick' : 'untick'} ${q(task.description)}`),
    setDue: (note: NoteRef, task: Task, dueAt: string | null) =>
        withMeta({ k: 'updateTask', note, taskId: task.id, updates: { due_at: dueAt ?? '' } }, `due time on ${q(task.description)}`),
    move: (note: NoteRef, task: Task, direction: 'up' | 'down') =>
        withMeta({ k: 'moveTask', note, taskId: task.id, direction }, `move ${q(task.description)}`),
    reorder: (note: NoteRef, task: Task, afterId: number | null, reparent?: { parentId: number | null }) =>
        withMeta({ k: 'reorderTask', note, taskId: task.id, afterId, reparent }, `move ${q(task.description)}`),
    deleteTask: (note: NoteRef, taskId: number, description: string) =>
        withMeta({ k: 'deleteTask', note, taskId }, `delete ${q(description)}`),
    prefs: (prefs: TaskTabPref[], intent: PrefsIntent) =>
        withMeta({ k: 'prefs', prefs, intent }, intent.type === 'pin' ? (intent.favorite ? 'pin a note' : 'unpin a note') : 'reorder notes'),
};

/** Which busy key (noteBusy.ts) an op holds. */
export function busyKeyOf(op: OpBody): string {
    switch (op.k) {
        case 'createList': case 'renameList': case 'deleteList': return LISTS_KEY;
        case 'prefs': return PREFS_KEY;
        default: return noteKey(op.note);
    }
}

/** Every id an op names that must be real on the server. */
function idsOf(op: OpBody): number[] {
    switch (op.k) {
        case 'createList': return [];
        case 'renameList': case 'deleteList': return [op.listId];
        case 'createTask': return [op.note.id, ...(op.parentId !== undefined ? [op.parentId] : [])];
        case 'editTask': case 'updateTask': case 'moveTask': case 'deleteTask': return [op.note.id, op.taskId];
        case 'reorderTask': return [op.note.id, op.taskId, ...(op.afterId !== null ? [op.afterId] : []), ...(op.reparent?.parentId != null ? [op.reparent.parentId] : [])];
        case 'prefs': return op.intent.type === 'pin' ? [op.intent.tab.id] : [];
    }
}

export function referencesTemp(op: OpBody): boolean {
    return idsOf(op).some(id => id < 0);
}

// --- Replay of one op --------------------------------------------------------------

export class UnresolvedTempId extends Error {
    readonly tempId: number;
    constructor(tempId: number) {
        super(`temporary id ${tempId} was never created`);
        this.tempId = tempId;
    }
}

type IdMap = Record<string, number>;

/** Run one op against the server. `fromQueue` = a replay: pins and order are
 *  re-derived from the server's current set instead of PUT as captured. */
export async function execOp(op: OpBody, idMap: IdMap, fromQueue: boolean): Promise<unknown> {
    const r = (id: number): number => {
        if (id >= 0) return id;
        const real = idMap[String(id)];
        if (real === undefined) throw new UnresolvedTempId(id);
        return real;
    };
    const note = (n: NoteRef): NoteRef => ({ kind: n.kind, id: r(n.id) });
    switch (op.k) {
        case 'createList': {
            const list = await createTaskList(op.title);
            idMap[String(op.tempId)] = list.id;
            return list;
        }
        case 'renameList': return renameTaskList(r(op.listId), op.title);
        case 'deleteList': return deleteTaskList(r(op.listId));
        case 'createTask': {
            const n = note(op.note);
            const parent = op.parentId === undefined ? undefined : r(op.parentId);
            const created = n.kind === 'channel'
                ? await createTask(n.id, op.description, parent)
                : await createListTask(n.id, op.description, parent);
            idMap[String(op.tempId)] = created.id;
            return created;
        }
        case 'editTask': {
            const n = note(op.note);
            return n.kind === 'channel'
                ? updateChannelTask(n.id, r(op.taskId), { description: op.description }, op.createdBy)
                : updateListTask(r(op.taskId), { description: op.description });
        }
        case 'updateTask': return updateTask(r(op.taskId), op.updates);
        case 'moveTask': return moveTask(r(op.taskId), op.direction);
        case 'reorderTask':
            return reorderTask(
                r(op.taskId),
                op.afterId === null ? null : r(op.afterId),
                op.reparent ? { parentId: op.reparent.parentId === null ? null : r(op.reparent.parentId) } : undefined,
            );
        case 'deleteTask': return deleteTask(r(op.taskId));
        case 'prefs': {
            if (!fromQueue) return putTaskTabPrefs(op.prefs);
            const current = await getTaskTabPrefs();
            const next = applyPrefsIntent(current, op.intent, idMap);
            return next === null ? undefined : putTaskTabPrefs(next);
        }
    }
}

/** A pin or order intent against the server's CURRENT set; null = nothing to do. */
export function applyPrefsIntent(current: TaskTabPref[], intent: PrefsIntent, idMap: IdMap = {}): TaskTabPref[] | null {
    const realTab = (t: TaskTabRef): TaskTabRef | null => {
        if (t.id >= 0) return t;
        const real = idMap[String(t.id)];
        return real === undefined ? null : { kind: t.kind, id: real };
    };
    const ordered: TaskTabRef[] = current.map(p => ({ kind: p.kind, id: p.ref_id }));
    if (intent.type === 'pin') {
        const tab = realTab(intent.tab);
        if (!tab) return null;
        if (isFavoriteTab(current, tab) === intent.favorite) return null;
        const withTab = ordered.some(t => t.kind === tab.kind && t.id === tab.id) ? ordered : [...ordered, tab];
        return toggleFavoritePrefs(withTab, current, tab);
    }
    const tabs = intent.keys
        .map(parseNoteKeyLoose)
        .map(t => (t ? realTab(t) : null))
        .filter((t): t is TaskTabRef => t !== null);
    return buildPrefsForOrder(tabs, current);
}

function parseNoteKeyLoose(key: string): TaskTabRef | null {
    const m = /^(list|channel):(-?\d+)$/.exec(key);
    if (!m) return null;
    return { kind: m[1] as TaskTabRef['kind'], id: Number(m[2]) };
}

// --- The persisted queue -------------------------------------------------------------

export interface OutboxState {
    queue: NoteOp[];
    ids: IdMap;
    /** Temp ids whose create was dropped: ops naming them are dropped too. */
    dead: number[];
}

const EMPTY: OutboxState = { queue: [], ids: {}, dead: [] };
const RECORD = 'outbox';

export interface OutboxDeps {
    sub: () => number | null;
    identity: () => Identity | null;
    store: (sub: number) => KV | null;
    exec: (op: OpBody, ids: IdMap, fromQueue: boolean) => Promise<unknown>;
    online: () => boolean;
    /** Serialise read-modify-write of the queue (and, separately, replay)
     *  across tabs; a same-page chain where Web Locks are unavailable. */
    lock: <T>(name: string, fn: () => Promise<T>, opts?: { ifAvailable?: boolean }) => Promise<T | undefined>;
    onReplayed: (summary: ReplaySummary) => void;
}

export interface ReplaySummary {
    sent: number;
    dropped: NoteOp[];
    /** Temp id -> real id, for everything created in this replay. */
    created: IdMap;
    touchedDue: boolean;
}

const chains = new Map<string, Promise<unknown>>();
function localLock<T>(name: string, fn: () => Promise<T>, opts?: { ifAvailable?: boolean }): Promise<T | undefined> {
    const busy = chains.has(name);
    if (busy && opts?.ifAvailable) return Promise.resolve(undefined);
    const prev = chains.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    chains.set(name, tail);
    void tail.then(() => { if (chains.get(name) === tail) chains.delete(name); });
    return next;
}

function webLock<T>(name: string, fn: () => Promise<T>, opts?: { ifAvailable?: boolean }): Promise<T | undefined> {
    const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
    if (!locks) return localLock(name, fn, opts);
    return locks.request(name, { ifAvailable: !!opts?.ifAvailable }, async lock => (lock ? fn() : undefined)) as Promise<T | undefined>;
}

export interface Outbox {
    /** How many ops are queued (this page's last view of it). */
    pending(): number;
    queuedKeys(): Set<string>;
    subscribe(cb: () => void): () => void;
    load(): Promise<void>;
    send<T>(op: NoteOp): Promise<{ queued: true } | { queued: false; value: T }>;
    replay(): Promise<ReplaySummary | undefined>;
    /** The id a temp id became, once its create has replayed. */
    realId(tempId: number): number | undefined;
}

export function createOutbox(deps: OutboxDeps): Outbox {
    let view: OutboxState = EMPTY;
    const listeners = new Set<() => void>();
    const publish = (s: OutboxState) => {
        view = s;
        setQueuedNotes(queuedKeysOf(s));
        for (const cb of listeners) cb();
    };

    const read = async (sub: number, id: Identity, kv: KV): Promise<OutboxState> => {
        const sealed = await kv.get(RECORD);
        if (!sealed) return EMPTY;
        const text = await openLocal(id, sub, RECORD, sealed);
        if (text === null) return EMPTY;
        try {
            const s = JSON.parse(text) as OutboxState;
            return Array.isArray(s.queue) ? { queue: s.queue, ids: s.ids ?? {}, dead: s.dead ?? [] } : EMPTY;
        } catch {
            return EMPTY;
        }
    };
    const save = async (sub: number, id: Identity, kv: KV, s: OutboxState) => {
        await kv.put(RECORD, await sealLocal(id, sub, RECORD, JSON.stringify(s)));
    };

    const ctx = () => {
        const sub = deps.sub();
        const id = deps.identity();
        const kv = sub === null ? null : deps.store(sub);
        return sub === null || !id ? null : { sub, id, kv };
    };

    /** Read-modify-write under the queue lock; the store is the truth. */
    const mutate = async (fn: (s: OutboxState) => OutboxState): Promise<OutboxState> => {
        const c = ctx();
        if (!c) throw new Error('Not signed in: nothing to queue this under');
        const run = async () => {
            const cur = c.kv ? await read(c.sub, c.id, c.kv) : view;
            const next = fn(cur);
            if (c.kv) await save(c.sub, c.id, c.kv, next);
            return next;
        };
        const next = (await deps.lock(`pucaNotesOutbox:${c.sub}`, run)) ?? view;
        publish(next);
        return next;
    };

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 2_000;
    const scheduleReplay = (ms: number) => {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; void outbox.replay(); }, ms);
    };

    const outbox: Outbox = {
        pending: () => view.queue.length,
        queuedKeys: () => queuedKeysOf(view),
        subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        realId: tempId => view.ids[String(tempId)],

        async load() {
            const c = ctx();
            if (!c || !c.kv) { publish(EMPTY); return; }
            const kv = c.kv;
            try {
                publish(await deps.lock(`pucaNotesOutbox:${c.sub}`, () => read(c.sub, c.id, kv)) ?? EMPTY);
            } catch {
                publish(EMPTY);
            }
        },

        async send<T>(op: NoteOp) {
            const mustQueue = view.queue.length > 0 || referencesTemp(op) || !deps.online();
            if (mustQueue) {
                await mutate(s => ({ ...s, queue: [...s.queue, op] }));
                if (deps.online()) scheduleReplay(0);
                return { queued: true as const };
            }
            const done = beginNoteWrite(busyKeyOf(op));
            try {
                const value = await deps.exec(op, { ...view.ids }, false) as T;
                return { queued: false as const, value };
            } catch (err) {
                if (!isNetworkError(err)) throw err;
                // Never reached the server: keep it, and keep the screen as is.
                await mutate(s => ({ ...s, queue: [...s.queue, op] }));
                scheduleReplay(backoffMs);
                return { queued: true as const };
            } finally {
                done();
            }
        },

        async replay() {
            const c = ctx();
            if (!c || !deps.online()) return undefined;
            return deps.lock(`pucaNotesOutboxReplay:${c.sub}`, async () => {
                const summary: ReplaySummary = { sent: 0, dropped: [], created: {}, touchedDue: false };
                for (;;) {
                    const state = await mutate(s => s);   // re-read: another tab may have changed it
                    const head = state.queue[0];
                    if (!head) break;
                    const dropHead = (dead?: number) => mutate(s => ({
                        ...s,
                        queue: s.queue.filter(o => o.oid !== head.oid),
                        dead: dead === undefined ? s.dead : [...s.dead, dead],
                    }));
                    if (idsOf(head).some(id => state.dead.includes(id))) {
                        summary.dropped.push(head);
                        await dropHead(head.k === 'createTask' || head.k === 'createList' ? head.tempId : undefined);
                        continue;
                    }
                    const ids = { ...state.ids };
                    const done = beginNoteWrite(busyKeyOf(head));
                    try {
                        await deps.exec(head, ids, true);
                        summary.sent++;
                        if (head.k === 'createTask' || head.k === 'createList') {
                            const real = ids[String(head.tempId)];
                            if (real !== undefined) summary.created[String(head.tempId)] = real;
                        }
                        if (head.k === 'updateTask' && head.updates.due_at !== undefined) summary.touchedDue = true;
                        await mutate(s => ({ ...s, ids: { ...s.ids, ...ids }, queue: s.queue.filter(o => o.oid !== head.oid) }));
                        backoffMs = 2_000;
                    } catch (err) {
                        const status = err instanceof ApiError ? err.status : undefined;
                        if (isNetworkError(err)) {
                            scheduleReplay(backoffMs);
                            backoffMs = Math.min(backoffMs * 2, 60_000);
                            break;
                        }
                        if (status === 401) break;   // the session ended; wait for this account to sign in
                        if (status !== undefined && (status >= 500 || status === 429) && (head.attempts ?? 0) < 4) {
                            await mutate(s => ({ ...s, queue: s.queue.map(o => (o.oid === head.oid ? { ...o, attempts: (o.attempts ?? 0) + 1 } : o)) }));
                            scheduleReplay(backoffMs);
                            backoffMs = Math.min(backoffMs * 2, 60_000);
                            break;
                        }
                        // Refused (or unresolvable): it will never succeed as written.
                        summary.dropped.push(head);
                        await dropHead(head.k === 'createTask' || head.k === 'createList' ? head.tempId : undefined);
                    } finally {
                        done();
                    }
                }
                if (summary.sent > 0 || summary.dropped.length > 0) deps.onReplayed(summary);
                return summary;
            }, { ifAvailable: true });
        },
    };
    return outbox;
}

function queuedKeysOf(s: OutboxState): Set<string> {
    return new Set(s.queue.map(busyKeyOf));
}

// --- The app's instance --------------------------------------------------------------

let appQc: QueryClient | null = null;

function onReplayed(summary: ReplaySummary): void {
    if (summary.touchedDue) pokeTaskReminders();
    if (summary.dropped.length > 0) {
        const n = summary.dropped.length;
        const what = summary.dropped.map(o => o.label).join('; ');
        pushMessageToast({ title: `${n} change${n === 1 ? '' : 's'} made offline couldn’t be saved: ${what.slice(0, 160)}` });
    }
    // Re-read the truth: temp ids become real ones, and whatever the server
    // refused disappears from the screen.
    void appQc?.invalidateQueries({ queryKey: ['notes'] });
    for (const cb of tempListeners) cb(summary.created);
}

const tempListeners = new Set<(created: IdMap) => void>();

/** Called with temp -> real ids after a replay (the open note follows). */
export function onTempIdsResolved(cb: (created: IdMap) => void): () => void {
    tempListeners.add(cb);
    return () => { tempListeners.delete(cb); };
}

export const appOutbox = createOutbox({
    sub: currentUserIdFromToken,
    identity: () => (seedMatchesCurrentAccount() ? getActiveIdentity() : null),
    store: sub => idbStore(sub, 'o'),
    exec: execOp,
    online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    lock: webLock,
    onReplayed,
});

/** Run (or queue) one note op. See the module header. */
export function sendNoteOp<T = unknown>(op: NoteOp): Promise<{ queued: true } | { queued: false; value: T }> {
    return appOutbox.send<T>(op);
}

/** Create an item, or queue its creation and hand back a temporary one. */
export async function sendCreateTask(note: NoteRef, description: string, parentId: number | undefined, siblings: () => Task[]): Promise<Task> {
    const tempId = newTempId();
    const r = await sendNoteOp<Task>(ops.createTask(note, tempId, description, parentId));
    if (!r.queued) return r.value;
    const me = currentUserIdFromToken() ?? 0;
    const position = siblings().reduce((m, t) => Math.max(m, t.position), 0) + 1;
    return {
        id: tempId,
        channel_id: note.kind === 'channel' ? note.id : null,
        list_id: note.kind === 'list' ? note.id : null,
        parent_id: parentId ?? null,
        description,
        is_completed: false,
        position,
        created_at: new Date().toISOString(),
        created_by: me,
        attachments: null,
        due_at: null,
    };
}

/** Create a note (list), or queue it and hand back a temporary one. */
export async function sendCreateList(title: string): Promise<TaskList> {
    const tempId = newTempId();
    const r = await sendNoteOp<TaskList>(ops.createList(tempId, title));
    if (!r.queued) return r.value;
    return { id: tempId, title, created_at: new Date().toISOString(), total_tasks: 0, completed_tasks: 0 };
}

export function pendingOutboxCount(): number {
    return appOutbox.pending();
}

/** Whether a card has changes that have not reached the server. */
export function useNoteUnsynced(key: string): boolean {
    return useSyncExternalStore(appOutbox.subscribe, () => appOutbox.queuedKeys().has(key), () => false);
}

export function useOutboxPending(): number {
    return useSyncExternalStore(appOutbox.subscribe, appOutbox.pending, () => 0);
}

/**
 * Mount once in the shell: load the queue, replay it on the way in, on
 * reconnect, on focus, and after any successful fetch; and point the open
 * note at its real id once a temp one has replayed.
 */
export function useNotesOutbox(onOpenNoteMoved?: (from: string, to: string) => void): void {
    const qc = useQueryClient();
    useEffect(() => {
        appQc = qc;
        let alive = true;
        void appOutbox.load().then(() => { if (alive) void appOutbox.replay(); });
        const kick = () => { if (appOutbox.pending() > 0) void appOutbox.replay(); };
        const onVisible = () => { if (document.visibilityState === 'visible') kick(); };
        window.addEventListener('online', kick);
        window.addEventListener('focus', kick);
        document.addEventListener('visibilitychange', onVisible);
        const unsubQc = qc.getQueryCache().subscribe(ev => {
            if (ev.type === 'updated' && ev.action.type === 'success' && !ev.action.manual) kick();
        });
        const unsubTemp = onTempIdsResolved(created => {
            for (const [temp, real] of Object.entries(created)) {
                onOpenNoteMoved?.(`list:${temp}`, `list:${real}`);
            }
        });
        return () => {
            alive = false;
            if (appQc === qc) appQc = null;
            window.removeEventListener('online', kick);
            window.removeEventListener('focus', kick);
            document.removeEventListener('visibilitychange', onVisible);
            unsubQc();
            unsubTemp();
        };
        // onOpenNoteMoved is read once; the shell passes a stable callback.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [qc]);
}
