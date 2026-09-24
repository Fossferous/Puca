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
 * one toast lists what did not save, in the words the user typed. Two
 * exceptions, both a note's own content losing a race with another device
 * (a STALE 409, NoteConflictError, which is not an ApiError): a picture add
 * or removal stays queued and retries, because an intent re-applied to the
 * newer sidecar always converges; and text is kept as a new note (below).
 *
 * LAST WRITE WINS for item edits: the task API has no revision field, so a
 * change replayed hours later overwrites a newer edit of the SAME field made
 * elsewhere in the meantime (docs/NOTES.md says so). A RENAME replayed off
 * the queue is last-write-wins too, deliberately (see `renameList`). Pins
 * and order are replayed as intents against the server's CURRENT set, never
 * as a stale full replace.
 *
 * A NOTE'S TEXT IS NOT LAST-WRITE-WINS, queued or not. A replayed `setBody`
 * names the revision the typing started from (migration 069), and when
 * another device wrote the text in between, BOTH are kept: the note keeps
 * the other device's text, and the words typed here become a new note beside
 * it, "<title> (offline copy)", made once however often the op replays (its
 * create key, `copyKey`, is minted with the op), and ONE per typing: text
 * typed on afterwards on the same revision of the same note goes into that
 * copy while it still holds only words this typing sent (`copies`, kept in
 * the queue's record — see `keepOfflineText`). The toast names it. The device's
 * OWN writes are not "another device": every content write this tab lands
 * is watched (api/listConflict.ts `watchContentWrites`), and a queued text's
 * revision is carried forward over them before it is sent (`revs`, kept in
 * the queue's record so it survives a reload).
 *
 * CREATES CARRY A KEY. A create the server COMMITTED whose answer was lost
 * (the connection dropped mid-response) looks exactly like one that never
 * arrived: it is queued, or kept, and replayed. So every create op is minted
 * with a random `key` (api/opKey.ts) the moment the user acts — sealed into
 * the queue with the rest of the op, and therefore identical across every
 * retry, every replay and every reload. The server claims it with the insert
 * (migration 070) and answers a replay with the note or item it already made,
 * so the same create can no longer produce two. The key is random and says
 * NOTHING about what was written; a server older than 070 ignores it and the
 * old at-least-once behaviour returns.
 * A NOTE'S OWN CONTENT queues too. `setBody` carries the typed text and is
 * sealed for the server when it runs, like every other op; a second one for
 * the same note REPLACES the queued one — in its place, but with its OWN op
 * id — because the editor saves after every pause in typing.
 * `addMedia` carries only the IDS of ciphertext
 * parked on this device (notesBlobs.ts) — a photo is encrypted the moment it
 * is taken, and replay uploads the bytes and then adds the real refs to
 * whatever the server's sidecar holds at that moment. A dropped or forgotten
 * media op deletes its ciphertext, and `load` sweeps anything the queue does
 * not name. What a replayed add or remove takes OUT of the sidecar has its
 * upload deleted once the server has the new sidecar — the same rule Púca's
 * Tasks view follows, kept in one place (api/noteMedia.ts).
 *
 *
 * COLD START. `send` waits for the persisted queue to load before deciding
 * whether an op may run straight away: an op sent in the moment before the
 * load finished would otherwise overtake what a previous page left queued.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { currentUserIdFromToken } from '../../api/auth';
import { ApiError, isDefiniteRefusal, isNetworkError } from '../../api/client';
import { getActiveIdentity, openLocal, sealLocal, seedMatchesCurrentAccount, type Identity } from '../../api/e2ee';
import {
    type NewTaskTiming, type StampClock, type Task, type TaskList, type TaskTabPref, type TaskTabRef, type TaskTimingPatch,
    timingPatchMovesClock, createTask, createListTask, createTaskList, renameTaskList, openSelfTaskText,
    updateTask, updateChannelTask, updateListTask, deleteTask, moveTask, reorderTask, patchTaskTiming,
    getTaskTabPrefs, putTaskTabPrefs, isFavoriteTab, toggleFavoritePrefs, buildPrefsForOrder, taskTabKey,
} from '../../api/tasks';
import {
    NoteConflictError, createTaskListWithContent, deleteFiles, keepHiddenSlots, restoreTaskList,
    setTaskListBody, setTaskListTiming, trashOrDeleteList,
} from '../../api/listContent';
import { type ContentWrite, watchContentWrites } from '../../api/listConflict';
import { isUndecryptable } from '../../api/decryptMarkers';
import { newOpKey } from '../../api/opKey';
import { type TaskAttachmentRef } from '../../api/tasks';
import { addNoteRefs, fileIdsOf, removeNoteRefs, uploadParkedMedia } from '../../api/noteMedia';
import { appParkedStore, type ParkedStore } from './notesBlobs';
import { pokeTaskReminders } from '../../api/taskReminders';
import { pushMessageToast } from '../../components/messageToastBus';
import { beginNoteWrite, LISTS_KEY, PREFS_KEY, setQueuedNotes } from './noteBusy';
import { idbStore, type KV } from './notesCache';
import { MAX_TITLE_LENGTH, noteKey, type NoteRef } from './notesModel';

// --- Ops --------------------------------------------------------------------------

export type PrefsIntent =
    | { type: 'pin'; tab: TaskTabRef; favorite: boolean }
    | { type: 'pins'; tabs: TaskTabRef[]; favorite: boolean }
    | { type: 'order'; keys: string[] };

type OpBody =
    | { k: 'createList'; tempId: number; title: string; key: string }
    // `expectRev`: the note's content revision when the user typed the new
    // title (migration 069). Sent only when the op runs STRAIGHT AWAY — a
    // replay off the queue deliberately drops it, because the recorded
    // revision is stale by definition there and refusing every queued rename
    // would lose offline work the user cannot get back. Offline renames stay
    // last-write-wins, exactly as this module's header has always said.
    | { k: 'renameList'; listId: number; title: string; expectRev?: number }
    | { k: 'deleteList'; listId: number }
    // Out of the trash (the Undo of a delete that trashed). Queued behind a
    // trash still waiting offline, so the two replay in the order they were
    // made and the note ends up where the user left it.
    | { k: 'restoreList'; listId: number }
    | { k: 'createTask'; note: NoteRef; tempId: number; description: string; parentId?: number; timing?: NewTaskTiming; key: string }
    | { k: 'editTask'; note: NoteRef; taskId: number; description: string; createdBy: number }
    // A due time (setDue). Ticks are `timing` ops: a plain is_completed
    // update is refused for a scheduled item by migration 066's guard.
    | { k: 'updateTask'; note: NoteRef; taskId: number; updates: { is_completed?: boolean; due_at?: string } }
    // A tick, a date & repeat, or a snooze (api/tasks.ts patchTaskTiming):
    // sealed for the server when it RUNS, like every other op, and always
    // `recurrence_aware`. A repeating tick carries `expect_due_at`, so a
    // replay that lost a race with another device's advance is refused
    // (409) and dropped with the usual toast, never applied twice.
    // A tick or advance also carries `expect_schedules_as_of` in its patch
    // (api/taskCompletion.ts): replayed as is, so a tick queued before
    // another device made the item repeat is refused (409, the same toast)
    // instead of ending the series. `scope` names the rows whose edits by
    // THIS device would outdate that stamp, and `stampClock` which edits of
    // them do (see `enqueue`; absent = `content`, what every op queued before
    // it meant). Ops queued by an older client have none of these and replay
    // exactly as they always did.
    | { k: 'timing'; note: NoteRef; taskId: number; createdBy: number; patch: TaskTimingPatch; scope?: number[]; stampClock?: StampClock }
    | { k: 'moveTask'; note: NoteRef; taskId: number; direction: 'up' | 'down' }
    | { k: 'reorderTask'; note: NoteRef; taskId: number; afterId: number | null; reparent?: { parentId: number | null } }
    | { k: 'deleteTask'; note: NoteRef; taskId: number }
    // The NOTE's own reminder (migration 068): a date set on a phone with
    // no signal is queued like every item date, not lost. Three-state, the
    // same patch api/listContent.ts sends.
    | { k: 'listTiming'; listId: number; patch: { dueAt?: string | null; schedule?: string | null } }
    | { k: 'prefs'; prefs: TaskTabPref[]; intent: PrefsIntent }
    // A note's own text. Queued ops for the same note COLLAPSE (see `send`):
    // NoteBodyField saves a pause after every keystroke, so a paragraph
    // typed with no connection would otherwise be dozens of ops racing to
    // overwrite each other.
    // `expectRev` is the revision the typing STARTED from (migration 069),
    // named inline AND on replay. A replay that loses to another device's
    // text does not throw the offline words away: they become a new note
    // (execOp below). Absent (an older server, a note made offline, an op
    // queued before 069) there is no check, as before.
    // `copyKey` is that note's create key, minted with the op (random, like
    // every create key — api/opKey.ts), so the copy is made once however
    // often the op replays. Replay swaps in the key this TYPING already used
    // (`OutboxState.copies`), so text typed on after a copy lands in that
    // copy rather than a new one. Optional: an op queued before it existed
    // is given one when it replays.
    // `copySent` is never stored: replay fills it in from the same record —
    // digests of the texts this typing sent under that key (`keepOfflineText`).
    | { k: 'setBody'; listId: number; body: string; expectRev?: number; copyKey?: string; copySent?: string[] }
    // Pictures and files sealed on this device (notesBlobs.ts) that still
    // have to go up. Running it uploads them, then adds the real refs to
    // whatever the server's sidecar holds THEN, naming the revision it read
    // — an intent, so a picture added elsewhere in the meantime is not
    // deleted by a stale replace. `refs` is this device's view of the
    // finished sidecar; it is no longer written anywhere (inline ran it as a
    // blind replace, which is exactly what dropped another device's picture)
    // and is kept only so ops already queued in a browser still parse.
    | { k: 'addMedia'; listId: number; blobIds: string[]; replacing: string[]; refs: TaskAttachmentRef[] }
    // Removing a picture: the same intent (and the same unused snapshot).
    | { k: 'removeMedia'; listId: number; removing: string[]; refs: TaskAttachmentRef[] };

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
    createList: (tempId: number, title: string) => withMeta({ k: 'createList', tempId, title, key: newOpKey() }, `new note ${q(title)}`),
    renameList: (listId: number, title: string, expectRev?: number) => withMeta({ k: 'renameList', listId, title, ...(expectRev === undefined ? {} : { expectRev }) }, `rename to ${q(title)}`),
    deleteList: (listId: number, title: string) => withMeta({ k: 'deleteList', listId }, `delete ${q(title)}`),
    restoreList: (listId: number, title: string) => withMeta({ k: 'restoreList', listId }, `restore ${q(title)}`),
    createTask: (note: NoteRef, tempId: number, description: string, parentId?: number, timing?: NewTaskTiming) =>
        withMeta({ k: 'createTask', note, tempId, description, parentId, ...(timing ? { timing } : {}), key: newOpKey() }, `new item ${q(description)}`),
    editTask: (note: NoteRef, task: Task, description: string) =>
        withMeta({ k: 'editTask', note, taskId: task.id, description, createdBy: task.created_by }, `edit ${q(description)}`),
    setDue: (note: NoteRef, task: Task, dueAt: string | null) =>
        withMeta({ k: 'updateTask', note, taskId: task.id, updates: { due_at: dueAt ?? '' } }, `due time on ${q(task.description)}`),
    move: (note: NoteRef, task: Task, direction: 'up' | 'down') =>
        withMeta({ k: 'moveTask', note, taskId: task.id, direction }, `move ${q(task.description)}`),
    reorder: (note: NoteRef, task: Task, afterId: number | null, reparent?: { parentId: number | null }) =>
        withMeta({ k: 'reorderTask', note, taskId: task.id, afterId, reparent }, `move ${q(task.description)}`),
    deleteTask: (note: NoteRef, taskId: number, description: string) =>
        withMeta({ k: 'deleteTask', note, taskId }, `delete ${q(description)}`),
    timing: (note: NoteRef, task: Task, patch: TaskTimingPatch, what: string, scope?: number[], stampClock?: StampClock) =>
        withMeta({ k: 'timing', note, taskId: task.id, createdBy: task.created_by, patch, ...(scope ? { scope } : {}), ...(scope && stampClock ? { stampClock } : {}) }, `${what} ${q(task.description)}`),
    setListTiming: (listId: number, title: string, patch: { dueAt?: string | null; schedule?: string | null }, what: string) =>
        withMeta({ k: 'listTiming', listId, patch }, `${what} ${q(title)}`),
    setBody: (listId: number, body: string, expectRev?: number) =>
        withMeta({ k: 'setBody', listId, body, expectRev, copyKey: newOpKey() }, body === '' ? 'clear a note’s text' : `text ${q(body)}`),
    addMedia: (listId: number, blobIds: string[], replacing: string[], refs: TaskAttachmentRef[], what: string) =>
        withMeta({ k: 'addMedia', listId, blobIds, replacing, refs }, what),
    removeMedia: (listId: number, removing: string[], refs: TaskAttachmentRef[], what: string) =>
        withMeta({ k: 'removeMedia', listId, removing, refs }, what),
    prefs: (prefs: TaskTabPref[], intent: PrefsIntent) =>
        withMeta({ k: 'prefs', prefs, intent }, intent.type === 'order' ? 'reorder notes' : `${intent.favorite ? 'pin' : 'unpin'} ${intent.type === 'pins' ? `${intent.tabs.length} notes` : 'a note'}`),
};

/** Which busy key (noteBusy.ts) an op holds. */
export function busyKeyOf(op: OpBody): string {
    switch (op.k) {
        case 'createList': case 'renameList': case 'deleteList': case 'restoreList': return LISTS_KEY;
        case 'listTiming': return noteKey({ kind: 'list', id: op.listId });
        case 'prefs': return PREFS_KEY;
        // The CARD, not the listing: what is unsynced is this one note.
        case 'setBody': case 'addMedia': case 'removeMedia': return noteKey({ kind: 'list', id: op.listId });
        default: return noteKey(op.note);
    }
}

/** Every id an op names that must be real on the server. */
function idsOf(op: OpBody): number[] {
    switch (op.k) {
        case 'createList': return [];
        case 'renameList': case 'deleteList': case 'restoreList': case 'listTiming': return [op.listId];
        case 'setBody': case 'addMedia': case 'removeMedia': return [op.listId];
        case 'createTask': return [op.note.id, ...(op.parentId !== undefined ? [op.parentId] : [])];
        case 'editTask': case 'updateTask': case 'moveTask': case 'deleteTask': case 'timing': return [op.note.id, op.taskId];
        case 'reorderTask': return [op.note.id, op.taskId, ...(op.afterId !== null ? [op.afterId] : []), ...(op.reparent?.parentId != null ? [op.reparent.parentId] : [])];
        case 'prefs': return op.intent.type === 'pin' ? [op.intent.tab.id] : op.intent.type === 'pins' ? op.intent.tabs.map(t => t.id) : [];
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

/** One ref `addMedia` put on the server, and the parked record it came
 *  from. What `execOp` answers for an `addMedia`. */
export interface AddedParked { id: string; ref: TaskAttachmentRef }

/** Run one op against the server. `fromQueue` = a replay: pins and order are
 *  re-derived from the server's current set instead of PUT as captured. */
export async function execOp(op: OpBody, idMap: IdMap, fromQueue: boolean, parked: ParkedStore = appParkedStore): Promise<unknown> {
    const r = (id: number): number => {
        if (id >= 0) return id;
        const real = idMap[String(id)];
        if (real === undefined) throw new UnresolvedTempId(id);
        return real;
    };
    const note = (n: NoteRef): NoteRef => ({ kind: n.kind, id: r(n.id) });
    switch (op.k) {
        case 'createList': {
            // op.key rides every attempt of THIS create, so a replay after a
            // lost answer is answered with the note it already made.
            const list = await createTaskList(op.title, op.key);
            idMap[String(op.tempId)] = list.id;
            return list;
        }
        case 'renameList': return renameTaskList(r(op.listId), op.title, fromQueue ? undefined : op.expectRev);
        // No expect_due_at on a replay: the compare-and-swap exists so two
        // devices advancing one reminder cannot both win, and a queued edit
        // the user made deliberately is not an advance. It is last-write-wins
        // like every other queued edit (this file's header).
        case 'listTiming': return setTaskListTiming(r(op.listId), op.patch);
        // The trash where the server has one (api/listContent.ts), probed at
        // the moment it runs — a queued delete replays against whatever
        // server answers then.
        case 'deleteList': return trashOrDeleteList(r(op.listId));
        case 'restoreList': return restoreTaskList(r(op.listId));
        case 'createTask': {
            const n = note(op.note);
            const parent = op.parentId === undefined ? undefined : r(op.parentId);
            const created = n.kind === 'channel'
                ? await createTask(n.id, op.description, parent, op.timing, op.key)
                : await createListTask(n.id, op.description, parent, op.timing, op.key);
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
        case 'timing': {
            const n = note(op.note);
            return patchTaskTiming({ id: r(op.taskId), channel_id: n.kind === 'channel' ? n.id : null, created_by: op.createdBy }, op.patch);
        }
        case 'setBody': {
            const listId = r(op.listId);
            try {
                return await setTaskListBody(listId, op.body, op.expectRev);
            } catch (err) {
                // Inline, a conflict is the editor's to show (Keep mine / Use
                // theirs). Off the queue there is no editor to ask.
                if (!fromQueue || !(err instanceof NoteConflictError)) throw err;
                return keepOfflineText(op, err);
            }
        }
        case 'addMedia': {
            const listId = r(op.listId);
            const records = await parked.read(op.blobIds);
            // Swept, or a database cleared under us: there is nothing left to
            // send, and the sidecar must not be rewritten from a stale
            // snapshot that still names the parked refs.
            if (records.length === 0) return undefined;
            const added = await uploadParkedMedia(records);
            try {
                // An INTENT, inline as on replay: added to the sidecar the
                // server holds NOW, named by the revision it was read at
                // (api/listContent.ts). `op.refs` — this device's snapshot —
                // is no longer written: a snapshot replaced blind dropped a
                // picture another device had added since it was taken.
                // `addNoteRefs` also deletes the uploads behind whatever the
                // replace dropped — nothing names those now, and leaving
                // them would charge the owner's quota for a picture no note
                // shows (api/noteMedia.ts holds that rule for both doors).
                await addNoteRefs(listId, added, op.replacing);
            } catch (err) {
                // A DEFINITE refusal wrote nothing, so nothing names the
                // uploads: do not leave them against the quota (the same
                // rule as uploadNoteMedia). A lost answer is different — the
                // server may hold a sidecar naming them, and deleting them
                // would leave that note a broken picture for good; the op
                // stays queued, and at worst the retry adds a second copy.
                if (isDefiniteRefusal(err)) await deleteFiles(fileIdsOf(added));
                throw err;
            }
            await parked.remove(op.blobIds);
            // PAIRED with the record each ref came from: `uploadParkedMedia`
            // answers one ref per record, in order. Replay needs that pairing
            // to take one picture back out again when a Remove landed while
            // this upload was in flight (`forgetParked` below).
            return records.map((rec, i): AddedParked => ({ id: rec.id, ref: added[i] }));
        }
        // The same intent inline and on replay (see addMedia): only what the
        // server really held is taken out, and only its uploads deleted.
        case 'removeMedia': return removeNoteRefs(r(op.listId), op.removing);
        case 'prefs': {
            if (!fromQueue) return putTaskTabPrefs(op.prefs);
            const current = await getTaskTabPrefs();
            const next = applyPrefsIntent(current, op.intent, idMap);
            return next === null ? undefined : putTaskTabPrefs(next);
        }
    }
}

/** What a replayed `setBody` answers when it kept the offline words as a
 *  new note: that note's title, for the toast, and the create key it was
 *  made under, for the next text of the same typing (`OutboxState.copies`). */
export interface OfflineCopy { offlineCopy: string; copyKey?: string }

export function isOfflineCopy(v: unknown): v is OfflineCopy {
    return typeof v === 'object' && v !== null && typeof (v as OfflineCopy).offlineCopy === 'string';
}

const COPY_SUFFIX = ' (offline copy)';

/** A digest standing for a text this device sent into an offline copy, so
 *  the queue's record can remember WHICH words without holding them twice
 *  (it is sealed on this device either way, and never sent). */
export async function textDigest(text: string): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    let bin = '';
    for (const b of d) bin += String.fromCharCode(b);
    return btoa(bin);
}

/**
 * A replayed text save lost to another device's text. Never throw the words
 * typed here away, and never write them over theirs:
 *  - the same text already there: nothing to do, it is saved;
 *  - a CLEAR: there are no words to keep, and clearing theirs is what the
 *    check exists to stop — refused, and listed in the replay's toast;
 *  - otherwise the offline words become a NEW note beside it, under the
 *    create key minted with the op (`copyKey`: random, never derived from
 *    what was typed or when — api/opKey.ts), so a replay whose answer was
 *    lost, run again, is answered with the copy already made rather than
 *    making a second.
 *
 * ONE COPY PER TYPING. The user types on after the copy's answer was lost
 * (or after the copy was made, on the same stale revision), and that text
 * replays under the SAME key (the queue's `copies` record). The server then
 * answers with the copy it already made — holding EARLIER words. Taking that
 * as done would lose the newer ones, so the answer is compared: the copy is
 * brought up to date (naming its revision) only while it still holds words
 * this typing sent under that key (`copySent`); a copy changed since by
 * anyone is left alone, and these words become a fresh copy.
 */
async function keepOfflineText(op: Extract<OpBody, { k: 'setBody' }>, err: NoteConflictError): Promise<number | OfflineCopy> {
    if ((err.body ?? '') === op.body) return err.contentRev;
    if (op.body === '') throw err;
    const opened = err.sealedTitle === null ? '' : await openSelfTaskText(err.sealedTitle);
    const base = !opened || isUndecryptable(opened) ? 'Note' : opened;
    const title = `${base.slice(0, MAX_TITLE_LENGTH - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
    const key = op.copyKey ?? newOpKey();
    const copy = await createTaskListWithContent(title, { body: op.body }, key);
    // Made now (or a server that says nothing about the text): done.
    if (copy.body === undefined || (copy.body ?? '') === op.body) return { offlineCopy: title, copyKey: key };
    // Binned since, or holding anything but this typing's own words: left
    // alone. A write the server REFUSES (changed under us, trashed, gone)
    // falls through to a fresh copy too — the words are never dropped; one
    // whose answer is lost is retried, and lands in the same copy.
    const inTrash = typeof copy.trashed_at === 'string' && copy.trashed_at !== '';
    if (!inTrash && typeof copy.content_rev === 'number' && typeof copy.body === 'string'
        && (op.copySent ?? []).includes(await textDigest(copy.body))) {
        try {
            await setTaskListBody(copy.id, op.body, copy.content_rev);
            return { offlineCopy: title, copyKey: key };
        } catch (e) {
            if (!(e instanceof NoteConflictError) && !isDefiniteRefusal(e)) throw e;
        }
    }
    const fresh = newOpKey();
    await createTaskListWithContent(title, { body: op.body }, fresh);
    return { offlineCopy: title, copyKey: fresh };
}

/** `l<listId>@<rev>` -> the copy key text typed on that revision of that note
 *  went into, and digests of the texts sent under it (`keepOfflineText`). */
export type OfflineCopies = Record<string, { key: string; sent: string[] }>;
const COPIES_NOTES = 32;
const COPIES_SENT = 8;

/** Remember that the text with `digest` went (or may have gone) into the copy
 *  made under `key` for text typed on `at`. Bounded, oldest first out. */
export function recordCopy(copies: OfflineCopies, at: string, key: string, digest: string): OfflineCopies {
    const prev = copies[at];
    const sent = prev && prev.key === key ? [...prev.sent.filter(d => d !== digest), digest].slice(-COPIES_SENT) : [digest];
    const next: OfflineCopies = { ...copies };
    delete next[at];
    next[at] = { key, sent };
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - COPIES_NOTES))) delete next[k];
    return next;
}

// --- The device's own revisions -----------------------------------------------------

/** `l<listId>` -> [from, to] pairs: revisions THIS device moved the note
 *  between. Keys are not integer-like, so insertion order is kept (and the
 *  oldest note is the one trimmed). */
export type OwnRevs = Record<string, Array<[number, number]>>;
const OWN_REVS_PER_NOTE = 8;
const OWN_REVS_NOTES = 64;

/** Record content writes this device landed. A write that named no
 *  revision moved the note by one, as every content write does (a sealed
 *  value is never byte-identical twice). */
export function addOwnRevs(revs: OwnRevs, writes: ContentWrite[]): OwnRevs {
    if (writes.length === 0) return revs;
    const next: OwnRevs = { ...revs };
    for (const w of writes) {
        const from = w.expectRev ?? w.rev - 1;
        if (from === w.rev) continue;
        const k = `l${w.listId}`;
        const pairs = (next[k] ?? []).filter(([f]) => f !== from);
        delete next[k];
        next[k] = [...pairs, [from, w.rev] as [number, number]].slice(-OWN_REVS_PER_NOTE);
    }
    const keys = Object.keys(next);
    for (const k of keys.slice(0, Math.max(0, keys.length - OWN_REVS_NOTES))) delete next[k];
    return next;
}

/** The revision `expectRev` became through this device's OWN writes. A gap
 *  another device made stops the walk, so a real conflict stays one. */
export function rebaseOnOwnRevs(revs: OwnRevs[], listId: number, expectRev: number): number {
    const step = new Map<number, number>();
    for (const r of revs) for (const [from, to] of r[`l${listId}`] ?? []) step.set(from, to);
    let rev = expectRev;
    const seen = new Set<number>();
    while (step.has(rev) && !seen.has(rev)) {
        seen.add(rev);
        rev = step.get(rev)!;
    }
    return rev;
}

/** A pin or order intent against the server's CURRENT set; null = nothing to do. */
export function applyPrefsIntent(current: TaskTabPref[], intent: PrefsIntent, idMap: IdMap = {}): TaskTabPref[] | null {
    const realTab = (t: TaskTabRef): TaskTabRef | null => {
        if (t.id >= 0) return t;
        const real = idMap[String(t.id)];
        return real === undefined ? null : { kind: t.kind, id: real };
    };
    const ordered: TaskTabRef[] = current.map(p => ({ kind: p.kind, id: p.ref_id }));
    if (intent.type === 'pins') {
        let next: TaskTabPref[] = current;
        let changed = false;
        for (const tab of intent.tabs) {
            const r = applyPrefsIntent(next, { type: 'pin', tab, favorite: intent.favorite }, idMap);
            if (r) { next = r; changed = true; }
        }
        return changed ? next : null;
    }
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
    // Entries the order does not name — a note in the trash, one this device
    // never saw — keep the index they hold on the server (keepHiddenSlots),
    // rather than all moving to the tail: a trashed note restored later comes
    // back where it was.
    const named = new Set(tabs.map(taskTabKey));
    const unnamed = new Set(ordered.map(taskTabKey).filter(k => !named.has(k)));
    return buildPrefsForOrder(keepHiddenSlots(tabs, current, unnamed), current);
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
    /** Revisions this device's own replayed writes moved notes between
     *  (`rebaseOnOwnRevs`). Optional: a record saved before this existed
     *  has none. */
    revs?: OwnRevs;
    /** The copy key each offline TYPING's text went into (`recordCopy`), so
     *  a later text of the same typing lands in the same copy. Optional, like
     *  `revs`. */
    copies?: OfflineCopies;
}

const EMPTY: OutboxState = { queue: [], ids: {}, dead: [], revs: {}, copies: {} };
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
    /** Ciphertext waiting to be uploaded (notesBlobs.ts): a dropped op's
     *  records are deleted with it, and load() sweeps what no op names. */
    parked: ParkedStore;
    /** Every content write this tab lands (api/listConflict.ts
     *  `watchContentWrites`), so the device's own revision bumps are not
     *  taken for another device's. Optional: without it nothing is rebased. */
    watchWrites?: (fn: (w: ContentWrite) => void) => () => void;
}

export interface ReplaySummary {
    sent: number;
    dropped: NoteOp[];
    /** Titles of the notes text typed offline was kept as, because the
     *  note's text had been changed elsewhere meanwhile. */
    copies: string[];
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
    /** Pictures and files still waiting to be uploaded. */
    pendingMedia(): number;
    queuedKeys(): Set<string>;
    /** The notes whose delete (a move to the trash) is still queued. The
     *  same Set until that changes, so it can be a store snapshot. */
    queuedListDeletes(): ReadonlySet<number>;
    subscribe(cb: () => void): () => void;
    load(): Promise<void>;
    /** Resolves once `pending()` reflects the PERSISTED queue. Until the
     *  load finishes it reads 0 whatever a previous page left behind, so
     *  anything that decides "nothing is waiting, run this directly" has to
     *  wait for this first — `send` already does. */
    ready(): Promise<void>;
    send<T>(op: NoteOp): Promise<{ queued: true } | { queued: false; value: T }>;
    replay(): Promise<ReplaySummary | undefined>;
    /** The id a temp id became, once its create has replayed. */
    realId(tempId: number): number | undefined;
    /** Forget parked media that will never be sent — a picture removed from
     *  the note before it got a connection. Drops it from any queued
     *  `addMedia` (and the op with it, once it names nothing) and deletes
     *  its ciphertext. */
    forgetParked(blobIds: string[]): Promise<void>;
}

export function createOutbox(deps: OutboxDeps): Outbox {
    let view: OutboxState = EMPTY;
    let deletes: ReadonlySet<number> = new Set();
    const listeners = new Set<() => void>();
    const publish = (s: OutboxState) => {
        view = s;
        const nextDeletes = new Set(s.queue.flatMap(o => (o.k === 'deleteList' ? [o.listId] : [])));
        if (nextDeletes.size !== deletes.size || [...nextDeletes].some(id => !deletes.has(id))) deletes = nextDeletes;
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
            return Array.isArray(s.queue) ? { queue: s.queue, ids: s.ids ?? {}, dead: s.dead ?? [], revs: s.revs ?? {}, copies: s.copies ?? {} } : EMPTY;
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

    /**
     * REMOVING A PICTURE WHOSE UPLOAD HAS OVERTAKEN THE SCREEN.
     *
     * `setNoteAttachments` queues nothing server-side for a picture it still
     * knows by its PARKED name (`puca-parked:<id>`): it only has to forget
     * the queued op that would have sent it. That holds for exactly as long
     * as the op is still queued — and it stops holding twice:
     *
     *  - while the op is IN FLIGHT. Both `send` and `replay` await `exec`
     *    outside the queue lock, and `addMedia` reads its ciphertext and
     *    uploads it before it writes the note's sidecar, so a Remove in that
     *    window rewrites a queued op that is about to be dropped by oid
     *    anyway. `forgottenInFlight` holds those ids until the href exists.
     *  - AFTER it lands, until the note's cached sidecar is re-read. Replay
     *    invalidates the queries only when the whole run ends, and the
     *    refetch is a request; until it answers, the editor still shows the
     *    parked name. `sentAs` holds what each parked id became, so a Remove
     *    in that window queues the real removal.
     *
     * Without both, the ref reaches the server with nothing left to take it
     * out again: the picture the user removed comes back on the next fetch,
     * and its upload is charged to their quota for good.
     */
    const inFlight = new Set<NoteOp>();
    const forgottenInFlight = new Set<string>();
    /** parked id -> the note it went to and the ref it became. Bounded: the
     *  window it covers is one refetch, so the oldest entries are long dead,
     *  and evicting one can at worst cost what this whole block prevents. */
    const sentAs = new Map<string, { listId: number; href: string }>();
    const SENT_AS_MAX = 256;

    // The device's own content writes: every one this tab lands, in memory
    // (a text save typed online, a picture added directly), and the ones a
    // REPLAY lands, which are also persisted with the queue so a reload
    // cannot forget them — text queued after a replay, on the revision the
    // cache still held, is judged against them too.
    let liveRevs: OwnRevs = {};
    let collecting: ContentWrite[] | null = null;
    deps.watchWrites?.(w => {
        liveRevs = addOwnRevs(liveRevs, [w]);
        collecting?.push(w);
    });

    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 2_000;
    const scheduleReplay = (ms: number) => {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => { retryTimer = null; void outbox.replay(); }, ms);
    };

    /** Queue the removal of whatever these parked ids became — one op per
     *  note. An INTENT, like every other removal: replayed against whatever
     *  the sidecar holds then. */
    const dropSent = async (ids: string[]) => {
        const byList = new Map<number, string[]>();
        for (const id of ids) {
            const sent = sentAs.get(id);
            if (!sent) continue;
            sentAs.delete(id);                      // once is enough
            byList.set(sent.listId, [...(byList.get(sent.listId) ?? []), sent.href]);
        }
        if (byList.size === 0) return;
        for (const [listId, hrefs] of byList) {
            const n = hrefs.length;
            await mutate(s => enqueue(s, ops.removeMedia(listId, hrefs, [], `remove ${n} picture${n === 1 ? '' : 's'}`)));
        }
        if (deps.online()) scheduleReplay(0);
    };

    /** Run one op, remembering it while it is out; then record what its
     *  uploads became, and take back out of the note anything a Remove
     *  forgot while there was no href yet to name. */
    const execTracked = async (op: NoteOp, ids: IdMap, fromQueue: boolean): Promise<unknown> => {
        inFlight.add(op);
        let value: unknown;
        try {
            value = await deps.exec(op, ids, fromQueue);
        } catch (err) {
            // It never landed: whatever `forgetParked` rewrote in the QUEUE
            // (the op is still in it while it is out) is the whole answer.
            if (op.k === 'addMedia') for (const id of op.blobIds) forgottenInFlight.delete(id);
            throw err;
        } finally {
            inFlight.delete(op);
        }
        if (op.k !== 'addMedia') return value;
        for (const a of (Array.isArray(value) ? value as AddedParked[] : [])) {
            sentAs.set(a.id, { listId: op.listId, href: a.ref.href });
            if (sentAs.size > SENT_AS_MAX) {
                const oldest = sentAs.keys().next().value;
                if (oldest !== undefined) sentAs.delete(oldest);
            }
        }
        // `delete` answers whether it was there: these are the ids a Remove
        // named while this very op was out.
        const late = op.blobIds.filter(id => forgottenInFlight.delete(id));
        if (late.length > 0) await dropSent(late);
        return value;
    };

    // Which account's persisted queue `view` reflects, and the load under
    // way. Until the queue is loaded `view` is EMPTY, and an online op sent in
    // that window must not run ahead of ops a previous page left queued.
    let loadedFor: number | null = null;
    let loading: { sub: number; p: Promise<void> } | null = null;
    const ensureLoaded = (sub: number): Promise<void> => {
        if (loadedFor === sub) return Promise.resolve();
        if (loading && loading.sub === sub) return loading.p;
        return outbox.load();
    };

    const outbox: Outbox = {
        pending: () => view.queue.length,
        pendingMedia: () => view.queue.reduce((n, o) => n + (o.k === 'addMedia' ? o.blobIds.length : 0), 0),
        queuedKeys: () => queuedKeysOf(view),
        queuedListDeletes: () => deletes,
        subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb); }; },
        realId: tempId => view.ids[String(tempId)],

        async forgetParked(blobIds) {
            if (blobIds.length === 0) return;
            const drop = new Set(blobIds);
            // An op already out cannot be rewritten; it is answered when it
            // lands. One that has ALREADY landed is answered now, by the ref
            // it became — the editor named it `puca-parked:` only because the
            // replay's refetch has not reached it yet.
            for (const op of inFlight) {
                if (op.k !== 'addMedia') continue;
                for (const id of op.blobIds) if (drop.has(id)) forgottenInFlight.add(id);
            }
            await dropSent(blobIds);
            const next = await mutate(s => ({
                ...s,
                queue: s.queue.flatMap((o): NoteOp[] => {
                    if (o.k !== 'addMedia') return [o];
                    const kept = o.blobIds.filter(id => !drop.has(id));
                    if (kept.length === o.blobIds.length) return [o];
                    // Nothing left to send: the op goes too, or replay would
                    // rewrite the sidecar for no reason.
                    return kept.length === 0 ? [] : [{ ...o, blobIds: kept }];
                }),
            }));
            const still = queuedBlobIds(next);
            await deps.parked.remove(blobIds.filter(id => !still.has(id)));
        },

        load() {
            const c = ctx();
            if (!c || !c.kv) { publish(EMPTY); loadedFor = c ? c.sub : null; return Promise.resolve(); }
            const kv = c.kv;
            const sub = c.sub;
            const p = (async () => {
                let state = EMPTY;
                try {
                    state = await deps.lock(`pucaNotesOutbox:${sub}`, () => read(sub, c.id, kv)) ?? EMPTY;
                    publish(state);
                } catch {
                    publish(EMPTY);
                }
                loadedFor = sub;
                // Bytes no op names are nobody's: a page that died mid-park,
                // or a queue cleared by a sign-in as the same account again.
                try { await deps.parked.sweep(queuedBlobIds(state)); } catch { /* online-only */ }
            })().finally(() => { if (loading?.p === p) loading = null; });
            loading = { sub, p };
            return p;
        },

        ready() {
            const c = ctx();
            return c ? ensureLoaded(c.sub) : Promise.resolve();
        },

        async send<T>(op: NoteOp) {
            const c0 = ctx();
            if (c0) await ensureLoaded(c0.sub);
            const mustQueue = view.queue.length > 0 || referencesTemp(op) || !deps.online();
            if (mustQueue) {
                await mutate(s => enqueue(s, op));
                if (deps.online()) scheduleReplay(0);
                return { queued: true as const };
            }
            const done = beginNoteWrite(busyKeyOf(op));
            try {
                const value = await execTracked(op, { ...view.ids }, false) as T;
                return { queued: false as const, value };
            } catch (err) {
                if (!isNetworkError(err)) throw err;
                // Never reached the server: keep it, and keep the screen as is.
                await mutate(s => enqueue(s, op));
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
                const summary: ReplaySummary = { sent: 0, dropped: [], copies: [], created: {}, touchedDue: false };
                for (;;) {
                    const state = await mutate(s => s);   // re-read: another tab may have changed it
                    const head = state.queue[0];
                    if (!head) break;
                    const dropHead = async (dead?: number) => {
                        const next = await mutate(s => ({
                            ...s,
                            queue: s.queue.filter(o => o.oid !== head.oid),
                            dead: dead === undefined ? s.dead : [...s.dead, dead],
                        }));
                        // Its ciphertext is what nobody will ever name again.
                        if (head.k === 'addMedia') {
                            const still = queuedBlobIds(next);
                            await deps.parked.remove(head.blobIds.filter(id => !still.has(id))).catch(() => undefined);
                        }
                        return next;
                    };
                    if (idsOf(head).some(id => state.dead.includes(id))) {
                        summary.dropped.push(head);
                        await dropHead(head.k === 'createTask' || head.k === 'createList' ? head.tempId : undefined);
                        continue;
                    }
                    const ids = { ...state.ids };
                    // Text queued on revision N, behind this device's own
                    // writes that moved the note to N+k, is sent as N+k: only
                    // another device's write is a conflict.
                    let run: NoteOp = head;
                    // Text typed on one revision of one note is ONE typing:
                    // every text of it that loses goes into the same copy
                    // (keepOfflineText), under the key recorded here.
                    let copyAt: string | null = null;
                    if (head.k === 'setBody' && head.expectRev !== undefined) {
                        const real = head.listId < 0 ? ids[String(head.listId)] : head.listId;
                        if (real !== undefined) {
                            const rebased = rebaseOnOwnRevs([state.revs ?? {}, liveRevs], real, head.expectRev);
                            copyAt = `l${real}@${head.expectRev}`;
                            const prior = state.copies?.[copyAt];
                            run = {
                                ...head,
                                expectRev: rebased,
                                copyKey: prior?.key ?? head.copyKey ?? newOpKey(),
                                ...(prior ? { copySent: prior.sent } : {}),
                            };
                        }
                    }
                    const noteCopy = async (key: string) => {
                        if (copyAt === null || head.k !== 'setBody') return;
                        const at = copyAt;
                        const digest = await textDigest(head.body);
                        await mutate(s => ({ ...s, copies: recordCopy(s.copies ?? {}, at, key, digest) }));
                    };
                    const done = beginNoteWrite(busyKeyOf(head));
                    const writes: ContentWrite[] = [];
                    try {
                        collecting = writes;
                        let value: unknown;
                        try {
                            value = await execTracked(run, ids, true);
                        } finally {
                            collecting = null;
                        }
                        summary.sent++;
                        if (isOfflineCopy(value)) {
                            summary.copies.push(value.offlineCopy);
                            const key = value.copyKey ?? (run.k === 'setBody' ? run.copyKey : undefined);
                            if (key) await noteCopy(key);
                        }
                        if (head.k === 'createTask' || head.k === 'createList') {
                            const real = ids[String(head.tempId)];
                            if (real !== undefined) summary.created[String(head.tempId)] = real;
                        }
                        if ((head.k === 'updateTask' && head.updates.due_at !== undefined) || head.k === 'timing' || head.k === 'listTiming' || (head.k === 'createTask' && head.timing)) summary.touchedDue = true;
                        await mutate(s => ({
                            ...s,
                            ids: { ...s.ids, ...ids },
                            queue: s.queue.filter(o => o.oid !== head.oid),
                            revs: addOwnRevs(s.revs ?? {}, writes),
                        }));
                        backoffMs = 2_000;
                    } catch (err) {
                        const status = err instanceof ApiError ? err.status : undefined;
                        // Text that may have made (or updated) its copy before
                        // the answer was lost: the next text of this typing
                        // must go into that one, whatever becomes of this op.
                        if (run.k === 'setBody' && run.copyKey && !isDefiniteRefusal(err)) {
                            await noteCopy(run.copyKey).catch(() => undefined);
                        }
                        if (isNetworkError(err)) {
                            scheduleReplay(backoffMs);
                            backoffMs = Math.min(backoffMs * 2, 60_000);
                            break;
                        }
                        if (status === 401) break;   // the session ended; wait for this account to sign in
                        // A picture add or removal that lost its race with
                        // another device a few times running. An intent is
                        // always safe to run again and always converges, so it
                        // stays queued and is retried with backoff. Filed as
                        // "refused" (NoteConflictError is not an ApiError) it
                        // was dropped, and an add's parked picture with it.
                        if (err instanceof NoteConflictError && (head.k === 'addMedia' || head.k === 'removeMedia')) {
                            scheduleReplay(backoffMs);
                            backoffMs = Math.min(backoffMs * 2, 60_000);
                            break;
                        }
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

/** Every parked record the queue still names. */
export function queuedBlobIds(s: OutboxState): Set<string> {
    return new Set(s.queue.flatMap(o => (o.k === 'addMedia' ? o.blobIds : [])));
}

/** Does this queued op move `clock` on one of `ids` on the server?
 *
 *  `content` (updated_at, a server older than migration 071): any change —
 *  its text, tick, date, place in the tree, or a new item hung under it.
 *
 *  `schedule` (071's schedule_changed_at): only what moves that clock — a
 *  schedule written, a tick changed (or a subtree reopened under it), a new
 *  parent, a new item. Its text, a due time, a snooze, a slot among its
 *  siblings and a delete (the row goes with its whole subtree, moving no
 *  surviving row's clock) leave the stamp standing, so a tick queued behind
 *  "edit its text offline" is still checked when it replays. */
function touchesAny(o: OpBody, ids: Set<number>, clock: StampClock = 'content'): boolean {
    if (clock === 'schedule') {
        switch (o.k) {
            case 'updateTask':
                return o.updates.is_completed !== undefined && ids.has(o.taskId);
            case 'timing':
                return timingPatchMovesClock(o.patch) && ids.has(o.taskId);
            case 'reorderTask':
                return o.reparent !== undefined && (ids.has(o.taskId) || (o.reparent.parentId != null && ids.has(o.reparent.parentId)));
            case 'createTask':
                return ids.has(o.tempId) || (o.parentId !== undefined && ids.has(o.parentId));
            default:
                return false;
        }
    }
    switch (o.k) {
        case 'editTask': case 'updateTask': case 'timing': case 'deleteTask': case 'moveTask':
            return ids.has(o.taskId);
        case 'reorderTask':
            return ids.has(o.taskId) || (o.reparent?.parentId != null && ids.has(o.reparent.parentId));
        case 'createTask':
            return ids.has(o.tempId) || (o.parentId !== undefined && ids.has(o.parentId));
        default:
            return false;
    }
}

/**
 * Append an op — EXCEPT a second `setBody` for the same note, which replaces
 * the queued one IN PLACE (keeping its position, so it still replays behind
 * the create of a note made offline). NoteBodyField saves a pause after
 * every keystroke; without this, a paragraph typed on a plane is dozens of
 * ops, each overwriting the last, and the queue count is nonsense.
 */
export function enqueue(s: OutboxState, op: NoteOp): OutboxState {
    // A freshness stamp (api/taskCompletion.ts) is this device's view as of
    // the moment it was planned — which already includes its own edits still
    // waiting in this queue. When those replay first they move the very
    // stamps the server compares, and it cannot tell them from another
    // device's: a queued untick-then-tick of a dated item, or a date set and
    // then ticked, would be refused and lost. So the stamp goes when the
    // queue already holds an edit of a row it covers that moves the clock
    // the stamp was read from (`stampClock`, touchesAny); the tick replays
    // unchecked, as every queued tick did before the stamp existed. On a
    // 071+ server that is only a schedule, tick or parent change, so "edit
    // its text offline, then tick it" keeps its stamp and is still refused
    // if another device made the item repeat meanwhile.
    if (op.k === 'timing' && op.patch.expect_schedules_as_of !== undefined && op.scope) {
        const scope = new Set(op.scope);
        const clock = op.stampClock ?? 'content';
        if (s.queue.some(o => touchesAny(o, scope, clock))) {
            const patch = { ...op.patch };
            delete patch.expect_schedules_as_of;
            op = { ...op, patch };
        }
    }
    if (op.k === 'setBody') {
        const i = s.queue.findIndex(o => o.k === 'setBody' && o.listId === op.listId);
        if (i >= 0) {
            const queue = [...s.queue];
            // The INDEX is what keeps the order; the replacement keeps its
            // own oid. Reusing the old one lost the last thing the user
            // typed: `replay` awaits `exec(head)` OUTSIDE the queue lock, so
            // a save that collapses in while the head is in flight would be
            // deleted by the success filter (`oid !== head.oid`) — and by
            // dropHead on a 403 — as though it were the op that just ran.
            // With a fresh oid both are no-ops and the newer text replays next.
            queue[i] = op;
            return { ...s, queue };
        }
    }
    return { ...s, queue: [...s.queue, op] };
}

// --- The app's instance --------------------------------------------------------------

let appQc: QueryClient | null = null;

/** What the app does after a replay: the toasts, the refetch, the temp ids.
 *  Exported for its tests. */
export function onReplayed(summary: ReplaySummary): void {
    if (summary.touchedDue) pokeTaskReminders();
    if (summary.dropped.length > 0) {
        const n = summary.dropped.length;
        const what = summary.dropped.map(o => o.label).join('; ');
        pushMessageToast({ title: `${n} change${n === 1 ? '' : 's'} made offline couldn’t be saved: ${what.slice(0, 160)}` });
    }
    if (summary.copies.length > 0) {
        // Nothing was lost, but the user must be told where their words went —
        // and that it was the NOTE's text that changed elsewhere, not theirs.
        const n = summary.copies.length;
        const names = summary.copies.map(q).join(', ');
        const whose = n === 1 ? 'A note’s text was' : `${n} notes’ text was`;
        pushMessageToast({ title: `${whose} changed on another device before what you typed here was saved, so your words were kept as ${n === 1 ? 'a new note' : 'new notes'}: ${names.slice(0, 160)}` });
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
    parked: appParkedStore,
    watchWrites: watchContentWrites,
});

/** Run (or queue) one note op. See the module header. */
export function sendNoteOp<T = unknown>(op: NoteOp): Promise<{ queued: true } | { queued: false; value: T }> {
    return appOutbox.send<T>(op);
}

/** Create an item, or queue its creation and hand back a temporary one. */
export async function sendCreateTask(note: NoteRef, description: string, parentId: number | undefined, siblings: () => Task[], timing?: NewTaskTiming): Promise<Task> {
    const tempId = newTempId();
    const r = await sendNoteOp<Task>(ops.createTask(note, tempId, description, parentId, timing));
    if (!r.queued) return r.value;
    return queuedTaskStandIn(note, tempId, description, parentId, siblings(), timing);
}

/** What a queued create shows until it replays: a temporary item, with the
 *  date it was made with (a calendar tap-to-add) so it stays on that day. */
export function queuedTaskStandIn(note: NoteRef, tempId: number, description: string, parentId: number | undefined, siblings: Task[], timing?: NewTaskTiming): Task {
    const me = currentUserIdFromToken() ?? 0;
    const position = siblings.reduce((m, t) => Math.max(m, t.position), 0) + 1;
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
        due_at: timing?.dueAt ?? null,
        ...(timing?.schedule !== undefined ? { schedule: timing.schedule } : {}),
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

/**
 * Await before reading `pendingOutboxCount()` to decide whether something
 * may run directly. The count is 0 until the persisted queue has loaded, so
 * a note made in the first moments after a reload would otherwise be sent
 * straight to the server, ahead of everything the previous page queued —
 * exactly the overtaking `send`'s own cold-start wait exists to prevent.
 */
export function ensureOutboxLoaded(): Promise<void> {
    return appOutbox.ready();
}

/** Forget parked media removed from a note before it could be sent. */
export function forgetParkedMedia(blobIds: string[]): Promise<void> {
    return appOutbox.forgetParked(blobIds);
}

/** Pictures and files still waiting for a connection. */
export function useOutboxPendingMedia(): number {
    return useSyncExternalStore(appOutbox.subscribe, appOutbox.pendingMedia, () => 0);
}

/** Whether a card has changes that have not reached the server. */
export function useNoteUnsynced(key: string): boolean {
    return useSyncExternalStore(appOutbox.subscribe, () => appOutbox.queuedKeys().has(key), () => false);
}

/** Notes whose move to the trash has not reached the server yet: the Trash
 *  view lists them (deleteNote puts them there at once) but must not restore
 *  or delete them for good until it has — a direct call would run BEFORE the
 *  queued trash and be undone by it. */
export function useQueuedListDeletes(): ReadonlySet<number> {
    return useSyncExternalStore(appOutbox.subscribe, appOutbox.queuedListDeletes, appOutbox.queuedListDeletes);
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
