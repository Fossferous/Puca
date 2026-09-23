/**
 * Púca Notes' list content, over the task API: a personal list's note text
 * and note-level photos/drawings (sealed to self — api/listSeal.ts), and the
 * trash (src/list_content.rs). Shared by Púca Notes and Púca's Tasks view so
 * the two front doors cannot disagree.
 *
 * VERSION SKEW. Everything here is gated on `fetchListFeatures()`, which asks
 * the server what it supports without depending on the account having any
 * lists. A server older than migration 065 answers that route with a 404/405
 * and gets `NO_LIST_FEATURES`: no text or photo notes are offered, and delete
 * stays today's immediate, permanent delete. Any OTHER failure (offline, a
 * 5xx) throws, so a caller never mistakes a bad moment for an old server and
 * falls back to the permanent delete.
 */
import { apiClient, ApiError, markNotSent } from './client';
import {
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    type TaskTabPref,
    type TaskTabRef,
    buildPrefsForOrder,
    deleteTaskList,
    isFavoriteTab,
    listListTasks,
    listTaskLists,
    openSelfTaskText,
    parseTaskAttachments,
    serializeTaskAttachments,
    isAttachmentsLocked,
    taskTabKey,
} from './tasks';
import { openListContent, sealSelfField } from './listSeal';
import { NoteConflictError, patchListContent } from './listConflict';
export { NoteConflictError } from './listConflict';
import { MAX_READABLE_ENVELOPE_VERSION, messageEncState } from './e2ee';
import { parseEncAttachment } from './attachments';
import { withoutParked } from './parkedMedia';
import { parseServerTimestamp } from '../utils/serverTime';

export interface ListFeatures {
    body: boolean;
    attachments: boolean;
    trash: boolean;
    /** The NOTE itself can carry a reminder (migration 068): `due_at` and a
     *  sealed `schedule` on the list, and a `-list_id` row in the reminder
     *  feed. A listing cannot be read as this probe — a 067 server and a 068
     *  one look identical for an account whose notes have no reminder yet. */
    noteReminders: boolean;
    /** 0 = the server keeps trash until it is emptied. */
    trashRetentionDays: number;
    maxBodyLen: number;
    /** The server's clock minus this device's, in ms, measured when the
     *  answer arrived (`server_now_ms`); null when the server did not say.
     *  Anything that decides "this trash has expired" uses the SERVER's
     *  clock (`serverNowFrom`): a phone whose clock runs ahead must not
     *  delete the owner's trash early. */
    serverClockOffsetMs: number | null;
    /** Migration 069: every note carries a content revision, and a save may
     *  name the one it was based on. False = the server does not check, so
     *  the last save wins as it always did. */
    contentRev: boolean;
    /** Migration 070: a create may carry a random id, so a create whose
     *  answer was lost is not made twice.
     *
     *  The KEY is deliberately not gated on it, unlike every other flag
     *  here. It is a short random field an older server drops on the floor,
     *  so sending it unconditionally is byte-for-byte the old behaviour there
     *  and needs no probe; gating would only add a way to stop sending it.
     *  The one reader is `mayReuseHeldUploads` below: a retry re-sends the
     *  uploads an earlier attempt made only to a server that de-duplicates
     *  (the server's matching `op_key` entry in GET /task-features says the
     *  same for the item routes). No reader may become "skip the key". */
    idempotentCreates: boolean;
}

export const NO_LIST_FEATURES: ListFeatures = Object.freeze({
    body: false,
    attachments: false,
    trash: false,
    noteReminders: false,
    trashRetentionDays: 0,
    maxBodyLen: 0,
    serverClockOffsetMs: null,
    contentRev: false,
    idempotentCreates: false,
});

/** Parse the features answer. Anything malformed reads as "not supported"
 *  field by field — never as supported. `receivedAt` is this device's clock
 *  when the answer arrived. */
