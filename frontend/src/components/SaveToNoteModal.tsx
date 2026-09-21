/**
 * "Save to Notes" — keep a chat message in one of your own notes.
 *
 * It is a one-way COPY. The text is re-sealed to your own key, and a picture
 * is decrypted, encrypted again under a fresh key and uploaded as YOUR file
 * (api/captureToNote.ts), so deleting the message later leaves the note intact
 * and deleting the note takes only its own copy.
 *
 * Only PERSONAL lists are offered. A channel checklist is a shared note, and
 * writing a captured message into one would publish it to every member of that
 * channel — per-person sharing is deferred, and it is not going to arrive by
 * accident through this modal.
 *
 * And a note whose text or pictures this device cannot READ is not a target at
 * all: every write here REPLACES what is stored, so saving into one would seal
 * the captured line over content the user still has, somewhere, under a key
 * this device has not got yet. See `lockedFor`.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    attachmentRefsInMessage,
    captureTextFromMessage,
    captureTitle,
    copyRefsIntoMyNote,
    discardCopies,
} from '../api/captureToNote';
import { isUndecryptable } from '../api/decryptMarkers';
import { fetchListFeatures, createTaskListWithContent, setTaskListAttachments, setTaskListBody } from '../api/listContent';
import {
    type TaskAttachmentRef,
    type TaskList,
    MAX_TASK_ATTACHMENTS,
    createListTask,
    deleteTaskList,
    isAttachmentsLocked,
    listTaskLists,
    parseTaskAttachments,
} from '../api/tasks';
import { CloseIcon } from './Icons';
import './SaveToNoteModal.css';

interface SaveToNoteModalProps {
    /** Decrypted content of the message being kept. */
    content: string;
    onClose: () => void;
    /** Saved — the caller toasts and offers to open Notes. */
    onSaved: (noteTitle: string) => void;
}

type Shape = 'item' | 'text';

