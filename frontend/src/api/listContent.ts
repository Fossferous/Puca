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
import { apiClient, ApiError } from './client';
import {
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    type TaskTabPref,
    type TaskTabRef,
    buildPrefsForOrder,
    isFavoriteTab,
    listListTasks,
    openSelfTaskText,
    parseTaskAttachments,
    serializeTaskAttachments,
    isAttachmentsLocked,
    taskTabKey,
} from './tasks';
import { openListContent, sealSelfField } from './listSeal';
import { MAX_READABLE_ENVELOPE_VERSION, messageEncState } from './e2ee';
import { parseEncAttachment } from './attachments';
import { parseServerTimestamp } from '../utils/serverTime';

export interface ListFeatures {
    body: boolean;
    attachments: boolean;
    trash: boolean;
    /** 0 = the server keeps trash until it is emptied. */
    trashRetentionDays: number;
    maxBodyLen: number;
}

export const NO_LIST_FEATURES: ListFeatures = Object.freeze({
    body: false,
    attachments: false,
    trash: false,
    trashRetentionDays: 0,
    maxBodyLen: 0,
});

/** Parse the features answer. Anything malformed reads as "not supported"
 *  field by field — never as supported. */
export function parseListFeatures(raw: unknown): ListFeatures {
    if (typeof raw !== 'object' || raw === null) return NO_LIST_FEATURES;
    const o = raw as Record<string, unknown>;
    const days = typeof o.trash_retention_days === 'number' && Number.isFinite(o.trash_retention_days) && o.trash_retention_days >= 0
        ? Math.floor(o.trash_retention_days) : 0;
    const maxBody = typeof o.max_body_len === 'number' && o.max_body_len > 0 ? Math.floor(o.max_body_len) : 0;
    return {
        body: o.body === true && maxBody > 0,
        attachments: o.attachments === true,
        trash: o.trash === true,
        trashRetentionDays: days,
        maxBodyLen: maxBody,
    };
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

/** Replace a list's note text; '' clears it. */
export async function setTaskListBody(listId: number, body: string): Promise<void> {
    const sealed = body === '' ? '' : await sealSelfField(body);
    return apiClient.patch(`/task-lists/${listId}`, { body: sealed, reads_up_to: MAX_READABLE_ENVELOPE_VERSION });
}

/** Replace a list's own attachment refs; an empty array clears them. */
export async function setTaskListAttachments(listId: number, refs: TaskAttachmentRef[]): Promise<void> {
    const sealed = refs.length === 0 ? '' : await sealSelfField(serializeTaskAttachments(refs));
    return apiClient.patch(`/task-lists/${listId}`, { attachments: sealed, reads_up_to: MAX_READABLE_ENVELOPE_VERSION });
}

/** Create a list with its title, and optionally its note text and refs, in
 *  one request (so a photo note never exists without its photo). */
export async function createTaskListWithContent(
    title: string,
    content: { body?: string; refs?: TaskAttachmentRef[] },
): Promise<TaskList> {
    const payload: Record<string, string> = { title: await sealSelfField(title) };
    if (content.body) payload.body = await sealSelfField(content.body);
    if (content.refs && content.refs.length > 0) payload.attachments = await sealSelfField(serializeTaskAttachments(content.refs));
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

/** The trash, opened like the live listing. Rows without a trash time are
 *  dropped: a server that ignored `?trashed=true` would otherwise hand back
 *  every live list as "trash". */
export async function listTrashedTaskLists(): Promise<TaskList[]> {
    const lists: TaskList[] = await apiClient.get('/task-lists?trashed=true');
    const trashed = lists.filter(l => typeof l.trashed_at === 'string' && l.trashed_at !== '');
    return Promise.all(trashed.map(async l => {
        const wire = l.title;
        // Same title rule as listTaskLists (titles predate encryption).
        const title = await openSelfTaskText(wire);
        return { ...l, title, titleEncState: messageEncState(wire, title), ...await openListContent(l) };
    }));
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

/**
 * Delete a list for good, and the uploads it names first. Files before the
 * row: the server cannot read the sidecars, so once the row is gone nothing
 * can find those files again. If the list delete then fails the note is
 * still in the trash, with broken images, and the user can try again.
 */
export async function deleteListForever(list: Pick<TaskList, 'id' | 'attachments'>): Promise<void> {
    let tasks: Task[] = [];
    try {
        tasks = await listListTasks(list.id);
    } catch {
        // Unreadable items: the note's own files are still worth reclaiming.
    }
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
