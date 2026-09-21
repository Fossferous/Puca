/**
 * Púca Notes — the data layer.
 *
 * Everything Notes shows comes from Púca's task API (api/tasks.ts) through
 * @tanstack/react-query, and every edit goes back through the same functions
 * the Tasks view calls. Optimistic updates use the SAME pure helpers Púca's
 * TasksView and ChecklistBody use (planToggle, applyReorder, applyMove,
 * collectSubtreeIds, buildPrefsForOrder, keepHiddenSlots), so an edit made
 * in Notes lands in exactly the state Púca would have produced — and rolls back
 * to the previous snapshot on failure, as they do.
 *
 * THE OUTBOX. Every task and note write that can wait goes through
 * `sendNoteOp` (notesOutbox.ts): online it simply runs; offline it is queued
 * and replayed in order. That includes a tick (repeating or not), a date &
 * repeat, a snooze and an item created with a time (calendar tap-to-add), and
 * Delete, which is Move-to-trash wherever the server has a trash
 * (api/listContent.ts trashOrDeleteList, probed when the op runs). What does
 * NOT queue — uploading pictures, a note's text, attachments — fails offline
 * and says so.
 *
 * NO WEBSOCKET, deliberately. Púca's main.tsx wires the P2P file-transfer
 * handlers synchronously at boot because the server sweeps PARKED file offers
 * to whichever connection registers next, and an unwired handler map consumes
 * a delivered-once offer into nothing. Notes never opens the socket, so it can
 * never eat an offer meant for the chat app — and it never creates a presence
 * session or an unattested device connection either. Freshness comes from
 * the content-free event stream (taskEvents.ts), refetch-on-focus, a slow
 * interval while a SHARED note is open and the stream is down, and the
 * explicit refresh button.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClient, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
    type NewTaskTiming,
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    type TaskTabPref,
    type TaskTimingPatch,
    listTaskLists,
    listListTasks, updateListTaskAttachments,
    listTasks, updateChannelTaskAttachments,
    getTaskTabPrefs,
    applyMove, applyReorder, collectSubtreeIds, serializeTaskAttachments,
    buildPrefsForOrder, isFavoriteTab, canEditTask,
} from '../../api/tasks';
import { listServers, listChannels, listMembersWithRoles, type Channel, type MemberWithRoles, type Server } from '../../api/servers';
import { hasPerm, PERM } from '../../api/permissionBits';
import { listDMConversations, type DMConversation } from '../../api/dms';
import { ApiError } from '../../api/client';
import { pokeTaskReminders } from '../../api/taskReminders';
import { planToggle } from '../../api/taskCompletion';
import { snoozePatch } from '../../api/taskSchedule';
import { currentUserIdFromToken } from '../../api/auth';
import { pushMessageToast } from '../../components/messageToastBus';
import { toastRefusal } from '../../api/refusalToast';
import {
    type ListDeleteOutcome,
    fetchListFeatures,
    flushBodySave,
    keepHiddenSlots,
    toggleFavoriteKeepingHidden,
    trashedTaskListIds,
} from '../../api/listContent';
import {
    type NoteCard, type NoteRef, type NoteSource, type NotesNoteState,
    buildNoteCards, noteKey, cleanQuickItems, deriveQuickTitle, bulkPinOrder, withCreatedList,
} from './notesModel';
import { useTaskEventsLive } from './taskEvents';
import { ops, sendCreateList, sendCreateTask, sendNoteOp, type PrefsIntent } from './notesOutbox';
import { anythingQueued } from './noteBusy';
import { reinsertList } from './notesBulk';
import { newPruneState, pruneStep, type PruneGens, type PruneState } from './notesPrune';
import { getNotesPrefs, subscribeNotesPrefs, forgetNoteKeys, setNoteArchived, setNoteColor, setNoteLabels } from './notesPrefs';
import { type ListContentActions, type NoteExtras, hasExtras, listContentKeys, useListContentActions, useTrashedLists } from './useListContent';

/** Notes' own client: it WANTS refetch-on-focus (that is its live sync),
 *  unlike Púca's shared client which has a socket for that. */
export function makeNotesQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                gcTime: 30 * 60_000,
                retry: 1,
                // Not while offline edits are queued: the server's copy lacks
                // them, and the replay re-reads everything when it is done.
                refetchOnWindowFocus: () => !anythingQueued(),
                refetchOnReconnect: () => !anythingQueued(),
                refetchOnMount: () => !anythingQueued(),
            },
        },
    });
}

// --- Keys ------------------------------------------------------------------------

export const notesKeys = {
    all: ['notes'] as const,
    lists: ['notes', 'lists'] as const,
    prefs: ['notes', 'prefs'] as const,
    servers: ['notes', 'servers'] as const,
    channels: (serverId: string) => ['notes', 'servers', serverId, 'channels'] as const,
    members: (serverId: string) => ['notes', 'servers', serverId, 'members'] as const,
    dms: ['notes', 'dms'] as const,
    tasks: (ref: NoteRef) => ['notes', 'tasks', ref.kind, ref.id] as const,
};

/** Refetch cadence for an OPEN shared note: other members edit those and there
 *  is no socket to tell us. Personal lists never poll (only this account
 *  writes them, and focus-refetch covers its other devices). */
export const SHARED_NOTE_POLL_MS = 30_000;

// --- Queries ---------------------------------------------------------------------

export function useTaskListsQuery() {
    return useQuery({ queryKey: notesKeys.lists, queryFn: listTaskLists });
}

