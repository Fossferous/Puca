/**
 * Púca Notes — the data layer.
 *
 * Everything Notes shows comes from Púca's task API (api/tasks.ts) through
 * @tanstack/react-query, and every edit goes back through the same functions
 * the Tasks view calls. Optimistic updates use the SAME pure helpers Púca's
 * TasksView and ChecklistBody use (applyToggle, applyReorder, applyMove,
 * collectSubtreeIds, buildPrefsForOrder, toggleFavoritePrefs), so an edit made
 * in Notes lands in exactly the state Púca would have produced — and rolls back
 * to the previous snapshot on failure, as they do.
 *
 * NO WEBSOCKET, deliberately. Púca's main.tsx wires the P2P file-transfer
 * handlers synchronously at boot because the server sweeps PARKED file offers
 * to whichever connection registers next, and an unwired handler map consumes
 * a delivered-once offer into nothing. Notes never opens the socket, so it can
 * never eat an offer meant for the chat app — and it never creates a presence
 * session or an unattested device connection either. Freshness comes from
 * refetch-on-focus, a slow interval while a SHARED note is open (other
 * members edit those), and the explicit refresh button.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { QueryClient, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    type TaskTabPref,
    listTaskLists, createTaskList, renameTaskList, deleteTaskList,
    listListTasks, createListTask, updateListTask, updateListTaskAttachments,
    listTasks, createTask, updateChannelTask, updateChannelTaskAttachments,
    updateTask, deleteTask, moveTask, reorderTask,
    getTaskTabPrefs, putTaskTabPrefs,
    applyMove, applyReorder, collectSubtreeIds, serializeTaskAttachments,
    buildPrefsForOrder, toggleFavoritePrefs,
} from '../../api/tasks';
import { listServers, listChannels, listMembersWithRoles, type Channel, type MemberWithRoles, type Server } from '../../api/servers';
import { ApiError } from '../../api/client';
import { pokeTaskReminders } from '../../api/taskReminders';
import { planToggle } from '../../api/taskCompletion';
import { patchTaskTiming } from '../../api/tasks';
import { serializeSnooze } from '../../api/taskSchedule';
import { type NewTaskTiming } from '../../api/tasks';
import { canEditTask } from '../../api/tasks';
import { currentUserIdFromToken } from '../../api/auth';
import { pushMessageToast } from '../../components/messageToastBus';
import {
    type NoteCard, type NoteRef, type NoteSource,
    buildNoteCards, noteKey, cleanQuickItems, deriveQuickTitle,
} from './notesModel';
import { getNotesPrefs, subscribeNotesPrefs, pruneNotesPrefs, setNoteArchived, setNoteColor, setNoteLabels } from './notesPrefs';

/** Notes' own client: it WANTS refetch-on-focus (that is its live sync),
 *  unlike Púca's shared client which has a socket for that. */
