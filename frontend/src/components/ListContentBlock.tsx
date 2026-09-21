/**
 * Púca's side of Púca Notes' text and photo notes, and of the trash — so a
 * note made in Notes is not an empty "0 tasks" list here, and a list moved to
 * the trash here can be found again.
 *
 *  - `ListContentBlock`: a personal list's note text (editable) and its
 *    pictures (add photo, remove; drawings show as pictures and are edited in
 *    Púca Notes), above the list's tasks in TasksView.
 *  - `TasksTrash`: the trashed lists, with Restore and Delete forever, under
 *    the All-tasks board.
 *  (What the server supports, and the trashed ids, are
 *  useListContentSupport.ts.)
 *
 * All of it is gated on GET /task-lists/features (api/listContent.ts): an
 * older server gets exactly the Tasks view it had.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { type TaskAttachmentRef, type TaskList, isAttachmentsLocked, parseTaskAttachments } from '../api/tasks';
import {
    type ListFeatures, NoteConflictError, NoteFilesUnreadableError, deleteFiles, deleteListForever,
    restoreTaskList, setTaskListAttachments, setTaskListBody, trashPurgeAt,
} from '../api/listContent';
import { listContentQueryKeys } from './useListContentSupport';
import { type GalleryItem, fileIdsOf, refsOfItem, uploadNoteMedia, withoutItem } from '../api/noteMedia';
import { NoteBodyField, type BodySaveOutcome } from './NoteBodyField';
import { NoteImages } from './NoteImages';
import { pushMessageToast } from './messageToastBus';
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from './Icons';
import './NoteImages.css';

interface BlockProps {
    list: TaskList;
    features: ListFeatures;
    /** Apply a change to the list in the caller's state (optimistic). */
    onPatch: (listId: number, patch: Partial<TaskList>) => void;
    coarse: boolean;
}

export function ListContentBlock({ list, features, onPatch, coarse }: BlockProps) {
    const [busy, setBusy] = useState(false);
    if (!features.body && !features.attachments) return null;
    const opened = list.attachments ?? null;
    const refs: TaskAttachmentRef[] = isAttachmentsLocked(opened) ? [] : parseTaskAttachments(opened);

    const saveBody = async (text: string, baseRev?: number): Promise<BodySaveOutcome> => {
        const before = list.body ?? null;
        const base = features.contentRev ? (baseRev ?? list.content_rev) : undefined;
        onPatch(list.id, { body: text === '' ? null : text });
        try {
            const rev = await setTaskListBody(list.id, text, base);
            if (rev !== null) onPatch(list.id, { content_rev: rev });
            return { rev };
        } catch (err) {
            onPatch(list.id, { body: before });
            if (err instanceof NoteConflictError) {
                // The same contract as Púca Notes': nothing was written, the
                // note goes back to what the server holds, and the field keeps
                // the typed words and asks which to keep.
                onPatch(list.id, { body: err.body, content_rev: err.contentRev });
                return { conflict: { theirs: err.body, rev: err.contentRev } };
            }
            console.error('Failed to save note text:', err);
            return false;
        }
    };
    const saveRefs = async (next: TaskAttachmentRef[], dropped: TaskAttachmentRef[]): Promise<boolean> => {
        const before = list.attachments ?? null;
        onPatch(list.id, { attachments: next.length === 0 ? null : JSON.stringify(next) });
        try {
            const rev = await setTaskListAttachments(list.id, next, features.contentRev ? list.content_rev : undefined);
            if (rev !== null) onPatch(list.id, { content_rev: rev });
        } catch (err) {
            onPatch(list.id, { attachments: before });
            if (err instanceof NoteConflictError) {
                // Same as Púca Notes': pictures get no two-way choice (there
                // is no half of a sidecar to keep), so the note goes back to
                // the copy that won and the user is told.
                onPatch(list.id, { attachments: err.attachments, content_rev: err.contentRev });
                pushMessageToast({ title: 'This note’s pictures were changed somewhere else, so this change wasn’t saved — the other copy is shown' });
                return false;
            }
            console.error('Failed to save note pictures:', err);
            return false;
        }
        if (dropped.length > 0) void deleteFiles(fileIdsOf(dropped));
        return true;
    };
    const addPhotos = async (files: File[]) => {
        setBusy(true);
        try {
            const added = await uploadNoteMedia(files, [], refs.length);
            if (!await saveRefs([...refs, ...added], [])) await deleteFiles(fileIdsOf(added));
        } catch (err) {
            console.error('Failed to upload picture:', err);
            pushMessageToast({ title: err instanceof Error && err.name === 'TooManyAttachmentsError' ? err.message : 'Couldn’t upload the picture' });
        } finally {
            setBusy(false);
        }
    };
    const remove = async (item: GalleryItem) => {
        if (!window.confirm('Remove this picture? It is deleted for good.')) return;
        setBusy(true);
        try { await saveRefs(withoutItem(refs, item), refsOfItem(item)); } finally { setBusy(false); }
    };

    return (
        <div className="list-content-block">
            {features.body && (
                <NoteBodyField key={list.id} listId={list.id} value={list.body} contentRev={list.content_rev} onSave={saveBody} placeholder="Add a note…" />
            )}
            {features.attachments && (
                <NoteImages
                    opened={opened}
                    editable
                    busy={busy}
                    onAddPhotos={files => void addPhotos(files)}
                    onRemove={item => void remove(item)}
                    showCamera={coarse}
                />
            )}
        </div>
    );
}

