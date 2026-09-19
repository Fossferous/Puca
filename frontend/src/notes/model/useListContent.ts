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
 *    is why `useTrashedKeys` reports the trash as live keys and as `settled`
 *    only once it has actually been read;
 *  - the saved tab order, a full replace on every pin and move, which is why
 *    saves go through `keepHiddenSlots` with the trashed keys.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
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
    deleteFiles,
    deleteListForever,
    fetchListFeatures,
    listTrashedTaskLists,
    listsDueForClientPurge,
    restoreTaskList,
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

export function useTrashedLists() {
    const { features, known } = useListFeatures();
    const q = useQuery({ queryKey: listContentKeys.trash, queryFn: listTrashedTaskLists, enabled: known && features.trash });
    return { ...q, enabled: known && features.trash, features, featuresKnown: known };
}

/** The trashed notes' keys, and whether they are KNOWN (a prune or an order
 *  save must wait for that — an unread trash looks empty). */
export function useTrashedKeys(): { keys: string[]; settled: boolean } {
    const t = useTrashedLists();
    const data = t.data;
    const keys = useMemo(() => (data ?? []).map(l => `list:${l.id}`), [data]);
    const settled = t.featuresKnown && (!t.enabled || t.isSuccess);
    return { keys, settled };
}

function explain(what: string, err: unknown): void {
    console.error(`[notes] ${what}:`, err);
    if (err instanceof ApiError && (err.status === 409 || err.status === 413)) pushMessageToast({ title: err.message });
}

/** Lists purged this session (a purge must not be retried in a loop). */
const purgedThisSession = new Set<number>();

export interface ListContentActions {
    features: ListFeatures;
    trashEnabled: boolean;
    trashedKeys: ReadonlySet<string>;
    /** What the server supports, asking it now if that is not known yet;
     *  null when it cannot be reached. A delete must never guess. */
    ensureFeatures: () => Promise<ListFeatures | null>;
    createContentNote: (title: string, items: string[], extra: NoteExtras) => Promise<NoteRef | null>;
    setBody: (listId: number, body: string) => Promise<boolean>;
    setNoteAttachments: (listId: number, next: TaskAttachmentRef[], dropped?: TaskAttachmentRef[]) => Promise<boolean>;
    addNoteMedia: (listId: number, photos: File[], drawings: DrawingFiles[], replacing?: TaskAttachmentRef[]) => Promise<boolean>;
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
    const trashedKeys = useMemo(() => new Set((trashData ?? []).map(l => `list:${l.id}`)), [trashData]);
    const keysRef = useRef(keys);
    useEffect(() => { keysRef.current = keys; });

    const lists = useCallback(() => qc.getQueryData<TaskList[]>(keysRef.current.lists), [qc]);
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
            explain('moving to the trash failed', err);
            qc.setQueryData(keysRef.current.lists, listsBefore);
            qc.setQueryData(listContentKeys.trash, trashBefore);
            return false;
        }
    }, [qc, lists]);

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

    const deleteForever = useCallback(async (list: TaskList): Promise<boolean> => {
        const trashBefore = qc.getQueryData<TaskList[]>(listContentKeys.trash);
        qc.setQueryData<TaskList[]>(listContentKeys.trash, prev => prev?.filter(l => l.id !== list.id));
        try {
            await deleteListForever(list);
            qc.removeQueries({ queryKey: keysRef.current.tasks({ kind: 'list', id: list.id }) });
            return true;
        } catch (err) {
            explain('delete forever failed', err);
            qc.setQueryData(listContentKeys.trash, trashBefore);
            return false;
        }
    }, [qc]);

    const emptyTrash = useCallback(async () => {
        const all = qc.getQueryData<TaskList[]>(listContentKeys.trash) ?? [];
        for (const l of all) await deleteForever(l);
    }, [qc, deleteForever]);

    // Purge our own expired trash, files first, before the server's sweep
    // deletes the rows and strands the files (src/list_content.rs).
    const retention = features.trashRetentionDays;
    useEffect(() => {
        if (!trashData || retention <= 0) return;
        const due = listsDueForClientPurge(trashData, retention, Date.now()).filter(l => !purgedThisSession.has(l.id));
        if (due.length === 0) return;
        for (const l of due) purgedThisSession.add(l.id);
        void (async () => {
            for (const l of due) {
                try {
                    await deleteListForever(l);
                } catch (err) {
                    console.error('[notes] purging expired trash failed:', err);
                }
            }
            void qc.invalidateQueries({ queryKey: listContentKeys.trash });
        })();
    }, [trashData, retention, qc]);

    const trashEnabled = known && features.trash;
    return useMemo(() => ({
        features, trashEnabled, trashedKeys, ensureFeatures,
        createContentNote, setBody, setNoteAttachments, addNoteMedia, trash, restore, deleteForever, emptyTrash,
    }), [features, trashEnabled, trashedKeys, ensureFeatures, createContentNote, setBody, setNoteAttachments, addNoteMedia, trash, restore, deleteForever, emptyTrash]);
}
