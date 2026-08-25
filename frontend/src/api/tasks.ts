// Task API — channel checklists + personal task lists (Google Keep style).
// A task belongs to either a channel or a personal list, and may nest under
// a parent task ("subtasks") up to MAX_TASK_DEPTH levels.
//
// Both scopes are E2EE. Personal lists encrypt to the owner's identity
// (encrypt-to-self). Channel checklists are shared, so they encrypt under the
// channel GROUP KEY for the current epoch — exactly like channel messages — so
// the server only ever stores envelopes and a removed member loses access on the
// next key rotation.
import { apiClient } from './client';
import {
    getActiveIdentity,
    encryptSelf,
    decryptSelf,
    encryptChannelMessage,
    decryptChannelMessage,
    parseEnvelope,
    serializeEnvelope,
    messageEncState,
    type MessageEncState,
} from './e2ee';
import { ensureChannelKey, getChannelKeyForEpoch } from './channelKeys';
import { PERM, hasPerm } from './permissionBits';
import * as MARKERS from './decryptMarkers';
import { parseServerTimestamp } from '../utils/serverTime';

export interface Task {
    id: number;
    channel_id: number | null;
    list_id: number | null;
    parent_id: number | null;
    description: string;
    is_completed: boolean;
    position: number;
    created_at: string;
    created_by: number;
    /** Attachment sidecar: sealed on the wire (same key path as description),
     *  opened to plaintext JSON by listTasks/listListTasks. null = none.
     *  Parse with parseTaskAttachments. */
    attachments: string | null;
    /** Optional due time (RFC3339). Plaintext metadata like is_completed and
     *  position — the server learns WHEN so reminders can exist, never WHAT
     *  (the description stays E2EE). */
    due_at: string | null;
    /** E2EE state of `description`, set by listTasks/listListTasks. `legacy`
     *  (server stored plaintext) is flagged in the UI so an injected cleartext
     *  checklist item can't pose as an encrypted one (audit H-1). */
    descEncState?: MessageEncState;
}

/** One task attachment: an E2EE file ref (sovereign-enc: href carries the
 *  per-file key + mime — see api/attachments.ts) plus its display name. */
export interface TaskAttachmentRef {
    href: string;
    name: string;
}

/** Most attachments a single task may hold; serializeTaskAttachments rejects
 *  more, and the server separately caps the sealed sidecar at 16 KB. */
export const MAX_TASK_ATTACHMENTS = 12;

export interface TaskList {
    id: number;
    title: string;
    created_at: string;
    total_tasks: number;
    completed_tasks: number;
}

// Markers substituted by openChannel/openSelf when a stored value can't be
// decrypted (absent/rotated key, locked identity). Exposed via
// isAttachmentsLocked so callers can tell a LOCKED attachments sidecar from a
// genuinely empty one: treating locked as empty would let the next edit
// overwrite (and permanently orphan) refs the viewer merely can't read yet.
// Re-exported from the shared set — see api/decryptMarkers. Defined per-file
// before, which is how search ended up matching content nobody can read.
const ENC_KEY_UNAVAILABLE = MARKERS.ENC_KEY_UNAVAILABLE;
const DECRYPT_FAILED = MARKERS.TASK_DECRYPT_FAILED;
const IDENTITY_LOCKED = MARKERS.TASK_IDENTITY_LOCKED;
const DECRYPT_FAILURE_MARKERS = MARKERS.DECRYPT_FAILURE_MARKERS;

/** True when an OPENED attachments sidecar is really a decrypt-failure marker
 *  (key unavailable / identity locked) rather than content. Callers MUST refuse
 *  destructive attachment edits in this state and render a locked placeholder. */
export function isAttachmentsLocked(opened: string | null): boolean {
    return opened != null && DECRYPT_FAILURE_MARKERS.has(opened);
}

// --- Channel checklist (E2EE under the channel group key) ---

/** Encrypt shared checklist text under the channel key for the current epoch.
 *  Throws if no key can be obtained — never store a checklist item in plaintext. */
async function sealChannel(channelId: number, plaintext: string): Promise<string> {
    const ck = await ensureChannelKey(channelId);
    if (!ck) throw new Error('Channel encryption key unavailable; cannot store checklist item');
    return serializeEnvelope(await encryptChannelMessage(ck.key, ck.epoch, plaintext));
}

