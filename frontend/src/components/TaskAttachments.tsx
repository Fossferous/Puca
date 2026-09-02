/**
 * TaskAttachments — compact strip of E2EE picture/video attachments under a
 * task row (works for subtasks too; they render through the same TaskTree).
 *
 * Each ref's sovereign-enc: href carries the per-file AES key, so decryption
 * happens entirely client-side (decryptToBlobUrl caches by file id). A ref
 * that fails to parse or decrypt degrades to a broken-file placeholder —
 * a corrupt sidecar must never take down the checklist.
 */
import { useEffect, useState } from 'react';
import { type TaskAttachmentRef } from '../api/tasks';
import { parseEncAttachment, decryptToBlobUrl, videoMimeFor } from '../api/attachments';
import { ImageLightbox } from './ImageLightbox';
import { CheckCircleIcon, CloseIcon, PaperclipIcon, WarningIcon } from './Icons';
import { saveAttachment } from '../api/saveAttachment';
import './TaskAttachments.css';

interface TaskAttachmentsProps {
    refs: TaskAttachmentRef[];
    canEdit: boolean;
    onRemove: (index: number) => void;
}

/** One decrypted attachment: image thumb / small video / plain download link. */
function AttachmentItem({ refItem }: { refItem: TaskAttachmentRef }) {
    const parsed = parseEncAttachment(refItem.href);
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);

    const href = refItem.href;
    const name = refItem.name;
    useEffect(() => {
        // parseEncAttachment is pure, so keying the effect off the href alone
        // covers everything it derives (name rides along for the video-MIME
        // fallback below).
        const p = parseEncAttachment(href);
        if (!p) return;
        let cancelled = false;
        // Same extension fallback as chat messages: a ref recorded with
        // application/octet-stream but named *.mkv is a video (File.type is
        // routinely empty for mkv), and the blob should be media-typed.
        decryptToBlobUrl(p.id, p.key, videoMimeFor(name, p.mime) ?? p.mime)
            .then(u => { if (!cancelled) setUrl(u); })
            .catch(err => {
                console.error('Failed to decrypt task attachment:', err);
                if (!cancelled) setFailed(true);
            });
        return () => { cancelled = true; };
    }, [href, name]);

    if (!parsed || failed) {
        return <span className="ta-broken" title={refItem.name}><WarningIcon /> {refItem.name}</span>;
    }
    if (!url) {
        return <div className="ta-thumb ta-pending" title={refItem.name} />;
    }
    if (parsed.mime.startsWith('image/')) {
        return (
            <>
                <img
                    className="ta-thumb"
                    src={url}
                    alt={refItem.name}
                    title={refItem.name}
                    onClick={() => setZoomed(true)}
                />
                {zoomed && (
                    <ImageLightbox url={url} name={refItem.name} onClose={() => setZoomed(false)} />
                )}
            </>
        );
    }
    if (videoMimeFor(refItem.name, parsed.mime)) {
        return <video className="ta-video" src={url} controls preload="metadata" title={refItem.name} />;
    }
    // A BUTTON, never a link: `download` is ignored by middle-click and
    // "Open link in new tab", and a blob: document inherits this app's origin
    // while its MIME comes from whoever sent the file. See api/saveAttachment.
    return <TaskFileDownload url={url} name={refItem.name} />;
}

function TaskFileDownload({ url, name }: { url: string; name: string }) {
    const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [where, setWhere] = useState('');
    return (
        <button
            type="button"
            className={`ta-file ${state}`}
            title={state === 'saved' ? `Saved to ${where}` : name}
            disabled={state === 'saving'}
            onClick={async () => {
                setState('saving');
                try {
                    const res = await saveAttachment(url, name);
                    if (res.cancelled) { setState('idle'); return; } // the Save As dialog was dismissed
                    setWhere(res.where);
                    setState('saved');
                } catch (err) {
                    console.error('[task attachment] save failed:', err);
                    setState('error');
                }
            }}
        >
            {state === 'saved' ? <CheckCircleIcon /> : state === 'error' ? <WarningIcon /> : <PaperclipIcon />} {name}
        </button>
    );
}

export function TaskAttachments({ refs, canEdit, onRemove }: TaskAttachmentsProps) {
    if (refs.length === 0) return null;
    return (
        <div className="task-attachments">
            {refs.map((r, i) => (
                <div key={`${r.href}-${i}`} className="ta-item">
                    <AttachmentItem refItem={r} />
                    {canEdit && (
                        <button
                            className="ta-remove"
                            title="Remove attachment"
                            onClick={() => onRemove(i)}
                        >
                            <CloseIcon />
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}
