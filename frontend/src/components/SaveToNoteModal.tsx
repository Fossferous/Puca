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
 */
import { useEffect, useMemo, useState } from 'react';
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
    const [target, setTarget] = useState<'new' | number | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const text = useMemo(() => captureTextFromMessage(content), [content]);
    const refs = useMemo(() => attachmentRefsInMessage(content), [content]);
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

    /** Writing over a sidecar this device cannot read would orphan the refs
     *  already in it — the rule useListContent enforces on every other write. */
    const lockedFor = (l: TaskList) => copyPictures && refs.length > 0 && isAttachmentsLocked(l.attachments ?? null);

    const save = async () => {
        if (target === null || saving) return;
        setSaving(true);
        setError(null);
        const wanted = copyPictures && attachmentsSupported ? refs : [];
        let copied: TaskAttachmentRef[] = [];
        try {
            const existing = target === 'new'
                ? 0
                : parseTaskAttachments((lists ?? []).find(l => l.id === target)?.attachments ?? null).length;
            if (existing + wanted.length > MAX_TASK_ATTACHMENTS) {
                throw new Error(`That note already holds ${existing} of ${MAX_TASK_ATTACHMENTS} pictures.`);
            }
            copied = wanted.length ? await copyRefsIntoMyNote(wanted, existing) : [];
            const body = text || (refs[0]?.name ?? '');
            const title = captureTitle(body);
            if (target === 'new') {
                const created = await createTaskListWithContent(title, {
                    ...(shape === 'text' && body ? { body } : {}),
                    ...(copied.length ? { refs: copied } : {}),
                });
                if (shape === 'item' && body) await createListTask(created.id, body);
                onSaved(created.title);
            } else {
                const list = (lists ?? []).find(l => l.id === target);
                if (shape === 'item' && body) {
                    await createListTask(target, body);
                } else if (body) {
                    const existingBody = list && !isUndecryptable(list.body ?? '') ? (list.body ?? '') : '';
                    await setTaskListBody(target, existingBody ? `${existingBody}\n\n${body}` : body);
                }
                if (copied.length) {
                    const keep = parseTaskAttachments(list?.attachments ?? null);
                    await setTaskListAttachments(target, [...keep, ...copied]);
                }
                onSaved(list?.title ?? 'your note');
            }
            onClose();
        } catch (err) {
            console.error('Failed to save to Notes:', err);
            // Files that already landed belong to nothing now — take them back
            // before telling the user it failed.
            if (copied.length) await discardCopies(copied).catch(() => undefined);
            setError(err instanceof Error && err.message ? err.message : 'Couldn’t save it — nothing was kept.');
            setSaving(false);
        }
    };

    return (
        <div className="save-note-overlay" onClick={onClose}>
            <div className="save-note-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Save to Notes">
                <button className="save-note-close" onClick={onClose} title="Close" aria-label="Close"><CloseIcon size={18} /></button>
                <h2>Save to Notes</h2>
                {error && <div className="save-note-error" role="alert">{error}</div>}

                <div className="save-note-shape" role="group" aria-label="How to save it">
                    <button type="button" className={shape === 'item' ? 'active' : ''} onClick={() => setShape('item')}>As an item</button>
                    <button type="button" className={shape === 'text' ? 'active' : ''} onClick={() => setShape('text')}>As the note’s text</button>
                </div>

                {refs.length > 0 && (
                    attachmentsSupported ? (
                        <label className="save-note-check">
                            <input type="checkbox" checked={copyPictures} onChange={e => setCopyPictures(e.target.checked)} />
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
                        onClick={() => setTarget('new')}
                    >
                        <span className="save-note-name">New note</span>
                    </button>
                    {rows.map(l => (
                        <button
                            key={l.id}
                            type="button"
                            className={`save-note-row ${target === l.id ? 'picked' : ''}`}
                            disabled={saving || lockedFor(l)}
                            title={lockedFor(l) ? 'This note’s pictures can’t be read on this device yet' : undefined}
                            onClick={() => setTarget(l.id)}
                        >
                            <span className="save-note-name">{l.title}</span>
                        </button>
                    ))}
                    {lists === null && <div className="save-note-empty">Loading…</div>}
                    {lists !== null && rows.length === 0 && q && <div className="save-note-empty">Nothing matches that.</div>}
                </div>

                <div className="save-note-actions">
                    <button type="button" className="save-note-cancel" onClick={onClose} disabled={saving}>Cancel</button>
                    <button type="button" className="save-note-go" disabled={target === null || saving} onClick={() => { void save(); }}>
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
}
