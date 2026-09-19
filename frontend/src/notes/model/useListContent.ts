/**
 * Púca Notes — the query/mutation layer for a note's own content (text,
 * photos, drawings) and the trash. notesQueries.ts calls into this from
 * `useNoteCards` / `useNoteActions` with a few one-line insertions; the rest
 * lives here so the shared data layer stays small.
 *
 * TRASH AND DEVICE-LOCAL STATE. A trashed note leaves the default listing,
 * so to everything that reads "the live notes" it looks deleted. Two things
 * must not believe that, or restoring would bring a note back stripped:
 *  - the device-local prune (colour, labels, archive — notesPrefs.ts), which
 *    is why `useTrashAwarePrune` counts the trash as live, and prunes a note
 *    missing from BOTH only against a trash read that started after the
 *    listing it is missing from arrived (a note trashed in Púca or on
 *    another device leaves the listing before this device's cached trash
 *    knows it);
 *  - the saved tab order, a full replace on every pin and move, which is why
 *    saves go through `keepHiddenSlots` with the trashed keys, and wait until
 *    the trash has been read (`trashSettled`).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useIsFetching, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';
import {
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    createListTask,
    parseTaskAttachments,
    isAttachmentsLocked,
} from '../../api/tasks';
import {
    type ListFeatures,
    NO_LIST_FEATURES,
    createTaskListWithContent,
    NoteFilesUnreadableError,
    deleteFiles,
    deleteListForever,
    fetchListFeatures,
    flushBodySave,
    listTrashedTaskLists,
    listsDueForClientPurge,
    restoreTaskList,
    serverNowFrom,
    setTaskListAttachments,
    setTaskListBody,
    trashTaskList,
} from '../../api/listContent';
import { type DrawingFiles, fileIdsOf, nextDrawingName, uploadNoteMedia } from '../../api/noteMedia';
import { ApiError } from '../../api/client';
import { pushMessageToast } from '../../components/messageToastBus';
import { pokeTaskReminders } from '../../api/taskReminders';
import { type NoteRef, cleanQuickItems } from './notesModel';
import { deriveContentTitle } from './noteContent';
import { getNotesPrefs, pruneNotesPrefs } from './notesPrefs';

export const listContentKeys = {
    features: ['notes', 'features'] as const,
    trash: ['notes', 'trash'] as const,
};

/** What a composer can hand createNote beyond a title and items. */
export interface NoteExtras {
    body?: string;
    photos?: File[];
    drawing?: DrawingFiles;
}

export function hasExtras(extra: NoteExtras | undefined): extra is NoteExtras {
    return !!extra && (!!extra.body?.trim() || (extra.photos?.length ?? 0) > 0 || !!extra.drawing);
}

