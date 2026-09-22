/**
 * The open note's OWN content, above its items: the note text, its photos,
 * drawings and voice notes, and the two conversions — "Show checkboxes" (each line of
 * the text becomes an item) and "Hide checkboxes" (the items become lines of
 * text). Personal notes only, and only what the server supports
 * (useListContent.ts); against an older server this renders nothing and the
 * editor is exactly what it was.
 *
 * "Show checkboxes" never half-applies. It is refused while offline or while
 * anything waits in the offline outbox (every new item would queue behind
 * it while the text, which never queues, was cleared at once), and it clears
 * the text FIRST: if that fails nothing has changed, and if an item is then
 * refused the text is put back and the items made so far are removed. An
 * item that only QUEUES (the connection dropped mid-way) is not a failure —
 * it replays, in order, with the rest.
 *
 * Both conversions offer Undo. "Hide checkboxes" is lossy when items nest,
 * carry due times or attachments, or are done — it asks first, and its Undo
 * re-creates the items with those properties (so the attachment files are
 * kept while Undo is offered). Once the Undo window closes — it expires, a
 * newer Undo replaces it, or the note closes — nothing names those files any
 * more, and they are deleted rather than left on the server. Only the files
 * of items whose delete actually went through, and never one a live item
 * still names at that moment: an item whose delete failed is put back WITH
 * its pictures, so it stays an item (the text gets only the lines that
 * left), and its files are its own again.
 */
import { useEffect, useRef, useState } from 'react';
import { type Task, isAttachmentsLocked, parseTaskAttachments } from '../../api/tasks';
import { type GalleryItem, fileIdsOf, galleryItemNoun, readStrokes, refsOfItem, withoutItem } from '../../api/noteMedia';
import { type NoteBodyHandle, NoteBodyField } from '../../components/NoteBodyField';
import { bodyBytes, deleteFiles, MAX_BODY_BYTES } from '../../api/listContent';
import { NoteImages } from '../../components/NoteImages';
import { pushMessageToast } from '../../components/messageToastBus';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type NoteCard } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';
import { pendingOutboxCount } from '../model/notesOutbox';
import { bodyToItems, conversionLosses, describeLosses, itemsToBody, readableBody, recreationOrder } from '../model/noteContent';
import { type DrawingDoc, parseDrawing } from '../../api/drawing';
import { DrawingCanvas } from '../../components/DrawingCanvas';
import { AudioRecorder, type RecordedClip } from './AudioRecorder';
import { canRecordAudio } from '../model/audioNote';
import { transcribeClip } from '../model/transcribe';
import { UndoBar } from './UndoBar';
import '../noteContent.css';

const COARSE = '(pointer: coarse) and (max-width: 1024px)';

/** An item's attachment refs, when this device can read them. */
function attachmentsOf(t: Task) {
    return t.attachments && !isAttachmentsLocked(t.attachments) ? parseTaskAttachments(t.attachments) : [];
}

interface Props {
    card: NoteCard;
    actions: NoteActions;
    /** The note's items as the editor has them. */
    tasks: Task[];
    /** False while the items are still loading (no conversion then). */
    tasksLoaded: boolean;
}

/** `commit` runs when the Undo can no longer happen (see the header). */
type Undo = { token: number; message: string; run: () => Promise<void>; commit?: () => void };
let undoSeq = 0;