/** Decrypt a stored checklist item. Legacy plaintext passes through; an
 *  undecryptable envelope becomes a visible marker rather than an error. */
async function openChannel(channelId: number, stored: string): Promise<string> {
    const env = parseEnvelope(stored);
    if (!env) return stored;                       // legacy plaintext row
    if (env.t !== 'ch') return DECRYPT_FAILED;
    const key = await getChannelKeyForEpoch(channelId, env.epoch ?? 0);
    if (!key) return ENC_KEY_UNAVAILABLE;
    return (await decryptChannelMessage(key, env)) ?? DECRYPT_FAILED;
}

export async function listTasks(channelId: number): Promise<Task[]> {
    const tasks: Task[] = await apiClient.get(`/channels/${channelId}/tasks`);
    return Promise.all(tasks.map(async (t) => {
        const wire = t.description;
        const description = await openChannel(channelId, wire);
        return {
            ...t,
            description,
            attachments: t.attachments ? await openChannel(channelId, t.attachments) : null,
            descEncState: messageEncState(wire, description),
        };
    }));
}

export async function createTask(channelId: number, description: string, parentId?: number): Promise<Task> {
    const created: Task = await apiClient.post(`/channels/${channelId}/tasks`, {
        description: await sealChannel(channelId, description),
        parent_id: parentId ?? null,
    });
    return { ...created, description }; // show the plaintext locally
}

/** Update a channel checklist task; a changed description is re-encrypted under
 *  the channel key. Use this (not `updateTask`) for channel-scope description
 *  edits. `due_at` passes through in the clear (metadata; '' clears it). */
export async function updateChannelTask(
    channelId: number,
    taskId: number,
    updates: { is_completed?: boolean; description?: string; due_at?: string },
): Promise<void> {
    const payload = updates.description === undefined
        ? updates
        : { ...updates, description: await sealChannel(channelId, updates.description) };
    return apiClient.patch(`/tasks/${taskId}`, payload);
}

/** Replace a channel task's attachment refs, sealed under the channel key.
 *  An empty array clears the sidecar (the server maps "" to NULL). */
export async function updateChannelTaskAttachments(
    channelId: number,
    taskId: number,
    refs: TaskAttachmentRef[],
): Promise<void> {
    const attachments = refs.length === 0
        ? ''
        : await sealChannel(channelId, serializeTaskAttachments(refs));
    return apiClient.patch(`/tasks/${taskId}`, { attachments });
}

// --- Shared (either scope) ---

export function updateTask(taskId: number, updates: { is_completed?: boolean; description?: string; due_at?: string }): Promise<void> {
    return apiClient.patch(`/tasks/${taskId}`, updates);
}

export function deleteTask(taskId: number): Promise<void> {
    return apiClient.delete(`/tasks/${taskId}`);
}

export function moveTask(taskId: number, direction: 'up' | 'down'): Promise<void> {
    return apiClient.post(`/tasks/${taskId}/move`, { direction });
}

/** Drop a task at an arbitrary slot among its visible siblings: immediately
 *  after `afterId`, or first in the group when null. Backs drag-and-drop;
 *  `moveTask` (one-slot) remains for the coarse-pointer arrow buttons.
 *
 *  `reparent` (S1+) moves the task under a different parent in the same drop
 *  (null = top level); field names copied from `ReorderTaskRequest`
 *  (task_handlers.rs). Omitted entirely for a plain reorder, so the wire is
 *  byte-identical to the pre-S1 frame. AGAINST A PRE-S1 SERVER a reparent
 *  frame silently plain-reorders (serde ignores unknown fields) — callers
 *  that reparent must re-fetch after success rather than trusting their
 *  optimistic parent (see the handleReorder sites). */
export function reorderTask(
    taskId: number,
    afterId: number | null,
    reparent?: { parentId: number | null },
): Promise<void> {
    return apiClient.post(`/tasks/${taskId}/reorder`, reparent
        ? { after_id: afterId, reparent: true, parent_id: reparent.parentId }
        : { after_id: afterId });
}

// --- Tasks-view tab preferences (bar order + favourites) ---

export type TaskTabKind = 'list' | 'channel';

/** One saved tab preference. GET returns them in display order; PUT takes the
 *  full set in display order (the array order IS the bar order). */
