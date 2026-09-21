/**
 * Púca Notes — the pure note model.
 *
 * Notes is a second front door onto Púca's task system: a "note" is a personal
 * task list (encrypt-to-self) or a channel checklist (sealed under the channel
 * group key), and its rows are the same tasks the Tasks view edits. Nothing in
 * this file talks to the network or the DOM — it turns the data the query
 * layer already holds (lists, channel tabs, tasks, tab prefs, the device-local
 * Notes prefs) into what the grid, the reminders view and search render, and it
 * is unit-tested as such.
 *
 * Every ordering/favourite/toggle rule is DELEGATED to api/tasks.ts (the same
 * helpers TasksView and ChecklistBody use), so Notes cannot disagree with Púca
 * about which note is pinned, which comes first, or what completing a parent
 * does to its subtasks.
 */
import {
    type Task,
    type TaskTabKind,
    type TaskTabPref,
    buildTaskTree,
    type TaskNode,
    orderTaskTabs,
    isFavoriteTab,
    taskTabKey,
    isTaskOverdue,
} from '../../api/tasks';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type MessageEncState } from '../../api/e2ee';
import { parseServerTimestamp } from '../../utils/serverTime';
import { type ReminderSlot, noteUpdatedAt, reminderSlotOf, scheduleSearchText } from './notesTiming';

/** Which checklist a note is: a personal list or a channel checklist. */
export interface NoteRef {
    kind: TaskTabKind;
    id: number;
}

/** The string key a note is filed under everywhere (prefs, caches, routes):
 *  the SAME key the Tasks view uses for its tabs, so the two never diverge. */
export function noteKey(ref: NoteRef): string {
    return taskTabKey({ kind: ref.kind, id: ref.id });
}

/** Inverse of noteKey; null for anything that is not a well-formed key. */
export function parseNoteKey(key: string): NoteRef | null {
    const m = /^(list|channel):(\d+)$/.exec(key);
    if (!m) return null;
    const id = Number(m[2]);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    return { kind: m[1] as TaskTabKind, id };
}

/**
 * The twelve card tints. `default` is the plain surface; every other value is
 * a translucent overlay defined in notes.css so it reads on all eight themes.
 * Names, not hues, so a theme can reinterpret them (light vs dark).
 */
export const NOTE_COLORS = [
    'default', 'coral', 'peach', 'sand', 'mint', 'sage',
    'fog', 'storm', 'dusk', 'blossom', 'clay', 'chalk',
] as const;
export type NoteColor = typeof NOTE_COLORS[number];

export function isNoteColor(v: unknown): v is NoteColor {
    return typeof v === 'string' && (NOTE_COLORS as readonly string[]).includes(v);
}

/** Labels are free text; keep them short enough to sit in a chip. */
export const MAX_LABEL_LENGTH = 40;
export const MAX_LABELS_PER_NOTE = 8;

/** Normalise a label the way it is stored: trimmed, single-spaced, capped.
 *  Empty after cleaning → null (the caller drops it). */
export function normalizeLabel(raw: string): string | null {
    const cleaned = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL_LENGTH);
    return cleaned === '' ? null : cleaned;
}

/** What the data layer knows about a note before (and independently of) its
 *  tasks: identity, title, and for channel notes the server context. */
export interface NoteSource {
    ref: NoteRef;
    /** Decrypted title (a personal list) or the channel name. May be a
     *  decrypt-failure marker for a list whose key is unavailable. */
    title: string;
    /** How the server stores the title (personal lists; see TaskList). */
    titleEncState?: MessageEncState;
    /** Channel notes: where they live and what the caller may do there. */
    serverId?: string;
    serverName?: string;
    myPerms?: number;
    resolveUserName?: (id: number) => string | undefined;
    /** The list row's own counts — shown until the tasks themselves load. */
    totalTasks?: number;
    completedTasks?: number;
    createdAt?: string;
    /** Personal notes: the OPENED note text and note-level attachments
     *  sidecar (api/listSeal.ts), when the server has them. */
    body?: string | null;
    noteAttachments?: string | null;
    /** The list row's last edit (066+ servers; personal lists only). */
    updatedAt?: string;
}

