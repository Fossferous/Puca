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
 * by the time the note is saved; Done waits for it if it is not. That wait is
 * real seconds with the composer still live underneath it, so the save reads
 * the draft as it stands when the wait ENDS — a title typed meanwhile is in
 * the note, and Discard pressed meanwhile cancels the save instead of being
 * overtaken by it.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraIcon, CheckboxIcon, CloseIcon, FileTextIcon, ImageIcon, MicIcon, PaperclipIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/Icons';
import { isEditableTarget } from '../../api/hotkeys';
import { MAX_ITEM_LENGTH, MAX_TITLE_LENGTH, cleanQuickItems } from '../model/notesModel';
import { composeModeFor, type ComposeIntent } from '../model/composeIntent';
import { type NoteExtras } from '../model/useListContent';
import { type DrawingFiles } from '../../api/noteMedia';
import { filesFromTransfer, isTextPaste, linesFromPaste, pasteAsOneLine } from '../model/noteContent';
import { DrawingCanvas } from '../../components/DrawingCanvas';
import { PastedLinesDialog } from './PastedLinesDialog';
import { hasTransferFiles, ONLY_PICTURES } from '../model/pasteDrop';
import { MAX_BODY_BYTES, bodyBytes } from '../../api/listContent';
import { pushMessageToast } from '../../components/messageToastBus';
import { AudioRecorder, type RecordedClip } from './AudioRecorder';
import { appendTranscript, canRecordAudio } from '../model/audioNote';
import { transcribeClip } from '../model/transcribe';
import '../../components/NoteImages.css';
import '../noteContent.css';

/**
 * Something waiting in the composer. A picture carries an on-device preview
 * URL; anything else — a PDF, a spreadsheet — carries none, because it has
 * no preview: rendering it as an <img> would show a broken image, and giving
 * it a live blob: URL would be the security hole api/saveAttachment.ts
 * exists to avoid. It shows as a named chip until it is saved.
 */
interface PendingPicture { key: number; url: string | null; photo?: File; drawing?: DrawingFiles }
let pictureSeq = 0;

const isImageFile = (f: File | undefined) => !!f && f.type.startsWith('image/');

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
    /**
     * Open pre-filled, from outside the page: a launcher shortcut, the
     * quick-settings tile, the home-screen widget, or a share from another
     * app. Re-seeds whenever `seq` changes, so the same request twice still
     * re-opens. It NEVER saves — the user presses Done, which is what keeps
     * a share from another app out of the account on its own.
     */
    initial?: ComposeIntent | null;
    /** Called once this composer has taken `initial`, so the owner can clear
     *  it. Without this the OTHER mount of QuickAdd (the phone renders both
     *  the inline card and the sheet; the inline one is only hidden by CSS)
     *  seeds itself from the same payload the moment the sheet closes — and
     *  the inline composer SAVES on a click outside, so the shared note was
     *  created twice. Found by the walk. */
    onInitialUsed?: () => void;
}