export interface TaskTabPref {
    kind: TaskTabKind;
    ref_id: number;
    is_favorite: boolean;
}

/** The caller's saved tab order + favourites. Callers treat a failure (old
 *  backend, offline) as "no prefs" — the bar then shows its natural order. */
export function getTaskTabPrefs(): Promise<TaskTabPref[]> {
    return apiClient.get('/task-tab-prefs');
}

// --- Due-time reminders ---

/** One open task with a due time this user should be reminded about: their
 *  personal-list tasks + channel tasks they created (while still a member).
 *  Ids and times only — content stays E2EE and the toast is content-free. */
export interface TaskReminder {
    id: number;
    channel_id: number | null;
    list_id: number | null;
    due_at: string;
}

export function listTaskReminders(): Promise<TaskReminder[]> {
    return apiClient.get('/task-reminders');
}

/** Replace the whole pref set; pass every current tab in display order. */
export function putTaskTabPrefs(prefs: TaskTabPref[]): Promise<void> {
    return apiClient.put('/task-tab-prefs', { prefs });
}

// --- Personal task lists (E2EE: encrypt-to-self) ---

/** Encrypt owner-only text into a serialized envelope. Throws without keys —
 *  personal tasks must never be stored in plaintext. */
async function sealSelf(plaintext: string): Promise<string> {
    const identity = getActiveIdentity();
    if (!identity) throw new Error('E2EE identity not available; cannot store personal tasks');
    return serializeEnvelope(await encryptSelf(identity, plaintext));
}

/** Decrypt stored owner-only text. Plaintext passes through (legacy rows);
 *  undecryptable envelopes become a visible marker rather than an error. */
async function openSelf(stored: string): Promise<string> {
    const envelope = parseEnvelope(stored);
    if (!envelope) return stored;
    const identity = getActiveIdentity();
    if (!identity) return IDENTITY_LOCKED;
    return (await decryptSelf(identity, envelope)) ?? DECRYPT_FAILED;
}

/** Get (or lazily create) the single "Notes to self" personal list that backs
 *  the self-DM notes. The server-created title is a plain label (passes through
 *  openSelf unchanged); a user-renamed title arrives as an encrypt-to-self
 *  envelope and is decrypted here. Items are encrypt-to-self like any list. */
export async function getSelfChecklist(): Promise<TaskList> {
    const list: TaskList = await apiClient.get('/task-lists/self');
    return { ...list, title: await openSelf(list.title) };
}

export async function listTaskLists(): Promise<TaskList[]> {
    const lists: TaskList[] = await apiClient.get('/task-lists');
    return Promise.all(lists.map(async l => ({ ...l, title: await openSelf(l.title) })));
}

export async function createTaskList(title: string): Promise<TaskList> {
    const created: TaskList = await apiClient.post('/task-lists', { title: await sealSelf(title) });
    return { ...created, title };
}

export async function renameTaskList(listId: number, title: string): Promise<void> {
    return apiClient.patch(`/task-lists/${listId}`, { title: await sealSelf(title) });
}

export function deleteTaskList(listId: number): Promise<void> {
    return apiClient.delete(`/task-lists/${listId}`);
}

export async function listListTasks(listId: number): Promise<Task[]> {
    const tasks: Task[] = await apiClient.get(`/task-lists/${listId}/tasks`);
    return Promise.all(tasks.map(async t => {
        const wire = t.description;
        const description = await openSelf(wire);
        return {
            ...t,
            description,
            attachments: t.attachments ? await openSelf(t.attachments) : null,
            descEncState: messageEncState(wire, description),
        };
    }));
}

export async function createListTask(listId: number, description: string, parentId?: number): Promise<Task> {
    const created: Task = await apiClient.post(`/task-lists/${listId}/tasks`, {
        description: await sealSelf(description),
        parent_id: parentId ?? null,
    });
    return { ...created, description };
}

/** Update a personal-list task; descriptions are re-encrypted to self.
 *  `due_at` passes through in the clear (metadata; '' clears it). */
export async function updateListTask(taskId: number, updates: { is_completed?: boolean; description?: string; due_at?: string }): Promise<void> {
    const payload = updates.description === undefined
        ? updates
        : { ...updates, description: await sealSelf(updates.description) };
    return apiClient.patch(`/tasks/${taskId}`, payload);
}

