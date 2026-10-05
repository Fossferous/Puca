/**
 * TaskAttachments — compact strip of E2EE picture/video/audio attachments
 * under a task row (works for subtasks too; they render through the same
 * TaskTree). A recording made in Púca Notes plays here too, and never by
 * itself: `controls`, no `autoplay`, no call to play().
 *
 * Each ref's sovereign-enc: href carries the per-file AES key, so decryption
 * happens entirely client-side, and only while it is shown
 * (useHeldAttachmentUrl: the cache keeps the ciphertext). A ref that fails to
 * parse or decrypt degrades to a broken-file placeholder — a corrupt sidecar
 * must never take down the checklist.
 */
import { useCallback, useState } from 'react';
import { type TaskAttachmentRef } from '../api/tasks';
import { parseEncAttachment, videoMimeFor, audioMimeFor, isPlaylistBlobUrl } from '../api/attachments';
import { useHeldAttachmentUrl } from './useHeldAttachmentUrl';
import { ImageLightbox } from './ImageLightbox';
import { CheckCircleIcon, CloseIcon, PaperclipIcon, WarningIcon } from './Icons';
import { saveEncryptedAttachment, saveFailureNote } from '../api/saveAttachment';
import type { EncRef } from '../api/nativeDownloads';
import { followOutputDeviceRef } from './settingsStore';
import './TaskAttachments.css';

interface TaskAttachmentsProps {
    refs: TaskAttachmentRef[];
    canEdit: boolean;
    onRemove: (index: number) => void;
}

/** One decrypted attachment: image thumb / small video / plain download link. */
function AttachmentItem({ refItem }: { refItem: TaskAttachmentRef }) {
    const parsed = parseEncAttachment(refItem.href);
    const [zoomed, setZoomed] = useState(false);
    const [playing, setPlaying] = useState(false);
    const save = useTaskFileSave();
    // The player could not decode it (a file that lied about its type, or a
    // codec this engine lacks): the download button instead of a dead player.
    const [embedFailed, setEmbedFailed] = useState(false);

    const name = refItem.name;
    // Same extension fallback as chat messages: a ref recorded with
    // application/octet-stream but named *.mkv is a video (File.type is
    // routinely empty for mkv), one named *.mp3 is audio, and the blob
    // should be media-typed.
    const { url, failed } = useHeldAttachmentUrl(
        parsed ? { id: parsed.id, key: parsed.key, mime: videoMimeFor(name, parsed.mime) ?? audioMimeFor(name, parsed.mime) ?? parsed.mime, cap: parsed.cap } : null,
        // In use: kept while the app is in the background. A save keeps it
        // only while the save reads it, not for the Android app's native
        // save, which downloads the file again (api/saveAttachment.ts).
        { keep: zoomed || playing || save.reading },
    );
    const playingHandlers = { onPlay: () => setPlaying(true), onPause: () => setPlaying(false), onEnded: () => setPlaying(false) };

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
                    <ImageLightbox url={url} name={refItem.name} encRef={parsed} onClose={() => setZoomed(false)} />
                )}
            </>
        );
    }
    // A playlist never reaches a player, whatever its ref says: a <video> or
    // <audio> handed one fetches the URLs inside on its own (api/attachments.ts).
    if (isPlaylistBlobUrl(url)) return <TaskFileDownload url={url} name={refItem.name} encRef={parsed} save={save} />;
    // Both players sit on the Output Device chosen in Settings, not the OS default.
    if (videoMimeFor(refItem.name, parsed.mime)) {
        return <video ref={followOutputDeviceRef} className="ta-video" src={url} controls preload="metadata" title={refItem.name} {...playingHandlers} />;
    }
    // audioMimeFor, not any audio/*: the same name fallback and the same
    // playable-only list as a chat message (an .amr stays a download).
    if (audioMimeFor(refItem.name, parsed.mime) && !embedFailed) {
        return <audio ref={followOutputDeviceRef} className="ta-audio" src={url} controls preload="metadata" title={refItem.name} aria-label={refItem.name} onError={() => setEmbedFailed(true)} {...playingHandlers} />;
    }
    // A BUTTON, never a link: `download` is ignored by middle-click and
    // "Open link in new tab", and a blob: document inherits this app's origin
    // while its MIME comes from whoever sent the file. See api/saveAttachment.
    return <TaskFileDownload url={url} name={refItem.name} encRef={parsed} save={save} />;
}

interface TaskFileSave {
    state: { phase: 'idle' | 'saving' | 'saved' | 'error'; where: string; failure: string };
    /** The save is reading the page's copy: it must stay held (in the
     *  background too) until then. False for the Android app's native save
     *  as soon as it starts. */
    reading: boolean;
    start: (url: string, encRef: EncRef | null, name: string) => Promise<void>;
}
const IDLE_TASK_SAVE: TaskFileSave['state'] = { phase: 'idle', where: '', failure: '' };

/**
 * A file's save, owned by its attachment rather than by its button: the
 * button goes while the copy is let go in the background (a native save
 * does not hold it), and comes back saying the save is still running — not
 * as a fresh button that starts a second one. The same shape as a chat
 * message's (MessageContent's useAttachmentSave).
 */
function useTaskFileSave(): TaskFileSave {
    const [state, setState] = useState(IDLE_TASK_SAVE);
    const [reading, setReading] = useState(false);
    const start = useCallback(async (url: string, encRef: EncRef | null, name: string) => {
        setState({ ...IDLE_TASK_SAVE, phase: 'saving' });
        setReading(true);
        try {
            // The Android app saves natively from the ref (api/saveAttachment.ts)
            // and never reads `url`: it says so, and the copy may go.
            const res = await saveEncryptedAttachment(url, encRef, name, undefined, undefined, () => setReading(false));
            if (res.cancelled) { setState(IDLE_TASK_SAVE); return; } // the Save As dialog was dismissed
            setState({ ...IDLE_TASK_SAVE, phase: 'saved', where: res.where });
        } catch (err) {
            console.error('[task attachment] save failed:', err);
            setState({ ...IDLE_TASK_SAVE, phase: 'error', failure: saveFailureNote(err) });
        } finally {
            setReading(false);
        }
    }, []);
    return { state, reading, start };
}

function TaskFileDownload({ url, name, encRef, save }: { url: string; name: string; encRef: EncRef | null; save: TaskFileSave }) {
    const { phase, where, failure } = save.state;
    return (
        <button
            type="button"
            className={`ta-file ${phase}`}
            title={phase === 'saved' ? `Saved to ${where}` : phase === 'error' ? `${name}: ${failure}` : name}
            disabled={phase === 'saving'}
            onClick={() => { void save.start(url, encRef, name); }}
        >
            {phase === 'saved' ? <CheckCircleIcon /> : phase === 'error' ? <WarningIcon /> : <PaperclipIcon />} {name}
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
