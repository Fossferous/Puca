/**
 * A note's own pictures and recordings — photos, drawings and voice notes
 * stored in the personal list's sealed attachments sidecar
 * (api/listContent.ts, api/noteMedia.ts). Shared by Púca Notes' editor and
 * Púca's Tasks view, so a note shows the same media through both front doors.
 *
 * Every picture and every recording is decrypted on this device
 * (decryptToBlobUrl); the server only ever holds ciphertext. A voice note
 * gets a real player with controls and NEVER autoplays: sound on this device
 * happens only because someone pressed play. A LOCKED sidecar (the identity is locked, the
 * value is not an envelope) renders a lock line and offers no edits: writing
 * over refs this device cannot read would orphan them for good.
 *
 * Touch: every control is a visible button with a label (no hover-only
 * tools), and on phones a second picker opens the camera directly
 * (`capture`), the first the photo library.
 */
import { useEffect, useRef, useState } from 'react';
import { type TaskAttachmentRef, isAttachmentsLocked } from '../api/tasks';
import { decryptToBlobUrl, parseEncAttachment } from '../api/attachments';
import { type GalleryItem, galleryItems } from '../api/noteMedia';
import { ImageLightbox } from './ImageLightbox';
import { CameraIcon, CloseIcon, ImageIcon, LockIcon, MicIcon, PaperclipIcon, PencilIcon, WarningIcon } from './Icons';
import './NoteImages.css';

function Picture({ refItem, onOpen }: { refItem: TaskAttachmentRef; onOpen: (url: string) => void }) {
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

export function NoteImages({ opened, editable, busy = false, onAddPhotos, onRemove, onDraw, showCamera = false, onRecord }: NoteImagesProps) {
    const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null);
    const pickRef = useRef<HTMLInputElement>(null);
    const cameraRef = useRef<HTMLInputElement>(null);
    const locked = isAttachmentsLocked(opened ?? null);
    const items = galleryItems(opened);
    const canEdit = editable && !locked && !busy;

    const onPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []).filter(f => f.type.startsWith('image/') || f.type === '');
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
                        <figure key={item.ref.href} className={`ni-item ${item.kind}`}>
                            {item.kind === 'file'
                                ? <span className="ni-file"><PaperclipIcon /> {item.ref.name}</span>
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
                                        <button type="button" className="ni-tool" onClick={() => onRemove(item)} aria-label={`Remove ${item.kind === 'drawing' ? 'drawing' : item.kind === 'audio' ? 'voice note' : 'picture'}`} title="Remove">
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