export function NoteContentSection({ card, actions, tasks, tasksLoaded }: Props) {
    const c = actions.content;
    const [drawing, setDrawing] = useState<{ item?: GalleryItem; initial?: DrawingDoc } | null>(null);
    const [recording, setRecording] = useState(false);
    /** Why the last recording was not written down (an honest sentence), or
     *  null. Shown under the media, never as a toast that scrolls away. */
    const [transcribeNotice, setTranscribeNotice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [undo, setUndoState] = useState<Undo | null>(null);
    const [converting, setConverting] = useState(false);
    const undoRef = useRef<Undo | null>(null);
    /** The live text field, while there is one — a transcript is added
     *  through it, never behind it (see keepClip). */
    const bodyRef = useRef<NoteBodyHandle>(null);
    // The items as they are NOW, for a commit that runs after they changed.
    const tasksRef = useRef(tasks);
    useEffect(() => { tasksRef.current = tasks; });
    /** Replace the pending Undo; the one replaced can no longer happen. */
    const setUndo = (next: Undo | null, committed = true) => {
        const prev = undoRef.current;
        undoRef.current = next;
        setUndoState(next);
        if (prev && prev !== next && committed) prev.commit?.();
    };
    // Closing the note ends the Undo too.
    useEffect(() => () => { undoRef.current?.commit?.(); undoRef.current = null; }, []);
    if (card.ref.kind !== 'list') return null;
    const listId = card.ref.id;
    const ref = card.ref;
    const showBody = c.features.body;
    const showImages = c.features.attachments;
    if (!showBody && !showImages) return null;
    const coarse = typeof window !== 'undefined' && window.matchMedia?.(COARSE).matches;
    const opened = card.noteAttachments ?? null;
    const refs = isAttachmentsLocked(opened) ? [] : parseTaskAttachments(opened);
    const text = readableBody(card.body);
    const bodyLocked = !!card.body && isUndecryptable(card.body);

    const addPhotos = async (files: File[]) => {
        setBusy(true);
        try { await c.addNoteMedia(listId, files, []); } finally { setBusy(false); }
    };
    const remove = async (item: GalleryItem) => {
        // The same three words the Remove button carries (NoteImages.tsx):
        // being asked to confirm deleting a "picture" on a note that also
        // holds photos reads as the wrong attachment going.
        if (!window.confirm(`Remove this ${galleryItemNoun(item)}? It is deleted for good.`)) return;
        setBusy(true);
        try { await c.setNoteAttachments(listId, withoutItem(refs, item), refsOfItem(item)); } finally { setBusy(false); }
    };
    /** Keep a recording, then try to write it down ON THIS PHONE. The clip is
     *  saved either way: a device that cannot transcribe says so rather than
     *  sending the audio anywhere (model/transcribe.ts). The transcript goes
     *  into the note's TEXT, which is what makes a voice note searchable —
     *  search never reads attachment names.
     *
     *  It goes there through the TEXT FIELD's own handle, never straight to
     *  the note: transcribing takes a second or two, the recorder sheet is
     *  already closed, and a body written behind a half-typed line is undone
     *  by that field's next autosave. */
    const keepClip = async (clip: RecordedClip): Promise<boolean> => {
        setBusy(true);
        setTranscribeNotice(null);
        try {
            if (!await c.addNoteMedia(listId, [], [], [], [clip.file])) return false;
        } finally {
            setBusy(false);
        }
        setRecording(false);
        try {
            // No text field, no home for a transcript: a server without the
            // body feature holds nothing but the sealed clip, and asking the
            // phone to transcribe for a note that cannot keep the words is
            // work with nowhere to go.
            if (!showBody) return true;
            const r = await transcribeClip(clip.file, clip.durationMs);
            if (!r.text) { setTranscribeNotice(r.reason); return true; }
            const field = bodyRef.current;
            if (!field) {
                // The note was closed while the phone was transcribing. Its
                // text is whatever that field last saved, which this closure
                // can no longer see, so the transcript is dropped rather than
                // written over the user's last words.
                console.warn('[notes] the note closed before its transcript was ready');
                return true;
            }
            const outcome = await field.appendText(r.text);
            if (outcome === 'too-long') setTranscribeNotice('There is no room left in this note’s text for what was said — the recording is saved.');
            else if (outcome === 'failed') setTranscribeNotice('The recording is saved, but what was said couldn’t be added to the text.');
        } catch (err) {
            console.error('[notes] transcribing failed:', err);
            setTranscribeNotice('The recording is saved, but this device couldn’t write it down.');
        } finally {
            // The preview URL came with the clip and is OURS now
            // (AudioRecorder hands ownership over on Keep and deliberately
            // does not revoke it): the sheet is gone, so free the blob.
            URL.revokeObjectURL(clip.url);
        }
        return true;
    };

    const openDrawing = async (item?: GalleryItem) => {
        if (!item?.strokes) { setDrawing({}); return; }
        try {
            const doc = parseDrawing(await readStrokes(item.strokes));
            if (!doc) throw new Error('unreadable strokes');
            setDrawing({ item, initial: doc });
        } catch (err) {
            console.error('[notes] opening the drawing failed:', err);
            pushMessageToast({ title: 'Couldn’t open that drawing for editing' });
        }
    };

    const showCheckboxes = async () => {
        const items = bodyToItems(text);
        if (items.length === 0) return;
        if (!navigator.onLine || pendingOutboxCount() > 0) {
            pushMessageToast({ title: 'Can’t turn the text into a checklist while offline or while changes are waiting to sync — try again once they have' });
            return;
        }
        setConverting(true);
        const created: Task[] = [];
        const before = text;
        try {
            if (!await c.setBody(listId, '')) {
                pushMessageToast({ title: 'Couldn’t turn the text into a checklist — the text is kept' });
                return;
            }
            for (const t of items) {
                const made = await actions.addTask(ref, t);
                if (!made) break;
                created.push(made);
            }
            if (created.length < items.length) {
                // Refused part-way: back to the text alone, as it was.
                await c.setBody(listId, before);
                for (const t of created) await actions.deleteTaskFrom(ref, t.id);
                pushMessageToast({ title: 'Not every line became an item — the text is kept' });
                return;
            }
            setUndo({
                token: ++undoSeq,
                message: 'Turned the text into a checklist',
                run: async () => {
                    if (!await c.setBody(listId, before)) return;
                    for (const t of created) await actions.deleteTaskFrom(ref, t.id);
                },
            });
        } finally {
            setConverting(false);
        }
    };

    const hideCheckboxes = async () => {
        const losses = conversionLosses(tasks);
        if (losses.unreadable > 0) {
            pushMessageToast({ title: 'Some items can’t be read on this device, so this list can’t be turned into text here' });
            return;
        }
        const warning = describeLosses(losses);
        if (warning && !window.confirm(warning)) return;
        const before = text;
        const next = [before, itemsToBody(tasks)].filter(s => s !== '').join('\n');
        if (bodyBytes(next) > MAX_BODY_BYTES) {
            pushMessageToast({ title: 'Too much text for one note — shorten the list first' });
            return;
        }
        setConverting(true);
        const all = recreationOrder(tasks);
        try {
            if (!await c.setBody(listId, next)) return;
            // Deleting a top-level item takes its subtree with it.
            const gone = new Set<number>();
            for (const t of all) if (t.parent_id === null && await actions.deleteTaskFrom(ref, t.id)) gone.add(t.id);
            for (const t of all) if (t.parent_id !== null && gone.has(t.parent_id)) gone.add(t.id);   // parents come first
            const snapshot = all.filter(t => gone.has(t.id));
            if (snapshot.length < all.length) {
                // Some stayed items: the text gets only the lines that left.
                const partial = [before, itemsToBody(snapshot)].filter(s => s !== '').join('\n');
                await c.setBody(listId, partial);
                pushMessageToast({ title: snapshot.length === 0 ? 'Couldn’t turn the checklist into text — the items are kept' : 'Not every item became text — the rest are still items' });
                if (snapshot.length === 0) return;
            }
            // The dropped items' uploads: kept for the Undo, deleted after it —
            // never one a live item names by then.
            const orphaned = fileIdsOf(snapshot.flatMap(attachmentsOf));
            setUndo({
                token: ++undoSeq,
                message: 'Turned the checklist into text',
                run: async () => {
                    const idMap = new Map<number, number>();
                    for (const t of snapshot) {
                        const parent = t.parent_id === null ? undefined : idMap.get(t.parent_id);
                        const made = await actions.addTask(ref, t.description, parent);
                        if (!made) continue;
                        idMap.set(t.id, made.id);
                        if (t.due_at) await actions.setDue(ref, made, t.due_at);
                        if (t.attachments && !isAttachmentsLocked(t.attachments)) {
                            await actions.setAttachments(ref, made, parseTaskAttachments(t.attachments));
                        }
                        // Completing a parent completes its subtree, so only
                        // the top of each completed branch is toggled.
                        const parentDone = t.parent_id !== null && snapshot.find(p => p.id === t.parent_id)?.is_completed;
                        if (t.is_completed && !parentDone) await actions.toggleTask(ref, made, true);
                    }
                    await c.setBody(listId, before);
                },
                commit: orphaned.length > 0 ? () => {
                    const named = new Set(fileIdsOf(tasksRef.current.flatMap(attachmentsOf)));
                    const unused = orphaned.filter(id => !named.has(id));
                    if (unused.length > 0) void deleteFiles(unused);
                } : undefined,
            });
        } finally {
            setConverting(false);
        }
    };

    return (
        <div className="notes-editor-content">
            {showBody && (
                <NoteBodyField
                    key={card.key}
                    ref={bodyRef}
                    listId={listId}
                    value={card.body}
                    onSave={t => c.setBody(listId, t)}
                    placeholder={tasks.length > 0 ? 'Add some text…' : 'Take a note…'}
                />
            )}
            {showImages && (
                <NoteImages
                    opened={opened}
                    editable
                    busy={busy}
                    onAddPhotos={files => void addPhotos(files)}
                    onRemove={item => void remove(item)}
                    onDraw={item => void openDrawing(item)}
                    showCamera={!!coarse}
                    onRecord={canRecordAudio() ? () => { setTranscribeNotice(null); setRecording(true); } : undefined}
                />
            )}
            {transcribeNotice && (
                <p className="notes-transcribe-notice" role="status">{transcribeNotice}</p>
            )}
            {recording && (
                <AudioRecorder
                    onCancel={() => setRecording(false)}
                    onSave={clip => keepClip(clip)}
                />
            )}
            {showBody && tasksLoaded && !bodyLocked && (text !== '' || tasks.length > 0) && (
                <div className="notes-convert-row">
                    {text !== '' && (
                        <button type="button" className="ni-action" disabled={converting} onClick={() => void showCheckboxes()}>Show checkboxes</button>
                    )}
                    {tasks.length > 0 && (
                        <button type="button" className="ni-action" disabled={converting} onClick={() => void hideCheckboxes()}>Hide checkboxes</button>
                    )}
                </div>
            )}
            {drawing && (
                <DrawingCanvas
                    initial={drawing.initial}
                    onCancel={() => setDrawing(null)}
                    onSave={async files => {
                        const ok = await c.addNoteMedia(listId, [], [files], drawing.item ? refsOfItem(drawing.item) : []);
                        if (ok) setDrawing(null);
                        return ok;
                    }}
                />
            )}
            {undo && (
                <UndoBar
                    token={undo.token}
                    message={undo.message}
                    onUndo={() => { const u = undo; setUndo(null, false); void u.run(); }}
                    onExpire={() => setUndo(null)}
                />
            )}
        </div>
    );
}