export function parseListFeatures(raw: unknown, receivedAt: number = Date.now()): ListFeatures {
    if (typeof raw !== 'object' || raw === null) return NO_LIST_FEATURES;
    const o = raw as Record<string, unknown>;
    const days = typeof o.trash_retention_days === 'number' && Number.isFinite(o.trash_retention_days) && o.trash_retention_days >= 0
        ? Math.floor(o.trash_retention_days) : 0;
    const maxBody = typeof o.max_body_len === 'number' && o.max_body_len > 0 ? Math.floor(o.max_body_len) : 0;
    const serverNow = typeof o.server_now_ms === 'number' && Number.isFinite(o.server_now_ms) && o.server_now_ms > 0 ? o.server_now_ms : null;
    return {
        body: o.body === true && maxBody > 0,
        attachments: o.attachments === true,
        trash: o.trash === true,
        noteReminders: o.note_reminders === true,
        trashRetentionDays: days,
        maxBodyLen: maxBody,
        serverClockOffsetMs: serverNow === null ? null : serverNow - receivedAt,
        contentRev: o.content_rev === true,
        idempotentCreates: o.idempotent_creates === true,
    };
}

/** The server's "now", or null when the server has not told us its clock. */
export function serverNowFrom(features: Pick<ListFeatures, 'serverClockOffsetMs'>, localNow: number = Date.now()): number | null {
    return features.serverClockOffsetMs === null ? null : localNow + features.serverClockOffsetMs;
}

/**
 * RE-SENDING A CREATE'S UPLOADS. A create whose answer was lost keeps its
 * uploads (the server may have made the note, and its sealed sidecar names
 * them) and its key. Whether the user's retry may send those SAME uploads
 * again depends on whether the server will answer it with the note it
 * already made:
 *  - a server that does not de-duplicate creates (older than 070) makes a
 *    SECOND note. Two notes naming the same files is a delayed loss: binning
 *    the duplicate and emptying the trash deletes the files, and the note
 *    that was kept loses its pictures for good;
 *  - a 070 server forgets a key after NOTES_OP_KEY_RETENTION_HOURS (at least
 *    one hour, whatever the operator sets; 0 = never), and then does the same.
 * So the uploads are re-sent only when the server says it de-duplicates AND
 * the hold is younger than the shortest window any server can have. Anything
 * else re-uploads — and deletes nothing, since the first attempt's uploads
 * may still be named. The KEY is kept regardless: where the server still has
 * it, it answers with the note it already made and the fresh uploads are
 * merely unused.
 *
 * Why the hold's age bounds the key's: every note that could name the held
 * uploads was created by a request sent AFTER they were held, and its key
 * row is no older than that request — so a hold younger than an hour has no
 * key row older than an hour. Measured on both clocks, so neither a wall
 * clock set back nor a monotonic clock paused through sleep shortens it.
 */
export const HELD_UPLOADS_MAX_AGE_MS = 50 * 60_000;

export interface HeldUploadsClock { heldAt: number; heldAtMono: number }

const monoNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Stamp a hold as made now. */
export function heldUploadsClock(): HeldUploadsClock {
    return { heldAt: Date.now(), heldAtMono: monoNow() };
}

/** May a retry re-send the uploads held since `held`? See above. `features`
 *  null = not known, which is a no. */
export function mayReuseHeldUploads(held: HeldUploadsClock, features: Pick<ListFeatures, 'idempotentCreates'> | null): boolean {
    if (features?.idempotentCreates !== true) return false;
    const age = Math.max(Date.now() - held.heldAt, monoNow() - held.heldAtMono);
    return age >= 0 && age < HELD_UPLOADS_MAX_AGE_MS;
}

/** What the server supports. 404/405 = a server older than 065 (the path
 *  falls through to `/task-lists/:id`, which has no GET). Other failures
 *  throw — see the header. */
export async function fetchListFeatures(): Promise<ListFeatures> {
    try {
        return parseListFeatures(await apiClient.get('/task-lists/features'));
    } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return NO_LIST_FEATURES;
        throw err;
    }
}

