/**
 * "Take a note…" — Notes' composer. Collapsed it is one line; open it is a
 * title plus a growing list of items (Enter = next item). Closing with
 * content SAVES (Notes' behaviour): a personal list is created, then its
 * items in typed order. A note needs a title in Púca, so an untitled note
 * borrows its first item (deriveQuickTitle).
 *
 * Rendered inline on desktop; on a phone the FAB opens the same component
 * as a full-screen sheet (`sheet`), because the inline card is hidden there.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraIcon, CheckboxIcon, CloseIcon, FileTextIcon, ImageIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/Icons';
import { isEditableTarget } from '../../api/hotkeys';
import { pushMessageToast } from '../../components/messageToastBus';
import { MAX_TITLE_LENGTH, cleanQuickItems } from '../model/notesModel';
import { type NoteExtras } from '../model/useListContent';
import { type DrawingFiles } from '../../api/noteMedia';
import { filesFromTransfer, linesFromPaste, pasteAsOneLine } from '../model/noteContent';
import { DrawingCanvas } from './DrawingCanvas';
import { PastedLinesDialog } from './PastedLinesDialog';
import { hasTransferFiles, ONLY_PICTURES } from '../model/pasteDrop';
import '../noteContent.css';

/** A picture waiting in the composer, with its on-device preview URL. */
interface PendingPicture { key: number; url: string; photo?: File; drawing?: DrawingFiles }
let pictureSeq = 0;

interface QuickAddProps {
    /** Called with the typed title and items; resolves true once the note
     *  exists. On false the composer stays open with the draft intact — a
     *  failed save must never throw the typed text away. */
    onCreate: (title: string, items: string[], extra?: NoteExtras) => Promise<boolean>;
    /** What the server can store beyond a checklist (useListContent.ts):
     *  text notes, and photos/drawings. Absent = a checklist, as before. */
    content?: { text: boolean; pictures: boolean; camera?: boolean };
    /** Open immediately as a full-screen sheet (phone FAB). */
    sheet?: boolean;
    /** Sheet only: dismissed (after a save, or empty). */
    onDismiss?: () => void;
    /** A parent can force the composer open (the `c` shortcut). */
    openSignal?: number;
}