export function SaveToNoteModal({ content, onClose, onSaved }: SaveToNoteModalProps) {
    const [filter, setFilter] = useState('');
    const [lists, setLists] = useState<TaskList[] | null>(null);
    const [attachmentsSupported, setAttachmentsSupported] = useState(false);
    const [copyPictures, setCopyPictures] = useState(false);
    const [pick, setPick] = useState<'new' | number | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const text = useMemo(() => captureTextFromMessage(content), [content]);
    const refs = useMemo(() => attachmentRefsInMessage(content), [content]);
    /** What actually gets written: the prose, or the picture's name when the
     *  message was only a picture. */
    const body = useMemo(() => text || (refs[0]?.name ?? ''), [text, refs]);
    // A one-line message reads as an item; several lines are the note's text.
    const [shape, setShape] = useState<Shape>(() => (captureTextFromMessage(content).includes('\n') ? 'text' : 'item'));

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            const [ls, features] = await Promise.all([
                listTaskLists().catch(() => [] as TaskList[]),
                fetchListFeatures().catch(() => null),
            ]);
            if (cancelled) return;
            setLists(ls);
            setAttachmentsSupported(!!features?.attachments);
            setCopyPictures(!!features?.attachments);
        })();
        return () => { cancelled = true; };
    }, []);

    const q = filter.trim().toLowerCase();
    const rows = useMemo(() => (lists ?? [])
        // A title this device cannot read is not a target: it would be saved
        // into a note the user cannot identify.
        .filter(l => !isUndecryptable(l.title))
        .filter(l => !q || l.title.toLowerCase().includes(q)),
    [lists, q]);

    /**
     * Why this note cannot receive the capture, or null.
     *
     * Both reasons are one rule: a write must never seal over content this
     * device merely cannot READ. `isAttachmentsLocked` exists for the sidecar
     * ("Callers MUST refuse destructive attachment edits in this state",
     * api/tasks.ts) — but the note's TEXT is replaced wholesale by
     * `setTaskListBody`, so an unreadable body needs the same refusal:
     * appending to "" is not appending, it is overwriting, and the original
     * ciphertext would be gone on every device, for good.
     */
    const lockedFor = useCallback((l: TaskList): string | null => {
        if (copyPictures && refs.length > 0 && isAttachmentsLocked(l.attachments ?? null)) {
            return 'This note’s pictures can’t be read on this device yet';
        }
        if (shape === 'text' && body && isUndecryptable(l.body ?? '')) {
            return 'This note’s text can’t be read on this device yet';
        }
        return null;
    }, [copyPictures, refs, shape, body]);

    // A target picked while no reason applied must not survive the reason
    // ARRIVING — re-ticking "Also keep pictures", or switching to "As the
    // note's text". The row greys out on its own, but the PICK is state and
    // would otherwise outlive it, leaving Save live on a note it must not
    // touch. Derived rather than cleared in an effect: there is then no render
    // in which the two disagree, and unticking the box brings the pick back.
    const pickedList = typeof pick === 'number' ? (lists ?? []).find(l => l.id === pick) : undefined;
    const target = pickedList && lockedFor(pickedList) ? null : pick;

    /**
     * Every exit, while a save is in flight, does nothing.
     *
     * Closing does not CANCEL the request: the copies keep uploading and the
     * note keeps being written. So a backdrop click or the X while "Saving…"
     * is on screen would hide a save that then lands, the user would open the
     * sheet and save again, and the message would be kept twice — two notes,
     * two sets of uploaded copies against the same quota. Cancel was already
     * disabled; these two were not. `NotesDialog` shuts the same two doors
     * with `busy`.
     */
    const closeIfIdle = useCallback(() => { if (!saving) onClose(); }, [saving, onClose]);

    const save = async () => {
        if (target === null || saving) return;
        setSaving(true);
        setError(null);
        const wanted = copyPictures && attachmentsSupported ? refs : [];
        let copied: TaskAttachmentRef[] = [];
        let createdId: number | null = null;
        // A write into an EXISTING note that already landed. There is nothing
        // to undo — the item or the appended text is in a note the user keeps
        // — so the failure message must not say "nothing was kept", or the
        // obvious retry writes the same line a second time.
        let landedInExisting = false;
        let saved = '';
        try {
            // `target` is DERIVED past `lockedFor` (above), so by the time a
            // save runs the note is known readable — there is no render in
            // which the button is live over a locked row, and no await here
            // between the derivation and the write that could change it.
            const list = target === 'new' ? undefined : (lists ?? []).find(l => l.id === target);
            if (target !== 'new' && !list) throw new Error('That note isn’t in your list any more — pick another.');

            const existing = parseTaskAttachments(list?.attachments ?? null).length;
            if (existing + wanted.length > MAX_TASK_ATTACHMENTS) {
                throw new Error(`That note already holds ${existing} of ${MAX_TASK_ATTACHMENTS} pictures.`);
            }
            copied = wanted.length ? await copyRefsIntoMyNote(wanted, existing) : [];
            const title = captureTitle(body);
            if (target === 'new') {
                const created = await createTaskListWithContent(title, {
                    ...(shape === 'text' && body ? { body } : {}),
                    ...(copied.length ? { refs: copied } : {}),
                });
                createdId = created.id;
                if (shape === 'item' && body) await createListTask(created.id, body);
                saved = created.title;
            } else {
                if (shape === 'item' && body) {
                    await createListTask(target, body);
                    landedInExisting = true;
                } else if (body) {
                    const existingBody = list?.body ?? '';
                    await setTaskListBody(target, existingBody ? `${existingBody}\n\n${body}` : body);
                    landedInExisting = true;
                }
                if (copied.length) {
                    const keep = parseTaskAttachments(list?.attachments ?? null);
                    await setTaskListAttachments(target, [...keep, ...copied]);
                }
                saved = list?.title ?? 'your note';
            }
        } catch (err) {
            console.error('Failed to save to Notes:', err);
            // The copies are only safe to take back while NOTHING names them.
            // A note that was already created names them, so undo that first —
            // otherwise the rollback leaves a note in Notes with no text and
            // broken pictures, under a message that says nothing was kept.
            let orphaned = false;
            if (createdId !== null) {
                try { await deleteTaskList(createdId); } catch { orphaned = true; }
            }
            if (copied.length && !orphaned) await discardCopies(copied).catch(() => undefined);
            setError(orphaned
                ? 'The note was made, but the rest couldn’t be added — open Notes to finish it.'
                : landedInExisting
                    // The text is in the note; only the pictures are missing.
                    // Saying "nothing was kept" here would earn a retry that
                    // appends the same line twice.
                    ? 'The text was kept, but the pictures couldn’t be added — open Notes to finish it.'
                    : (err instanceof Error && err.message ? err.message : 'Couldn’t save it — nothing was kept.'));
            setSaving(false);
            return;
        }
        onSaved(saved);
        onClose();
    };

    return (
        <div className="save-note-overlay" onClick={closeIfIdle}>
            <div className="save-note-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Save to Notes">
                <button className="save-note-close" onClick={closeIfIdle} disabled={saving} title="Close" aria-label="Close"><CloseIcon size={18} /></button>
                <h2>Save to Notes</h2>
                {error && <div className="save-note-error" role="alert">{error}</div>}

                <div className="save-note-shape" role="group" aria-label="How to save it">
                    <button type="button" className={shape === 'item' ? 'active' : ''} disabled={saving} onClick={() => setShape('item')}>As an item</button>
                    <button type="button" className={shape === 'text' ? 'active' : ''} disabled={saving} onClick={() => setShape('text')}>As the note’s text</button>
                </div>

                {refs.length > 0 && (
                    attachmentsSupported ? (
                        <label className="save-note-check">
                            <input type="checkbox" checked={copyPictures} disabled={saving} onChange={e => setCopyPictures(e.target.checked)} />
                            <span>Also keep {refs.length} picture{refs.length === 1 ? '' : 's'} — a copy of your own, not a link</span>
                        </label>
                    ) : (
                        <p className="save-note-hint">This server can’t hold pictures in a note yet, so only the text is kept.</p>
                    )
                )}

                <input
                    type="text"
                    className="save-note-filter"
                    placeholder="Search your notes…"
                    aria-label="Search your notes"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                />

                <div className="save-note-list">
                    <button
                        type="button"
                        className={`save-note-row ${target === 'new' ? 'picked' : ''}`}
                        disabled={saving}
                        onClick={() => setPick('new')}
                    >
                        <span className="save-note-name">New note</span>
                    </button>
                    {rows.map(l => {
                        const locked = lockedFor(l);
                        return (
                            <button
                                key={l.id}
                                type="button"
                                className={`save-note-row ${target === l.id ? 'picked' : ''}`}
                                disabled={saving || !!locked}
                                title={locked ?? undefined}
                                onClick={() => setPick(l.id)}
                            >
                                <span className="save-note-name">{l.title}</span>
                            </button>
                        );
                    })}
                    {lists === null && <div className="save-note-empty">Loading…</div>}
                    {lists !== null && rows.length === 0 && q && <div className="save-note-empty">Nothing matches that.</div>}
                </div>

                <div className="save-note-actions">
                    <button type="button" className="save-note-cancel" onClick={closeIfIdle} disabled={saving}>Cancel</button>
                    <button type="button" className="save-note-go" disabled={target === null || saving} onClick={() => { void save(); }}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
