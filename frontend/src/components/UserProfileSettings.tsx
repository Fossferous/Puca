import { useState, useEffect, useRef } from 'react';
import { getProfile, updateAvatar, updateProfile } from '../api/profile';
import type { Profile } from '../api/profile';
import { uploadFile, discardUpload, isAudioType, MAX_SOUND_BYTES, formatFileSize } from '../api/uploads';
import './UserProfileSettings.css';
import { CloseIcon, PlayIcon } from './Icons';
import { fetchFileUrl } from '../api/authedMedia';
import { useAuthedFileUrl } from '../hooks/useAuthedFileUrl';

interface UserProfileSettingsProps {
    isOpen: boolean;
    onClose: () => void;
}

/** On-screen crop viewport (px) — the square the circular mask sits in. */
const CROP_VIEW = 256;
/** Exported avatar resolution (px). */
const CROP_OUT = 512;
const CROP_MAX_ZOOM = 4;

type CropState = {
    src: string;      // object URL of the picked image
    fileType: string; // output mime (png stays png for transparency, else jpeg)
    nw: number;       // natural width
    nh: number;       // natural height
};

export function UserProfileSettings({ isOpen, onClose }: UserProfileSettingsProps) {
    const [profile, setProfile] = useState<Profile | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [isUploading, setIsUploading] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Zoom-to-fit cropper state. `crop` non-null = cropping UI is up.
    const [crop, setCrop] = useState<CropState | null>(null);
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState({ x: 0, y: 0 }); // image translation from centered, in viewport px
    const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
    const viewportRef = useRef<HTMLDivElement | null>(null);
    const cropImgRef = useRef<HTMLImageElement | null>(null);

    useEffect(() => {
        if (isOpen) {
            loadProfile();
        }
    }, [isOpen]);

    const loadProfile = async () => {
        try {
            const data = await getProfile();
            setProfile(data);
            setDisplayName(data.display_name || '');
            setError(null);
        } catch (err) {
            console.error('[Profile] Failed to load:', err);
            setError('Failed to load profile');
        }
    };

    /** Keep the image covering the whole circle: clamp the pan so no edge
     *  can be dragged inside the viewport. */
    const clampOffset = (x: number, y: number, z: number, nw: number, nh: number) => {
        const s = Math.max(CROP_VIEW / nw, CROP_VIEW / nh) * z;
        const maxX = Math.max(0, (nw * s - CROP_VIEW) / 2);
        const maxY = Math.max(0, (nh * s - CROP_VIEW) / 2);
        return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
    };

    // Zooming out can strand the pan outside the new bounds — re-clamp.
    useEffect(() => {
        if (crop) setOffset(o => clampOffset(o.x, o.y, zoom, crop.nw, crop.nh));
    }, [zoom, crop]);

    // Wheel-to-zoom needs preventDefault (the modal scrolls otherwise), so a
    // native non-passive listener — React's synthetic wheel can't block it.
    useEffect(() => {
        const el = viewportRef.current;
        if (!el || !crop) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            setZoom(z => Math.min(CROP_MAX_ZOOM, Math.max(1, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [crop]);

    const closeCrop = () => {
        if (crop) URL.revokeObjectURL(crop.src);
        setCrop(null);
        dragRef.current = null;
    };

    // Dropping the modal while the cropper is up must not leak the object URL.
    useEffect(() => {
        if (!isOpen) closeCrop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const uploadAvatarFile = async (file: File | Blob, name: string, type: string) => {
        setIsUploading(true);
        setError(null);
        setSuccess(null);
        try {
            const uploaded = await uploadFile(new File([file], name, { type }));
            await updateAvatar(uploaded.id);
            setProfile(prev => prev ? { ...prev, avatar_url: `/files/${uploaded.id}` } : null);
            setSuccess('Avatar updated!');
            setTimeout(() => setSuccess(null), 2000);
            return true;
        } catch {
            setError('Failed to upload avatar');
            return false;
        } finally {
            setIsUploading(false);
        }
    };

    const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // let the same file be picked again later
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            setError('Please select an image file');
            return;
        }

        // Canvas cropping would freeze an animated GIF — upload those as-is.
        if (file.type === 'image/gif') {
            void uploadAvatarFile(file, file.name, file.type);
            return;
        }

        const src = URL.createObjectURL(file);
        const probe = new Image();
        probe.onload = () => {
            setCrop({
                src,
                fileType: file.type === 'image/png' ? 'image/png' : 'image/jpeg',
                nw: probe.naturalWidth,
                nh: probe.naturalHeight,
            });
            setZoom(1);
            setOffset({ x: 0, y: 0 });
            setError(null);
        };
        probe.onerror = () => {
            URL.revokeObjectURL(src);
            setError('Could not read that image');
        };
        probe.src = src;
    };

    const confirmCrop = async () => {
        const img = cropImgRef.current;
        if (!crop || !img) return;
        // Map the viewport square back into source-image pixels.
        const s = Math.max(CROP_VIEW / crop.nw, CROP_VIEW / crop.nh) * zoom;
        const sw = CROP_VIEW / s;
        const sx = crop.nw / 2 - offset.x / s - sw / 2;
        const sy = crop.nh / 2 - offset.y / s - sw / 2;

        const canvas = document.createElement('canvas');
        canvas.width = CROP_OUT;
        canvas.height = CROP_OUT;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            setError('Failed to crop image');
            return;
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, sw, sw, 0, 0, CROP_OUT, CROP_OUT);

        const blob = await new Promise<Blob | null>(resolve =>
            canvas.toBlob(resolve, crop.fileType, 0.92)
        );
        if (!blob) {
            setError('Failed to crop image');
            return;
        }
        const ok = await uploadAvatarFile(
            blob,
            crop.fileType === 'image/png' ? 'avatar.png' : 'avatar.jpg',
            crop.fileType,
        );
        if (ok) closeCrop();
    };

    // --- Custom join/leave sounds -------------------------------------------
    const [soundBusy, setSoundBusy] = useState<'join' | 'leave' | null>(null);

    const soundField = (kind: 'join' | 'leave') =>
        kind === 'join' ? 'join_sound_file_id' as const : 'leave_sound_file_id' as const;

    const handleSoundPicked = async (kind: 'join' | 'leave', e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // let the same file be picked again later
        if (!file) return;
        if (!isAudioType(file.type)) {
            setError('Please select an audio file (mp3, ogg, wav…)');
            return;
        }
        if (file.size > MAX_SOUND_BYTES) {
            setError(`Sound clips are capped at ${formatFileSize(MAX_SOUND_BYTES)} — this one is ${formatFileSize(file.size)}.`);
            return;
        }
        setSoundBusy(kind);
        setError(null);
        setSuccess(null);
        let uploadedId: string | null = null;
        try {
            const uploaded = await uploadFile(file);
            uploadedId = uploaded.id;
            await updateProfile(kind === 'join'
                ? { join_sound_file_id: uploaded.id }
                : { leave_sound_file_id: uploaded.id });
            setProfile(prev => prev ? { ...prev, [soundField(kind)]: uploaded.id } : prev);
            setSuccess(kind === 'join' ? 'Join sound saved!' : 'Leave sound saved!');
            setTimeout(() => setSuccess(null), 2000);
        } catch (err) {
            // The PATCH rejected the file (or the upload broke): don't leave the
            // orphan counting against the quota.
            if (uploadedId) discardUpload(uploadedId);
            setError(err instanceof Error && err.message ? err.message : 'Failed to save sound');
        } finally {
            setSoundBusy(null);
        }
    };

    const handleSoundClear = async (kind: 'join' | 'leave') => {
        setSoundBusy(kind);
        setError(null);
        setSuccess(null);
        try {
            await updateProfile(kind === 'join'
                ? { join_sound_file_id: '' }   // empty string clears
                : { leave_sound_file_id: '' });
            setProfile(prev => prev ? { ...prev, [soundField(kind)]: null } : prev);
        } catch {
            setError('Failed to remove sound');
        } finally {
            setSoundBusy(null);
        }
    };

    /** Own-clip preview — deliberately NOT the gated playback path: you should
     *  be able to hear what you just uploaded regardless of notification
     *  settings. */
    const previewSound = async (fileId: string) => {
        // /files needs credentials now, and <audio src> cannot send them.
        const url = await fetchFileUrl(fileId);
        if (!url) { setError('Could not load that clip'); return; }
        const a = new Audio(url);
        a.volume = 0.6;
        void a.play().catch(() => { /* autoplay refusal — a click precedes this, so rare */ });
    };

    const handleSaveDisplayName = async () => {
        setIsSaving(true);
        setError(null);
        setSuccess(null);

        try {
            await updateProfile({ display_name: displayName.trim() || undefined });
            setProfile(prev => prev ? { ...prev, display_name: displayName.trim() || null } : null);
            setSuccess('Display name saved!');
            setTimeout(() => setSuccess(null), 2000);
        } catch {
            setError('Failed to save display name');
        } finally {
            setIsSaving(false);
        }
    };

    // MUST stay ABOVE the `!isOpen` early return. This is a real hook
    // (useState + useEffect); below the return it ran only while the modal was
    // open, so opening it changed the hook count and React threw #310
    // "Rendered more hooks than during the previous render" — which the root
    // ErrorBoundary turns into the whole app being replaced by the crash
    // screen. The component is mounted permanently by Chat with isOpen=false,
    // so the very first click on "Edit Profile" hit it, on every platform.
    // It no-ops on undefined, so calling it while closed is free.
    const avatarUrl = useAuthedFileUrl(profile?.avatar_url?.replace('/files/', ''));

    if (!isOpen) return null;

    // Displayed image size inside the crop viewport (cover × zoom).
    const cropScale = crop ? Math.max(CROP_VIEW / crop.nw, CROP_VIEW / crop.nh) * zoom : 1;
    const dispW = crop ? crop.nw * cropScale : 0;
    const dispH = crop ? crop.nh * cropScale : 0;

    return (
        <div className="profile-settings-overlay" onClick={onClose}>
            <div className="profile-settings-modal" onClick={e => e.stopPropagation()}>
                <button className="profile-close-btn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>

                <h2>User Profile</h2>

                {error && <div className="profile-error">{error}</div>}
                {success && <div className="profile-success">{success}</div>}

                <div className="profile-section">
                    <h3>Avatar</h3>
                    <p className="profile-description">
                        {crop
                            ? 'Drag to position — use the slider (or scroll) to zoom.'
                            : 'Upload an image to use as your profile picture.'}
                    </p>

                    {crop ? (
                        <div className="avatar-crop-area">
                            <div
                                ref={viewportRef}
                                className="avatar-crop-viewport"
                                style={{ width: CROP_VIEW, height: CROP_VIEW }}
                                onPointerDown={(e) => {
                                    e.preventDefault();
                                    e.currentTarget.setPointerCapture(e.pointerId);
                                    dragRef.current = {
                                        startX: e.clientX,
                                        startY: e.clientY,
                                        baseX: offset.x,
                                        baseY: offset.y,
                                    };
                                }}
                                onPointerMove={(e) => {
                                    const drag = dragRef.current;
                                    if (!drag || !crop) return;
                                    setOffset(clampOffset(
                                        drag.baseX + (e.clientX - drag.startX),
                                        drag.baseY + (e.clientY - drag.startY),
                                        zoom, crop.nw, crop.nh,
                                    ));
                                }}
                                onPointerUp={() => { dragRef.current = null; }}
                                onPointerCancel={() => { dragRef.current = null; }}
                            >
                                <img
                                    ref={cropImgRef}
                                    src={crop.src}
                                    alt=""
                                    draggable={false}
                                    style={{
                                        width: dispW,
                                        height: dispH,
                                        left: CROP_VIEW / 2 + offset.x - dispW / 2,
                                        top: CROP_VIEW / 2 + offset.y - dispH / 2,
                                    }}
                                />
                                <div className="avatar-crop-mask" />
                            </div>
                            <input
                                type="range"
                                className="avatar-crop-zoom"
                                min={1}
                                max={CROP_MAX_ZOOM}
                                step={0.01}
                                value={zoom}
                                onChange={(e) => setZoom(Number(e.target.value))}
                                aria-label="Zoom"
                            />
                            <div className="avatar-crop-actions">
                                <button className="avatar-crop-cancel" onClick={closeCrop} disabled={isUploading}>
                                    Cancel
                                </button>
                                <button className="avatar-upload-btn" onClick={confirmCrop} disabled={isUploading}>
                                    {isUploading ? 'Uploading...' : 'Save Avatar'}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="avatar-upload-area">
                            <div className="avatar-preview">
                                {avatarUrl ? (
                                    <img src={avatarUrl} alt="Avatar" />
                                ) : (
                                    <span className="avatar-placeholder">
                                        {(displayName || profile?.username)?.charAt(0).toUpperCase() || '?'}
                                    </span>
                                )}
                            </div>
                            <div className="avatar-info">
                                <p className="username">{profile?.username}</p>
                                <label className="avatar-upload-btn">
                                    {isUploading ? 'Uploading...' : 'Upload Avatar'}
                                    <input
                                        type="file"
                                        accept="image/*"
                                        onChange={handleFilePicked}
                                        disabled={isUploading}
                                        style={{ display: 'none' }}
                                    />
                                </label>
                            </div>
                        </div>
                    )}
                </div>

                <div className="profile-section">
                    <h3>Display Name</h3>
                    <p className="profile-description">
                        This is how others will see you. Leave blank to use your username.
                    </p>
                    <div className="display-name-field">
                        <input
                            type="text"
                            value={displayName}
                            onChange={(e) => setDisplayName(e.target.value)}
                            placeholder={profile?.username || 'Display Name'}
                            maxLength={32}
                        />
                        <button
                            onClick={handleSaveDisplayName}
                            disabled={isSaving}
                            className="save-display-name-btn"
                        >
                            {isSaving ? 'Saving...' : 'Save'}
                        </button>
                    </div>
                </div>

                <div className="profile-section">
                    <h3>Join / Leave Sounds</h3>
                    <p className="profile-description">
                        Short clips other people hear when you enter or leave a voice channel
                        (audio only, max {formatFileSize(MAX_SOUND_BYTES)}; the first 4 seconds play).
                        Server admins can silence them per member.
                    </p>
                    {(['join', 'leave'] as const).map(kind => {
                        const fileId = profile?.[soundField(kind)] ?? null;
                        return (
                            <div className="sound-upload-row" key={kind}>
                                <span className="sound-label">{kind === 'join' ? 'Join' : 'Leave'}</span>
                                <span className="sound-state">{fileId ? 'Custom clip' : 'Default chime'}</span>
                                {fileId && (
                                    <button className="sound-btn" onClick={() => previewSound(fileId)}>
                                        <PlayIcon /> Play
                                    </button>
                                )}
                                <label className={`sound-btn ${soundBusy !== null ? 'disabled' : ''}`}>
                                    {soundBusy === kind ? 'Saving…' : fileId ? 'Replace' : 'Upload'}
                                    <input
                                        type="file"
                                        accept="audio/*"
                                        style={{ display: 'none' }}
                                        disabled={soundBusy !== null}
                                        onChange={(e) => void handleSoundPicked(kind, e)}
                                    />
                                </label>
                                {fileId && (
                                    <button
                                        className="sound-btn"
                                        disabled={soundBusy !== null}
                                        onClick={() => void handleSoundClear(kind)}
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