// --- Note text and note-level attachments ---------------------------------------------

/** Replace a list's note text; '' clears it. `expectRev` is the note's
 *  `content_rev` this save is based on — a mismatch throws NoteConflictError
 *  and nothing is written (api/listConflict.ts). Omit it (and every client
 *  older than migration 069 does) for today's last-write-wins. Resolves to
 *  the note's new revision, or null from a server that has none. */
export async function setTaskListBody(listId: number, body: string, expectRev?: number): Promise<number | null> {
    const sealed = body === '' ? '' : await sealSelfField(body);
    return patchListContent(listId, {
        body: sealed,
        ...(expectRev === undefined ? {} : { expect_rev: expectRev }),
    });
}

/** The NOTE's own reminder (migration 068), over the same PATCH the title
 *  and body use. Three-state throughout, exactly as the task timing patch is:
 *  a field left out is kept, `null` clears it, a value sets it.
 *
 *  `schedule` is sealed HERE (encrypt-to-self), so no caller can hand the
 *  server a plaintext one by mistake; `expectDueAt` is the compare-and-swap
 *  that stops two devices advancing the same reminder (409 when it loses). */
export async function setTaskListTiming(
    listId: number,
    patch: { dueAt?: string | null; schedule?: string | null; expectDueAt?: string | null },
): Promise<void> {
    const body: Record<string, string | number> = { reads_up_to: MAX_READABLE_ENVELOPE_VERSION };
    if (patch.dueAt !== undefined) body.due_at = patch.dueAt ?? '';
    if (patch.schedule !== undefined) body.schedule = patch.schedule === null ? '' : await sealSelfField(patch.schedule);
    if (patch.expectDueAt !== undefined) body.expect_due_at = patch.expectDueAt ?? '';
    return apiClient.patch(`/task-lists/${listId}`, body);
}

/**
 * Replace a list's own attachment refs; an empty array clears them.
 * `expectRev` as for setTaskListBody.
 *
 * Anything still parked on this device (api/noteMedia.ts) is dropped first:
 * a `puca-parked:` href names bytes only this device holds, and sealing one
 * into the sidecar would give every other device a ref it can never open.
 * The queued `addMedia` op puts the real ref there when the bytes go up.
 */
export async function setTaskListAttachments(listId: number, refs: TaskAttachmentRef[], expectRev?: number): Promise<number | null> {
    const real = withoutParked(refs);
    let sealed: string;
    try {
        sealed = real.length === 0 ? '' : await sealSelfField(serializeTaskAttachments(real));
    } catch (err) {
        throw markNotSent(err);   // nothing has left this device
    }
    return patchListContent(listId, {
        attachments: sealed,
        ...(expectRev === undefined ? {} : { expect_rev: expectRev }),
    });
}

/** A list's OWN sidecar as the SERVER holds it now, opened, and the
 *  revision it was read at (`content_rev`, migration 069) — undefined from a
 *  server older than 069, which lists none. Null when the list is gone, or
 *  its sidecar cannot be read on this device (a locked identity: writing
 *  over refs we cannot read would orphan them). */
export async function fetchListSidecar(listId: number): Promise<{ refs: TaskAttachmentRef[]; rev: number | undefined } | null> {
    const list = (await listTaskLists()).find(l => l.id === listId);
    if (!list) return null;
    const opened = list.attachments ?? null;
    if (isAttachmentsLocked(opened)) return null;
    return { refs: parseTaskAttachments(opened), rev: typeof list.content_rev === 'number' ? list.content_rev : undefined };
}

/** Attempts an intent makes before it gives up on a note that keeps moving. */
const SIDECAR_ATTEMPTS = 3;