/**
 * The saved pins + order. A backend without the endpoint (404) means "no
 * prefs" — natural order, nothing pinned. ANY OTHER failure throws, so
 * react-query retries and keeps the last good data across a failed focus
 * refetch. Swallowing it into [] (the first cut) turned a one-second blip
 * into an empty grid of pins — and the next pin would have PUT that
 * emptiness over the server's row, which is also Púca's Tasks tab bar.
 */
export function useTabPrefsQuery() {
    return useQuery({
        queryKey: notesKeys.prefs,
        queryFn: async (): Promise<TaskTabPref[]> => {
            try {
                return await getTaskTabPrefs();
            } catch (err) {
                if (err instanceof ApiError && err.status === 404) return [];
                throw err;
            }
        },
    });
}

/**
 * List-level mutations in flight (a delete's or a restore's optimistic
 * move). The device-local prune must not run while one is: the note may be
 * in neither cache for a moment and come back on rollback, and a pruned
 * label cannot.
 */
let listMutationsInFlight = 0;
const pruneBlocked = () => listMutationsInFlight > 0;

export function useServersQuery() {
    return useQuery({ queryKey: notesKeys.servers, queryFn: listServers });
}

/** One NoteSource per checklist channel across every joined server, plus
 *  whether any server's channel query is still pending or failed (a caller
 *  must not prune prefs against an INCOMPLETE set). */
