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
} from '../../api/listContent';
import {
    type DrawingFiles, type SealedMedia,
    fileIdsOf, fileIdsOfHrefs, mediaCountLabel, nameAudioFiles, nextDrawingName, refOfParked, sealNoteMedia, uploadNoteMedia,
} from '../../api/noteMedia';
import { parkedIdsOf, withoutParked } from '../../api/parkedMedia';
import { ParkedMediaFullError, appParkedStore } from './notesBlobs';
import { ensureOutboxLoaded, forgetParkedMedia, ops, pendingOutboxCount, sendCreateList, sendCreateTask, sendNoteOp } from './notesOutbox';
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
    /** Anything that is not a picture — a PDF, a ticket, a spreadsheet.
     *  Encrypted and uploaded exactly like a photo, but never put through
     *  the image decoder and never shrunk. */
    files?: File[];
    drawing?: DrawingFiles;
    /** Voice notes: uploaded raw, sealed exactly as a photo is. */
    audio?: File[];
}

/** What a save of a note's text answers with: `{ rev }` saved (naming the
 *  note's new revision, or null from a server that has none), `false` did
 *  not, and a `conflict` means the text was changed somewhere else first and
 *  nothing was written — `theirs` is that copy, opened (null = the other
 *  device cleared the text). Use `noteSaved` rather than truthiness: a
 *  conflict is an object too, and reading it as success is how a caller ends
 *  up acting as though its text had landed. */
export type SaveOutcome = boolean | 'saved' | 'queued' | 'failed' | { rev: number | null } | { conflict: { theirs: string | null; rev: number } };