export function QuickAdd({ onCreate, sheet = false, onDismiss, openSignal = 0, content, initial = null, onInitialUsed }: QuickAddProps) {
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
    const fileRef = useRef<HTMLInputElement>(null);
    const cameraRef = useRef<HTMLInputElement>(null);
    const picturesRef = useRef(pictures);
    useEffect(() => { picturesRef.current = pictures; });
    // Previews are object URLs of files on this device; free them on the way out.
    useEffect(() => () => { for (const p of picturesRef.current) if (p.url) URL.revokeObjectURL(p.url); }, []);
    const itemRefs = useRef<(HTMLInputElement | null)[]>([]);
    const rootRef = useRef<HTMLDivElement>(null);
    const cameraBtnRef = useRef<HTMLButtonElement>(null);
    /** The draft as the LAST render had it. `close()` waits for the phone to
     *  finish writing a recording down before it creates the note, and a value
     *  captured in the Done click's closure would be the one from before that
     *  wait — so a title typed, an item added or a picture attached while
     *  "Writing down what you said…" was on the screen would be read from a
     *  dead render and silently dropped. Assigned during render rather than in
     *  an effect, so it can never be a beat behind what is on the screen. */
    const live = useRef({ title, items, mode, body, pictures, clip });
    live.current = { title, items, mode, body, pictures, clip };
    /** Bumped by anything that means "this draft is no longer being saved":
     *  Discard pressed while a save is waiting must not create the note. */
    const closeToken = useRef(0);
    const focusItem = (i: number) => requestAnimationFrame(() => itemRefs.current[i]?.focus());

    useEffect(() => {
        if (openSignal > 0) { setOpen(true); focusItem(0); }
    }, [openSignal]);

    // A shortcut, the tile, the widget or a share: open, seeded, on every new
    // `seq`. A mode this server cannot store degrades to a checklist rather
    // than rendering a control that does nothing (composeModeFor).
    const seededSeq = useRef(-1);
    useEffect(() => {
        if (!initial || initial.seq === seededSeq.current) return;
        seededSeq.current = initial.seq;
        const want = composeModeFor(initial.mode, content);
        setOpen(true);
        setMode(want === 'text' ? 'text' : 'list');
        if (initial.title !== undefined) setTitle(initial.title.slice(0, MAX_TITLE_LENGTH));
        if (initial.body !== undefined) {
            // Shared text belongs in a body; on a server with no body field
            // its lines become the checklist, which is where they would go
            // if the user had pasted them.
            if (want === 'text') setBody(initial.body);
            else {
                const lines = initial.body.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 200);
                setItems(lines.length > 0 ? lines : ['']);
            }
        }
        if (initial.files?.length) addPictures(initial.files);
        setDrawingOpen(want === 'draw');
        // The camera cannot be opened for the user: a programmatic click on a
        // file input needs a user activation, and a launch is not one. The
        // button is focused instead, so it is one tap away and never dead.
        if (want === 'photo') requestAnimationFrame(() => cameraBtnRef.current?.focus());
        else if (want !== 'draw') focusItem(0);
        onInitialUsed?.();
        // `content` is read, not depended on: a server-features refetch must
        // not re-seed a composer the user is already typing in.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initial]);

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
        // live, not the closure: reset() also runs after an await, and a
        // picture added during that wait has a URL of its own to free.
        for (const p of live.current.pictures) if (p.url) URL.revokeObjectURL(p.url);
        setPictures([]);
        dropClip();
    };
    /** Anything worth saving, transcript aside (a transcript only exists when
     *  a recording does, and a recording is content on its own). */
    const hasContent = (from = live.current) => from.pictures.length > 0 || !!from.clip || (from.mode === 'text' && from.body.trim() !== '');
    const extras = (from = live.current): NoteExtras | undefined => {
        // A pick is split by kind: a picture is shrunk before it is sealed, a
        // PDF or a spreadsheet is not (api/noteMedia.ts).
        const picked = from.pictures.flatMap(p => (p.photo ? [p.photo] : []));
        const photos = picked.filter(isImageFile);
        const files = picked.filter(f => !isImageFile(f));
        const drawing = from.pictures.find(p => p.drawing)?.drawing;
        const typed = from.mode === 'text' ? from.body.trim() : '';
        const audio = from.clip ? [from.clip.file] : [];
        let text = typed;
        const heard = transcriptRef.current;
        if (heard) {
            const joined = appendTranscript(typed, heard, MAX_BODY_BYTES, bodyBytes);
            // Refused rather than clipped: the user's own words stay whole.
            if (joined === null) pushMessageToast({ title: 'There was no room in this note’s text for what was said — the recording is saved.' });
            else text = joined;
        }
        if (text === '' && picked.length === 0 && !drawing && audio.length === 0) return undefined;
        return { body: text || undefined, photos, files, drawing, audio };
    };
    // No MIME filter: a note holds any file. Only an image gets a preview URL.
    const addPictures = (files: File[]) => {
        setPictures(prev => [...prev, ...files.map(f => ({
            key: ++pictureSeq,
            url: isImageFile(f) ? URL.createObjectURL(f) : null,
            photo: f,
        }))]);
    };
    const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length > 0) addPictures(files);
    };
    const removePicture = (key: number) => setPictures(prev => {
        const gone = prev.find(p => p.key === key);
        if (gone?.url) URL.revokeObjectURL(gone.url);
        return prev.filter(p => p.key !== key);
    });
    const hasDrawing = pictures.some(p => p.drawing);

    /** The draft as it stands at this instant — what a save would create. */
    const draftNow = () => {
        const from = live.current;
        const raw = from.mode === 'list' ? from.items : [];
        return { from, raw, empty: from.title.trim() === '' && cleanQuickItems(raw).length === 0 && !hasContent(from) };
    };

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
     *  wanted. A paste that carries text is text, whatever picture Chromium
     *  put beside it (isTextPaste). */
    const onPasteRoot = (e: React.ClipboardEvent) => {
        if (e.defaultPrevented) return;
        if (isTextPaste(e.clipboardData)) return;
        const { images } = filesFromTransfer(e.clipboardData);
        if (images.length === 0) return;
        e.preventDefault();
        addPictures(images);
    };

    /** A paste into an item field. More than one line asks first — items are
     *  removed one at a time, so a silent forty-item paste is unrecoverable. */
    const onPasteItem = (i: number, e: React.ClipboardEvent<HTMLInputElement>) => {
        const text = e.clipboardData?.getData('text') ?? '';
        // A picture goes to the root handler — but only when the root handler
        // will actually take it, which it does not for a text paste.
        if (!isTextPaste(e.clipboardData) && filesFromTransfer(e.clipboardData).images.length > 0) return;
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
            // Truncated like every other route into an item: the field below
            // refuses a 600th character by typing, so a paste must not slip
            // one in behind it.
            next.splice(blank ? at : at + 1, blank ? 1 : 0, ...lines.map(l => l.slice(0, MAX_ITEM_LENGTH)));
            return next;
        });
        setPaste(null);
        focusItem(at + lines.length);
    };
    const applyPasteOne = () => {
        if (!paste) return;
        const { text, at } = paste;
        const one = pasteAsOneLine(text).slice(0, MAX_ITEM_LENGTH);
        setItems(prev => prev.map((v, idx) => (idx === at ? (v.trim() === '' ? one : `${v}${one}`).slice(0, MAX_ITEM_LENGTH) : v)));
        setPaste(null);
        focusItem(at);
    };

    const close = async () => {
        if (saving) return;
        const dismiss = () => {
            reset();
            setOpen(!sheet && false);
            onDismiss?.();
        };
        if (draftNow().empty) { dismiss(); return; }
        setSaving(true);
        const token = ++closeToken.current;
        let ok = false;
        try {
            // What the phone is still writing down belongs IN this note, so
            // the save waits for it rather than racing it into a second
            // write. Bounded: transcribe.ts gives up on its own.
            if (transcribeJob.current) {
                try { await transcribeJob.current; } catch { /* the job answers, it never rejects */ }
            }
            // Everything below reads the draft AFTER that wait, which can be
            // seconds long and which nothing about the composer freezes.
            // Discard pressed in it means this save is cancelled: the draft is
            // already gone, and creating the note now would bring back the
            // very recording the user just threw away.
            if (closeToken.current !== token) return;
            const d = draftNow();
            if (d.empty) { dismiss(); return; }   // emptied while we waited
            ok = await onCreate(d.from.title, d.raw, extras(d.from));
        } finally {
            setSaving(false);
        }
        if (!ok) return;   // the owner has toasted why; the draft stays
        // Discarded while the note was being created: whatever is on the
        // screen now belongs to the next note, so leave it alone.
        if (closeToken.current !== token) return;
        reset();
        setOpen(false);
        onDismiss?.();
    };

    const discard = () => {
        if ((pictures.length > 0 || clip || body.trim()) && !window.confirm('Discard this note?')) return;
        // A save still waiting for the transcript is off, and the composer
        // must stop claiming to be saving a note that no longer exists.
        closeToken.current++;
        setSaving(false);
        reset(); setOpen(false); onDismiss?.();
    };

    // Click outside (desktop inline card) saves, like Notes.
    useEffect(() => {
        if (!open || sheet) return;
        const onDown = (e: PointerEvent) => {
            // The drawing editor, the recorder and the paste confirmation are
            // portaled outside this card, so a click inside any of them reads
            // as "outside" and would save-and-close the composer under them.
            if (drawingOpen || recorderOpen || paste) return;
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
                                {p.url
                                    ? <img src={p.url} alt={p.drawing ? 'Drawing' : (p.photo?.name ?? 'Photo')} />
                                    : <span className="ni-file"><PaperclipIcon /><span className="ni-file-name">{p.photo?.name ?? 'File'}</span></span>}
                                <button type="button" className="ni-tool" aria-label={p.url ? 'Remove picture' : 'Remove file'} title="Remove" onClick={() => removePicture(p.key)}>
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
                            maxLength={MAX_ITEM_LENGTH}
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
                            <button type="button" className="notes-iconbtn small" aria-label="Add file" title="Add file" onClick={() => fileRef.current?.click()}>
                                <PaperclipIcon />
                            </button>
                            <input ref={fileRef} type="file" multiple onChange={onPicked} data-testid="qa-pick-file" />
                            {content.camera && (
                                <>
                                    <button ref={cameraBtnRef} type="button" className="notes-iconbtn small" aria-label="Take photo" title="Take photo" onClick={() => cameraRef.current?.click()}>
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
