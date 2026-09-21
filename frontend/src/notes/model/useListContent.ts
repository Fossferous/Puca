/**
 * Púca Notes — the query/mutation layer for a note's own content (text,
 * photos, drawings) and the trash. notesQueries.ts calls into this from
 * `useNoteCards` / `useNoteActions` with a few one-line insertions; the rest
 * lives here so the shared data layer stays small.
 *
 * TRASH AND DEVICE-LOCAL STATE. A trashed note leaves the default listing,
 * so to everything that reads "the live notes" it looks deleted. Two things
 * must not believe that, or restoring would bring a note back stripped:
 *  - the prune of colour, labels and archive (notesQueries.ts, with
 *    notesPrune.ts), which counts the cached trash as live, waits until the
 *    trash has been read, and asks the trash AFRESH before it forgets a
 *    personal list (a note trashed in Púca or on another device leaves the
 *    listing before this device's cached trash knows it);
 *  - the saved tab order, a full replace on every pin and move, which is why
 *    saves go through `keepHiddenSlots` with the trashed keys, and wait until
 *    the trash has been read (`trashSettled`).
 *
 * Delete, its Undo and the Trash view's Restore are notesQueries.ts's
 * deleteNote/restoreNote, through the offline outbox, so a restore can never
 * overtake a trash still queued. What stays here is what only the Trash view
 * does, as direct calls: `deleteForever` and `emptyTrash` (the view disables
 * them for a note whose move to the trash is still queued).
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
    type NewTaskTiming,
    type Task,
    type TaskAttachmentRef,
    type TaskList,
    createListTask,
    parseTaskAttachments,
    patchTaskTiming,
    updateListTaskAttachments,
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
    listTrashedTaskLists,
    listsDueForClientPurge,
    serverNowFrom,
    setTaskListAttachments,
    setTaskListBody,
} from '../../api/listContent';
import { type DrawingFiles, fileIdsOf, nextDrawingName, resealRefs, uploadNoteMedia } from '../../api/noteMedia';
import { ApiError } from '../../api/client';
import { pushMessageToast } from '../../components/messageToastBus';
import { pokeTaskReminders } from '../../api/taskReminders';
import { type NoteRef, cleanQuickItems } from './notesModel';
import { deriveContentTitle } from './noteContent';
import { type CopyItem, type CopyPlan, flattenCopyItems } from './noteText';

export const listContentKeys = {
    features: ['notes', 'features'] as const,
    trash: ['notes', 'trash'] as const,
};

/** What a composer can hand createNote beyond a title and items. */
export interface NoteExtras {
    body?: string;
    photos?: File[];
    drawing?: DrawingFiles;
    /** Refs that are ALREADY uploaded and sealed, to go straight into the new
     *  note's sidecar — a copy encrypts the source's pictures again itself. */
    refs?: TaskAttachmentRef[];
}

export function hasExtras(extra: NoteExtras | undefined): extra is NoteExtras {
    return !!extra && (!!extra.body?.trim() || (extra.photos?.length ?? 0) > 0 || !!extra.drawing || (extra.refs?.length ?? 0) > 0);
}

