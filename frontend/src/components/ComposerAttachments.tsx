/**
 * The pending-attachment chip strip above the message composer.
 *
 * Renders the PendingAttachment list (api/composerAttachments): a thumbnail
 * for images, a file icon otherwise, a spinner while uploading, a warning +
 * retry on failure, a spoiler toggle, and a remove button. Pure view: every
 * mutation goes through the callbacks, and object-URL lifecycle stays with
 * Chat (which created them).
 */
import type { PendingAttachment } from '../api/composerAttachments';
import { CloseIcon, EyeIcon, EyeOffIcon, FileIcon, PendingIcon, RefreshIcon, WarningIcon } from './Icons';
import './ComposerAttachments.css';

interface ComposerAttachmentsProps {
    attachments: PendingAttachment[];
    onRemove: (localId: string) => void;
    onToggleSpoiler: (localId: string) => void;
    onRetry: (localId: string) => void;
}

export function ComposerAttachments({ attachments, onRemove, onToggleSpoiler, onRetry }: ComposerAttachmentsProps) {
    if (attachments.length === 0) return null;
    return (
        <div className="composer-attachments" role="list" aria-label="Attachments to send">
            {attachments.map(a => (
                <div
                    key={a.localId}
                    role="listitem"
                    className={`composer-chip composer-chip-${a.status}${a.spoiler ? ' composer-chip-spoiler' : ''}`}
                    title={a.status === 'failed' ? (a.error ?? 'Upload failed') : a.name}
                >
                    <span className="composer-chip-thumb" aria-hidden="true">
                        {a.previewUrl
                            ? <img src={a.previewUrl} alt="" />
                            : <FileIcon />}
                        {a.status === 'uploading' && (
                            <span className="composer-chip-busy"><PendingIcon /></span>
                        )}
                        {a.status === 'failed' && (
                            <span className="composer-chip-warn"><WarningIcon /></span>
                        )}
                    </span>
                    <span className="composer-chip-text">
                        <span className="composer-chip-name">{a.name}</span>
                        {/* VISIBLE, not only in `title`: touch devices render
                            no tooltips, and the 507 case is unactionable
                            without its explanation (retry cannot succeed). */}
                        {a.status === 'failed' && (
                            <span className="composer-chip-error">{a.error ?? 'Upload failed'}</span>
                        )}
                    </span>
                    <span className="composer-chip-actions">
                        {a.status === 'failed' ? (
                            <button
                                type="button"
                                className="composer-chip-btn"
                                onClick={() => onRetry(a.localId)}
                                aria-label={`Retry uploading ${a.name}`}
                                title="Retry upload"
                            >
                                <RefreshIcon size={14} />
                            </button>
                        ) : (
                            <button
                                type="button"
                                className={`composer-chip-btn${a.spoiler ? ' active' : ''}`}
                                onClick={() => onToggleSpoiler(a.localId)}
                                aria-label={a.spoiler ? `Unmark ${a.name} as spoiler` : `Mark ${a.name} as spoiler`}
                                title={a.spoiler ? 'Spoiler — click to unmark' : 'Mark as spoiler'}
                            >
                                {a.spoiler ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                            </button>
                        )}
                        <button
                            type="button"
                            className="composer-chip-btn"
                            onClick={() => onRemove(a.localId)}
                            aria-label={`Remove ${a.name}`}
                            title="Remove"
                        >
                            <CloseIcon size={14} />
                        </button>
                    </span>
                </div>
            ))}
        </div>
    );
}