/** Replace a personal-list task's attachment refs, sealed to self.
 *  An empty array clears the sidecar (the server maps "" to NULL). */
export async function updateListTaskAttachments(taskId: number, refs: TaskAttachmentRef[]): Promise<void> {
    const attachments = refs.length === 0
        ? ''
        : await sealSelf(serializeTaskAttachments(refs));
    return apiClient.patch(`/tasks/${taskId}`, { attachments });
}

// --- Pure helpers (shared by ChecklistPanel + TasksView, unit-tested) ---

/** Task-level edit rights on a CHANNEL checklist: description edits, moves,
 *  deletes, and attachment changes belong to the task's creator or anyone
 *  holding MANAGE_TASKS. `perms` is the channel's resolved my_permissions;
 *  null/undefined (old backend, personal lists) means everything is allowed
 *  via hasPerm's backward-compat fallback. */
export function canEditTask(task: Task, userId: number | undefined, perms: number | null | undefined): boolean {
    return hasPerm(perms, PERM.MANAGE_TASKS) || task.created_by === userId;
}

/** Parse an OPENED (plaintext) attachments sidecar into refs. Malformed JSON,
 *  non-arrays, and entries without string href/name all degrade to nothing —
 *  a corrupt sidecar must never crash the tree render. */
export function parseTaskAttachments(plain: string | null): TaskAttachmentRef[] {
    if (!plain) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(plain);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed
        .filter((e): e is TaskAttachmentRef =>
            typeof e === 'object' && e !== null &&
            typeof (e as TaskAttachmentRef).href === 'string' &&
            typeof (e as TaskAttachmentRef).name === 'string')
        .slice(0, MAX_TASK_ATTACHMENTS)
        .map(({ href, name }) => ({ href, name }));
}

/** Serialize refs for sealing. Throws over the per-task cap — callers check
 *  before appending, so this firing means a bug, not a user mistake. */
export function serializeTaskAttachments(refs: TaskAttachmentRef[]): string {
    if (refs.length > MAX_TASK_ATTACHMENTS) {
        throw new Error(`Tasks hold at most ${MAX_TASK_ATTACHMENTS} attachments`);
    }
    return JSON.stringify(refs.map(({ href, name }) => ({ href, name })));
}

// --- Due-time display helpers (pure, unit-tested) ---

/** ISO due time → value for an `<input type="datetime-local">` (local time,
 *  minute precision). '' for none/unparseable. */
