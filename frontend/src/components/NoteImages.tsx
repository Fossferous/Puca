/**
 * A note's own attachments — photos, drawings, voice notes and any other
 * FILE, stored in the personal list's sealed attachments sidecar
 * (api/listContent.ts, api/noteMedia.ts). Shared by Púca Notes' editor and
 * Púca's Tasks view, so a note shows the same things through both front
 * doors.
 *
 * A NON-PICTURE IS A DOWNLOAD BUTTON, never a link, and never an inline
 * preview. `safeBlobType` (api/attachments.ts) reduces a PDF to opaque bytes
 * on purpose: a `blob:` document inherits this app's origin and its MIME
 * comes from the ref, so an in-origin document could read the stored token
 * and the E2EE key material. Saving it to disk is the whole affordance, and
 * the button mirrors TaskAttachments.tsx, which has had it all along while a
 * note's own gallery rendered a dead <span> nobody could act on. A RECORDING
 * is the exception that proves the rule: audio is a type the blob URL may
 * keep, so it gets a real player — and one that never plays by itself.
 *
 * Every picture and every recording is decrypted on this device
 * (decryptToBlobUrl); the server only ever holds ciphertext. A voice note
 * gets a real player with controls and NEVER autoplays: sound on this device
 * happens only because someone pressed play. A LOCKED sidecar (the identity is locked, the
 * value is not an envelope) renders a lock line and offers no edits: writing
 * over refs this device cannot read would orphan them for good.
 *
 * A picture added with no connection has NOT been uploaded yet: its ref is a
 * local `puca-parked:` one and its plaintext comes from this device's own
 * sealed copy (api/parkedPreview.ts). It is marked "Not sent yet", so nobody
 * is told a photo is safe elsewhere while it is only here.
 *
 * Touch: every control is a visible button with a label (no hover-only
 * tools), and on phones a second picker opens the camera directly
 * (`capture`), the first the photo library.
 */
import { useEffect, useRef, useState } from 'react';
import { type TaskAttachmentRef, isAttachmentsLocked } from '../api/tasks';
import { decryptToBlobUrl, parseEncAttachment } from '../api/attachments';
import { type GalleryItem, galleryItemNoun, galleryItems } from '../api/noteMedia';
import { isParkedRef, parseParkedRef } from '../api/parkedMedia';
import { parkedObjectUrl } from '../api/parkedPreview';
import { saveAttachment } from '../api/saveAttachment';
import { ImageLightbox } from './ImageLightbox';
import { CameraIcon, CheckCircleIcon, CloseIcon, ImageIcon, LockIcon, MicIcon, PaperclipIcon, PencilIcon, WarningIcon } from './Icons';
import './NoteImages.css';

/**
 * A file in a note's sidecar: decrypt on this device, then hand the bytes to
 * the platform's own save path (api/saveAttachment.ts — a Tauri command, the
 * filesystem plugin on a phone, a transient anchor on the web). A parked file
 * is saved from the copy this device is already holding.
 */
function FileDownload({ refItem, folder }: { refItem: TaskAttachmentRef; folder?: string }) {
    const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [where, setWhere] = useState('');
    const parked = isParkedRef(refItem);
    return (
        <button
            type="button"
            className={`ni-file ${state}`}
            title={state === 'saved' ? `Saved to ${where}` : refItem.name}
            disabled={state === 'saving'}
            onClick={async () => {
                setState('saving');
                try {
                    const p = parseEncAttachment(refItem.href);
                    const url = p
                        ? await decryptToBlobUrl(p.id, p.key, p.mime, p.cap)
                        : await parkedObjectUrl(refItem.href);
                    if (!url) throw new Error('nothing to save');
                    const res = await saveAttachment(url, refItem.name, folder);
                    if (res.cancelled) { setState('idle'); return; }
                    setWhere(res.where);
                    setState('saved');
                } catch (err) {
                    console.error('[note attachment] save failed:', err);
                    setState('error');
                }
            }}
        >
            {state === 'saved' ? <CheckCircleIcon /> : state === 'error' ? <WarningIcon /> : <PaperclipIcon />}
            <span className="ni-file-name">{refItem.name}</span>
            {parked && state === 'idle' && <span className="ni-file-note">on this device</span>}
        </button>
    );
}