export function makeNotesQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 30_000,
                gcTime: 30 * 60_000,
                retry: 1,
                refetchOnWindowFocus: true,
                refetchOnReconnect: true,
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
 * List-level mutations in flight (a delete's optimistic removal). The
 * device-local prune must not run while one is: the note is gone from the
 * cache but may come back on rollback, and a pruned label cannot.
 */
let listMutationsInFlight = 0;

export function useServersQuery() {
    return useQuery({ queryKey: notesKeys.servers, queryFn: listServers });
}

/** One NoteSource per checklist channel across every joined server, plus
 *  whether any server's channel query is still pending or failed (a caller
 *  must not prune prefs against an INCOMPLETE set). */
export function useChannelSources(): { sources: NoteSource[]; complete: boolean } {
    const { data: servers = [], isSuccess: serversDone } = useServersQuery();
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
    return useMemo(() => {
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
}

function listSource(l: TaskList): NoteSource {
    return {
        ref: { kind: 'list', id: l.id },
        title: l.title,
        titleEncState: l.titleEncState,
        totalTasks: l.total_tasks,
        completedTasks: l.completed_tasks,
        createdAt: l.created_at,
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
    };
}

function fetchTasksFor(ref: NoteRef): Promise<Task[]> {
    return ref.kind === 'list' ? listListTasks(ref.id) : listTasks(ref.id);
}

/** The tasks of one note. `live` polls shared notes while the editor is open. */
export function useNoteTasks(ref: NoteRef | null, opts: { live?: boolean } = {}) {
    return useQuery({
        queryKey: ref ? notesKeys.tasks(ref) : ['notes', 'tasks', 'none'],
        queryFn: () => fetchTasksFor(ref!),
        enabled: ref !== null,
        refetchInterval: opts.live && ref?.kind === 'channel' ? SHARED_NOTE_POLL_MS : false,
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
    const { sources, loading, error, complete } = useNoteSources();
    const prefsQuery = useTabPrefsQuery();
    const prefsData = prefsQuery.data;
    const prefs = useMemo(() => prefsData ?? [], [prefsData]);
    const local = useNotesPrefs();
    const tasks = useAllNoteTasks(sources);
    const cards = useMemo(
        () => buildNoteCards(sources, tasks.byKey, prefs, local),
        [sources, tasks.byKey, prefs, local],
    );
    useEffect(() => {
        // Only against a COMPLETE, SETTLED set: a failed server query must not
        // look like a deleted note, and neither must a delete whose request
        // is still in flight (it comes back on rollback; a pruned label does
        // not). The rollback changes `sources`, so this re-runs then.
        if (!complete || listMutationsInFlight > 0) return;
        pruneNotesPrefs(new Set(sources.map(s => noteKey(s.ref))));
    }, [complete, sources]);
    return { cards, sources, prefs, prefsReady: prefsData !== undefined, loading, error, tasksPending: tasks.anyPending };
}

// --- Mutations -------------------------------------------------------------------

/** Púca's own rule: a 409 is the server explaining an envelope-version
 *  refusal in its own words, so it is shown; everything else is logged. */
function explain(what: string, err: unknown): void {
    console.error(`[notes] ${what}:`, err);
    if (err instanceof ApiError && err.status === 409) pushMessageToast({ title: err.message });
}

export interface NoteActions {
    /** Task-level edits on one note. */
    toggleTask: (note: NoteRef, task: Task, completed: boolean) => Promise<void>;
    editTask: (note: NoteRef, task: Task, description: string) => Promise<void>;
    addTask: (note: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming) => Promise<Task | null>;
    deleteTaskFrom: (note: NoteRef, taskId: number) => Promise<void>;
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
    createNote: (title: string, items: string[], timing?: (NewTaskTiming | undefined)[]) => Promise<NoteRef | null>;
    renameNote: (note: NoteRef, title: string) => Promise<boolean>;
    deleteNote: (note: NoteRef) => Promise<boolean>;
    togglePin: (note: NoteRef) => void;
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

    const toggleTask = useCallback(async (note: NoteRef, task: Task, completed: boolean) => {
        const original = await snapshot(note);
        // One completion path (taskCompletion.ts): a repeating task advances.
        const card = cardsRef.current.find(c => c.ref.kind === note.kind && c.ref.id === note.id);
        const canEdit = note.kind === 'list' || canEditTask(task, currentUserIdFromToken() ?? undefined, card?.myPerms);
        const plan = planToggle(original, task, completed, { canEdit });
        const next = plan.next;
        restore(note, next);
        syncListCounts(note, next);
        try {
            await plan.send();
        } catch (err) {
            explain('toggle failed', err);
            restore(note, original);
            syncListCounts(note, original);
            // A lost race with another device's advance: show the truth.
            if (err instanceof ApiError && err.status === 409) restore(note, await fetchTasksFor(note).catch(() => original));
        }
    }, [snapshot, restore, syncListCounts]);

    const editTask = useCallback(async (note: NoteRef, task: Task, description: string) => {
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, description } : t)));
        try {
            if (note.kind === 'channel') await updateChannelTask(note.id, task.id, { description }, task.created_by);
            else await updateListTask(task.id, { description });
        } catch (err) {
            explain('edit failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

    const addTask = useCallback(async (note: NoteRef, description: string, parentId?: number, timing?: NewTaskTiming): Promise<Task | null> => {
        try {
            // `timing` (a calendar tap-to-add) rides the same one POST.
            const created = note.kind === 'channel'
                ? await createTask(note.id, description, parentId, timing)
                : await createListTask(note.id, description, parentId, timing);
            if (timing) pokeTaskReminders();
            const next = [...await snapshot(note), created];
            restore(note, next);
            syncListCounts(note, next);
            return created;
        } catch (err) {
            explain('add failed', err);
            return null;
        }
    }, [snapshot, restore, syncListCounts]);

    const deleteTaskFrom = useCallback(async (note: NoteRef, taskId: number) => {
        const original = await snapshot(note);
        const doomed = collectSubtreeIds(original, taskId);
        const next = original.filter(t => !doomed.has(t.id));
        restore(note, next);
        syncListCounts(note, next);
        try {
            await deleteTask(taskId);
        } catch (err) {
            explain('delete failed', err);
            restore(note, original);
            syncListCounts(note, original);
        }
    }, [snapshot, restore, syncListCounts]);

    const moveTaskIn = useCallback(async (note: NoteRef, task: Task, direction: 'up' | 'down') => {
        const original = await snapshot(note);
        const next = applyMove(original, task, direction);
        if (next === original) return;
        restore(note, next);
        try {
            await moveTask(task.id, direction);
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
            await reorderTask(task.id, afterId, reparent);
            // A reparent re-reads from truth on success (ChecklistBody's rule:
            // the one old-server frame that 200s is healed by this read).
            if (reparent) restore(note, await fetchTasksFor(note));
        } catch (err) {
            explain('reorder failed', err);
            restore(note, original);
        }
    }, [snapshot, restore]);

    const setDue = useCallback(async (note: NoteRef, task: Task, dueAt: string | null) => {
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, due_at: dueAt } : t)));
        try {
            await updateTask(task.id, { due_at: dueAt ?? '' });   // '' clears server-side
            pokeTaskReminders();
        } catch (err) {
            explain('due time failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

    const setSchedule = useCallback(async (note: NoteRef, task: Task, schedule: string | null, dueAt: string | null) => {
        const original = await snapshot(note);
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, schedule, due_at: dueAt } : t)));
        try {
            await patchTaskTiming(task, { schedule, due_at: dueAt });
            pokeTaskReminders();
        } catch (err) {
            explain('schedule failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

    const snoozeTask = useCallback(async (note: NoteRef, task: Task, until: number | null) => {
        if (!task.due_at) return;   // nothing to snooze: the reminder has no time on the server
        const original = await snapshot(note);
        const snooze = until === null ? null : serializeSnooze({ forDue: task.due_at, until: new Date(until).toISOString() });
        setTasks(note, prev => prev.map(t => (t.id === task.id ? { ...t, snooze } : t)));
        try {
            await patchTaskTiming(task, { snooze });
            pokeTaskReminders();
        } catch (err) {
            explain('snooze failed', err);
            restore(note, original);
        }
    }, [snapshot, setTasks, restore]);

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

    const createNote = useCallback(async (title: string, items: string[], timing?: (NewTaskTiming | undefined)[]): Promise<NoteRef | null> => {
        // Timing rides with its item through the blank-dropping clean.
        const timingOf = new Map<number, NewTaskTiming | undefined>();
        const cleanItems = cleanQuickItems(items.filter((raw, i) => {
            const keep = cleanQuickItems([raw]).length > 0;
            if (keep) timingOf.set(timingOf.size, timing?.[i]);
            return keep;
        }));
        let list: TaskList;
        try {
            list = await createTaskList(deriveQuickTitle(title, cleanItems));
        } catch (err) {
            explain('create failed', err);
            return null;   // nothing landed: the caller keeps the draft
        }
        const ref: NoteRef = { kind: 'list', id: list.id };
        const created: Task[] = [];
        const missing: string[] = [];
        // Sequential so positions follow the typed order. An item that fails
        // does not lose the note: the list exists, the rest is reported.
        for (const [i, text] of cleanItems.entries()) {
            try {
                created.push(await createListTask(list.id, text, undefined, timingOf.get(i)));
            } catch (err) {
                explain('create item failed', err);
                missing.push(text);
            }
        }
        qc.setQueryData<Task[]>(notesKeys.tasks(ref), created);
        qc.setQueryData<TaskList[]>(notesKeys.lists, prev => [
            ...(prev ?? []),
            { ...list, total_tasks: created.length, completed_tasks: 0 },
        ]);
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
            await renameTaskList(note.id, title);
            return true;
        } catch (err) {
            explain('rename failed', err);
            qc.setQueryData(notesKeys.lists, prev);
            return false;
        }
    }, [qc]);

    const deleteNote = useCallback(async (note: NoteRef): Promise<boolean> => {
        if (note.kind !== 'list') return false;
        const prev = qc.getQueryData<TaskList[]>(notesKeys.lists);
        listMutationsInFlight++;   // holds the device-local prune off until this settles
        qc.setQueryData<TaskList[]>(notesKeys.lists, p => p?.filter(l => l.id !== note.id));
        try {
            await deleteTaskList(note.id);
            qc.removeQueries({ queryKey: notesKeys.tasks(note) });
            return true;
        } catch (err) {
            explain('delete list failed', err);
            qc.setQueryData(notesKeys.lists, prev);
            return false;
        } finally {
            listMutationsInFlight--;
        }
    }, [qc]);

    const savePrefs = useCallback((next: TaskTabPref[]) => {
        // Never PUT a set built on prefs that were never read: it is a full
        // replace of the row Púca's Tasks tab bar renders from.
        if (!prefsReadyRef.current) {
            pushMessageToast({ title: 'Pins and order couldn’t be loaded — refresh, then try again' });
            return;
        }
        const before = prefsRef.current;
        const seq = ++prefSeq.current;
        qc.setQueryData<TaskTabPref[]>(notesKeys.prefs, next);
        putTaskTabPrefs(next).catch(err => {
            console.error('[notes] saving pins/order failed:', err);
            pushMessageToast({ title: 'Couldn’t save the pin or order — check your connection' });
            if (prefSeq.current === seq) qc.setQueryData<TaskTabPref[]>(notesKeys.prefs, before);
        });
    }, [qc]);

    const orderedTabs = useCallback(() => cardsRef.current.map(c => ({ kind: c.ref.kind, id: c.ref.id })), []);

    const togglePin = useCallback((note: NoteRef) => {
        savePrefs(toggleFavoritePrefs(orderedTabs(), prefsRef.current, { kind: note.kind, id: note.id }));
    }, [savePrefs, orderedTabs]);

    const reorderNotes = useCallback((orderedKeys: string[]) => {
        const byKey = new Map(cardsRef.current.map(c => [c.key, c]));
        const tabs = orderedKeys.map(k => byKey.get(k)).filter((c): c is NoteCard => !!c).map(c => ({ kind: c.ref.kind, id: c.ref.id }));
        savePrefs(buildPrefsForOrder(tabs, prefsRef.current));
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
        createNote, renameNote, deleteNote, togglePin, reorderNotes,
        setColor, setLabels, setArchived, refreshAll, refreshNote,
    }), [
        toggleTask, editTask, addTask, deleteTaskFrom, moveTaskIn, reorderTaskIn, setDue, setSchedule, snoozeTask, setAttachments,
        createNote, renameNote, deleteNote, togglePin, reorderNotes,
        setColor, setLabels, setArchived, refreshAll, refreshNote,
    ]);
}