export function useListFeatures(): { features: ListFeatures; known: boolean } {
    const q = useQuery({ queryKey: listContentKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
    return { features: q.data ?? NO_LIST_FEATURES, known: q.isSuccess };
}

/** When the latest trash read that SUCCEEDED was sent (this device's clock,
 *  as react-query's dataUpdatedAt is), per query client. */
const trashReadStartedAt = new WeakMap<QueryClient, number>();

export function useTrashedLists() {
    const qc = useQueryClient();
    const { features, known } = useListFeatures();
    const queryFn = useCallback(async () => {
        const started = Date.now();
        const lists = await listTrashedTaskLists();
        trashReadStartedAt.set(qc, started);
        return lists;
    }, [qc]);
    const q = useQuery({ queryKey: listContentKeys.trash, queryFn, enabled: known && features.trash });
    const enabled = known && features.trash;
    // Known = a pin, a move or a prune may rely on it: an unread trash looks empty.
    const settled = known && (!enabled || q.isSuccess);
    return { ...q, enabled, settled, features, featuresKnown: known };
}

/**
 * Prune device-local state (colour, labels, archive) for notes that are
 * really gone, and never for one that is only in the trash. `liveKeys` is
 * the COMPLETE live set (`ready` false while it is not); `blocked` holds the
 * prune off while a delete's optimistic removal is in flight.
 *
 * A note missing from the listing AND from the cached trash is either
 * deleted or trashed after that trash was read — in Púca's Tasks view or on
 * another device, while this one's trash was still fresh. Only a trash read
 * that started after the listing arrived can tell them apart, so the prune
 * asks for one (once per listing) and waits for it; while either query is
 * fetching nothing is pruned at all.
 */
export function useTrashAwarePrune(listsKey: QueryKey, liveKeys: string[], ready: boolean, blocked: () => boolean): { trashKeys: string[] } {
    const qc = useQueryClient();
    const t = useTrashedLists();
    const data = t.data;
    const trashKeys = useMemo(() => (data ?? []).map(l => `list:${l.id}`), [data]);
    const listsFetching = useIsFetching({ queryKey: listsKey, exact: true }) > 0;
    const asked = useRef(-1);
    const { featuresKnown, enabled, isSuccess, isFetching } = t;
    useEffect(() => {
        if (!ready || !featuresKnown || listsFetching || blocked()) return;
        const live = new Set([...liveKeys, ...trashKeys]);
        if (!enabled) { pruneNotesPrefs(live); return; }
        if (!isSuccess || isFetching) return;
        const p = getNotesPrefs();
        const gone = (o: Record<string, unknown>) => Object.keys(o).some(k => !live.has(k));
        if (!gone(p.colors) && !gone(p.labels) && !gone(p.archived)) return;
        const listsAt = qc.getQueryState(listsKey)?.dataUpdatedAt ?? 0;
        if ((trashReadStartedAt.get(qc) ?? 0) >= listsAt) { pruneNotesPrefs(live); return; }
        if (asked.current === listsAt) return;   // asked once for this listing; a failed read must not loop
        asked.current = listsAt;
        void qc.refetchQueries({ queryKey: listContentKeys.trash, exact: true });
    }, [qc, listsKey, liveKeys, trashKeys, ready, blocked, featuresKnown, enabled, isSuccess, isFetching, listsFetching]);
    return { trashKeys };
}

/** Log a failure, and show the server's own words when it gave a reason
 *  (400: e.g. Notes to self; 409: in the trash, or an envelope downgrade;
 *  413: too large). Returns whether a toast was shown. */
function explain(what: string, err: unknown): boolean {
    console.error(`[notes] ${what}:`, err);
    if (err instanceof ApiError && (err.status === 400 || err.status === 409 || err.status === 413)) {
        pushMessageToast({ title: err.message });
        return true;
    }
    return false;
}

/** One toast for a Delete forever (or an Empty trash) that failed. */
function reportDeleteFailure(err: unknown, many: boolean): void {
    if (err instanceof NoteFilesUnreadableError) pushMessageToast({ title: err.message });
    else if (!explain('delete forever failed', err)) {
        pushMessageToast({ title: many ? 'Some notes couldn’t be deleted — check your connection' : 'Couldn’t delete the note — check your connection' });
    }
}

/** Lists purged this session (a purge must not be retried in a loop). */
const purgedThisSession = new Set<number>();

export interface ListContentActions {
    features: ListFeatures;
    trashEnabled: boolean;
    /** The trash has been read (or there is none): until then the trashed
     *  keys are unknown, and a pin or move would drop their slots. */
    trashSettled: boolean;
    trashedKeys: ReadonlySet<string>;
    /** The "Notes to self" list, which cannot be trashed. */
    isSelfList: (listId: number) => boolean;
    /** What the server supports, asking it now if that is not known yet;
     *  null when it cannot be reached. A delete must never guess. */
    ensureFeatures: () => Promise<ListFeatures | null>;
    createContentNote: (title: string, items: string[], extra: NoteExtras) => Promise<NoteRef | null>;
    setBody: (listId: number, body: string) => Promise<boolean>;
    setNoteAttachments: (listId: number, next: TaskAttachmentRef[], dropped?: TaskAttachmentRef[]) => Promise<boolean>;
    addNoteMedia: (listId: number, photos: File[], drawings: DrawingFiles[], replacing?: TaskAttachmentRef[]) => Promise<boolean>;
    /** Resolves false on failure, having shown exactly ONE toast. */
    trash: (listId: number) => Promise<boolean>;
    restore: (listId: number) => Promise<boolean>;
    deleteForever: (list: TaskList) => Promise<boolean>;
    emptyTrash: () => Promise<void>;
}

export function useListContentActions(keys: { lists: QueryKey; tasks: (ref: NoteRef) => QueryKey }): ListContentActions {
    const qc = useQueryClient();
    const { features, known } = useListFeatures();
    const trashed = useTrashedLists();
    const trashData = trashed.data;
    const trashSettled = trashed.settled;
    const trashedKeys = useMemo(() => new Set((trashData ?? []).map(l => `list:${l.id}`)), [trashData]);
    const keysRef = useRef(keys);
    useEffect(() => { keysRef.current = keys; });

    const lists = useCallback(() => qc.getQueryData<TaskList[]>(keysRef.current.lists), [qc]);
    const isSelfList = useCallback((listId: number) => lists()?.find(l => l.id === listId)?.is_self === true, [lists]);
    const patchList = useCallback((id: number, fn: (l: TaskList) => TaskList) => {
        qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => prev?.map(l => (l.id === id ? fn(l) : l)));
    }, [qc]);

    const createContentNote = useCallback(async (title: string, items: string[], extra: NoteExtras): Promise<NoteRef | null> => {
        const cleanItems = cleanQuickItems(items);
        const body = extra.body?.replace(/\s+$/, '') ?? '';
        let refs: TaskAttachmentRef[] = [];
        try {
            refs = await uploadNoteMedia(
                extra.photos ?? [],
                extra.drawing ? [{ files: extra.drawing, base: nextDrawingName([]) }] : [],
                0,
            );
        } catch (err) {
            explain('upload failed', err);
            pushMessageToast({ title: err instanceof Error && err.name === 'TooManyAttachmentsError' ? err.message : 'Couldn’t upload the picture — check your connection' });
            return null;
        }
        let list: TaskList;
        try {
            list = await createTaskListWithContent(
                deriveContentTitle(title, { body, items: cleanItems, images: extra.photos?.length ?? 0, drawing: !!extra.drawing }),
                { body: body || undefined, refs },
            );
        } catch (err) {
            explain('create failed', err);
            await deleteFiles(fileIdsOf(refs));   // nothing names them now
            return null;
        }
        const ref: NoteRef = { kind: 'list', id: list.id };
        const created: Task[] = [];
        for (const text of cleanItems) {
            try {
                created.push(await createListTask(list.id, text));
            } catch (err) {
                explain('create item failed', err);
            }
        }
        qc.setQueryData<Task[]>(keysRef.current.tasks(ref), created);
        qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => [...(prev ?? []), { ...list, total_tasks: created.length, completed_tasks: 0 }]);
        return ref;
    }, [qc]);

    const setBody = useCallback(async (listId: number, body: string): Promise<boolean> => {
        const before = lists();
        patchList(listId, l => ({ ...l, body: body === '' ? null : body }));
        try {
            await setTaskListBody(listId, body);
            return true;
        } catch (err) {
            explain('saving the text failed', err);
            qc.setQueryData(keysRef.current.lists, before);
            return false;
        }
    }, [qc, lists, patchList]);

    /** Replace the sidecar; `dropped` refs are no longer named anywhere and
     *  their uploads are deleted once the new sidecar is saved. */
    const setNoteAttachments = useCallback(async (listId: number, next: TaskAttachmentRef[], dropped: TaskAttachmentRef[] = []): Promise<boolean> => {
        const current = lists()?.find(l => l.id === listId);
        if (current && isAttachmentsLocked(current.attachments ?? null)) {
            pushMessageToast({ title: 'This note’s pictures can’t be read on this device yet, so they can’t be changed here' });
            return false;
        }
        const before = lists();
        patchList(listId, l => ({ ...l, attachments: next.length === 0 ? null : JSON.stringify(next.map(({ href, name }) => ({ href, name }))) }));
        try {
            await setTaskListAttachments(listId, next);
        } catch (err) {
            explain('saving the pictures failed', err);
            qc.setQueryData(keysRef.current.lists, before);
            return false;
        }
        if (dropped.length > 0) void deleteFiles(fileIdsOf(dropped));
        return true;
    }, [qc, lists, patchList]);

    const addNoteMedia = useCallback(async (listId: number, photos: File[], drawings: DrawingFiles[], replacing: TaskAttachmentRef[] = []): Promise<boolean> => {
        const current = lists()?.find(l => l.id === listId);
        const opened = current?.attachments ?? null;
        if (isAttachmentsLocked(opened)) {
            pushMessageToast({ title: 'This note’s pictures can’t be read on this device yet, so nothing can be added here' });
            return false;
        }
        const replaceSet = new Set(replacing.map(r => r.href));
        const kept = parseTaskAttachments(opened).filter(r => !replaceSet.has(r.href));
        let added: TaskAttachmentRef[];
        try {
            const bases: string[] = [];
            let names = kept;
            for (let i = 0; i < drawings.length; i++) {
                const base = nextDrawingName(names);
                bases.push(base);
                names = [...names, { href: `pending:${base}`, name: `${base}.png` }];
            }
            added = await uploadNoteMedia(photos, drawings.map((files, i) => ({ files, base: bases[i] })), kept.length);
        } catch (err) {
            explain('upload failed', err);
            pushMessageToast({ title: err instanceof Error && err.name === 'TooManyAttachmentsError' ? err.message : 'Couldn’t upload the picture — check your connection' });
            return false;
        }
        const ok = await setNoteAttachments(listId, [...kept, ...added], replacing);
        if (!ok) await deleteFiles(fileIdsOf(added));
        return ok;
    }, [lists, setNoteAttachments]);

    // Trash and restore move the note between the two caches in ONE step, both
    // before the request: a moment where it is in neither is a moment the
    // device-local prune reads as "deleted" (see the header).
    const ensureFeatures = useCallback(async (): Promise<ListFeatures | null> => {
        try {
            return await qc.fetchQuery({ queryKey: listContentKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
        } catch {
            return null;
        }
    }, [qc]);

    const trash = useCallback(async (listId: number): Promise<boolean> => {
        if (isSelfList(listId)) {
            pushMessageToast({ title: 'Notes to self can’t be moved to the trash' });
            return false;
        }
        // Text typed just before this is still on its way (NoteBodyField
        // saves after a pause): let it land first, or the trash's 409 eats it.
        await flushBodySave(listId);
        // An in-flight refetch of either cache would land after this and put
        // the note back where it was.
        await qc.cancelQueries({ queryKey: keysRef.current.lists });
        await qc.cancelQueries({ queryKey: listContentKeys.trash });
        const listsBefore = lists();
        const trashBefore = qc.getQueryData<TaskList[]>(listContentKeys.trash);
        const list = listsBefore?.find(l => l.id === listId);
        qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => prev?.filter(l => l.id !== listId));
        if (list) qc.setQueryData<TaskList[]>(listContentKeys.trash, prev => [{ ...list, trashed_at: new Date().toISOString() }, ...(prev ?? []).filter(l => l.id !== listId)]);
        try {
            await trashTaskList(listId);
            void qc.invalidateQueries({ queryKey: listContentKeys.trash });
            pokeTaskReminders();
            return true;
        } catch (err) {
            if (!explain('moving to the trash failed', err)) pushMessageToast({ title: 'Couldn’t move the note to the trash — check your connection' });
            qc.setQueryData(keysRef.current.lists, listsBefore);
            qc.setQueryData(listContentKeys.trash, trashBefore);
            return false;
        }
    }, [qc, lists, isSelfList]);

    const restore = useCallback(async (listId: number): Promise<boolean> => {
        await qc.cancelQueries({ queryKey: keysRef.current.lists });
        await qc.cancelQueries({ queryKey: listContentKeys.trash });
        const trashBefore = qc.getQueryData<TaskList[]>(listContentKeys.trash);
        const listsBefore = lists();
        const list = trashBefore?.find(l => l.id === listId);
        if (list) qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => (prev?.some(l => l.id === listId) ? prev : [...(prev ?? []), { ...list, trashed_at: null }]));
        qc.setQueryData<TaskList[]>(listContentKeys.trash, prev => prev?.filter(l => l.id !== listId));
        try {
            await restoreTaskList(listId);
            void qc.invalidateQueries({ queryKey: keysRef.current.lists });
            void qc.invalidateQueries({ queryKey: listContentKeys.trash });
            pokeTaskReminders();
            return true;
        } catch (err) {
            explain('restoring failed', err);
            qc.setQueryData(listContentKeys.trash, trashBefore);
            qc.setQueryData(keysRef.current.lists, listsBefore);
            return false;
        }
    }, [qc, lists]);

    /** Delete one trashed list for good; the error, when there is one, is
     *  the caller's to report. */
    const deleteOne = useCallback(async (list: TaskList): Promise<unknown> => {
        const trashBefore = qc.getQueryData<TaskList[]>(listContentKeys.trash);
        qc.setQueryData<TaskList[]>(listContentKeys.trash, prev => prev?.filter(l => l.id !== list.id));
        try {
            await deleteListForever(list);
            qc.removeQueries({ queryKey: keysRef.current.tasks({ kind: 'list', id: list.id }) });
            return null;
        } catch (err) {
            console.error('[notes] delete forever failed:', err);
            qc.setQueryData(listContentKeys.trash, trashBefore);
            return err;
        }
    }, [qc]);

    const deleteForever = useCallback(async (list: TaskList): Promise<boolean> => {
        const err = await deleteOne(list);
        if (err) reportDeleteFailure(err, false);
        return !err;
    }, [deleteOne]);

    const emptyTrash = useCallback(async () => {
        const all = qc.getQueryData<TaskList[]>(listContentKeys.trash) ?? [];
        let first: unknown = null;
        for (const l of all) first = first ?? await deleteOne(l);   // one toast for the lot
        if (first) reportDeleteFailure(first, all.length > 1);
    }, [qc, deleteOne]);

    // Purge our own expired trash, files first, before the server's sweep
    // deletes the rows and strands the files (src/list_content.rs).
    // "Expired" is measured on the SERVER's clock: this device's may be days
    // off, and a purge cannot be undone. No server clock, no purge.
    const retention = features.trashRetentionDays;
    const clockOffset = features.serverClockOffsetMs;
    useEffect(() => {
        if (!trashData || retention <= 0) return;
        const now = serverNowFrom({ serverClockOffsetMs: clockOffset });
        if (now === null) return;
        const due = listsDueForClientPurge(trashData, retention, now).filter(l => !purgedThisSession.has(l.id));
        if (due.length === 0) return;
        for (const l of due) purgedThisSession.add(l.id);
        void (async () => {
            for (const l of due) {
                try {
                    await deleteListForever(l);
                } catch (err) {
                    // Files it cannot name (locked, offline) are skipped, not
                    // orphaned: the list stays and a later session retries.
                    console.error('[notes] purging expired trash skipped a note:', err);
                }
            }
            void qc.invalidateQueries({ queryKey: listContentKeys.trash });
        })();
    }, [trashData, retention, clockOffset, qc]);

    const trashEnabled = known && features.trash;
    return useMemo(() => ({
        features, trashEnabled, trashSettled, trashedKeys, isSelfList, ensureFeatures,
        createContentNote, setBody, setNoteAttachments, addNoteMedia, trash, restore, deleteForever, emptyTrash,
    }), [features, trashEnabled, trashSettled, trashedKeys, isSelfList, ensureFeatures, createContentNote, setBody, setNoteAttachments, addNoteMedia, trash, restore, deleteForever, emptyTrash]);
}
