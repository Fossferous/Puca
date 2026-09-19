/**
 * The open note's OWN content, above its items: the note text, its photos
 * and drawings, and the two conversions — "Show checkboxes" (each line of
 * the text becomes an item) and "Hide checkboxes" (the items become lines of
 * text). Personal notes only, and only what the server supports
 * (useListContent.ts); against an older server this renders nothing and the
 * editor is exactly what it was.
 *
 * Both conversions offer Undo. "Hide checkboxes" is lossy when items nest,
 * carry due times or attachments, or are done — it asks first, and its Undo
 * re-creates the items with those properties (the attachment files are never
 * deleted by a conversion, so their refs still open).
 */
import { useState } from 'react';
import { type Task, isAttachmentsLocked, parseTaskAttachments } from '../../api/tasks';
import { type GalleryItem, readStrokes, refsOfItem, withoutItem } from '../../api/noteMedia';
import { NoteBodyField } from '../../components/NoteBodyField';
import { bodyBytes, MAX_BODY_BYTES } from '../../api/listContent';
import { NoteImages } from '../../components/NoteImages';
import { pushMessageToast } from '../../components/messageToastBus';
import { isUndecryptable } from '../../api/decryptMarkers';
import { type NoteCard } from '../model/notesModel';
import { type NoteActions } from '../model/notesQueries';
import { bodyToItems, conversionLosses, describeLosses, itemsToBody, readableBody, recreationOrder } from '../model/noteContent';
import { type DrawingDoc, parseDrawing } from '../model/drawing';
import { DrawingCanvas } from './DrawingCanvas';
import { UndoBar } from './UndoBar';
import '../noteContent.css';

const COARSE = '(pointer: coarse) and (max-width: 1024px)';

interface Props {
    card: NoteCard;
    actions: NoteActions;
    /** The note's items as the editor has them. */
    tasks: Task[];
    /** False while the items are still loading (no conversion then). */
    tasksLoaded: boolean;
}

type Undo = { token: number; message: string; run: () => Promise<void> };
let undoSeq = 0;

export function NoteContentSection({ card, actions, tasks, tasksLoaded }: Props) {
    const c = actions.content;
    const [drawing, setDrawing] = useState<{ item?: GalleryItem; initial?: DrawingDoc } | null>(null);
    const [busy, setBusy] = useState(false);
    const [undo, setUndo] = useState<Undo | null>(null);
    const [converting, setConverting] = useState(false);
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
        if (!window.confirm(`Remove this ${item.kind === 'drawing' ? 'drawing' : 'picture'}? It is deleted for good.`)) return;
        setBusy(true);
        try { await c.setNoteAttachments(listId, withoutItem(refs, item), refsOfItem(item)); } finally { setBusy(false); }
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
        setConverting(true);
        const created: Task[] = [];
        try {
            for (const t of items) {
                const made = await actions.addTask(ref, t);
                if (!made) break;
                created.push(made);
            }
            if (created.length < items.length) {
                pushMessageToast({ title: 'Not every line became an item — the text is kept' });
                return;
            }
            const before = text;
            if (!await c.setBody(listId, '')) return;
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
        const snapshot = recreationOrder(tasks);
        try {
            if (!await c.setBody(listId, next)) return;
            for (const t of snapshot) if (t.parent_id === null) await actions.deleteTaskFrom(ref, t.id);
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
            });
        } finally {
            setConverting(false);
        }
    };

    return (
        <div className="notes-editor-content">
            {showImages && (
                <NoteImages
                    opened={opened}
                    editable
                    busy={busy}
                    onAddPhotos={files => void addPhotos(files)}
                    onRemove={item => void remove(item)}
                    onDraw={item => void openDrawing(item)}
                    showCamera={!!coarse}
                />
            )}
            {showBody && (
                <NoteBodyField
                    key={card.key}
                    value={card.body}
                    onSave={t => c.setBody(listId, t)}
                    placeholder={tasks.length > 0 ? 'Add some text…' : 'Take a note…'}
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
                    onUndo={() => { const u = undo; setUndo(null); void u.run(); }}
                    onExpire={() => setUndo(null)}
                />
            )}
        </div>
    );
}