/**
 * Read the sidecar, compute the next one from THAT read, and write it naming
 * the revision it was read at — re-reading and re-applying when another
 * device wrote in between (a stale 409, NoteConflictError). An intent is
 * always safe to re-apply, so the race is simply run again.
 *
 * Without the revision, two devices replaying at once each read [x], and the
 * second write of [x, b] silently dropped the first's [x, a] — and with it
 * the key to `a`, which lives only in that ref.
 *
 * `plan` answers null when there is nothing to write. After the last lost
 * race the conflict itself is thrown — never a blind write; the outbox keeps
 * the op queued (notesOutbox.ts). Only a STALE revision is retried: a 409 for
 * a trashed note or an envelope downgrade is not a NoteConflictError and
 * goes straight back to the caller. A failure while READING is marked as not
 * sent: no write of this intent has landed.
 */
async function applySidecarIntent<T>(
    listId: number,
    plan: (current: TaskAttachmentRef[]) => { next: TaskAttachmentRef[]; answer: T } | { next: null; answer: T },
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        let read: Awaited<ReturnType<typeof fetchListSidecar>>;
        try {
            read = await fetchListSidecar(listId);
        } catch (err) {
            throw markNotSent(err);
        }
        if (read === null) throw markNotSent(new NoteFilesUnreadableError());
        const step = plan(read.refs);
        if (step.next === null) return step.answer;
        try {
            await setTaskListAttachments(listId, step.next, read.rev);
            return step.answer;
        } catch (err) {
            // No revision was named (an older server): nothing to retry.
            if (!(err instanceof NoteConflictError) || read.rev === undefined || attempt >= SIDECAR_ATTEMPTS) throw err;
        }
    }
}

/**
 * Add refs to whatever the server holds NOW, optionally dropping some — an
 * INTENT, not a snapshot. A replayed full replace would silently delete a
 * picture another device added in the meantime (and strand its upload); this
 * cannot, because it never names refs it did not just read, and it names the
 * revision it read them at.
 *
 * Returns the refs it actually DROPPED — never the ones it was merely asked
 * to drop, and only those the WINNING attempt dropped. Those uploads are
 * nobody's now, and the caller deletes them (api/noteMedia.ts
 * `addNoteRefs`); a ref the server no longer held is not among them, so a
 * picture another device still names is never destroyed.
 *
 * A ref that is ALREADY there (an earlier attempt of this same add landed
 * but its answer was lost) is not added twice.
 */
export async function addTaskListAttachments(listId: number, added: TaskAttachmentRef[], replacing: string[] = []): Promise<TaskAttachmentRef[]> {
    return applySidecarIntent(listId, current => {
        const drop = new Set(replacing);
        const have = new Set(current.map(r => r.href));
        const dropped = current.filter(r => drop.has(r.href));
        const fresh = added.filter(r => !have.has(r.href));
        if (dropped.length === 0 && fresh.length === 0) return { next: null, answer: [] };
        return { next: [...current.filter(r => !drop.has(r.href)), ...fresh], answer: dropped };
    });
}

/** Remove refs from whatever the server holds now — the same intent form,
 *  and the same answer: the refs actually taken out. */
export async function removeTaskListAttachments(listId: number, removing: string[]): Promise<TaskAttachmentRef[]> {
    return applySidecarIntent(listId, current => {
        const drop = new Set(removing);
        const gone = current.filter(r => drop.has(r.href));
        if (gone.length === 0) return { next: null, answer: [] };   // already gone: nothing to say
        return { next: current.filter(r => !drop.has(r.href)), answer: gone };
    });
}

/** Create a list with its title, and optionally its note text and refs, in
 *  one request (so a photo note never exists without its photo). `opKey` is
 *  this create's random id (api/opKey.ts): held across the caller's retries,
 *  it stops a create whose answer was lost from making a second note. */