export function useChannelSources(): { sources: NoteSource[]; complete: boolean; updatedAt: number; oldestAt: number } {
    const { data: servers = [], isSuccess: serversDone, dataUpdatedAt: serversAt } = useServersQuery();
    const channelQueries = useQueries({
        queries: servers.map((s: Server) => ({
            queryKey: notesKeys.channels(s.id),
            queryFn: () => listChannels(s.id),
        })),
    });
    const memberQueries = useQueries({
        queries: servers.map((s: Server) => ({
            queryKey: notesKeys.members(s.id),
            queryFn: () => listMembersWithRoles(s.id),
            staleTime: 5 * 60_000,
        })),
    });
    const channelData = channelQueries.map(q => q.data);
    const memberData = memberQueries.map(q => q.data);
    const allChannelsSettled = channelQueries.every(q => q.isSuccess);
    // When the channel set was last fetched: the prune's generation for
    // checklist notes (notesPrune.ts).
    const updatedAt = Math.max(serversAt, ...channelQueries.map(q => q.dataUpdatedAt));
    // ...and the oldest fetch behind it: a view still holding a channel list
    // hydrated from the device cache is not this page's own (notesPrune.ts).
    const oldestAt = Math.min(serversAt, ...channelQueries.map(q => q.dataUpdatedAt));
    const memo = useMemo(() => {
        const sources: NoteSource[] = servers.flatMap((server: Server, i: number) => {
            const names = new Map(
                ((memberData[i] as MemberWithRoles[] | undefined) ?? [])
                    .map(m => [m.id, m.display_name || m.server_nickname || m.username]),
            );
            return ((channelData[i] as Channel[] | undefined) ?? [])
                .filter(c => c.has_checklist)
                .map(c => ({
                    ref: { kind: 'channel' as const, id: c.id },
                    title: c.name,
                    serverId: server.id,
                    serverName: server.name,
                    myPerms: c.my_permissions,
                    resolveUserName: (id: number) => names.get(id),
                }));
        });
        return { sources, complete: serversDone && allChannelsSettled };
        // The query result arrays are new every render; the data inside is
        // what matters, and react-query keeps THAT referentially stable.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [servers, serversDone, allChannelsSettled, ...channelData, ...memberData]);
    return useMemo(() => ({ ...memo, updatedAt, oldestAt }), [memo, updatedAt, oldestAt]);
}

/** Existing DM conversations, for "Send to Púca…". Its own key, its own
 *  cadence: Notes never renders DMs, so this is fetched only when the sheet
 *  asks for it (`enabled`). */
export function useDMTargetsQuery(enabled: boolean) {
    return useQuery({ queryKey: notesKeys.dms, queryFn: listDMConversations, enabled, staleTime: 60_000 });
}

/** One send destination: a text channel of a joined server. */
export interface SendChannelTarget {
    server: Server;
    channel: Channel;
}

/**
 * Where a note may be POSTED as a message: text channels of joined servers
 * that this account can actually send in, plus existing DM conversations.
 *
 * The filter is the exact INVERSE of useChannelSources' — a checklist channel
 * IS a note already, and posting a note's text into its own feed is nonsense —
 * with one thing ForwardModal deliberately cannot do: `my_permissions` is in
 * hand here, so a channel this account cannot post in is not offered at all
 * rather than offered and 403'd. It reuses the SAME query keys the grid
 * already primes, so opening the sheet costs no extra fetch for channels.
 */
export function useSendTargets(enabled: boolean): { channels: SendChannelTarget[]; dms: DMConversation[]; loading: boolean } {
    const { data: servers = [], isPending: serversPending } = useServersQuery();
    const channelQueries = useQueries({
        queries: servers.map((s: Server) => ({
            queryKey: notesKeys.channels(s.id),
            queryFn: () => listChannels(s.id),
        })),
    });
    const dmQuery = useDMTargetsQuery(enabled);
    // Computed on every render rather than memoised: the dependency would be
    // a variable-length spread of the per-server query results, which React
    // warns about ("the final argument passed to useMemo changed size"), and
    // the list is a handful of channels — the sheet is the only consumer.
    const channels = servers.flatMap((server: Server, i: number) =>
        ((channelQueries[i]?.data as Channel[] | undefined) ?? [])
            .filter(c => c.channel_type === 0 && !c.has_checklist && hasPerm(c.my_permissions, PERM.SEND_MESSAGES))
            .map(channel => ({ server, channel })));
    return {
        channels,
        dms: dmQuery.data ?? [],
        loading: serversPending || channelQueries.some(q => q.isPending) || dmQuery.isPending,
    };
}

function listSource(l: TaskList): NoteSource {
    return {
        ref: { kind: 'list', id: l.id },
        title: l.title,
        titleEncState: l.titleEncState,
        totalTasks: l.total_tasks,
        completedTasks: l.completed_tasks,
        createdAt: l.created_at,
        body: l.body,
        noteAttachments: l.attachments,
        updatedAt: l.updated_at,
    };
}

/** Every note the account can see, personal lists first (Púca's natural
 *  order before prefs apply), then channel checklists. */
export function useNoteSources(): {
    sources: NoteSource[];
    loading: boolean;
    error: unknown;
    complete: boolean;
    /** When the lists and the channel set were last fetched (prune gens). */
    gens: PruneGens;
} {
    const lists = useTaskListsQuery();
    const channels = useChannelSources();
    const listData = lists.data;
    const sources = useMemo(
        () => [...(listData ?? []).map(listSource), ...channels.sources],
        [listData, channels.sources],
    );
    return {
        sources,
        loading: lists.isPending,
        error: lists.error,
        complete: lists.isSuccess && channels.complete,
        gens: { list: lists.dataUpdatedAt, channel: channels.updatedAt, channelOldest: channels.oldestAt },
    };
}

function fetchTasksFor(ref: NoteRef): Promise<Task[]> {
    return ref.kind === 'list' ? listListTasks(ref.id) : listTasks(ref.id);
}

/** The tasks of one note. `live` polls shared notes while the editor is open
 *  — unless the live event stream is up (taskEvents.ts), which makes it moot. */
export function useNoteTasks(ref: NoteRef | null, opts: { live?: boolean } = {}) {
    const streamLive = useTaskEventsLive();
    return useQuery({
        queryKey: ref ? notesKeys.tasks(ref) : ['notes', 'tasks', 'none'],
        queryFn: () => fetchTasksFor(ref!),
        // A note created offline (negative id) exists only here until it syncs.
        enabled: ref !== null && ref.id > 0,
        refetchInterval: opts.live && ref?.kind === 'channel' && !streamLive ? SHARED_NOTE_POLL_MS : false,
    });
}

/**
 * A module-level `combine` (stable identity, so react-query memoizes it)
 * that returns a PLAIN object of the per-query data references: react-query
 * structurally shares plain objects/arrays between renders, so `data` keeps
 * its identity while no query's result changed. A Map would not (it is not a
 * plain object), and an inline arrow would recompute every render.
 */
const combineTaskResults = (results: UseQueryResult<Task[], Error>[]) => ({
    data: results.map(r => r.data),
    anyPending: results.some(r => r.isPending),
    anyError: results.some(r => r.isError),
});

/** The tasks of EVERY note, keyed by note key, for the grid previews, search
 *  and the reminders view. The map is rebuilt only when a query's data or
 *  the source list changed. */
export function useAllNoteTasks(sources: NoteSource[]): { byKey: Map<string, Task[]>; anyPending: boolean; anyError: boolean } {
    const combined = useQueries({
        queries: sources.map(s => ({
            queryKey: notesKeys.tasks(s.ref),
            queryFn: () => fetchTasksFor(s.ref),
            enabled: s.ref.id > 0,
        })),
        combine: combineTaskResults,
    });
    const data = combined.data;
    const byKey = useMemo(() => {
        const m = new Map<string, Task[]>();
        data.forEach((d, i) => { if (d && sources[i]) m.set(noteKey(sources[i].ref), d); });
        return m;
    }, [data, sources]);
    return { byKey, anyPending: combined.anyPending, anyError: combined.anyError };
}

export function useNotesPrefs() {
    return useSyncExternalStore(subscribeNotesPrefs, getNotesPrefs, getNotesPrefs);
}

/** The assembled cards, in display order, plus the load state the shell
 *  renders from. Also prunes device-local state for notes that no longer
 *  exist — only once the FULL set is known (a failed server query must not
 *  look like a deleted note). */
export function useNoteCards(): {
    cards: NoteCard[];
    sources: NoteSource[];
    prefs: TaskTabPref[];
    /** False until the pins/order have been read successfully at least once —
     *  a save built on unknown prefs would replace the server's set with a
     *  guess, so the actions refuse to save while this is false. */
    prefsReady: boolean;
    loading: boolean;
    error: unknown;
    tasksPending: boolean;
} {
    const { sources, loading, error, complete, gens } = useNoteSources();
    const prefsQuery = useTabPrefsQuery();
    const prefsData = prefsQuery.data;
    const prefs = useMemo(() => prefsData ?? [], [prefsData]);
    const local = useNotesPrefs();
    const tasks = useAllNoteTasks(sources);
    const trash = useTrashedLists();
    const trashData = trash.data;
    const trashKeys = useMemo(() => (trashData ?? []).map(l => `list:${l.id}`), [trashData]);
    const cards = useMemo(
        () => buildNoteCards(sources, tasks.byKey, prefs, local),
        [sources, tasks.byKey, prefs, local],
    );
    // Colour, labels and archive of notes deleted OUTSIDE Notes are forgotten
    // only once they have been missing across two settled, complete fetches a
    // grace period apart, and a personal list only once the trash has been
    // asked afresh too (notesPrune.ts). A note in the trash counts as live
    // throughout — its colour and labels must survive so a restore brings it
    // back whole. Never while offline edits are queued (the server's set is
    // behind this device's then), while a delete's optimistic removal is in
    // flight (it comes back on rollback; a pruned label does not), or before
    // the trash has been read.
    useSettledAbsencePrune(sources, local, complete && trash.settled, gens, trashKeys);
    return { cards, sources, prefs, prefsReady: prefsData !== undefined, loading, error, tasksPending: tasks.anyPending };
}

let prunes: PruneState = newPruneState();

/** For tests: forget every strike the prune has recorded. */
export function resetNotesPrune(): void {
    prunes = newPruneState();
}

/** Ask the trash, afresh, before forgetting a personal list: a trashed note
 *  keeps its colour and labels for a restore. Any failure means "not
 *  confirmed". The one trash API is api/listContent.ts. */
export async function confirmGone(qc: QueryClient, keys: string[]): Promise<string[]> {
    const lists = keys.filter(k => k.startsWith('list:'));
    if (lists.length === 0) return keys;
    try {
        const features = await qc.fetchQuery({ queryKey: listContentKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
        if (!features.trash) return keys;
        // Outside the ['notes'] namespace: never persisted to the device
        // cache, and always fetched fresh for this one decision — a read
        // that STARTED after the listing the note is missing from, so a note
        // trashed elsewhere a moment ago is found there.
        const trashed = new Set(await qc.fetchQuery({ queryKey: ['notes-prune', 'trashed-ids'], queryFn: trashedTaskListIds, staleTime: 0, gcTime: 0 }));
        return keys.filter(k => !k.startsWith('list:') || !trashed.has(Number(k.slice(5))));
    } catch {
        return keys.filter(k => !k.startsWith('list:'));
    }
}

function useSettledAbsencePrune(sources: NoteSource[], local: NotesNoteState, complete: boolean, gens: PruneGens, trashKeys: string[]): void {
    const qc = useQueryClient();
    const { list, channel, channelOldest } = gens;
    useEffect(() => {
        if (!complete || anythingQueued() || pruneBlocked()) return;
        const present = new Set([...sources.map(s => noteKey(s.ref)), ...trashKeys]);
        const stored = new Set([...Object.keys(local.colors), ...Object.keys(local.labels), ...Object.keys(local.archived)]);
        const due = pruneStep(prunes, { list, channel, channelOldest }, Date.now(), present, stored);
        if (due.length === 0) return;
        let cancelled = false;
        void confirmGone(qc, due).then(gone => {
            if (!cancelled && gone.length > 0 && !anythingQueued() && !pruneBlocked()) forgetNoteKeys(gone);
        });
        return () => { cancelled = true; };
    }, [qc, sources, local, complete, list, channel, channelOldest, trashKeys]);
}

// --- Mutations -------------------------------------------------------------------

/** Every server refusal is the user's to see (a 403 on a snooze or a tick
 *  in a shared note used to roll back without a word; a 409 is an envelope
 *  or a trashed-note refusal in the server's own words). True when one was
 *  shown, so a caller can add its own message otherwise. */
function explain(what: string, err: unknown): boolean {
    console.error(`[notes] ${what}:`, err);
    return toastRefusal(err);
}

export interface NoteActions {
    /** Task-level edits on one note. */
    toggleTask: (note: NoteRef, task: Task, completed: boolean) => Promise<void>;
    editTask: (note: NoteRef, task: Task, description: string) => Promise<void>;
    addTask: (note: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming) => Promise<Task | null>;
    /** True once the item is gone: deleted on the server, or its delete
     *  queued offline (it replays). False when it was refused and put back —
     *  a caller must not treat its files as unused then. */
    deleteTaskFrom: (note: NoteRef, taskId: number) => Promise<boolean>;
    moveTaskIn: (note: NoteRef, task: Task, direction: 'up' | 'down') => Promise<void>;
    reorderTaskIn: (note: NoteRef, task: Task, afterId: number | null, reparent?: { parentId: number | null }) => Promise<void>;
    setDue: (note: NoteRef, task: Task, dueAt: string | null) => Promise<void>;
    /** Date & repeat (plaintext schedule, null removes) with its derived due_at. */
    setSchedule: (note: NoteRef, task: Task, schedule: string | null, dueAt: string | null) => Promise<void>;
    /** Snooze the item's current reminder until an instant (null = unsnooze). */
    snoozeTask: (note: NoteRef, task: Task, until: number | null) => Promise<void>;
    setAttachments: (note: NoteRef, task: Task, refs: TaskAttachmentRef[]) => Promise<void>;
    /** Note-level. createNote resolves with the new note once the LIST exists
     *  — even if some items failed (they are reported; the note is real) —
     *  and null only when nothing was saved. */
    createNote: (title: string, items: string[], extra?: NoteExtras, timing?: (NewTaskTiming | undefined)[]) => Promise<NoteRef | null>;
    renameNote: (note: NoteRef, title: string) => Promise<boolean>;
    /** Moves the note to the trash where the server has one, else deletes it
     *  for good; queued while offline (the trash is probed when it runs). */
    deleteNote: (note: NoteRef) => Promise<boolean>;
    /** Out of the trash (the Undo of deleteNote when it trashed). */
    restoreNote: (note: NoteRef) => Promise<boolean>;
    /** Note text, photos, drawings and the trash (useListContent.ts). */
    content: ListContentActions;
    togglePin: (note: NoteRef) => void;
    /** Pin or unpin several notes in ONE save (bulk selection). */
    setPinnedMany: (notes: NoteRef[], pinned: boolean) => void;
    reorderNotes: (orderedKeys: string[]) => void;
    /** Device-local. */
    setColor: (note: NoteRef, color: Parameters<typeof setNoteColor>[1]) => void;
    setLabels: (note: NoteRef, labels: string[]) => void;
    setArchived: (note: NoteRef, archived: boolean) => void;
    /** Refetch everything from the server. */
    refreshAll: () => Promise<void>;
    refreshNote: (note: NoteRef) => Promise<void>;
}

/**
 * The mutation surface, bound to the query cache. `cards`/`prefs` are read
 * through refs so the returned callbacks are stable (they are handed to every
 * card and to TaskTree).
 */
export function useNoteActions(cards: NoteCard[], prefs: TaskTabPref[], prefsReady: boolean): NoteActions {
    const qc = useQueryClient();
    const cardsRef = useRef(cards);
    const prefsRef = useRef(prefs);
    const prefsReadyRef = useRef(prefsReady);
    useEffect(() => { cardsRef.current = cards; prefsRef.current = prefs; prefsReadyRef.current = prefsReady; });
    // Sequenced pref saves: only the LATEST save may roll back (TasksView's rule).
    const prefSeq = useRef(0);
    const content = useListContentActions(notesKeys);
    const contentRef = useRef(content);
    useEffect(() => { contentRef.current = content; });
    // The rows this page's deletes took out of the grid, for their Undo: the
    // trash cache may not hold them (not read yet, or the move still queued
    // offline), and an Undo must put the note back on screen either way.
    const removedLists = useRef(new Map<number, TaskList>());

    const setTasks = useCallback((note: NoteRef, fn: (prev: Task[]) => Task[]) => {
        qc.setQueryData<Task[]>(notesKeys.tasks(note), prev => fn(prev ?? []));
    }, [qc]);
    /** Snapshot for an optimistic write. Cancels an in-flight fetch of the
     *  same note first: a response captured BEFORE the write would otherwise
     *  land after it and silently undo the edit (a poll or a focus refetch
     *  races every mutation here, and Púca's socket-driven views never had
     *  that race). */
    const snapshot = useCallback(async (note: NoteRef): Promise<Task[]> => {
        await qc.cancelQueries({ queryKey: notesKeys.tasks(note) });
        return qc.getQueryData<Task[]>(notesKeys.tasks(note)) ?? [];
    }, [qc]);
    const restore = useCallback((note: NoteRef, tasks: Task[]) => { qc.setQueryData<Task[]>(notesKeys.tasks(note), tasks); }, [qc]);
    const syncListCounts = useCallback((note: NoteRef, tasks: Task[]) => {
        if (note.kind !== 'list') return;
        qc.setQueryData<TaskList[]>(notesKeys.lists, prev => prev?.map(l => l.id === note.id
            ? { ...l, total_tasks: tasks.length, completed_tasks: tasks.filter(t => t.is_completed).length }
            : l));
    }, [qc]);
    /** May this user edit the item's time (its creator, a task manager, any
     *  personal list)? */
    const canEditTime = useCallback((note: NoteRef, task: Task): boolean => {
        if (note.kind === 'list') return true;
        const card = cardsRef.current.find(c => c.ref.kind === note.kind && c.ref.id === note.id);
        return canEditTask(task, currentUserIdFromToken() ?? undefined, card?.myPerms);
    }, []);
    /** A timing PATCH through the outbox; pokes the reminders once it ran
     *  (a queued one pokes them at replay — notesOutbox.ts touchedDue). */
    const sendTiming = useCallback(async (note: NoteRef, task: Task, patch: TaskTimingPatch, what: string) => {
        const sent = await sendNoteOp(ops.timing(note, task, patch, what));
        if (!sent.queued) pokeTaskReminders();
    }, []);

    const toggleTask = useCallback(async (note: NoteRef, task: Task, completed: boolean) => {
        const original = await snapshot(note);
        // One completion path (taskCompletion.ts): a repeating task advances.
        const plan = planToggle(original, task, completed, { canEdit: canEditTime(note, task) });
        const next = plan.next;
        restore(note, next);
        syncListCounts(note, next);
        try {
            // A refusal (no patch) rejects without the network; everything
            // else is a timing PATCH the outbox can queue.
            if (plan.patch) await sendTiming(note, task, plan.patch, completed ? (plan.advanced ? 'tick (next time)' : 'tick') : 'untick');
            else await plan.send();
        } catch (err) {
            explain('toggle failed', err);
            restore(note, original);
            syncListCounts(note, original);
            // A lost race with another device's advance: show the truth.
            if (err instanceof ApiError && err.status === 409) restore(note, await fetchTasksFor(note).catch(() => original));
        }
    }, [snapshot, restore, syncListCounts, canEditTime, sendTiming]);

    const editTask = useCallback(async (note: NoteRef, task: Task, description: string) => {
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, description } : t)));
        try {
            await sendNoteOp(ops.editTask(note, task, description));
        } catch (err) {
            explain('edit failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

    const addTask = useCallback(async (note: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming): Promise<Task | null> => {
        try {
            // `timing` (a calendar tap-to-add) rides the same one POST, queued
            // with it while offline.
            const created = await sendCreateTask(note, description, parentId, () => qc.getQueryData<Task[]>(notesKeys.tasks(note)) ?? [], timing);
            if (timing && created.id > 0) pokeTaskReminders();
            const next = [...await snapshot(note), created];
            restore(note, next);
            syncListCounts(note, next);
            return created;
        } catch (err) {
            explain('add failed', err);
            return null;
        }
    }, [qc, snapshot, restore, syncListCounts]);

    const deleteTaskFrom = useCallback(async (note: NoteRef, taskId: number): Promise<boolean> => {
        const original = await snapshot(note);
        const doomed = collectSubtreeIds(original, taskId);
        const next = original.filter(t => !doomed.has(t.id));
        restore(note, next);
        syncListCounts(note, next);
        try {
            await sendNoteOp(ops.deleteTask(note, taskId, original.find(t => t.id === taskId)?.description ?? ''));
            return true;
        } catch (err) {
            explain('delete failed', err);
            restore(note, original);
            syncListCounts(note, original);
            return false;
        }
    }, [snapshot, restore, syncListCounts]);

    const moveTaskIn = useCallback(async (note: NoteRef, task: Task, direction: 'up' | 'down') => {
        const original = await snapshot(note);
        const next = applyMove(original, task, direction);
        if (next === original) return;
        restore(note, next);
        try {
            await sendNoteOp(ops.move(note, task, direction));
        } catch (err) {
            explain('move failed', err);
            restore(note, original);
        }
    }, [snapshot, restore]);

    const reorderTaskIn = useCallback(async (
        note: NoteRef, task: Task, afterId: number | null, reparent?: { parentId: number | null },
    ) => {
        const original = await snapshot(note);
        const next = applyReorder(original, task, afterId, reparent);
        if (next === original) return;
        restore(note, next);
        try {
            const sent = await sendNoteOp(ops.reorder(note, task, afterId, reparent));
            // A reparent re-reads from truth on success (ChecklistBody's rule:
            // the one old-server frame that 200s is healed by this read).
            if (reparent && !sent.queued) restore(note, await fetchTasksFor(note));
        } catch (err) {
            explain('reorder failed', err);
            restore(note, original);
        }
    }, [snapshot, restore]);

    const setDue = useCallback(async (note: NoteRef, task: Task, dueAt: string | null) => {
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, due_at: dueAt } : t)));
        try {
            const sent = await sendNoteOp(ops.setDue(note, task, dueAt));   // '' clears server-side
            if (!sent.queued) pokeTaskReminders();
        } catch (err) {
            explain('due time failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

    const setSchedule = useCallback(async (note: NoteRef, task: Task, schedule: string | null, dueAt: string | null) => {
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, schedule, due_at: dueAt } : t)));
        try {
            await sendTiming(note, task, { schedule, due_at: dueAt }, schedule === null ? 'remove the date from' : 'date on');
        } catch (err) {
            explain('schedule failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore, sendTiming]);

    const snoozeTask = useCallback(async (note: NoteRef, task: Task, until: number | null) => {
        // A snooze moves the item's plaintext due_at to the snooze instant
        // when this user may edit its time (taskSchedule.snoozePatch), so a
        // phone reminding with Notes closed fires it then, not at the old time.
        const patch = snoozePatch(task, until, canEditTime(note, task));
        // No patch: the reminder has no time on the server, or this is an
        // editor's moved snooze and the user may not edit the time
        // (taskSchedule.snoozeLocked — the control is hidden as well).
        if (!patch) return;
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, snooze: patch.snooze, ...(patch.due_at !== undefined ? { due_at: patch.due_at } : {}) } : t)));
        try {
            await sendTiming(note, task, patch, until === null ? 'unsnooze' : 'snooze');
        } catch (err) {
            explain('snooze failed', err);
            restore(note, original);
            // Lost a race with another device's edit or advance: show the truth.
            if (err instanceof ApiError && err.status === 409) restore(note, await fetchTasksFor(note).catch(() => original));
        }
    }, [snapshot, setTasks, restore, canEditTime, sendTiming]);

    const setAttachments = useCallback(async (note: NoteRef, task: Task, refs: TaskAttachmentRef[]) => {
        const original = await snapshot(note);
        try {
            const plain = refs.length === 0 ? null : serializeTaskAttachments(refs);   // can throw (cap)
            setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, attachments: plain } : t)));
            if (note.kind === 'channel') await updateChannelTaskAttachments(note.id, task.id, refs, task.created_by);
            else await updateListTaskAttachments(task.id, refs);
        } catch (err) {
            explain('attachments failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

    const createNote = useCallback(async (title: string, items: string[], extra?: NoteExtras, timing?: (NewTaskTiming | undefined)[]): Promise<NoteRef | null> => {
        // A note with text or pictures goes through the content path: its
        // uploads cannot wait for a connection, so it never queues (it says
        // so when it fails). Its items keep their timing, as here — a copy
        // of a text note keeps its items' dates and repeats.
        if (hasExtras(extra)) return contentRef.current.createContentNote(title, items, extra, timing);
        // Timing rides with its item through the blank-dropping clean.
        const timingOf = new Map<number, NewTaskTiming | undefined>();
        const cleanItems = cleanQuickItems(items.filter((raw, i) => {
            const keep = cleanQuickItems([raw]).length > 0;
            if (keep) timingOf.set(timingOf.size, timing?.[i]);
            return keep;
        }));
        let list: TaskList;
        try {
            list = await sendCreateList(deriveQuickTitle(title, cleanItems));
        } catch (err) {
            explain('create failed', err);
            return null;   // nothing landed: the caller keeps the draft
        }
        const ref: NoteRef = { kind: 'list', id: list.id };
        const created: Task[] = [];
        const missing: string[] = [];
        let timedAndSent = false;
        // Sequential so positions follow the typed order. An item that fails
        // does not lose the note: the list exists, the rest is reported.
        for (const [i, text] of cleanItems.entries()) {
            try {
                const t = await sendCreateTask(ref, text, undefined, () => created, timingOf.get(i));
                if (t.id > 0 && timingOf.get(i)) timedAndSent = true;
                created.push(t);
            } catch (err) {
                explain('create item failed', err);
                missing.push(text);
            }
        }
        if (timedAndSent) pokeTaskReminders();
        qc.setQueryData<Task[]>(notesKeys.tasks(ref), created);
        qc.setQueryData<TaskList[]>(notesKeys.lists, prev => withCreatedList(prev, { ...list, total_tasks: created.length, completed_tasks: 0 }));
        if (missing.length > 0) {
            pushMessageToast({
                title: `Note saved, but ${missing.length} item${missing.length === 1 ? '' : 's'} didn’t — add again: ${missing.join(', ').slice(0, 120)}`,
            });
        }
        return ref;
    }, [qc]);

    const renameNote = useCallback(async (note: NoteRef, title: string): Promise<boolean> => {
        if (note.kind !== 'list') return false;
        const prev = qc.getQueryData<TaskList[]>(notesKeys.lists);
        qc.setQueryData<TaskList[]>(notesKeys.lists, p => p?.map(l => (l.id === note.id ? { ...l, title } : l)));
        try {
            await sendNoteOp(ops.renameList(note.id, title));
            return true;
        } catch (err) {
            explain('rename failed', err);
            qc.setQueryData(notesKeys.lists, prev);
            return false;
        }
    }, [qc]);

    const deleteNote = useCallback(async (note: NoteRef): Promise<boolean> => {
        if (note.kind !== 'list') return false;
        const c = contentRef.current;
        // Notes to self cannot go to the trash (the server refuses it, and
        // only a server with a trash marks a list as that).
        if (c.isSelfList(note.id)) {
            pushMessageToast({ title: 'Notes to self can’t be moved to the trash' });
            return false;
        }
        // Text typed just before this is still on its way (NoteBodyField
        // saves after a pause): let it land first, or the trash's 409 eats it.
        await flushBodySave(note.id);
        // An in-flight refetch of either cache would land after this and put
        // the note back where it was.
        await qc.cancelQueries({ queryKey: notesKeys.lists });
        await qc.cancelQueries({ queryKey: listContentKeys.trash });
        const prev = qc.getQueryData<TaskList[]>(notesKeys.lists);
        const index = prev?.findIndex(l => l.id === note.id) ?? -1;
        const removed = index >= 0 ? prev![index] : undefined;
        // Out of the grid and — where the server is known to have a trash —
        // into the trash in ONE step: a moment where it is in neither is a
        // moment the prune could read as "deleted".
        const intoTrash = c.trashEnabled && removed !== undefined;
        listMutationsInFlight++;   // holds the device-local prune off until this settles
        if (removed) removedLists.current.set(note.id, removed);
        qc.setQueryData<TaskList[]>(notesKeys.lists, p => p?.filter(l => l.id !== note.id));
        if (intoTrash) {
            // Only into a trash that has been READ: a cache created here would
            // look like the whole trash and settle the pin/order guard early.
            qc.setQueryData<TaskList[]>(listContentKeys.trash, p => (p === undefined ? p : [{ ...removed, trashed_at: new Date().toISOString() }, ...p.filter(l => l.id !== note.id)]));
        }
        try {
            // Through the outbox (queued offline); the trash where the server
            // has one, probed when it runs (api/listContent.ts).
            const sent = await sendNoteOp<ListDeleteOutcome>(ops.deleteList(note.id, removed?.title ?? ''));
            if (!sent.queued) {
                if (sent.value === 'deleted') {
                    // Only a PERMANENT delete forgets the colour and labels; a
                    // trashed note keeps them for a restore, and a queued one
                    // is left to the settled-absence prune (useNoteCards).
                    qc.removeQueries({ queryKey: notesKeys.tasks(note) });
                    qc.setQueryData<TaskList[]>(listContentKeys.trash, p => p?.filter(l => l.id !== note.id));
                    forgetNoteKeys([noteKey(note)]);
                } else {
                    void qc.invalidateQueries({ queryKey: listContentKeys.trash });
                    pokeTaskReminders();
                }
            }
            return true;
        } catch (err) {
            if (!explain('delete list failed', err)) {
                pushMessageToast({ title: c.trashEnabled ? 'Couldn’t move the note to the trash — check your connection' : 'Couldn’t delete the note — check your connection' });
            }
            // Put back THIS note only, into the set as it is now: bulk
            // deletes run concurrently, and a whole-snapshot restore would
            // resurrect notes the others had already deleted.
            if (removed) qc.setQueryData<TaskList[]>(notesKeys.lists, cur => reinsertList(cur, removed, index));
            if (intoTrash) qc.setQueryData<TaskList[]>(listContentKeys.trash, cur => cur?.filter(l => l.id !== note.id));
            return false;
        } finally {
            listMutationsInFlight--;
        }
    }, [qc]);

    const restoreNote = useCallback(async (note: NoteRef): Promise<boolean> => {
        if (note.kind !== 'list') return false;
        await qc.cancelQueries({ queryKey: notesKeys.lists });
        await qc.cancelQueries({ queryKey: listContentKeys.trash });
        const trashed = qc.getQueryData<TaskList[]>(listContentKeys.trash) ?? [];
        const tIndex = trashed.findIndex(l => l.id === note.id);
        const inTrash = tIndex >= 0 ? trashed[tIndex] : undefined;
        const row = inTrash ?? removedLists.current.get(note.id);
        const wasListed = qc.getQueryData<TaskList[]>(notesKeys.lists)?.some(l => l.id === note.id) ?? false;
        // Both caches in one step, as the delete did.
        listMutationsInFlight++;
        if (row && !wasListed) qc.setQueryData<TaskList[]>(notesKeys.lists, p => withCreatedList(p, { ...row, trashed_at: null }));
        qc.setQueryData<TaskList[]>(listContentKeys.trash, p => p?.filter(l => l.id !== note.id));
        try {
            // Through the outbox too: the Undo of a delete that is still
            // queued offline replays right behind it, in order.
            const sent = await sendNoteOp(ops.restoreList(note.id, row?.title ?? ''));
            removedLists.current.delete(note.id);
            if (!sent.queued) {
                void qc.invalidateQueries({ queryKey: notesKeys.lists });
                void qc.invalidateQueries({ queryKey: listContentKeys.trash });
                pokeTaskReminders();
            }
            return true;
        } catch (err) {
            if (!explain('restoring failed', err)) pushMessageToast({ title: 'Couldn’t restore the note — check your connection' });
            if (row && !wasListed) qc.setQueryData<TaskList[]>(notesKeys.lists, cur => cur?.filter(l => l.id !== note.id));
            if (inTrash) qc.setQueryData<TaskList[]>(listContentKeys.trash, cur => reinsertList(cur, inTrash, tIndex));
            return false;
        } finally {
            listMutationsInFlight--;
        }
    }, [qc]);

    const savePrefs = useCallback((next: TaskTabPref[], intent: PrefsIntent) => {
        // Never PUT a set built on prefs that were never read: it is a full
        // replace of the row Púca's Tasks tab bar renders from.
        if (!prefsReadyRef.current) {
            pushMessageToast({ title: 'Pins and order couldn’t be loaded — refresh, then try again' });
            return;
        }
        // ...nor one built before the trash was read: its notes' slots would
        // be dropped from the saved order (keepHiddenSlots needs their keys).
        if (!contentRef.current.trashSettled) {
            pushMessageToast({ title: 'Still loading the trash — try again in a moment' });
            return;
        }
        const before = prefsRef.current;
        const seq = ++prefSeq.current;
        qc.setQueryData<TaskTabPref[]>(notesKeys.prefs, next);
        sendNoteOp(ops.prefs(next, intent)).catch(err => {
            console.error('[notes] saving pins/order failed:', err);
            pushMessageToast({ title: 'Couldn’t save the pin or order — check your connection' });
            if (prefSeq.current === seq) qc.setQueryData<TaskTabPref[]>(notesKeys.prefs, before);
        });
    }, [qc]);

    const orderedTabs = useCallback(() => cardsRef.current.map(c => ({ kind: c.ref.kind, id: c.ref.id })), []);

    // Trashed notes keep their slot in the saved order (api/listContent.ts).
    const togglePin = useCallback((note: NoteRef) => {
        const tab = { kind: note.kind, id: note.id };
        savePrefs(
            toggleFavoriteKeepingHidden(orderedTabs(), prefsRef.current, tab, contentRef.current.trashedKeys),
            { type: 'pin', tab, favorite: !isFavoriteTab(prefsRef.current, tab) },
        );
    }, [savePrefs, orderedTabs]);

    const setPinnedMany = useCallback((notes: NoteRef[], pinned: boolean) => {
        const selected = new Set(notes.map(noteKey));
        const { order, overrides } = bulkPinOrder(cardsRef.current.map(c => c.key), selected, pinned);
        const byKey = new Map(cardsRef.current.map(c => [c.key, c]));
        const tabs = order.map(k => byKey.get(k)).filter((c): c is NoteCard => !!c).map(c => ({ kind: c.ref.kind, id: c.ref.id }));
        savePrefs(
            buildPrefsForOrder(keepHiddenSlots(tabs, prefsRef.current, contentRef.current.trashedKeys), prefsRef.current, overrides),
            { type: 'pins', tabs: notes.map(n => ({ kind: n.kind, id: n.id })), favorite: pinned },
        );
    }, [savePrefs]);

    const reorderNotes = useCallback((orderedKeys: string[]) => {
        const byKey = new Map(cardsRef.current.map(c => [c.key, c]));
        const tabs = orderedKeys.map(k => byKey.get(k)).filter((c): c is NoteCard => !!c).map(c => ({ kind: c.ref.kind, id: c.ref.id }));
        savePrefs(buildPrefsForOrder(keepHiddenSlots(tabs, prefsRef.current, contentRef.current.trashedKeys), prefsRef.current), { type: 'order', keys: orderedKeys });
    }, [savePrefs]);

    const setColor = useCallback((note: NoteRef, color: Parameters<typeof setNoteColor>[1]) => setNoteColor(noteKey(note), color), []);
    const setLabels = useCallback((note: NoteRef, labels: string[]) => setNoteLabels(noteKey(note), labels), []);
    const setArchived = useCallback((note: NoteRef, archived: boolean) => setNoteArchived(noteKey(note), archived), []);

    const refreshAll = useCallback(async () => {
        await qc.invalidateQueries({ queryKey: notesKeys.all });
    }, [qc]);
    const refreshNote = useCallback(async (note: NoteRef) => {
        await qc.invalidateQueries({ queryKey: notesKeys.tasks(note) });
    }, [qc]);

    return useMemo(() => ({
        toggleTask, editTask, addTask, deleteTaskFrom, moveTaskIn, reorderTaskIn, setDue, setSchedule, snoozeTask, setAttachments,
        createNote, renameNote, deleteNote, restoreNote, content, togglePin, setPinnedMany, reorderNotes,
        setColor, setLabels, setArchived, refreshAll, refreshNote,
    }), [
        toggleTask, editTask, addTask, deleteTaskFrom, moveTaskIn, reorderTaskIn, setDue, setSchedule, snoozeTask, setAttachments,
        createNote, renameNote, deleteNote, restoreNote, content, togglePin, setPinnedMany, reorderNotes,
        setColor, setLabels, setArchived, refreshAll, refreshNote,
    ]);
}