export function noteSaved(outcome: SaveOutcome): boolean {
    // 'queued' counts as saved: the words are on this device and the outbox
    // owns them from here. Only a refusal and a conflict are "not saved".
    if (outcome === false || outcome === 'failed') return false;
    if (outcome === true || outcome === 'saved' || outcome === 'queued') return true;
    return typeof outcome === 'object' && outcome !== null && 'rev' in outcome;
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
    return !!extra && (!!extra.body?.trim() || (extra.photos?.length ?? 0) > 0 || (extra.files?.length ?? 0) > 0 || !!extra.drawing || (extra.audio?.length ?? 0) > 0);
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

/** What to tell the user when uploading a note's media failed. The size and
 *  slot errors say the real numbers; anything else is a connection. */
function mediaFailureText(err: unknown): string {
    if (err instanceof Error && (err.name === 'TooManyAttachmentsError' || err.name === 'ClipTooLargeError' || err.name === 'FileTooLargeError')) return err.message;
    return 'Couldn’t upload that — check your connection';
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

/** What to tell the user when a picture could not even be kept. */
function mediaFailureMessage(err: unknown): string {
    if (err instanceof ParkedMediaFullError) return err.message;
    if (err instanceof Error && err.name === 'TooManyAttachmentsError') return err.message;
    return 'Couldn’t add the picture';
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
    /** Save a note's text. `{ rev }` (or 'saved') = written, 'queued' = kept
     *  on this device and sent when the connection is back, 'failed' = it did
     *  not save (the cache is rolled back and the caller has been told), and a
     *  `{ conflict }` means the text was changed somewhere else first: the
     *  server's copy is in `conflict.theirs` (null = they cleared it), the
     *  cache now holds it, and NOTHING was written. */
    setBody: (listId: number, body: string, baseRev?: number) => Promise<SaveOutcome>;
    /** Drop `dropped` from a note's sidecar (`next` is what is left). An
     *  intent, applied to whatever the server holds — see the implementation
     *  for why it needs no base revision. */
    setNoteAttachments: (listId: number, next: TaskAttachmentRef[], dropped?: TaskAttachmentRef[]) => Promise<boolean>;
    addNoteMedia: (listId: number, photos: File[], drawings: DrawingFiles[], replacing?: TaskAttachmentRef[], audio?: File[]) => Promise<boolean>;
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

    /**
     * A note with text or pictures, made with no connection (or behind a
     * queue): the media is sealed and parked here and now, the note, its
     * text, its pictures and its items are queued in that order, and the
     * caller gets a temporary note it can open at once.
     *
     * The order matters: every op after the create names the note's
     * temporary id, which the outbox rewrites when the create replays.
     */
    const queueContentNote = useCallback(async (
        noteTitle: string,
        body: string,
        photos: File[],
        drawings: { files: DrawingFiles; base: string }[],
        entries: { text: string; timing: NewTaskTiming | undefined }[],
    ): Promise<NoteRef | null> => {
        let records: SealedMedia[] = [];
        if (photos.length > 0 || drawings.length > 0) {
            try {
                records = await sealNoteMedia(photos, drawings, 0);
                await appParkedStore.park(records);
            } catch (err) {
                explain('keeping the picture failed', err);
                pushMessageToast({ title: mediaFailureMessage(err) });
                return null;   // the composer keeps the draft
            }
        }
        let list: TaskList;
        try {
            list = await sendCreateList(noteTitle);
        } catch (err) {
            explain('create failed', err);
            await forgetParkedMedia(records.map(r => r.id));
            return null;
        }
        const ref: NoteRef = { kind: 'list', id: list.id };
        if (body) {
            try {
                await sendNoteOp(ops.setBody(list.id, body));
            } catch (err) {
                explain('saving the text failed', err);
            }
        }
        if (records.length > 0) {
            try {
                await sendNoteOp(ops.addMedia(list.id, records.map(r => r.id), [], [], `${mediaCountLabel(photos, drawings.length)} on a new note`));
            } catch (err) {
                explain('upload failed', err);
                await forgetParkedMedia(records.map(r => r.id));
                records = [];
            }
        }
        const created: Task[] = [];
        for (const e of entries) {
            try {
                created.push(await sendCreateTask(ref, e.text, undefined, () => created, e.timing));
            } catch (err) {
                explain('create item failed', err);
            }
        }
        const shown = records.map(refOfParked);
        qc.setQueryData<Task[]>(keysRef.current.tasks(ref), created);
        qc.setQueryData<TaskList[]>(keysRef.current.lists, prev => [...(prev ?? []), {
            ...list,
            total_tasks: created.length,
            completed_tasks: 0,
            body: body || null,
            attachments: shown.length === 0 ? null : JSON.stringify(shown.map(({ href, name }) => ({ href, name }))),
        }]);
        return ref;
    }, [qc]);

    const createContentNote = useCallback(async (title: string, items: string[], extra: NoteExtras, timing?: (NewTaskTiming | undefined)[]): Promise<NoteRef | null> => {
        // Each item's timing rides with it through the blank-dropping clean.
        const entries = items
            .map((raw, i) => ({ text: cleanQuickItems([raw])[0], timing: timing?.[i] }))
            .filter((e): e is { text: string; timing: NewTaskTiming | undefined } => e.text !== undefined);
        const cleanItems = entries.map(e => e.text);
        const body = extra.body?.replace(/\s+$/, '') ?? '';
        const files = extra.files ?? [];
        // Both go up the same way; only the picture is shrunk first.
        const photos = [...(extra.photos ?? []), ...files];
        const drawings = extra.drawing ? [{ files: extra.drawing, base: nextDrawingName([]) }] : [];
        const noteTitle = deriveContentTitle(title, {
            body, items: cleanItems, images: extra.photos?.length ?? 0, drawing: !!extra.drawing,
            fileNames: files.map(f => f.name),
        });
        // Offline, or behind a queue this must not overtake: the note is made
        // through the outbox instead. It briefly exists without its picture
        // (three ops, not one request) — which is the price of a photo note
        // taken with no signal existing at all.
        //
        // The persisted queue has to have LOADED before that count means
        // anything: a note made in the first moments after a reload would
        // otherwise be sent straight to the server, ahead of what the
        // previous page left waiting.
        await ensureOutboxLoaded();
        if (!navigator.onLine || pendingOutboxCount() > 0) {
            return queueContentNote(noteTitle, body, photos, drawings, entries);
        }
        let refs: TaskAttachmentRef[] = [];
        try {
            refs = await uploadNoteMedia(photos, drawings, 0, nameAudioFiles(extra.audio ?? [], []));
        } catch (err) {
            explain('upload failed', err);
            pushMessageToast({ title: mediaFailureText(err) });
            return null;
        }
        let list: TaskList;
        // One key for this one note, minted here so it is the SAME on every
        // attempt of this create and different for every other (api/opKey.ts).
        const noteKey = newOpKey();
        try {
            list = await createTaskListWithContent(noteTitle, { body: body || undefined, refs }, noteKey);
        } catch (err) {
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
    }, [qc, queueContentNote]);

    // Through the outbox: online with nothing queued this simply runs, and
    // with no connection the typed text is kept on this device and replayed.
    // A second save for the same note replaces the queued one, so a
    // paragraph typed offline is one op, not one per pause in typing.
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
            const r = await sendNoteOp<number | null>(ops.setBody(listId, body, base));
            if (r.queued) return 'queued';
            const rev = r.value ?? null;
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
            return 'failed';
        } finally {
            done();
        }
    }, [qc, lists, patchList, features]);

    /**
     * Remove `dropped` from the sidecar (`next` is what is left). Through the
     * outbox, as an INTENT: replayed later it removes those refs from
     * whatever the server holds then, so a picture added on another device in
     * the meantime survives. The uploads behind them are deleted when the
     * removal reaches the server (notesOutbox.ts), not before.
     *
     * A picture still waiting on this device never reached the server at all:
     * its ciphertext is deleted and the queued op that would have sent it
     * forgets it — so `serverGone` can be empty and nothing is queued here.
     * That holds even once its upload has left: an op in flight, or one that
     * landed while this cache still names the parked ref, is no longer in
     * the queue for `forgetParked` to rewrite — so the outbox queues that
     * removal itself, by the href the upload became (notesOutbox.ts,
     * `forgottenInFlight` and `sentAs`).
     *
     * NO compare-and-swap here, deliberately: an intent that names the refs
     * to drop is applied to whatever the server holds, so there is nothing a
     * revision check could protect. The whole-sidecar replace that DOES need
     * one is in `addNoteMedia` below, which names its base explicitly.
     */
    const setNoteAttachments = useCallback(async (listId: number, next: TaskAttachmentRef[], dropped: TaskAttachmentRef[] = []): Promise<boolean> => {
        const current = lists()?.find(l => l.id === listId);
        if (current && isAttachmentsLocked(current.attachments ?? null)) {
            pushMessageToast({ title: 'This note’s pictures can’t be read on this device yet, so they can’t be changed here' });
            return false;
        }
        const before = lists();

        patchList(listId, l => ({ ...l, attachments: next.length === 0 ? null : JSON.stringify(next.map(({ href, name }) => ({ href, name }))) }));
        const parkedGone = parkedIdsOf(dropped);
        if (parkedGone.length > 0) await forgetParkedMedia(parkedGone);
        const serverGone = withoutParked(dropped);
        if (serverGone.length === 0) return true;
        // Busy under LISTS_KEY for the same reason setBody is: the write
        // lands in the LISTING query, whose refetch would otherwise bring
        // back the old sidecar and the old revision.
        const done = beginNoteWrite(LISTS_KEY);
        try {
            const n = serverGone.length;
            await sendNoteOp(ops.removeMedia(listId, serverGone.map(r => r.href), withoutParked(next), `remove ${n} picture${n === 1 ? '' : 's'}`));
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
        return true;
    }, [qc, lists, patchList]);

    /**
     * Add pictures, drawings, recordings or files to a note.
     *
     * Online with nothing waiting, they are uploaded there and then, exactly
     * as they always were. Otherwise they are encrypted on this device FIRST
     * and parked (notesBlobs.ts) and the upload becomes an outbox op — so a
     * photo taken with no signal is sealed at once and sent when the
     * connection is back, and the note shows it meanwhile from the parked
     * bytes.
     *
     * The two paths, and not one: parking a copy of a photo that is about to
     * go up anyway costs a phone two more passes over the ciphertext and
     * twice its size in IndexedDB, and it let the on-device cap refuse a
     * picture on a device that was perfectly online — which is not true of
     * an online device, and not a thing the user could act on.
     */
    const addNoteMedia = useCallback(async (listId: number, photos: File[], drawings: DrawingFiles[], replacing: TaskAttachmentRef[] = [], audio: File[] = []): Promise<boolean> => {
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
        const bases: string[] = [];
        let names = kept;
        for (let i = 0; i < drawings.length; i++) {
            const base = nextDrawingName(names);
            bases.push(base);
            names = [...names, { href: `pending:${base}`, name: `${base}.png` }];
        }
        const named = drawings.map((files, i) => ({ files, base: bases[i] }));
        const goneHrefs = withoutParked(replacing).map(r => r.href);
        await ensureOutboxLoaded();
        if (navigator.onLine && pendingOutboxCount() === 0) {
            // Hold the listing's refetches off for the whole window, so the
            // optimistic cache this save is built on cannot be replaced under it.
            const held = beginNoteWrite(LISTS_KEY);
            let added: TaskAttachmentRef[];
            try {
                added = await uploadNoteMedia(photos, named, kept.length, nameAudioFiles(audio, names));
            } catch (err) {
                held();
                explain('upload failed', err);
                pushMessageToast({ title: mediaFailureText(err) });
                return false;
            }
            const before = lists();
            patchList(listId, l => ({ ...l, attachments: JSON.stringify([...kept, ...added].map(({ href, name }) => ({ href, name }))) }));
            try {
                const rev = await setTaskListAttachments(listId, [...kept, ...added], baseRev);
                patchList(listId, l => ({ ...l, ...(rev === null ? {} : { content_rev: rev }) }));
            } catch (err) {
                qc.setQueryData(keysRef.current.lists, before);
                if (err instanceof NoteConflictError) {
                    // Pictures get no two-way choice: there is no half of a
                    // sidecar to keep, and replacing one set of refs with
                    // another blind would orphan uploads.
                    patchList(listId, l => ({ ...l, attachments: err.attachments, content_rev: err.contentRev }));
                    pushMessageToast({ title: 'This note’s pictures were changed somewhere else, so this change wasn’t saved — the other copy is shown' });
                } else {
                    explain('saving the pictures failed', err);
                }
                await deleteFiles(fileIdsOf(added));   // nothing names them now
                return false;
            } finally {
                held();
            }
            const parkedOut = parkedIdsOf(replacing);
            if (parkedOut.length > 0) await forgetParkedMedia(parkedOut);
            if (goneHrefs.length > 0) void deleteFiles(fileIdsOfHrefs(goneHrefs));
            return true;
        }
        let records: SealedMedia[];
        try {
            records = await sealNoteMedia(photos, named, kept.length, audio);
            await appParkedStore.park(records);
        } catch (err) {
            explain('keeping the picture failed', err);
            pushMessageToast({ title: mediaFailureMessage(err) });
            return false;
        }
        const before = lists();
        const shown = [...kept, ...records.map(refOfParked)];
        patchList(listId, l => ({ ...l, attachments: JSON.stringify(shown.map(({ href, name }) => ({ href, name }))) }));
        const parkedReplaced = parkedIdsOf(replacing);
        if (parkedReplaced.length > 0) await forgetParkedMedia(parkedReplaced);
        try {
            await sendNoteOp(ops.addMedia(
                listId,
                records.map(r => r.id),
                goneHrefs,
                withoutParked(kept),
                `${mediaCountLabel([...photos, ...audio], drawings.length)} on a note`,
            ));
        } catch (err) {
            explain('upload failed', err);
            pushMessageToast({ title: 'Couldn’t add the picture' });
            qc.setQueryData(keysRef.current.lists, before);
            await forgetParkedMedia(records.map(r => r.id));
            return false;
        }
        return true;
    }, [qc, lists, patchList, features]);

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