interface TrashProps {
    features: ListFeatures;
    trashed: TaskList[];
    /** A restored list, for the caller to show again. */
    onRestored: (list: TaskList) => void;
}

export function TasksTrash({ features, trashed, onRestored }: TrashProps) {
    const qc = useQueryClient();
    const [open, setOpen] = useState(false);
    if (trashed.length === 0) return null;
    const drop = (id: number) => qc.setQueryData<TaskList[]>(listContentQueryKeys.trash, prev => prev?.filter(l => l.id !== id));
    const restore = async (l: TaskList) => {
        try {
            await restoreTaskList(l.id);
            drop(l.id);
            onRestored({ ...l, trashed_at: null });
        } catch (err) {
            console.error('Failed to restore list:', err);
            pushMessageToast({ title: 'Couldn’t restore the list' });
        }
    };
    const forever = async (l: TaskList) => {
        if (!window.confirm(`Delete “${l.title}” forever? Its tasks, pictures and attachments go with it. This can’t be undone.`)) return;
        try {
            await deleteListForever(l);
            drop(l.id);
        } catch (err) {
            console.error('Failed to delete list:', err);
            // Refused because its files cannot all be found: say so, in its words.
            pushMessageToast({ title: err instanceof NoteFilesUnreadableError ? err.message : 'Couldn’t delete the list' });
        }
    };
    const days = features.trashRetentionDays;
    return (
        <section className="tasks-trash" aria-label="Trash">
            <button type="button" className="tasks-trash-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                {open ? <ChevronDownIcon /> : <ChevronRightIcon />} <TrashIcon /> Trash ({trashed.length})
            </button>
            {open && (
                <>
                    <p className="tasks-trash-copy">
                        {days > 0 ? `Lists in the trash are deleted forever after ${days} day${days === 1 ? '' : 's'}.` : 'Lists stay in the trash until you delete them forever.'}
                    </p>
                    <ul className="tasks-trash-list">
                        {trashed.map(l => {
                            const purge = trashPurgeAt(l.trashed_at, days);
                            return (
                                <li key={l.id} className="tasks-trash-row">
                                    <span className="tasks-trash-title">{l.title}</span>
                                    {purge !== null && <span className="tasks-trash-when">until {new Date(purge).toLocaleDateString()}</span>}
                                    <button type="button" className="tasks-trash-btn" onClick={() => void restore(l)}>Restore</button>
                                    <button type="button" className="tasks-trash-btn danger" onClick={() => void forever(l)}>Delete forever</button>
                                </li>
                            );
                        })}
                    </ul>
                </>
            )}
        </section>
    );
}