export async function createTaskListWithContent(
    title: string,
    content: { body?: string; refs?: TaskAttachmentRef[] },
    opKey?: string,
): Promise<TaskList> {
    const payload: Record<string, string> = {};
    try {
        payload.title = await sealSelfField(title);
        if (content.body) payload.body = await sealSelfField(content.body);
        if (content.refs && content.refs.length > 0) payload.attachments = await sealSelfField(serializeTaskAttachments(content.refs));
    } catch (err) {
        // Nothing has left this device: the caller may take its uploads back.
        throw markNotSent(err);
    }
    // POST /task-lists also accepts `due_at` and `schedule` (migration 068),
    // so a composer that offers a reminder can create a reminding note in ONE
    // request. Nothing offers that yet, so nothing sends them here.
    if (opKey) payload.op_key = opKey;
    const created: TaskList = await apiClient.post('/task-lists', payload);
    return {
        ...created,
        title,
        titleEncState: 'secure',
        ...await openListContent(created),
    };
}

// --- Trash -------------------------------------------------------------------------------

export function trashTaskList(listId: number): Promise<{ trashed_at: string | null }> {
    return apiClient.post(`/task-lists/${listId}/trash`, {});
}

export function restoreTaskList(listId: number): Promise<{ trashed_at: string | null }> {
    return apiClient.post(`/task-lists/${listId}/restore`, {});
}

/** Only rows that really are in the trash: a server that ignored
 *  `?trashed=true` would otherwise hand back every live list as "trash". */
function onlyTrashed<T extends Pick<TaskList, 'trashed_at'>>(lists: T[]): T[] {
    return lists.filter(l => typeof l.trashed_at === 'string' && l.trashed_at !== '');
}

/** The trash, opened like the live listing. */
export async function listTrashedTaskLists(): Promise<TaskList[]> {
    const lists: TaskList[] = await apiClient.get('/task-lists?trashed=true');
    const trashed = onlyTrashed(lists);
    return Promise.all(trashed.map(async l => {
        const wire = l.title;
        // Same title rule as listTaskLists (titles predate encryption).
        const title = await openSelfTaskText(wire);
        return { ...l, title, titleEncState: messageEncState(wire, title), ...await openListContent(l) };
    }));
}

/** Just the ids in the trash, nothing opened — for Púca Notes' prune, which
 *  must not forget a trashed note's colour and labels (notesQueries.ts). */
export async function trashedTaskListIds(): Promise<number[]> {
    const lists: Array<Pick<TaskList, 'id' | 'trashed_at'>> = await apiClient.get('/task-lists?trashed=true');
    return onlyTrashed(lists).map(l => l.id);
}

// --- Delete: the trash where the server has one ------------------------------------------

/** How long a delete trusts the last features answer (a queued delete
 *  replays against whatever server answers when it runs). */
const TRASH_PROBE_TTL_MS = 10 * 60_000;
let trashProbe: { trash: boolean; at: number } | null = null;

/** For tests: forget what the server said. */
export function resetTrashProbe(): void {
    trashProbe = null;
}

/** Whether the server has a trash, by `fetchListFeatures`' rule: only a
 *  404/405 (or `trash: false`) is "no"; any other failure throws, so a bad
 *  moment is never mistaken for an old server. */
export async function serverHasTrash(now: number = Date.now()): Promise<boolean> {
    if (trashProbe && now - trashProbe.at < TRASH_PROBE_TTL_MS) return trashProbe.trash;
    const { trash } = await fetchListFeatures();
    trashProbe = { trash, at: now };
    return trash;
}

export type ListDeleteOutcome = 'trashed' | 'deleted';

/**
 * Púca Notes' Delete, as it reaches the server (notesOutbox.ts runs it, now
 * or at replay): move the list to the trash, or — only on a server KNOWN to
 * have none (404/405 on the probe, or `trash: false`) — delete it for good.
 * A network error on the probe throws, so the outbox queues the delete and
 * probes again when it replays; a 5xx throws and the caller rolls back.
 */
export async function trashOrDeleteList(listId: number): Promise<ListDeleteOutcome> {
    if (await serverHasTrash()) {
        await trashTaskList(listId);
        return 'trashed';
    }
    await deleteTaskList(listId);
    return 'deleted';
}

// --- Files a note names ------------------------------------------------------------------

/** Every uploaded file id a note's OPENED sidecars name: its own, and its
 *  items'. A locked sidecar names nothing we can read (and nothing is
 *  deleted for it). */
