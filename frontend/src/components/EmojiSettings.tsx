import { useState, useEffect, useCallback } from 'react';
import { listEmojis, createEmoji, deleteEmoji } from '../api/reactions';
import type { CustomEmoji } from '../api/reactions';
import { uploadFile, discardUpload } from '../api/uploads';
import { getToken, decodeJwtPayload } from '../api/auth';
import './EmojiSettings.css';
import { AuthedImg } from './AuthedImg';
import { CloseIcon, TrashIcon } from './Icons';

/** The signed-in user's id, straight from the JWT (0 when unparseable). */
function currentUserId(): number {
    const token = getToken();
    const sub = token ? decodeJwtPayload(token)?.sub : null;
    return typeof sub === 'number' ? sub : 0;
}

interface EmojiSettingsProps {
    isOpen: boolean;
    onClose: () => void;
    serverId: string;
    serverName: string;
    isOwner: boolean;
    /** Render just the upload + list (no overlay) so this can sit inside
     *  another surface — ServerSettingsModal's Emoji tab uses this. */
    embedded?: boolean;
}

export function EmojiSettings({ isOpen, onClose, serverId, serverName, isOwner, embedded = false }: EmojiSettingsProps) {
    const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
    const [newEmojiName, setNewEmojiName] = useState('');
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    const loadEmojis = useCallback(async () => {
        setLoading(true);
        try {
            const data = await listEmojis(serverId);
            setEmojis(data);
        } catch (err) {
            console.error('Failed to load emojis:', err);
            setEmojis([]);
        }
        setLoading(false);
    }, [serverId]);

    useEffect(() => {
        if (isOpen) {
            loadEmojis();
        }
    }, [isOpen, serverId, loadEmojis]);

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            setError('Please select an image file');
            return;
        }

        setSelectedFile(file);
        setPreviewUrl(URL.createObjectURL(file));
        setError(null);

        // Auto-fill name from filename if empty
        if (!newEmojiName) {
            const name = file.name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_]/g, '_');
            setNewEmojiName(name);
        }
    };

    const handleUpload = async () => {
        if (!selectedFile || !newEmojiName.trim()) {
            setError('Please select an image and enter a name');
            return;
        }

        if (!/^[a-zA-Z0-9_]+$/.test(newEmojiName)) {
            setError('Name can only contain letters, numbers, and underscores');
            return;
        }

        setIsUploading(true);
        setError(null);

        try {
            const uploaded = await uploadFile(selectedFile);
            try {
                await createEmoji(serverId, newEmojiName.trim(), uploaded.id);
            } catch (e) {
                // The blob is already uploaded and already counting against the
                // quota. If naming it fails — a duplicate name is the common
                // case — nothing will ever reference it, so give the space back
                // instead of stranding it forever.
                discardUpload(uploaded.id);
                throw e;
            }
            await loadEmojis();

            // Reset form
            setNewEmojiName('');
            setSelectedFile(null);
            setPreviewUrl(null);
        } catch {
            setError('Failed to create emoji');
        } finally {
            setIsUploading(false);
        }
    };

    const handleDelete = async (emojiId: string, emojiName: string) => {
        if (!confirm(`Delete :${emojiName}: emoji?`)) return;

        try {
            await deleteEmoji(serverId, emojiId);
            setEmojis(prev => prev.filter(e => e.id !== emojiId));
        } catch {
            setError('Failed to delete emoji');
        }
    };

    if (!isOpen) return null;

    const body = (
        <>
                {error && <div className="emoji-error">{error}</div>}

                {/* Upload Section — every member. The server's create_emoji
                    requires membership only, so hiding this behind isOwner
                    just misrepresented what members are allowed to do. */}
                <div className="emoji-upload-section">
                    <h3>Add Emoji</h3>
                    <div className="emoji-upload-form">
                        <div className="emoji-preview-box">
                            {previewUrl ? (
                                <img src={previewUrl} alt="Preview" />
                            ) : (
                                <span className="emoji-preview-placeholder">?</span>
                            )}
                        </div>
                        <div className="emoji-form-fields">
                            <label className="emoji-file-btn">
                                Choose Image
                                <input
                                    type="file"
                                    accept="image/*"
                                    onChange={handleFileSelect}
                                    style={{ display: 'none' }}
                                />
                            </label>
                            <input
                                type="text"
                                value={newEmojiName}
                                onChange={e => setNewEmojiName(e.target.value)}
                                placeholder="emoji_name"
                                className="emoji-name-input"
                                maxLength={32}
                            />
                            <button
                                className="emoji-save-btn"
                                onClick={handleUpload}
                                disabled={isUploading || !selectedFile || !newEmojiName.trim()}
                            >
                                {isUploading ? 'Uploading...' : 'Add'}
                            </button>
                        </div>
                    </div>
                    <p className="emoji-hint">
                        Name can only contain letters, numbers, and underscores
                    </p>
                </div>

                {/* Emoji List */}
                <div className="emoji-list-section">
                    <h3>Server Emojis — {emojis.length}</h3>
                    {loading ? (
                        <div className="emoji-loading">Loading...</div>
                    ) : emojis.length === 0 ? (
                        <div className="emoji-empty">
                            No custom emojis yet
                        </div>
                    ) : (
                        <div className="emoji-grid">
                            {emojis.map(emoji => (
                                <div key={emoji.id} className="emoji-item">
                                    <AuthedImg fileId={emoji.url.replace('/files/', '')} alt={emoji.name} />
                                    <span className="emoji-name">:{emoji.name}:</span>
                                    {/* Delete for exactly who the server accepts it
                                        from: the owner, or the emoji's uploader. */}
                                    {(isOwner || emoji.uploader_id === currentUserId()) && (
                                        <button
                                            className="emoji-delete-btn"
                                            onClick={() => handleDelete(emoji.id, emoji.name)}
                                            title="Delete"
                                        >
                                            <TrashIcon />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
        </>
    );

    if (embedded) {
        return <div className="emoji-settings-embedded">{body}</div>;
    }

    return (
        <div className="emoji-settings-overlay" onClick={onClose}>
            <div className="emoji-settings-modal" onClick={e => e.stopPropagation()}>
                <button className="emoji-close-btn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
                <h2>{serverName} Emojis</h2>
                <p className="emoji-subtitle">Custom emojis for this server</p>
                {body}
            </div>
        </div>
    );
}
