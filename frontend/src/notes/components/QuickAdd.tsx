/**
 * "Take a note…" — Notes' composer. Collapsed it is one line; open it is a
 * title plus a growing list of items (Enter = next item). Closing with
 * content SAVES (Notes' behaviour): a personal list is created, then its
 * items in typed order. A note needs a title in Púca, so an untitled note
 * borrows its first item (deriveQuickTitle).
 *
 * Rendered inline on desktop; on a phone the FAB opens the same component
 * as a full-screen sheet (`sheet`), because the inline card is hidden there.
 *
 * A VOICE NOTE kept here is written down the same way an open note's is
 * (notes/model/transcribe.ts: this phone's on-device recogniser or an honest
 * refusal, never the network), and the words go into the note's TEXT —
 * without them the note is titled "Voice note" with an empty body and search,
 * which reads text and never attachment names, can never find it again. The
 * transcript starts at *Keep* rather than at *Done*, so it is usually ready
 * by the time the note is saved; Done waits for it if it is not.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraIcon, CheckboxIcon, CloseIcon, FileTextIcon, ImageIcon, MicIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/Icons';
import { isEditableTarget } from '../../api/hotkeys';
import { MAX_TITLE_LENGTH, cleanQuickItems } from '../model/notesModel';
import { type NoteExtras } from '../model/useListContent';
import { type DrawingFiles } from '../../api/noteMedia';
import { MAX_BODY_BYTES, bodyBytes } from '../../api/listContent';
import { pushMessageToast } from '../../components/messageToastBus';
import { DrawingCanvas } from './DrawingCanvas';
import { AudioRecorder, type RecordedClip } from './AudioRecorder';
import { appendTranscript, canRecordAudio } from '../model/audioNote';
import { transcribeClip } from '../model/transcribe';
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
    const [clip, setClip] = useState<RecordedClip | null>(null);
    const [recorderOpen, setRecorderOpen] = useState(false);
    /** Why the take was not written down (an honest sentence), or null. */
    const [clipNotice, setClipNotice] = useState<string | null>(null);
    const [transcribing, setTranscribing] = useState(false);
    /** What the phone heard, and the job still hearing it. Refs, not state:
     *  `close()` reads both AFTER awaiting, when a captured state value would
     *  be the one from the render that started the save. */
    const transcriptRef = useRef<string | null>(null);
    const transcribeJob = useRef<Promise<void> | null>(null);
    /** Bumped whenever the take is replaced or removed, so a transcript that
     *  arrives late cannot attach itself to a different recording. */
    const clipToken = useRef(0);
    const clipRef = useRef<RecordedClip | null>(null);
    useEffect(() => { clipRef.current = clip; });
    // The recorded take is an object URL of a file on this device.
    useEffect(() => () => { if (clipRef.current) URL.revokeObjectURL(clipRef.current.url); }, []);
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

    /** Drop the take and everything that belongs to it. */
    const dropClip = () => {
        clipToken.current++;
        transcriptRef.current = null;
        transcribeJob.current = null;
        setClipNotice(null);
        setTranscribing(false);
        if (clipRef.current) URL.revokeObjectURL(clipRef.current.url);
        setClip(null);
    };
    /** Write the take down ON THIS DEVICE, or say why not. Skipped when the
     *  server cannot hold a note's text at all: there would be nowhere to put
     *  the words, and the clip is saved either way. */
    const startTranscribe = (take: RecordedClip) => {
        if (!content?.text) return;
        const token = clipToken.current;
        setTranscribing(true);
        setClipNotice(null);
        transcribeJob.current = (async () => {
            try {
                const r = await transcribeClip(take.file, take.durationMs);
                if (clipToken.current !== token) return;
                if (r.text) transcriptRef.current = r.text;
                else setClipNotice(r.reason);
            } catch (err) {
                console.error('[notes] transcribing failed:', err);
                if (clipToken.current === token) setClipNotice('The recording is saved, but this device couldn’t write it down.');
            } finally {
                if (clipToken.current === token) setTranscribing(false);
            }
        })();
    };
    const reset = () => {
        setTitle(''); setItems(['']); setBody(''); setMode('list');
        for (const p of pictures) URL.revokeObjectURL(p.url);
        setPictures([]);
        dropClip();
    };
    /** Anything worth saving, transcript aside (a transcript only exists when
     *  a recording does, and a recording is content on its own). */
    const hasContent = () => pictures.length > 0 || !!clip || (mode === 'text' && body.trim() !== '');
    const extras = (): NoteExtras | undefined => {
        const photos = pictures.flatMap(p => (p.photo ? [p.photo] : []));
        const drawing = pictures.find(p => p.drawing)?.drawing;
        const typed = mode === 'text' ? body.trim() : '';
        const audio = clip ? [clip.file] : [];
        let text = typed;
        const heard = transcriptRef.current;
        if (heard) {
            const joined = appendTranscript(typed, heard, MAX_BODY_BYTES, bodyBytes);
            // Refused rather than clipped: the user's own words stay whole.
            if (joined === null) pushMessageToast({ title: 'There was no room in this note’s text for what was said — the recording is saved.' });
            else text = joined;
        }
        if (text === '' && photos.length === 0 && !drawing && audio.length === 0) return undefined;
        return { body: text || undefined, photos, drawing, audio };
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

    const close = async () => {
        if (saving) return;
        const cleaned = mode === 'list' ? cleanQuickItems(items) : [];
        if (title.trim() === '' && cleaned.length === 0 && !hasContent()) {
            reset();
            setOpen(!sheet && false);
            onDismiss?.();
            return;
        }
        setSaving(true);
        let ok = false;
        try {
            // What the phone is still writing down belongs IN this note, so
            // the save waits for it rather than racing it into a second
            // write. Bounded: transcribe.ts gives up on its own.
            if (transcribeJob.current) {
                try { await transcribeJob.current; } catch { /* the job answers, it never rejects */ }
            }
            ok = await onCreate(title, mode === 'list' ? items : [], extras());
        } finally {
            setSaving(false);
        }
        if (!ok) return;   // the owner has toasted why; the draft stays
        reset();
        setOpen(false);
        onDismiss?.();
    };

    const discard = () => {
        if ((pictures.length > 0 || clip || body.trim()) && !window.confirm('Discard this note?')) return;
        reset(); setOpen(false); onDismiss?.();
    };

    // Click outside (desktop inline card) saves, like Notes.
    useEffect(() => {
        if (!open || sheet) return;
        const onDown = (e: PointerEvent) => {
            // The drawing editor and the recorder are portaled outside this
            // card, so a click inside either reads as "outside" and would
            // save-and-close the composer under them.
            if (drawingOpen || recorderOpen) return;
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
        <div className={`notes-quickadd ${sheet ? 'sheet' : ''}`} ref={rootRef} role="dialog" aria-label="New note">
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
                {(pictures.length > 0 || clip) && (
                    <div className="notes-quickadd-media">
                        {clip && (
                            <figure className="qa-clip">
                                <audio src={clip.url} controls preload="metadata" aria-label="Recording preview" />
                                <button type="button" className="ni-tool" aria-label="Remove recording" title="Remove"
                                    onClick={dropClip}>
                                    <CloseIcon size={14} />
                                </button>
                            </figure>
                        )}
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
                {(transcribing || clipNotice) && (
                    <p className="notes-transcribe-notice" role="status">
                        {transcribing ? 'Writing down what you said, on this device…' : clipNotice}
                    </p>
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
                            {!clip && canRecordAudio() && (
                                <button type="button" className="notes-iconbtn small" aria-label="Voice note" title="Voice note" onClick={() => setRecorderOpen(true)}>
                                    <MicIcon />
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
            {recorderOpen && (
                <AudioRecorder
                    onCancel={() => setRecorderOpen(false)}
                    onSave={next => {
                        dropClip();               // a second take replaces the first, transcript and all
                        setClip(next);
                        setRecorderOpen(false);
                        startTranscribe(next);
                        return true;
                    }}
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