export function dueToLocalInput(iso: string | null): string {
    if (!iso) return '';
    const t = parseServerTimestamp(iso);
    const d = new Date(t);
    if (!Number.isFinite(d.getTime())) return '';
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** datetime-local input value → ISO for the wire; null when empty/invalid
 *  (the input gives local wall-clock time — Date parses it as local). */
export function localInputToIso(value: string): string | null {
    if (!value) return null;
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** Overdue = has a due time in the past and is still open. */
export function isTaskOverdue(task: Pick<Task, 'due_at' | 'is_completed'>, now: number): boolean {
    if (task.is_completed || !task.due_at) return false;
    const t = parseServerTimestamp(task.due_at);
    return Number.isFinite(t) && t <= now;
}

/** Compact chip label: time only when the due date is today (relative to
 *  `now`), day+time otherwise, plus the year when it differs. */
export function formatDueShort(iso: string, now: number): string {
    const t = parseServerTimestamp(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const ref = new Date(now);
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate()) {
        return time;
    }
    const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.getFullYear() === ref.getFullYear() ? `${day} ${time}` : `${day} ${d.getFullYear()} ${time}`;
}

/** Tasks nest arbitrarily deep (server caps it); node children are nodes. */
export interface TaskNode {
    task: Task;
    children: TaskNode[];
}

/** Deepest allowed level (top-level = 1). Mirrors MAX_TASK_DEPTH in
 *  task_handlers.rs — the UI hides "add subtask" at the cap; the server
 *  rejects beyond it. */
export const MAX_TASK_DEPTH = 5;

/** Display order: explicit position, then id as the stable tiebreaker. */
function byOrder(a: Task, b: Task): number {
    return a.position - b.position || a.id - b.id;
}

export function buildTaskTree(tasks: Task[]): TaskNode[] {
    const sorted = [...tasks].sort(byOrder);
    const nodes = new Map<number, TaskNode>(sorted.map(t => [t.id, { task: t, children: [] }]));
    const roots: TaskNode[] = [];
    for (const t of sorted) {
        const node = nodes.get(t.id)!;
        if (t.parent_id === null) {
            roots.push(node);
        } else {
            // Orphans (parent not in the array) stay hidden, as before.
            nodes.get(t.parent_id)?.children.push(node);
        }
    }
    return roots;
}

/** A task plus every descendant, for local delete mirrors (the server
 *  cascades via FK; this keeps optimistic state identical). */
export function collectSubtreeIds(tasks: Task[], rootId: number): Set<number> {
    const childrenOf = new Map<number, number[]>();
    for (const t of tasks) {
        if (t.parent_id !== null) {
            const kids = childrenOf.get(t.parent_id) ?? [];
            kids.push(t.id);
            childrenOf.set(t.parent_id, kids);
        }
    }
    const ids = new Set<number>([rootId]);
    const stack = [rootId];
    while (stack.length > 0) {
        const id = stack.pop()!;
        for (const child of childrenOf.get(id) ?? []) {
            if (!ids.has(child)) {
                ids.add(child);
                stack.push(child);
            }
        }
    }
    return ids;
}

/**
 * Apply a one-slot move locally by swapping positions with the nearest
 * visible sibling (same parent, same completion state), mirroring the
 * server's swap. Returns the input array unchanged at the edges.
 */
export function applyMove(tasks: Task[], moved: Task, direction: 'up' | 'down'): Task[] {
    const siblings = tasks
        .filter(t =>
            t.parent_id === moved.parent_id &&
            t.is_completed === moved.is_completed)
        .sort(byOrder);
    const idx = siblings.findIndex(t => t.id === moved.id);
    const neighbor = direction === 'up' ? siblings[idx - 1] : siblings[idx + 1];
    if (!neighbor) return tasks;
    return tasks.map(t => {
        if (t.id === moved.id) return { ...t, position: neighbor.position };
        if (t.id === neighbor.id) return { ...t, position: moved.position };
        return t;
    });
}

/**
 * Apply a drag-drop reorder locally, mirroring the server's renumber: the
 * moved task lands immediately after sibling `afterId` (null = first), and
 * the whole sibling group (same parent, same completion state) gets fresh
 * positions above the scope's current max — matching the server, which keeps
 * positions scope-unique because the completion toggle moves tasks between
 * groups without touching their position. Returns the input array unchanged
 * when `afterId` is not a valid same-group sibling.
 */
export function applyReorder(
    tasks: Task[], moved: Task, afterId: number | null,
    reparent?: { parentId: number | null },
): Task[] {
    // The parent the task will HAVE — its current one, or the reparent target
    // (mirroring the server: the parent UPDATE runs before the sibling read).
    const parentId = reparent !== undefined ? reparent.parentId : moved.parent_id;
    const group = tasks
        .filter(t =>
            (t.id === moved.id ? parentId : t.parent_id) === parentId &&
            t.is_completed === moved.is_completed)
        .sort(byOrder)
        .map(t => t.id);
    if (!group.includes(moved.id)) return tasks;
    const order = group.filter(id => id !== moved.id);
    let insertAt = 0;
    if (afterId !== null) {
        const i = order.indexOf(afterId);
        if (i < 0) return tasks; // not a same-group sibling (or the task itself)
        insertAt = i + 1;
    }
    order.splice(insertAt, 0, moved.id);
    const base = tasks.reduce((m, t) => Math.max(m, t.position), 0);
    const posById = new Map(order.map((id, i) => [id, base + i + 1]));
    return tasks.map(t => {
        const pos = posById.get(t.id);
        const withPos = pos !== undefined && pos !== t.position ? { ...t, position: pos } : t;
        if (t.id === moved.id && parentId !== moved.parent_id) {
            return { ...withPos, parent_id: parentId };
        }
        return withPos;
    });
}

// --- Drag-to-nest (W4): turn a drop's indent into a reorder/reparent plan ---

/** What one drop should do. `reparent` absent = today's plain reorder. */
export interface DropPlan {
    afterId: number | null;
    reparent?: { parentId: number | null };
}

/** 1-based depth of a task (top level = 1); 0 when the id is unknown.
 *  Bounded by MAX_TASK_DEPTH + 1 so drifted data cannot loop it. */
export function taskDepth(tasks: Task[], id: number): number {
    const byId = new Map(tasks.map(t => [t.id, t]));
    let depth = 0;
    let cur = byId.get(id);
    while (cur && depth <= MAX_TASK_DEPTH) {
        depth++;
        cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
    }
    return depth;
}

/** 1-based height of a subtree (a leaf = 1), same bound. */
export function subtreeHeight(tasks: Task[], rootId: number): number {
    const childrenOf = new Map<number, number[]>();
    for (const t of tasks) {
        if (t.parent_id !== null) {
            (childrenOf.get(t.parent_id) ?? childrenOf.set(t.parent_id, []).get(t.parent_id)!)
                .push(t.id);
        }
    }
    let height = 0;
    let level = [rootId];
    const seen = new Set<number>();
    while (level.length > 0 && height <= MAX_TASK_DEPTH) {
        height++;
        const next: number[] = [];
        for (const id of level) {
            if (seen.has(id)) continue;
            seen.add(id);
            next.push(...(childrenOf.get(id) ?? []));
        }
        level = next;
    }
    return height;
}

/**
 * Turn a drop (the drag hook's order/insertAt plus the horizontal indent
 * gesture) into what should actually happen:
 *
 *  - indent 0: the plain reorder, exactly as before.
 *  - indent +1: NEST under the row visually above the drop slot
 *    (`order[insertAt-1]`), landing as its last same-completion child.
 *  - indent -1: UN-NEST to the grandparent, landing right after the old
 *    parent (or first in the group when the parent's completion state
 *    differs — a completed parent is not in the moving task's group).
 *
 * Every impossible indent DEGRADES to the plain plan rather than dying: a
 * nest at the top slot, under the current parent, into the moving subtree
 * (cycle), or past MAX_TASK_DEPTH (the moving SUBTREE's height counts —
 * pre-validating what the server's depth rule will refuse) all fall back to
 * the drop the indicator line showed. A dead gesture teaches "drag is
 * broken"; a drop that lands where the line was teaches "the indent didn't
 * take", which is recoverable.
 */
export function planDropTarget(
    tasks: Task[], moved: Task, order: number[], insertAt: number, indent: number,
): DropPlan {
    const plain: DropPlan = { afterId: insertAt === 0 ? null : order[insertAt - 1] ?? null };
    if (indent > 0) {
        if (insertAt === 0) return plain;
        const parentCandidate = order[insertAt - 1];
        if (parentCandidate === undefined || parentCandidate === moved.parent_id) return plain;
        if (collectSubtreeIds(tasks, moved.id).has(parentCandidate)) return plain;
        if (taskDepth(tasks, parentCandidate) + subtreeHeight(tasks, moved.id) > MAX_TASK_DEPTH) {
            return plain;
        }
        const lastChild = tasks
            .filter(t => t.parent_id === parentCandidate && t.is_completed === moved.is_completed
                && t.id !== moved.id)
            .sort(byOrder)
            .at(-1);
        return { afterId: lastChild?.id ?? null, reparent: { parentId: parentCandidate } };
    }
    if (indent < 0) {
        if (moved.parent_id === null) return plain;
        const parent = tasks.find(t => t.id === moved.parent_id);
        if (!parent) return plain;
        const afterId = parent.is_completed === moved.is_completed ? parent.id : null;
        return { afterId, reparent: { parentId: parent.parent_id } };
    }
    return plain;
}

/** A bar tab: a personal list or a channel checklist. The Tasks view builds
 *  these from its lists + servers data; helpers below order them by prefs. */
export interface TaskTabRef {
    kind: TaskTabKind;
    id: number;
}

const tabKey = (kind: TaskTabKind, id: number) => `${kind}:${id}`;

/**
 * Order tabs by the saved prefs: prefed tabs first in pref order, then
 * everything the prefs don't know about (new lists, newly-joined servers) in
 * the natural order given. Prefs referencing tabs that no longer exist are
 * simply skipped.
 */
export function orderTaskTabs<T extends TaskTabRef>(tabs: T[], prefs: TaskTabPref[]): T[] {
    const byKey = new Map(tabs.map(t => [tabKey(t.kind, t.id), t]));
    const out: T[] = [];
    for (const p of prefs) {
        const t = byKey.get(tabKey(p.kind, p.ref_id));
        if (t) {
            out.push(t);
            byKey.delete(tabKey(p.kind, p.ref_id));
        }
    }
    for (const t of tabs) {
        if (byKey.has(tabKey(t.kind, t.id))) out.push(t);
    }
    return out;
}

/** True when the prefs mark this tab as a favourite. */
export function isFavoriteTab(prefs: TaskTabPref[], tab: TaskTabRef): boolean {
    return prefs.some(p => p.kind === tab.kind && p.ref_id === tab.id && p.is_favorite);
}

/**
 * Build the full pref set to PUT after a change: every current tab in the
 * given display order, carrying favourite flags from the old prefs (with
 * `overrides` applied on top — used by the favourite toggle). Tabs the old
 * prefs never saw default to not-favourite.
 *
 * Old prefs whose tab is NOT in `orderedTabs` are appended at the tail, in
 * their old order, flags intact. The PUT is a full replace server-side and
 * the visible tab set can be a SUBSET of the saved one (per-server channel
 * queries still in flight or failed, the prefs GET itself failed) — dropping
 * the unseen entries would permanently delete their order and favourites on
 * the next drag or favourite toggle.
 */
export function buildPrefsForOrder(
    orderedTabs: TaskTabRef[],
    oldPrefs: TaskTabPref[],
    overrides?: Map<string, boolean>,
): TaskTabPref[] {
    const favByKey = new Map(oldPrefs.map(p => [tabKey(p.kind, p.ref_id), p.is_favorite]));
    const present = new Set(orderedTabs.map(t => tabKey(t.kind, t.id)));
    const out: TaskTabPref[] = orderedTabs.map(t => ({
        kind: t.kind,
        ref_id: t.id,
        is_favorite: overrides?.get(tabKey(t.kind, t.id)) ?? favByKey.get(tabKey(t.kind, t.id)) ?? false,
    }));
    for (const p of oldPrefs) {
        const k = tabKey(p.kind, p.ref_id);
        if (!present.has(k)) {
            present.add(k);
            out.push({
                kind: p.kind,
                ref_id: p.ref_id,
                is_favorite: overrides?.get(k) ?? p.is_favorite,
            });
        }
    }
    return out;
}

/** Key helper shared with the view layer (drag identifies tabs by string). */
export function taskTabKey(tab: TaskTabRef): string {
    return tabKey(tab.kind, tab.id);
}

/**
 * Apply a favourite toggle: favouriting pulls the tab to the FRONT of the bar
 * (that is what "favourites appear first" means here — afterwards it drags
 * like any other tab); unfavouriting just clears the star in place. Returns
 * the new full pref set to PUT, given every current tab in display order.
 */
export function toggleFavoritePrefs(
    orderedTabs: TaskTabRef[],
    oldPrefs: TaskTabPref[],
    target: TaskTabRef,
): TaskTabPref[] {
    const nowFav = !isFavoriteTab(oldPrefs, target);
    const overrides = new Map([[tabKey(target.kind, target.id), nowFav]]);
    let nextOrder = orderedTabs;
    if (nowFav) {
        const rest = orderedTabs.filter(t => !(t.kind === target.kind && t.id === target.id));
        nextOrder = [target, ...rest];
    }
    return buildPrefsForOrder(nextOrder, oldPrefs, overrides);
}

/**
 * Apply a completion toggle locally, mirroring the server's Keep-style
 * cascade at any depth: completing a task completes its whole subtree;
 * re-activating a task re-activates every ancestor above it.
 */
export function applyToggle(tasks: Task[], toggled: Task, completed: boolean): Task[] {
    const sweep = completed
        ? collectSubtreeIds(tasks, toggled.id)
        : (() => {
            const byId = new Map(tasks.map(t => [t.id, t]));
            const ids = new Set<number>([toggled.id]);
            let cur = toggled.parent_id;
            while (cur !== null && !ids.has(cur)) {
                ids.add(cur);
                cur = byId.get(cur)?.parent_id ?? null;
            }
            return ids;
        })();
    return tasks.map(t => (sweep.has(t.id) ? { ...t, is_completed: completed } : t));
}