export function QuickAdd({ onCreate, sheet = false, onDismiss, openSignal = 0, content }: QuickAddProps) {
    const [open, setOpen] = useState(sheet);
    const [title, setTitle] = useState('');
    const [items, setItems] = useState<string[]>(['']);
    const [saving, setSaving] = useState(false);
    const [mode, setMode] = useState<'list' | 'text'>('list');
    const [body, setBody] = useState('');
    const [pictures, setPictures] = useState<PendingPicture[]>([]);
    const [drawingOpen, setDrawingOpen] = useState(false);
    const pickRef = useRef<HTMLInputElement>(null);
    const cameraRef = useRef<HTMLInputElement>(null);
    const picturesRef = useRef(pictures);
    useEffect(() => { picturesRef.current = pictures; });
    // Previews are object URLs of files on this device; free them on the way out.
    useEffect(() => () => { for (const p of picturesRef.current) URL.revokeObjectURL(p.url); }, []);
    const itemRefs = useRef<(HTMLInputElement | null)[]>([]);
    const rootRef = useRef<HTMLDivElement>(null);
    const focusItem = (i: number) => requestAnimationFrame(() => itemRefs.current[i]?.focus());

    useEffect(() => {
        if (openSignal > 0) { setOpen(true); focusItem(0); }
    }, [openSignal]);

    const reset = () => {
        setTitle(''); setItems(['']); setBody(''); setMode('list');
        for (const p of pictures) URL.revokeObjectURL(p.url);
        setPictures([]);
    };
    const extras = (): NoteExtras | undefined => {
        const photos = pictures.flatMap(p => (p.photo ? [p.photo] : []));
        const drawing = pictures.find(p => p.drawing)?.drawing;
        const text = mode === 'text' ? body : '';
        if (!text.trim() && photos.length === 0 && !drawing) return undefined;
        return { body: text.trim() ? text : undefined, photos, drawing };
    };
    const addPictures = (files: File[]) => {
        setPictures(prev => [...prev, ...files.map(f => ({ key: ++pictureSeq, url: URL.createObjectURL(f), photo: f }))]);
    };
    const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []).filter(f => f.type.startsWith('image/') || f.type === '');
        e.target.value = '';
        if (files.length > 0) addPictures(files);
    };
    const removePicture = (key: number) => setPictures(prev => {
        const gone = prev.find(p => p.key === key);
        if (gone) URL.revokeObjectURL(gone.url);
        return prev.filter(p => p.key !== key);
    });
    const hasDrawing = pictures.some(p => p.drawing);

    // --- Paste and drop ---------------------------------------------------------
    // Pictures go through addPictures, the SAME entry point the picker uses,
    // so they inherit its object-URL bookkeeping here and, at save, the
    // shrink-then-seal upload path. Nothing new touches the network.
    const [paste, setPaste] = useState<{ lines: string[]; text: string; at: number } | null>(null);
    const [dragging, setDragging] = useState(false);

    /** Pictures out of a paste or a drop; anything else is REPORTED, not
     *  dropped silently. */
    const takePictures = (dt: React.ClipboardEvent['clipboardData'] | React.DragEvent['dataTransfer'] | null): void => {
        const { images, others } = filesFromTransfer(dt);
        if (images.length > 0) addPictures(images);
        if (others.length > 0) pushMessageToast({ title: ONLY_PICTURES });
    };

    /** A paste anywhere in the composer: a picture is taken here. Multi-line
     *  TEXT is the item fields' business (onPasteItem) — this must not
     *  intercept a paste into the note's text, where lines are what is
     *  wanted. */
    const onPasteRoot = (e: React.ClipboardEvent) => {
        if (e.defaultPrevented) return;
        const { images } = filesFromTransfer(e.clipboardData);
        if (images.length === 0) return;
        e.preventDefault();
        addPictures(images);
    };

    /** A paste into an item field. More than one line asks first — items are
     *  removed one at a time, so a silent forty-item paste is unrecoverable. */
    const onPasteItem = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
        const { images } = filesFromTransfer(e.clipboardData);
        if (images.length > 0) return;          // the root handler takes it
        const text = e.clipboardData?.getData('text') ?? '';
        const lines = linesFromPaste(text);
        if (lines.length < 2) return;           // one line pastes as normal
        e.preventDefault();
        setPaste({ lines, text, at: i });
    };

    /** Put the pasted lines in at `at`: over that field when it is empty,
     *  after it when something is already typed there. */
    const applyPasteSeparate = () => {
        if (!paste) return;
        const { lines, at } = paste;
        setItems(prev => {
            const next = [...prev];
            const blank = (next[at] ?? '').trim() === '';
            next.splice(blank ? at : at + 1, blank ? 1 : 0, ...lines);
            return next;
        });
        setPaste(null);
        focusItem(at + lines.length);
    };
    const applyPasteOne = () => {
        if (!paste) return;
        const { text, at } = paste;
        const one = pasteAsOneLine(text).slice(0, 500);
        setItems(prev => prev.map((v, idx) => (idx === at ? (v.trim() === '' ? one : `${v}${one}`).slice(0, 500) : v)));
        setPaste(null);
        focusItem(at);
    };

    const close = async () => {
        const cleaned = mode === 'list' ? cleanQuickItems(items) : [];
        const extra = extras();
        if (title.trim() === '' && cleaned.length === 0 && !extra) {
            reset();
            setOpen(!sheet && false);
            onDismiss?.();
            return;
        }
        if (saving) return;
        setSaving(true);
        let ok = false;
        try {
            ok = await onCreate(title, mode === 'list' ? items : [], extra);
        } finally {
            setSaving(false);
        }
        if (!ok) return;   // the owner has toasted why; the draft stays
        reset();
        setOpen(false);
        onDismiss?.();
    };

    const discard = () => {
        if ((pictures.length > 0 || body.trim()) && !window.confirm('Discard this note?')) return;
        reset(); setOpen(false); onDismiss?.();
    };

    // Click outside (desktop inline card) saves, like Notes.
    useEffect(() => {
        if (!open || sheet) return;
        const onDown = (e: PointerEvent) => {
            // The drawing editor and the paste confirmation are portaled
            // outside this card: a click in either is not a click "outside".
            if (drawingOpen || paste) return;
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) void close();
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
        // close() reads live state through closures each render; re-binding per render is intended.
    });

    const onKeyItem = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            setItems(prev => {
                const next = [...prev];
                next.splice(i + 1, 0, '');
                return next;
            });
            focusItem(i + 1);
        } else if (e.key === 'Backspace' && items[i] === '' && items.length > 1) {
            e.preventDefault();
            setItems(prev => prev.filter((_, idx) => idx !== i));
            focusItem(Math.max(0, i - 1));
        } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            void close();
        }
    };

    if (!open) {
        return (
            <div className="notes-quickadd" ref={rootRef}>
                <button
                    type="button"
                    className="notes-quickadd-collapsed"
                    onClick={() => { setOpen(true); focusItem(0); }}
                    aria-label="Take a note"
                >
                    Take a note…
                    <CheckboxIcon />
                </button>
            </div>
        );
    }

    const composer = (
        <div
            className={`notes-quickadd ${sheet ? 'sheet' : ''} ${dragging ? 'dropping' : ''}`}
            ref={rootRef}
            role="dialog"
            aria-label="New note"
            onPaste={onPasteRoot}
            onDragOver={e => {
                // Only a drag carrying FILES: a text selection or an internal
                // drag must keep its own default handling.
                if (!hasTransferFiles(e.dataTransfer)) return;
                e.preventDefault();
                if (!dragging) setDragging(true);
            }}
            onDragLeave={e => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setDragging(false);
            }}
            onDrop={e => {
                if (!hasTransferFiles(e.dataTransfer)) return;
                e.preventDefault();
                setDragging(false);
                takePictures(e.dataTransfer);
            }}
        >
            <div className="notes-quickadd-open">
                <input
                    className="notes-quickadd-title"
                    placeholder="Title"
                    value={title}
                    maxLength={MAX_TITLE_LENGTH}
                    onChange={e => setTitle(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') { e.preventDefault(); focusItem(0); }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void close(); }
                    }}
                    autoFocus={sheet}
                    aria-label="Title"
                />
                {pictures.length > 0 && (
                    <div className="notes-quickadd-media">
                        {pictures.map(p => (
                            <figure key={p.key}>
                                <img src={p.url} alt={p.drawing ? 'Drawing' : (p.photo?.name ?? 'Photo')} />
                                <button type="button" className="ni-tool" aria-label="Remove picture" title="Remove" onClick={() => removePicture(p.key)}>
                                    <CloseIcon size={14} />
                                </button>
                            </figure>
                        ))}
                    </div>
                )}
                {mode === 'text' && (
                    <textarea
                        className="notes-quickadd-body"
                        placeholder="Take a note…"
                        value={body}
                        onChange={e => setBody(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void close(); } }}
                        aria-label="Note text"
                        autoFocus={!sheet}
                    />
                )}
                {mode === 'list' && items.map((it, i) => (
                    <div className="notes-quickadd-item" key={i}>
                        <CheckboxIcon />
                        <input
                            ref={el => { itemRefs.current[i] = el; }}
                            value={it}
                            placeholder={i === 0 ? 'List item' : ''}
                            maxLength={500}
                            onChange={e => setItems(prev => prev.map((v, idx) => (idx === i ? e.target.value : v)))}
                            onKeyDown={e => onKeyItem(i, e)}
                            onPaste={e => onPasteItem(i, e)}
                            aria-label={`Item ${i + 1}`}
                        />
                        {items.length > 1 && (
                            <button
                                type="button"
                                className="notes-iconbtn small"
                                aria-label="Remove item"
                                title="Remove"
                                onClick={() => setItems(prev => prev.filter((_, idx) => idx !== i))}
                            >
                                <CloseIcon size={14} />
                            </button>
                        )}
                    </div>
                ))}
                <div className="notes-quickadd-foot">
                    {mode === 'list' && (
                        <button type="button" className="notes-iconbtn small" aria-label="Add item" title="Add item"
                            onClick={() => { setItems(prev => [...prev, '']); focusItem(items.length); }}>
                            <PlusIcon />
                        </button>
                    )}
                    {content?.text && (
                        mode === 'list' ? (
                            <button type="button" className="notes-iconbtn small" aria-label="Text note" title="Write text instead of a list"
                                onClick={() => {
                                    // The typed items become the text's lines, so switching loses nothing.
                                    const lines = cleanQuickItems(items);
                                    if (lines.length > 0) setBody(b => [b, ...lines].filter(Boolean).join('\n'));
                                    setItems(['']);
                                    setMode('text');
                                }}>
                                <FileTextIcon />
                            </button>
                        ) : (
                            <button type="button" className="notes-iconbtn small" aria-label="Checklist" title="Make it a checklist"
                                onClick={() => {
                                    const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
                                    setItems(lines.length > 0 ? lines : ['']);
                                    setBody('');
                                    setMode('list');
                                }}>
                                <CheckboxIcon />
                            </button>
                        )
                    )}
                    {content?.pictures && (
                        <>
                            <button type="button" className="notes-iconbtn small" aria-label="Add photo" title="Add photo" onClick={() => pickRef.current?.click()}>
                                <ImageIcon />
                            </button>
                            <input ref={pickRef} type="file" accept="image/*" multiple onChange={onPicked} />
                            {content.camera && (
                                <>
                                    <button type="button" className="notes-iconbtn small" aria-label="Take photo" title="Take photo" onClick={() => cameraRef.current?.click()}>
                                        <CameraIcon />
                                    </button>
                                    <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={onPicked} />
                                </>
                            )}
                            {!hasDrawing && (
                                <button type="button" className="notes-iconbtn small" aria-label="Draw" title="Draw" onClick={() => setDrawingOpen(true)}>
                                    <PencilIcon />
                                </button>
                            )}
                        </>
                    )}
                    <button type="button" className="notes-iconbtn small" aria-label="Discard note" title="Discard" onClick={discard}>
                        <TrashIcon />
                    </button>
                    <button type="button" className="notes-textbtn" onClick={() => void close()} disabled={saving}>
                        {saving ? 'Saving…' : 'Done'}
                    </button>
                </div>
            </div>
            {paste && (
                <PastedLinesDialog
                    lines={paste.lines}
                    onAddSeparate={applyPasteSeparate}
                    onAddOne={applyPasteOne}
                    onCancel={() => { setPaste(null); focusItem(paste.at); }}
                />
            )}
            {drawingOpen && (
                <DrawingCanvas
                    onCancel={() => setDrawingOpen(false)}
                    onSave={async files => {
                        setPictures(prev => [...prev, { key: ++pictureSeq, url: URL.createObjectURL(files.png), drawing: files }]);
                        setDrawingOpen(false);
                        return true;
                    }}
                />
            )}
        </div>
    );

    if (!sheet) return composer;
    return createPortal(
        <div
            className="notes-editor-backdrop"
            onClick={e => { if (e.target === e.currentTarget && !isEditableTarget(document.activeElement)) void close(); }}
        >
            <div className="notes-editor notes-quickadd-sheet">{composer}</div>
        </div>,
        document.body,
    );
}