export function noteFileIds(listAttachments: string | null | undefined, tasks: Task[]): string[] {
    const ids = new Set<string>();
    const take = (opened: string | null | undefined) => {
        if (!opened || isAttachmentsLocked(opened)) return;
        for (const r of parseTaskAttachments(opened)) {
            const p = parseEncAttachment(r.href);
            if (p) ids.add(p.id);
        }
    };
    take(listAttachments);
    for (const t of tasks) take(t.attachments);
    return [...ids];
}

/** Best-effort file deletion (the server answers 404 for anything the
 *  caller did not upload). Resolves once every request has settled. */
export async function deleteFiles(ids: string[]): Promise<void> {
    await Promise.allSettled(ids.map(id => apiClient.delete(`/files/${id}`)));
}

/** Delete forever refused because the note's files cannot all be found
 *  (its items could not be listed, or a sidecar is locked on this device). */
export class NoteFilesUnreadableError extends Error {
    constructor() {
        super('This note’s pictures and attachments can’t be read here yet, so it wasn’t deleted — its files would be left behind. Try again once Púca is unlocked and online.');
        this.name = 'NoteFilesUnreadableError';
    }
}

/**
 * Delete a list for good, and the uploads it names first. Files before the
 * row: the server cannot read the sidecars, so once the row is gone nothing
 * can find those files again. If the list delete then fails the note is
 * still in the trash, with broken images, and the user can try again.
 *
 * For the same reason it REFUSES (NoteFilesUnreadableError, nothing deleted)
 * when it cannot know every file: the items cannot be listed, or the list's
 * or any item's sidecar is locked (identity not unlocked, a key missing).
 * Deleting the row anyway would orphan those uploads for good — the very
 * thing this exists to prevent.
 */