function Picture({ refItem, onOpen }: { refItem: TaskAttachmentRef; onOpen: (url: string) => void }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const href = refItem.href;
    const parked = isParkedRef(refItem);
    useEffect(() => {
        const p = parseEncAttachment(href);
        // A parked ref has no server file: its plaintext comes from this
        // device's own sealed copy, and null there means the bytes are gone.
        if (!p && !parseParkedRef(href)) return;
        let cancelled = false;
        const load = p
            ? decryptToBlobUrl(p.id, p.key, p.mime, p.cap)
            : parkedObjectUrl(href).then(u => { if (u === null) throw new Error('those bytes are no longer on this device'); return u; });
        load
            .then(u => { if (!cancelled) setUrl(u); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [href]);
    if ((!parseEncAttachment(href) && !parked) || failed) {
        return <span className="ni-broken" title={refItem.name}><WarningIcon /> {refItem.name}</span>;
    }
    if (!url) return <span className="ni-pending" aria-label={`Loading ${refItem.name}`} />;
    return (
        <button type="button" className="ni-open" onClick={() => onOpen(url)} aria-label={`Open ${refItem.name}`}>
            <img src={url} alt={refItem.name} />
        </button>
    );
}

/** A voice note: decrypted here, played only on purpose. `preload="metadata"`
 *  fetches the duration from the blob URL and nothing else; `autoplay` is
 *  never set, and there is no code path that calls play(). */
function AudioClip({ refItem }: { refItem: TaskAttachmentRef }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const href = refItem.href;
    useEffect(() => {
        const p = parseEncAttachment(href);
        if (!p) return;
        let cancelled = false;
        decryptToBlobUrl(p.id, p.key, p.mime, p.cap)
            .then(u => { if (!cancelled) setUrl(u); })
            .catch(() => { if (!cancelled) setFailed(true); });
        return () => { cancelled = true; };
    }, [href]);
    if (!parseEncAttachment(href) || failed) {
        return <span className="ni-broken" title={refItem.name}><WarningIcon /> {refItem.name}</span>;
    }
    if (!url) return <span className="ni-pending" aria-label={`Loading ${refItem.name}`} />;
    return (
        <span className="ni-audio">
            <span className="ni-audio-name"><MicIcon /> {refItem.name}</span>
            <audio src={url} controls preload="metadata" aria-label={refItem.name} />
        </span>
    );
}

export interface NoteImagesProps {
    /** The list's OPENED sidecar (null = none). */
    opened: string | null | undefined;
    /** Offer add/remove/draw. False for a read-only view. */
    editable: boolean;
    /** An upload or save is in flight. */
    busy?: boolean;
    onAddPhotos?: (files: File[]) => void;
    onRemove?: (item: GalleryItem) => void;
    /** The Documents/ folder a phone saves a file into; Púca Notes passes
     *  its own so a note's file does not land in the chat app's folder. */
    saveFolder?: string;
    /** Open the drawing editor: a new drawing, or `item` to edit it. Absent
     *  where drawings cannot be edited (they still show as pictures). */
    onDraw?: (item?: GalleryItem) => void;
    /** Phones: also offer the camera directly. */
    showCamera?: boolean;
    /** Open the voice recorder. Absent where this device cannot record (no
     *  MediaRecorder, no container, no microphone API) — the button is then
     *  not offered at all rather than failing when pressed. */
    onRecord?: () => void;
}

export function NoteImages({ opened, editable, busy = false, onAddPhotos, onRemove, onDraw, showCamera = false, onRecord, saveFolder }: NoteImagesProps) {
    const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null);
    const pickRef = useRef<HTMLInputElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const cameraRef = useRef<HTMLInputElement>(null);
    const locked = isAttachmentsLocked(opened ?? null);
    const items = galleryItems(opened);
    const canEdit = editable && !locked && !busy;

    // No MIME filter. It was the real gate (the three `accept` attributes are
    // only the dialog's default), and it dropped a file a user had deliberately
    // chosen — while the OS dialog's "All files" walked past `accept` and put
    // that same file in the sidecar anyway, where nothing could open it again.
    const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';   // the same file can be picked again
        if (files.length > 0) onAddPhotos?.(files);
    };

    return (
        <div className="note-images">
            {locked && (
                <div className="ni-locked"><LockIcon /> This note’s pictures can’t be read on this device yet.</div>
            )}
            {items.length > 0 && (
                <div className={`ni-grid ${items.length === 1 ? 'single' : ''}`}>
                    {items.map(item => (
                        <figure key={item.ref.href} className={`ni-item ${item.kind}`} data-parked={isParkedRef(item.ref) ? 'true' : undefined}>
                            {isParkedRef(item.ref) && <span className="ni-unsent" title="Waiting for a connection">Not sent yet</span>}
                            {item.kind === 'file'
                                ? <FileDownload refItem={item.ref} folder={saveFolder} />
                                : item.kind === 'audio'
                                    ? <AudioClip refItem={item.ref} />
                                    : <Picture refItem={item.ref} onOpen={url => setZoom({ url, name: item.ref.name })} />}
                            {canEdit && (
                                <div className="ni-tools">
                                    {item.kind === 'drawing' && onDraw && (
                                        <button type="button" className="ni-tool" onClick={() => onDraw(item)} aria-label="Edit drawing" title="Edit drawing">
                                            <PencilIcon />
                                        </button>
                                    )}
                                    {onRemove && (
                                        <button type="button" className="ni-tool" onClick={() => onRemove(item)} aria-label={`Remove ${galleryItemNoun(item)}`} title="Remove">
                                            <CloseIcon />
                                        </button>
                                    )}
                                </div>
                            )}
                        </figure>
                    ))}
                </div>
            )}
            {canEdit && (onAddPhotos || onDraw || onRecord) && (
                <div className="ni-actions">
                    {onAddPhotos && (
                        <>
                            <button type="button" className="ni-action" onClick={() => pickRef.current?.click()}>
                                <ImageIcon /> Add photo
                            </button>
                            <input ref={pickRef} type="file" accept="image/*" multiple hidden onChange={onPicked} data-testid="ni-pick" />
                            <button type="button" className="ni-action" onClick={() => fileRef.current?.click()}>
                                <PaperclipIcon /> Add file
                            </button>
                            {/* The camera input below keeps accept+capture: widening
                                it would send the camera button to a file browser. */}
                            <input ref={fileRef} type="file" multiple hidden onChange={onPicked} data-testid="ni-pick-file" />
                            {showCamera && (
                                <>
                                    <button type="button" className="ni-action" onClick={() => cameraRef.current?.click()}>
                                        <CameraIcon /> Take photo
                                    </button>
                                    <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={onPicked} />
                                </>
                            )}
                        </>
                    )}
                    {onDraw && (
                        <button type="button" className="ni-action" onClick={() => onDraw()}>
                            <PencilIcon /> Draw
                        </button>
                    )}
                    {onRecord && (
                        <button type="button" className="ni-action" onClick={onRecord} aria-label="Voice note">
                            <MicIcon /> Voice note
                        </button>
                    )}
                </div>
            )}
            {busy && <div className="ni-busy" role="status">Saving…</div>}
            {zoom && <ImageLightbox url={zoom.url} name={zoom.name} onClose={() => setZoom(null)} />}
        </div>
    );
}