/** Everything one card renders from. */
export interface NoteCard extends NoteSource {
    key: string;
    /** null until the tasks query has resolved. */
    tasks: Task[] | null;
    /** Pinned = favourited in Púca's Tasks view (server-synced). */
    pinned: boolean;
    color: NoteColor;
    labels: string[];
    archived: boolean;
    /** Progress: from the tasks when loaded, else from the list row. */
    total: number;
    completed: number;
}

/** The device-local Notes state a card needs (see notesPrefs.ts). */
export interface NotesNoteState {
    colors: Record<string, NoteColor>;
    labels: Record<string, string[]>;
    archived: Record<string, true>;
}

/**
 * Assemble the cards in display order: Púca's saved tab order (favourites
 * lead once favourited), then everything the prefs have not seen. Pinned,
 * colour, labels and archived come from the two pref sources.
 */
export function buildNoteCards(
    sources: NoteSource[],
    tasksByKey: ReadonlyMap<string, Task[]>,
    prefs: TaskTabPref[],
    local: NotesNoteState,
): NoteCard[] {
    const ordered = orderTaskTabs(sources.map(s => ({ ...s, kind: s.ref.kind, id: s.ref.id })), prefs);
    return ordered.map(s => {
        const key = noteKey(s.ref);
        const tasks = tasksByKey.get(key) ?? null;
        const { total, completed } = tasks
            ? countProgress(tasks)
            : { total: s.totalTasks ?? 0, completed: s.completedTasks ?? 0 };
        return {
            ref: s.ref,
            title: s.title,
            titleEncState: s.titleEncState,
            serverId: s.serverId,
            serverName: s.serverName,
            myPerms: s.myPerms,
            resolveUserName: s.resolveUserName,
            totalTasks: s.totalTasks,
            completedTasks: s.completedTasks,
            createdAt: s.createdAt,
            body: s.body,
            noteAttachments: s.noteAttachments,
            // The newest of the list's own stamp and its items' (notesTiming).
            updatedAt: noteUpdatedAt(s.updatedAt, tasks),
            key,
            tasks,
            pinned: isFavoriteTab(prefs, { kind: s.ref.kind, id: s.ref.id }),
            color: local.colors[key] ?? 'default',
            labels: local.labels[key] ?? [],
            archived: local.archived[key] === true,
            total,
            completed,
        };
    });
}

export function countProgress(tasks: Task[]): { total: number; completed: number } {
    let completed = 0;
    for (const t of tasks) if (t.is_completed) completed++;
    return { total: tasks.length, completed };
}

/** What the grid is showing. */
export type NoteFilter =
    | { kind: 'all' }
    | { kind: 'archive' }
    | { kind: 'label'; label: string }
    | { kind: 'search'; query: string };

/**
 * Apply a filter. `all` and `label` hide archived notes (Notes' behaviour);
 * `archive` shows only them; `search` looks everywhere — an archived hit is
 * still a hit, and the card says it is archived.
 */
export function filterNotes(cards: NoteCard[], filter: NoteFilter): NoteCard[] {
    switch (filter.kind) {
        case 'all':
            return cards.filter(c => !c.archived);
        case 'archive':
            return cards.filter(c => c.archived);
        case 'label': {
            const want = filter.label.toLocaleLowerCase();
            return cards.filter(c => !c.archived && c.labels.some(l => l.toLocaleLowerCase() === want));
        }
        case 'search':
            return searchNotes(cards, filter.query);
    }
}

/** Pinned first, in order; then the rest, in order. */
export function splitPinned(cards: NoteCard[]): { pinned: NoteCard[]; others: NoteCard[] } {
    const pinned: NoteCard[] = [];
    const others: NoteCard[] = [];
    for (const c of cards) (c.pinned ? pinned : others).push(c);
    return { pinned, others };
}