export function useListFeatures(): { features: ListFeatures; known: boolean } {
    const q = useQuery({ queryKey: listContentKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
    return { features: q.data ?? NO_LIST_FEATURES, known: q.isSuccess };
}

export function useTrashedLists() {
    const { features, known } = useListFeatures();
    const q = useQuery({ queryKey: listContentKeys.trash, queryFn: listTrashedTaskLists, enabled: known && features.trash });
    const enabled = known && features.trash;
    // Known = a pin, a move or a prune may rely on it: an unread trash looks empty.
    const settled = known && (!enabled || q.isSuccess);
    return { ...q, enabled, settled, features, featuresKnown: known };
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
    /** `timing[i]` is item i's date & repeat (a copy of a note keeps them). */
    createContentNote: (title: string, items: string[], extra: NoteExtras, timing?: (NewTaskTiming | undefined)[]) => Promise<NoteRef | null>;
    /** "Make a copy": the whole note again — text, pictures (re-encrypted
     *  under fresh keys), and every item with its nesting, dates and tick
     *  state. Never queued: its uploads cannot wait for a connection. */
    createNoteFromPlan: (plan: CopyPlan) => Promise<NoteRef | null>;
    setBody: (listId: number, body: string) => Promise<boolean>;
    setNoteAttachments: (listId: number, next: TaskAttachmentRef[], dropped?: TaskAttachmentRef[]) => Promise<boolean>;
    addNoteMedia: (listId: number, photos: File[], drawings: DrawingFiles[], replacing?: TaskAttachmentRef[]) => Promise<boolean>;
    deleteForever: (list: TaskList) => Promise<boolean>;
    /** Every trashed note but `keep` (whose move to the trash is still
     *  queued: deleting it now would run before that move). */
    emptyTrash: (keep?: ReadonlySet<number>) => Promise<void>;
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

    const createContentNote = useCallback(async (title: string, items: string[], extra: NoteExtras, timing?: (NewTaskTiming | undefined)[]): Promise<NoteRef | null> => {
        // Each item's timing rides with it through the blank-dropping clean.
        const entries = items
            .map((raw, i) => ({ text: cleanQuickItems([raw])[0], timing: timing?.[i] }))
            .filter((e): e is { text: string; timing: NewTaskTiming | undefined } => e.text !== undefined);
        const cleanItems = entries.map(e => e.text);
        const body = extra.body?.replace(/\s+$/, '') ?? '';
        let refs: TaskAttachmentRef[] = [];
        try {
            refs = [
                ...await uploadNoteMedia(
                    extra.photos ?? [],
                    extra.drawing ? [{ files: extra.drawing, base: nextDrawingName([]) }] : [],
                    0,
                ),
                // Already uploaded and sealed by the caller: they go into the
                // sidecar as they are, and into the rollback below.
                ...(extra.refs ?? []),
            ];
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
            // Never queued (its uploads could not wait): the composer says
            // so when this resolves null, and keeps the draft.
            explain('create failed', err);
            await deleteFiles(fileIdsOf(refs));   // nothing names them now
            return null;
        }
        const ref: NoteRef = { kind: 'list', id: list.id };
        const created: Task[] = [];
        let timed = false;
        for (const e of entries) {
            try {
                created.push(await createListTask(list.id, e.text, undefined, e.timing));
                if (e.timing) timed = true;
            } catch (err) {
                explain('create item failed', err);
            }
        }
        if (timed) pokeTaskReminders();
        qc.setQueryData<Task[]>(keysRef.current.tasks(ref), created);
        qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => [...(prev ?? []), { ...list, total_tasks: created.length, completed_tasks: 0 }]);
        return ref;
    }, [qc]);

    /**
     * Make the copy. The pictures are re-encrypted FIRST and all-or-nothing:
     * if the list create then fails, every upload made for this copy is
     * deleted again, so a failed copy never bills the owner for orphans.
     * Items are created parents-first so a child lands under the copy's own
     * parent id; a subtree whose parent failed is skipped rather than raised
     * to the top level, and the count is reported.
     */
    const createNoteFromPlan = useCallback(async (plan: CopyPlan): Promise<NoteRef | null> => {
        const uploaded: TaskAttachmentRef[] = [];
        const reseal = async (refs: TaskAttachmentRef[]) => {
            if (refs.length === 0) return [];
            const made = await resealRefs(refs);
            uploaded.push(...made);
            return made;
        };
        const flat = flattenCopyItems(plan.items);
        const itemRefs = new Map<CopyItem, TaskAttachmentRef[]>();
        let noteRefs: TaskAttachmentRef[];
        try {
            noteRefs = await reseal(plan.noteRefs);
            for (const { item } of flat) {
                if (item.attachments.length > 0) itemRefs.set(item, await reseal(item.attachments));
            }
        } catch (err) {
            if (!explain('copying the pictures failed', err)) {
                pushMessageToast({ title: err instanceof Error && err.name === 'TooManyAttachmentsError' ? err.message : 'Couldn’t copy the pictures — check your connection' });
            }
            await deleteFiles(fileIdsOf(uploaded));
            return null;
        }
        let list: TaskList;
        try {
            list = await createTaskListWithContent(plan.title, { body: plan.body || undefined, refs: noteRefs });
        } catch (err) {
            // Never queued (its uploads could not wait), and nothing names
            // what was uploaded for it now.
            explain('copy failed', err);
            await deleteFiles(fileIdsOf(uploaded));
            return null;
        }
        const ref: NoteRef = { kind: 'list', id: list.id };
        const created: Task[] = [];
        const newIdOf = new Map<CopyItem, number>();
        let missing = 0;
        let timed = false;
        for (const { item, parent } of flat) {
            const parentId = parent === null ? undefined : newIdOf.get(parent);
            if (parent !== null && parentId === undefined) { missing++; continue; }
            const timing: NewTaskTiming | undefined = item.schedule
                ? { dueAt: item.dueAt, schedule: item.schedule }
                : item.dueAt ? { dueAt: item.dueAt } : undefined;
            let made: Task;
            try {
                made = await createListTask(list.id, item.text, parentId, timing);
            } catch (err) {
                explain('copying an item failed', err);
                missing++;
                continue;
            }
            newIdOf.set(item, made.id);
            if (timing) timed = true;
            const refs = itemRefs.get(item);
            if (refs) {
                try {
                    await updateListTaskAttachments(made.id, refs);
                    made = { ...made, attachments: JSON.stringify(refs.map(({ href, name }) => ({ href, name }))) };
                } catch (err) {
                    explain('copying an item’s pictures failed', err);
                }
            }
            if (item.completed) {
                // A timing patch, not a plain is_completed: migration 066's
                // guard refuses the latter for a scheduled item, and the
                // ordinary tick would advance a repeating one.
                try {
                    await patchTaskTiming(made, { is_completed: true });
                    made = { ...made, is_completed: true };
                } catch (err) {
                    explain('copying an item’s tick failed', err);
                }
            }
            created.push(made);
        }
        if (timed) pokeTaskReminders();
        qc.setQueryData<Task[]>(keysRef.current.tasks(ref), created);
        qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => [...(prev ?? []), {
            ...list, total_tasks: created.length, completed_tasks: created.filter(t => t.is_completed).length,
        }]);
        if (missing > 0) {
            pushMessageToast({ title: `The copy is missing ${missing} item${missing === 1 ? '' : 's'} — check it against the original` });
        }
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

    const ensureFeatures = useCallback(async (): Promise<ListFeatures | null> => {
        try {
            return await qc.fetchQuery({ queryKey: listContentKeys.features, queryFn: fetchListFeatures, staleTime: 10 * 60_000 });
        } catch {
            return null;
        }
    }, [qc]);

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

    const emptyTrash = useCallback(async (keep?: ReadonlySet<number>) => {
        const all = (qc.getQueryData<TaskList[]>(listContentKeys.trash) ?? []).filter(l => !keep?.has(l.id));
        let first: unknown = null;
        for (const l of all) {
            // One note that cannot go must not keep the rest: try every one,
            // and report once for the lot.
            const err = await deleteOne(l);
            if (err && !first) first = err;
        }
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
        createContentNote, createNoteFromPlan, setBody, setNoteAttachments, addNoteMedia, deleteForever, emptyTrash,
    }), [features, trashEnabled, trashSettled, trashedKeys, isSelfList, ensureFeatures, createContentNote, createNoteFromPlan, setBody, setNoteAttachments, addNoteMedia, deleteForever, emptyTrash]);
}