export async function deleteListForever(list: Pick<TaskList, 'id' | 'attachments'>): Promise<void> {
    if (isAttachmentsLocked(list.attachments ?? null)) throw new NoteFilesUnreadableError();
    let tasks: Task[];
    try {
        tasks = await listListTasks(list.id);
    } catch {
        throw new NoteFilesUnreadableError();
    }
    if (tasks.some(t => isAttachmentsLocked(t.attachments ?? null))) throw new NoteFilesUnreadableError();
    await deleteFiles(noteFileIds(list.attachments, tasks));
    await apiClient.delete(`/task-lists/${list.id}`);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Púca Notes purges its own expired trash this long before the server's
 *  window closes, so the files go with the rows (src/list_content.rs). */
export const CLIENT_PURGE_MARGIN_MS = DAY_MS;

/** When a trashed list will be deleted by the server, or null when the
 *  server keeps trash forever (or the time is unreadable). */
export function trashPurgeAt(trashedAt: string | null | undefined, retentionDays: number): number | null {
    if (!trashedAt || retentionDays <= 0) return null;
    const t = parseServerTimestamp(trashedAt);
    return Number.isFinite(t) ? t + retentionDays * DAY_MS : null;
}

/** The trashed lists a client should purge itself now: within the last
 *  margin of the server's window (or past it — the sweep runs six-hourly). */
export function listsDueForClientPurge<T extends Pick<TaskList, 'trashed_at'>>(lists: T[], retentionDays: number, now: number): T[] {
    return lists.filter(l => {
        const at = trashPurgeAt(l.trashed_at, retentionDays);
        return at !== null && at - CLIENT_PURGE_MARGIN_MS <= now;
    });
}

/** "in 3 days" / "within a day" / "any time now" until the server deletes a
 *  trashed note. `now` may run up to `quantumMs` behind the real time (a
 *  clock that ticks once a minute), so the count starts from the latest it
 *  could be: a note trashed seconds ago reads "in 30 days", never 31. */
export function purgeCountdown(at: number, now: number, quantumMs = 0): string {
    const days = Math.ceil((at - now - quantumMs) / DAY_MS);
    if (days <= 0) return 'any time now';
    if (days === 1) return 'within a day';
    return `in ${days} days`;
}

// --- Keeping a trashed note's place in the saved tab order ---------------------------------

/**
 * The tab order to save when some saved tabs are HIDDEN rather than gone —
 * trashed lists. The saved prefs are a full replace (PUT /task-tab-prefs),
 * and buildPrefsForOrder moves every entry it is not given to the tail, so a
 * reorder or pin while a note sits in the trash would lose its slot and a
 * restored note would come back last. This re-inserts each hidden key at the
 * index it held in `prefs`, in ascending order, so every one of them lands
 * back at exactly that index (clamped to the end).
 */
export function keepHiddenSlots<T extends TaskTabRef>(
    visible: T[],
    prefs: TaskTabPref[],
    hiddenKeys: ReadonlySet<string>,
): TaskTabRef[] {
    const out: TaskTabRef[] = visible.filter(t => !hiddenKeys.has(taskTabKey(t)));
    prefs.forEach((p, index) => {
        const ref: TaskTabRef = { kind: p.kind, id: p.ref_id };
        if (!hiddenKeys.has(taskTabKey(ref))) return;
        out.splice(Math.min(index, out.length), 0, ref);
    });
    return out;
}

/**
 * toggleFavoritePrefs (api/tasks.ts) with hidden keys kept in their slots:
 * favouriting pulls the tab to the front of the VISIBLE order, and only then
 * are the hidden ones put back — doing it the other way round shifts every
 * hidden tab one place down on each pin.
 */
export function toggleFavoriteKeepingHidden<T extends TaskTabRef>(
    visible: T[],
    prefs: TaskTabPref[],
    target: TaskTabRef,
    hiddenKeys: ReadonlySet<string>,
): TaskTabPref[] {
    const nowFav = !isFavoriteTab(prefs, target);
    const overrides = new Map([[taskTabKey(target), nowFav]]);
    const shown: TaskTabRef[] = visible.map(t => ({ kind: t.kind, id: t.id }));
    const next = nowFav
        ? [{ kind: target.kind, id: target.id }, ...shown.filter(t => !(t.kind === target.kind && t.id === target.id))]
        : shown;
    return buildPrefsForOrder(keepHiddenSlots(next, prefs, hiddenKeys), prefs, overrides);
}

// --- Note text limits (NoteBodyField) --------------------------------------------------

/** Pause after the last keystroke before a note's text saves itself. */
export const BODY_SAVE_DELAY_MS = 800;
/** Plaintext bytes that still fit the server's 64 KiB envelope cap after
 *  encryption and base64 (MAX_LIST_BODY_LEN in src/list_content.rs). */
export const MAX_BODY_BYTES = 48_000;

export function bodyBytes(text: string): number {
    return new TextEncoder().encode(text).length;
}

// --- A note's text save that has not reached the server yet ------------------------------

/**
 * The text editor (NoteBodyField) saves a pause after the last keystroke,
 * and again as it unmounts. Moving the note to the trash inside that pause
 * would lose the last words typed: the trash commits first, and the late
 * save then meets the trashed note's 409 in a component nobody can see. So
 * the editor registers how to finish its save here, per list, and a trash
 * waits on `flushBodySave` before it is sent.
 */
const bodyFlushes = new Map<number, () => Promise<unknown>>();

/** Register `flush` (finish any pending save now) for a list; returns the
 *  unregister function, which only removes this registration. */
export function registerBodyFlush(listId: number, flush: () => Promise<unknown>): () => void {
    bodyFlushes.set(listId, flush);
    return () => { if (bodyFlushes.get(listId) === flush) bodyFlushes.delete(listId); };
}

/** Finish any pending or in-flight text save for a list. Never throws. */
export async function flushBodySave(listId: number): Promise<void> {
    const flush = bodyFlushes.get(listId);
    if (!flush) return;
    try { await flush(); } catch { /* the editor reports its own failure */ }
}