/** Case-insensitive, accent-insensitive, whitespace-normalised. */
export function normalizeForSearch(s: string): string {
    return s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLocaleLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** Every space-separated term must appear in the title, a label, the server
 *  name, or any item's text. Searching happens on the DECRYPTED strings the
 *  client already holds — nothing about the query ever leaves the device.
 *
 *  Decrypt-failure markers are NOT searchable text: typing "encrypted" or
 *  "key" must not match every note the user cannot read (decryptMarkers.ts
 *  records exactly that bug in message search). */
export function noteMatches(card: NoteCard, query: string): boolean {
    const terms = normalizeForSearch(query).split(' ').filter(Boolean);
    if (terms.length === 0) return true;
    const readable = (s: string) => (isUndecryptable(s) ? '' : s);
    const hay = [
        readable(card.title),
        readable(card.body ?? ''),
        card.serverName ?? '',
        ...card.labels,
        ...(card.tasks ?? []).map(t => readable(t.description)),
        ...(card.tasks ?? []).map(scheduleSearchText),
    ].map(normalizeForSearch).join('\n');
    return terms.every(term => hay.includes(term));
}

/**
 * Reordering is only meaningful against the SAVED order: a display sort
 * (title / created / edited) is not stored anywhere, and a search result is
 * not a section of it. Both the card menu's Move items and the grid drag
 * start here, so the two can never disagree about when ordering is offered.
 */
export function canReorder(sort: string, filterKind: NoteFilter['kind']): boolean {
    return sort === 'puca' && filterKind !== 'search';
}

/**
 * DRAGGING additionally needs the section to really be ONE COLUMN.
 * useDragReorder is one-axis and sorts items by their y-start, which across
 * the grid's CSS columns is meaningless — so drag is offered in list view, or
 * in any view on a coarse pointer, where notes.css forces `column-count: 1`
 * (the JS side of that media query is NotesShell's COARSE). Masonry on a fine
 * pointer keeps the card menu, which is the tap and keyboard path everywhere
 * anyway.
 */
export function canDragReorder(sort: string, filterKind: NoteFilter['kind'], view: 'grid' | 'list', coarse: boolean): boolean {
    return canReorder(sort, filterKind) && (view === 'list' || coarse);
}

/**
 * Splice a rearranged VISIBLE order back into the FULL order, so the saved
 * prefs (which Púca's Tasks tab bar renders from) keep every hidden note —
 * archived, filtered out, in another label, in the trash — exactly where it
 * was. Passing only the visible subset to buildPrefsForOrder would push every
 * hidden note to the tail of Púca's bar.
 *
 * `nextVisible` must be a permutation of the visible keys that actually exist
 * in `fullKeys`; anything else (a stale key, a dropped one, or the identity)
 * returns null, so a no-op never becomes a full-replace PUT. Both the card
 * menu's moves and the grid drag come through here — one splice, one place.
 */
export function applyVisibleOrder(
    fullKeys: readonly string[],
    visibleKeys: readonly string[],
    nextVisible: readonly string[],
): string[] | null {
    const vis = visibleKeys.filter(k => fullKeys.includes(k));
    if (nextVisible.length !== vis.length) return null;
    const want = new Set(vis);
    const seen = new Set<string>();
    for (const k of nextVisible) {
        if (!want.has(k) || seen.has(k)) return null;   // not a permutation
        seen.add(k);
    }
    if (nextVisible.every((k, idx) => k === vis[idx])) return null;   // no-op
    // The visible notes keep their SLOTS in the full order; only which
    // visible note sits in which slot changes.
    let n = 0;
    return fullKeys.map(k => (want.has(k) ? nextVisible[n++] : k));
}

/**
 * Move one note within the VISIBLE order and splice the result back into the
 * full order (applyVisibleOrder has that story). Returns null when the move is
 * a no-op — already at the edge, or the key is not visible.
 */
export function moveNoteInOrder(
    fullKeys: readonly string[],
    visibleKeys: readonly string[],
    key: string,
    target: 'top' | 'up' | 'down' | 'bottom',
): string[] | null {
    const vis = visibleKeys.filter(k => fullKeys.includes(k));
    const i = vis.indexOf(key);
    if (i < 0) return null;
    const next = [...vis];
    next.splice(i, 1);
    const at = target === 'top' ? 0
        : target === 'bottom' ? next.length
            : target === 'up' ? Math.max(0, i - 1)
                : Math.min(next.length, i + 1);
    next.splice(at, 0, key);
    return applyVisibleOrder(fullKeys, vis, next);
}

export function searchNotes(cards: NoteCard[], query: string): NoteCard[] {
    if (normalizeForSearch(query) === '') return cards.filter(c => !c.archived);
    return cards.filter(c => noteMatches(c, query));
}

/** One row of a card preview: a task and how deep it nests. */
export interface PreviewRow {
    task: Task;
    depth: number;
}

export interface NotePreview {
    /** Open items in tree order, capped at `limit`. */
    rows: PreviewRow[];
    /** Open items the cap hid. */
    moreOpen: number;
    /** Completed top-level items (their subtrees are folded into them). */
    completedCount: number;
}

/**
 * The card's compact view of a note: open items first (nested, in Púca's
 * order), the rest summarised as counts. Completed items are folded away
 * exactly as TaskTree's collapsed Completed section folds them — a card is
 * a glance, not the editor.
 */
export function previewRows(tasks: Task[], limit: number): NotePreview {
    const tree = buildTaskTree(tasks);
    const rows: PreviewRow[] = [];
    let openTotal = 0;
    let completedCount = 0;
    const walk = (nodes: TaskNode[], depth: number) => {
        for (const n of nodes) {
            if (n.task.is_completed) {
                if (depth === 0) completedCount++;
                continue;
            }
            openTotal++;
            if (rows.length < limit) rows.push({ task: n.task, depth });
            walk(n.children, depth + 1);
        }
    };
    walk(tree, 0);
    return { rows, moreOpen: Math.max(0, openTotal - rows.length), completedCount };
}

/** The earliest due time among OPEN tasks (overdue ones sort first because
 *  they are earliest); null when nothing is due. */
export function nearestDue(tasks: Task[]): Task | null {
    let best: Task | null = null;
    let bestT = Infinity;
    for (const t of tasks) {
        // A scheduled item's due_at is its next REMINDER, not a deadline: its
        // own chip (ScheduleChip) says when it is.
        if (t.is_completed || !t.due_at || (t.schedule !== undefined && t.schedule !== null)) continue;
        const at = parseServerTimestamp(t.due_at);
        if (!Number.isFinite(at) || at >= bestT) continue;
        best = t;
        bestT = at;
    }
    return best;
}

/** A due task with the note it belongs to, for the Reminders view. */
export interface DueItem {
    task: Task;
    note: NoteCard;
    /** Epoch ms. */
    at: number;
    /** How the item's timing reads (notesTiming.reminderSlotOf). */
    slot?: ReminderSlot;
}

export interface ReminderGroups {
    overdue: DueItem[];
    today: DueItem[];
    upcoming: DueItem[];
}

function sameLocalDay(a: number, b: number): boolean {
    const x = new Date(a);
    const y = new Date(b);
    return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * Every open task with a due time, across every note (archived included —
 * archiving a note does not cancel its reminders, which is also what the
 * reminder loop in api/taskReminders.ts will fire for), grouped for display
 * and sorted soonest-first within each group.
 */
export function groupReminders(cards: NoteCard[], now: number): ReminderGroups {
    const items: DueItem[] = [];
    for (const note of cards) {
        for (const task of note.tasks ?? []) {
            // Snoozes, repeats and events (notesTiming.reminderSlotOf): an
            // event is never overdue, a snoozed item sorts by its snooze.
            const slot = reminderSlotOf(task, now);
            if (!slot) continue;
            items.push({ task, note, at: slot.at, slot });
        }
    }
    items.sort((a, b) => a.at - b.at || a.task.id - b.task.id);
    const groups: ReminderGroups = { overdue: [], today: [], upcoming: [] };
    for (const it of items) {
        if (it.slot ? it.slot.overdue : isTaskOverdue(it.task, now)) groups.overdue.push(it);
        else if (sameLocalDay(it.at, now)) groups.today.push(it);
        else groups.upcoming.push(it);
    }
    return groups;
}

/** How many reminders deserve a badge: overdue + due today. */
export function reminderBadgeCount(groups: ReminderGroups): number {
    return groups.overdue.length + groups.today.length;
}

export const MAX_TITLE_LENGTH = 100;
export const QUICK_TITLE_FROM_ITEM_LENGTH = 60;

/**
 * The title a quick-add note gets. Púca lists must have a title (the server
 * rejects an empty one), while Notes lets you start typing items straight
 * away — so an untitled note borrows its first item, and a note with
 * nothing at all is "Untitled note".
 */
export function deriveQuickTitle(title: string, items: string[]): string {
    const t = title.replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, MAX_TITLE_LENGTH);
    const first = items.map(i => i.replace(/\s+/g, ' ').trim()).find(i => i !== '');
    if (!first) return 'Untitled note';
    return first.length > QUICK_TITLE_FROM_ITEM_LENGTH
        ? first.slice(0, QUICK_TITLE_FROM_ITEM_LENGTH - 1).trimEnd() + '…'
        : first;
}

/** Items a quick-add will create, in order: trimmed, blanks dropped. */
export function cleanQuickItems(items: string[]): string[] {
    return items.map(i => i.replace(/\s+/g, ' ').trim()).filter(i => i !== '');
}

/** The union of every label in use, sorted for the rail. */
export function allLabels(cards: NoteCard[]): string[] {
    const seen = new Map<string, string>();
    for (const c of cards) {
        for (const l of c.labels) {
            const k = l.toLocaleLowerCase();
            if (!seen.has(k)) seen.set(k, l);
        }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** The hash route for a note. */
export function noteRoute(ref: NoteRef): string {
    return `/n/${ref.kind}/${ref.id}`;
}

// --- Bulk selection (pure; notes/components/useNoteSelection.ts drives it) ------------

/** Add or remove one note. */
export function toggleInSelection(sel: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
}

/** Shift-click: add every note between the anchor and `key` in the VISIBLE
 *  order (inclusive). No usable anchor = a plain toggle. */
export function rangeSelection(sel: ReadonlySet<string>, visibleKeys: readonly string[], anchor: string | null, key: string): Set<string> {
    const a = anchor === null ? -1 : visibleKeys.indexOf(anchor);
    const b = visibleKeys.indexOf(key);
    if (a < 0 || b < 0) return toggleInSelection(sel, key);
    const next = new Set(sel);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(visibleKeys[i]);
    return next;
}

/** A selection only ever holds notes the user can see (a filter change, a
 *  search, a note deleted elsewhere drops the rest). */
export function keepVisible(sel: ReadonlySet<string>, visibleKeys: readonly string[]): Set<string> {
    const vis = new Set(visibleKeys);
    const next = new Set([...sel].filter(k => vis.has(k)));
    return next.size === sel.size ? (sel as Set<string>) : next;
}

/**
 * The saved order after pinning or unpinning a selection — over the FULL
 * order (every note, archived and filtered-out included), because the saved
 * prefs are a full replace of Púca's Tasks tab bar (moveNoteInOrder has the
 * story). Pinning pulls the selection to the front in its current order, the
 * way a single favourite does; unpinning changes no order.
 */
export function bulkPinOrder(fullKeys: readonly string[], selected: ReadonlySet<string>, pin: boolean): { order: string[]; overrides: Map<string, boolean> } {
    const overrides = new Map([...selected].filter(k => fullKeys.includes(k)).map(k => [k, pin] as [string, boolean]));
    const order = pin
        ? [...fullKeys.filter(k => selected.has(k)), ...fullKeys.filter(k => !selected.has(k))]
        : [...fullKeys];
    return { order, overrides };
}

/**
 * Put a just-created note into the cached list set exactly once. The live
 * event stream can refetch the set between the create and this write, so the
 * note may already be there; appending again showed it twice (and the sealed
 * cache kept the duplicate across a reload).
 */
export function withCreatedList<L extends { id: number }>(prev: readonly L[] | undefined, created: L): L[] {
    return [...(prev ?? []).filter(l => l.id !== created.id), created];
}
