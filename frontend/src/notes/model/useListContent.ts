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
    isAttachmentsLocked,
} from '../../api/tasks';
import {
    type ListFeatures,
    NO_LIST_FEATURES,
    createTaskListWithContent,
    NoteConflictError,
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
import { type DrawingFiles, fileIdsOf, nextDrawingName, uploadNoteMedia } from '../../api/noteMedia';
import { newOpKey } from '../../api/opKey';
import { LISTS_KEY, beginNoteWrite } from './noteBusy';
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

/** What a save of a note's text answers with: `{ rev }` saved (naming the
 *  note's new revision, or null from a server that has none), `false` did
 *  not, and a `conflict` means the text was changed somewhere else first and
 *  nothing was written — `theirs` is that copy, opened (null = the other
 *  device cleared the text). Use `noteSaved` rather than truthiness: a
 *  conflict is an object too, and reading it as success is how a caller ends
 *  up acting as though its text had landed. */
export type SaveOutcome = boolean | { rev: number | null } | { conflict: { theirs: string | null; rev: number } };

export function noteSaved(outcome: SaveOutcome): boolean {
    return outcome === true || (typeof outcome === 'object' && outcome !== null && 'rev' in outcome);
}

/** The revision a save should name, or undefined when there is nothing to
 *  name it against — an older server, or a note this cache has not seen.
 *  Undefined means "no check", which is what every client did before
 *  migration 069. */
function revOf(all: TaskList[] | undefined, listId: number, features: ListFeatures): number | undefined {
    if (!features.contentRev) return undefined;
    const rev = all?.find(l => l.id === listId)?.content_rev;
    return typeof rev === 'number' ? rev : undefined;
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
    /** Save a note's text. `true` = saved, `false` = it did not save (the
     *  cache is rolled back and the caller has been told), and a
     *  `{ conflict }` means the text was changed somewhere else first: the
     *  server's copy is in `conflict.theirs` (null = they cleared it), the
     *  cache now holds it, and NOTHING was written. */
    setBody: (listId: number, body: string, baseRev?: number) => Promise<SaveOutcome>;
    /** Replace a note's sidecar. `baseRev` is the revision `next` was built
     *  from — pass it whenever that was read before an await, or the check
     *  is judged against a revision the payload never saw. */
    setNoteAttachments: (listId: number, next: TaskAttachmentRef[], dropped?: TaskAttachmentRef[], baseRev?: number) => Promise<boolean>;
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
        // One key for this one note, minted here so it is the SAME on every
        // attempt of this create and different for every other (api/opKey.ts).
        const noteKey = newOpKey();
        try {
            list = await createTaskListWithContent(
                deriveContentTitle(title, { body, items: cleanItems, images: extra.photos?.length ?? 0, drawing: !!extra.drawing }),
                { body: body || undefined, refs },
                noteKey,
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
                created.push(await createListTask(list.id, e.text, undefined, e.timing, newOpKey()));
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

    const setBody = useCallback(async (listId: number, body: string, baseRev?: number): Promise<SaveOutcome> => {
        const before = lists();
        // The caller's base wins when it has one: the field took it when the
        // user started typing, and the cached revision may have moved to
        // another device's since (see components/NoteBodyField.tsx).
        const base = features.contentRev && baseRev !== undefined ? baseRev : revOf(lists(), listId, features);
        patchList(listId, l => ({ ...l, body: body === '' ? null : body }));
        // Busy under LISTS_KEY, not `list:<id>`. A note's text, title and
        // pictures live in the LISTING query (['notes','lists']), and a
        // task_lists UPDATE raises the 'lists' event (migration 067), whose
        // refetch taskEvents.ts defers under LISTS_KEY. `list:<id>` gates
        // only that note's ITEMS — which this write does not touch — so
        // marking it left the refetch that lands the OLD text, and the OLD
        // revision, entirely undeferred.
        const done = beginNoteWrite(LISTS_KEY);
        try {
            const rev = await setTaskListBody(listId, body, base);
            patchList(listId, l => ({ ...l, ...(rev === null ? {} : { content_rev: rev }) }));
            return { rev };
        } catch (err) {
            if (err instanceof NoteConflictError) {
                // Nothing was written. Put the server's copy in the cache
                // (with its revision, so the next save is judged against the
                // right base) and hand the text back to the caller, whose
                // field still holds what the user typed.
                qc.setQueryData(keysRef.current.lists, before);
                patchList(listId, l => ({ ...l, body: err.body, content_rev: err.contentRev }));
                return { conflict: { theirs: err.body, rev: err.contentRev } };
            }
            explain('saving the text failed', err);
            qc.setQueryData(keysRef.current.lists, before);
            return false;
        } finally {
            done();
        }
    }, [qc, lists, patchList, features]);

    /** Replace the sidecar; `dropped` refs are no longer named anywhere and
     *  their uploads are deleted once the new sidecar is saved. */
    const setNoteAttachments = useCallback(async (listId: number, next: TaskAttachmentRef[], dropped: TaskAttachmentRef[] = [], baseRev?: number): Promise<boolean> => {
        const current = lists()?.find(l => l.id === listId);
        if (current && isAttachmentsLocked(current.attachments ?? null)) {
            pushMessageToast({ title: 'This note’s pictures can’t be read on this device yet, so they can’t be changed here' });
            return false;
        }
        const before = lists();
        // As for the text: the caller's base wins, because `next` was built
        // from the sidecar as it stood THEN (addNoteMedia reads it before an
        // upload that can take seconds). A base read here would be the
        // revision after that window, and the check could not refuse the very
        // race it exists for.
        const base = features.contentRev && baseRev !== undefined ? baseRev : revOf(lists(), listId, features);
        patchList(listId, l => ({ ...l, attachments: next.length === 0 ? null : JSON.stringify(next.map(({ href, name }) => ({ href, name }))) }));
        const done = beginNoteWrite(LISTS_KEY);
        try {
            const rev = await setTaskListAttachments(listId, next, base);
            patchList(listId, l => ({ ...l, ...(rev === null ? {} : { content_rev: rev }) }));
        } catch (err) {
            qc.setQueryData(keysRef.current.lists, before);
            if (err instanceof NoteConflictError) {
                // Pictures get no two-way choice: there is no half of a
                // sidecar to keep, and replacing one set of refs with another
                // blind would orphan uploads. The note is put back to what
                // the server holds and the user is told, so they can add the
                // picture again on top of the copy that won.
                patchList(listId, l => ({ ...l, attachments: err.attachments, content_rev: err.contentRev }));
                pushMessageToast({ title: 'This note’s pictures were changed somewhere else, so this change wasn’t saved — the other copy is shown' });
                return false;
            }
            explain('saving the pictures failed', err);
            return false;
        } finally {
            done();
        }
        if (dropped.length > 0) void deleteFiles(fileIdsOf(dropped));
        return true;
    }, [qc, lists, patchList, features]);

    const addNoteMedia = useCallback(async (listId: number, photos: File[], drawings: DrawingFiles[], replacing: TaskAttachmentRef[] = []): Promise<boolean> => {
        const current = lists()?.find(l => l.id === listId);
        const opened = current?.attachments ?? null;
        if (isAttachmentsLocked(opened)) {
            pushMessageToast({ title: 'This note’s pictures can’t be read on this device yet, so nothing can be added here' });
            return false;
        }
        const replaceSet = new Set(replacing.map(r => r.href));
        const kept = parseTaskAttachments(opened).filter(r => !replaceSet.has(r.href));
        // The revision `kept` was read from, captured HERE — the upload below
        // is a multi-second window on a phone, and another device adding a
        // picture during it moves the cached revision. Saving against that
        // one would name THEIRS and drop their picture from the sidecar.
        const baseRev = revOf(lists(), listId, features);
        // And hold the listing's refetches off for the whole window, so the
        // optimistic cache this save is built on cannot be replaced under it.
        const held = beginNoteWrite(LISTS_KEY);
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
            held();
            explain('upload failed', err);
            pushMessageToast({ title: err instanceof Error && err.name === 'TooManyAttachmentsError' ? err.message : 'Couldn’t upload the picture — check your connection' });
            return false;
        }
        let ok: boolean;
        try {
            ok = await setNoteAttachments(listId, [...kept, ...added], replacing, baseRev);
        } finally {
            held();
        }
        if (!ok) await deleteFiles(fileIdsOf(added));
        return ok;
    }, [lists, setNoteAttachments, features]);

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
        createContentNote, setBody, setNoteAttachments, addNoteMedia, deleteForever, emptyTrash,
    }), [features, trashEnabled, trashSettled, trashedKeys, isSelfList, ensureFeatures, createContentNote, setBody, setNoteAttachments, addNoteMedia, deleteForever, emptyTrash]);
}
