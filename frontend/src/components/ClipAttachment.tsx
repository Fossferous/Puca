/**
 * A posted clip inside a message (docs/CLIPS.md §Phase 2).
 *
 * The message body carries `sovereign-clip:v1?<manifest>` — the clip KEY, the
 * part ids and the codec — under the channel's E2EE like any attachment ref.
 * This renders a plate with a Play control; only on Play does it fetch the
 * encrypted parts, decrypt them in this browser and feed a <video> through
 * MSE (api/clips/clipPlayback.ts). Nothing is decrypted before the click.
 *
 * The consent badge is decided by the pure clipBadge(): it renders ONLY when
 * the server-stamped `clip_consent` covers every part the manifest names.
 * Names never appear — the server does not stamp them (D6).
 *
 * Download: once a clip is posted, every required approver already agreed to
 * release it — so anyone who can see the message can save the original file
 * (downloadClipBytes fetches + decrypts every part and concatenates them,
 * byte-for-byte the muxer's original output), same as the Play button already
 * decrypts it into a <video>. Refused for the same reason Play is: a manifest
 * whose parts are not a subset of what was actually approved (clipBadge
 * 'mismatch').
 */
import { useEffect, useRef, useState } from 'react';
import { decodeClipRef, type ClipManifest } from '../api/clips/clipRef';
import { CLIP_DOWNLOAD_MAX_BYTES, createClipPlayer, downloadClipBytes, type ClipDownloadProgress, type ClipPlayerHandle } from '../api/clips/clipPlayback';
import { clipBadge, clipBadgeText } from '../api/clips/clipConsentBadge';
import { formatClock, formatMB } from '../api/clips/clipPresets';
import type { ClipConsent } from '../api/servers';
import { saveAttachment } from '../api/saveAttachment';
import { ClipIcon, DownloadIcon, LockIcon, PlayIcon, ShieldCheckIcon, WarningIcon } from './Icons';
import './ClipAttachment.css';

export interface ClipAttachmentProps {
    href: string;
    /** Server-stamped consent record for the message this ref lives in. */
    consent?: ClipConsent | null;
}

type PlayState = 'idle' | 'loading' | 'playing' | 'gone' | 'failed' | 'unsupported';

function resolutionLabel(m: ClipManifest): string {
    return `${m.height}p`;
}

type DownloadState = 'idle' | 'downloading' | 'saved' | 'gone' | 'failed';

export function ClipAttachment({ href, consent }: ClipAttachmentProps) {
    const manifest = decodeClipRef(href);
    const [state, setState] = useState<PlayState>('idle');
    const [error, setError] = useState<string | null>(null);
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const playerRef = useRef<ClipPlayerHandle | null>(null);
    const [dlState, setDlState] = useState<DownloadState>('idle');
    const [dlProgress, setDlProgress] = useState<ClipDownloadProgress | null>(null);
    const [dlError, setDlError] = useState<string | null>(null);
    const [savedWhere, setSavedWhere] = useState<string | null>(null);

    // Every hook above the early return (React #310 class). The caller keys
    // this element by href, so a different clip in the same slot remounts —
    // no state reset in an effect is needed.
    useEffect(() => () => { playerRef.current?.destroy(); playerRef.current = null; }, []);

    if (!manifest) {
        return <span className="clip-attachment clip-attachment-broken"><WarningIcon size={14} /> This clip reference is malformed.</span>;
    }
    const badge = clipBadge(manifest, consent);
    const badgeText = clipBadgeText(badge);
    const refused = badge.kind === 'mismatch';
    const tooLargeToDownload = manifest.totalCipherBytes > CLIP_DOWNLOAD_MAX_BYTES;

    const play = async () => {
        if (refused || state === 'loading' || state === 'playing') return;
        setState('loading'); setError(null);
        const player = createClipPlayer(manifest);
        playerRef.current = player;
        if (player.mode === 'unsupported') { setState('unsupported'); return; }
        const onFail = (e: unknown) => {
            if (playerRef.current !== player) return; // a newer play() superseded this one
            const status = (e as { status?: number })?.status;
            if (status === 404 || status === 410) { setState('gone'); return; }
            setError(e instanceof Error ? e.message : String(e));
            setState('failed');
        };
        // attach() resolves once the clip is PLAYABLE; later parts stream in
        // behind the playhead, so a failure can also arrive after that.
        player.onError = onFail;
        try {
            // The <video> is only in the DOM once state is 'loading'; wait a tick for the ref.
            await new Promise<void>((r) => setTimeout(r, 0));
            const el = videoRef.current;
            if (!el) throw new Error('no video element');
            await player.attach(el);
            setState('playing');
            void el.play().catch(() => { /* autoplay refused — controls are visible */ });
        } catch (e) {
            onFail(e);
        }
    };

    // Independent of Play: someone may want the file without watching inline
    // first. Builds the exact original bytes in memory, then saves them the
    // same way every other attachment does (api/saveAttachment.ts): a native
    // command on the desktop shell — a bare `<a download>` is NOT honoured in
    // the Tauri webview — and a transient anchor on the web/phone.
    const download = async () => {
        if (refused || tooLargeToDownload || dlState === 'downloading') return;
        setDlState('downloading'); setDlProgress(null); setDlError(null); setSavedWhere(null);
        let url: string | null = null;
        try {
            const blob = await downloadClipBytes(manifest, setDlProgress);
            url = URL.createObjectURL(blob);
            const res = await saveAttachment(url, `puca-clip-${manifest.clipId.slice(0, 8)}.mp4`);
            if (res.cancelled) { setDlState('idle'); return; } // the Save As dialog was dismissed
            setSavedWhere(res.onDisk ? res.where : null);
            setDlState('saved');
        } catch (e) {
            const status = (e as { status?: number })?.status;
            if (status === 404 || status === 410) { setDlState('gone'); return; }
            setDlError(e instanceof Error ? e.message : String(e));
            setDlState('failed');
        } finally {
            // The desktop path has already read the bytes; the web anchor was
            // clicked synchronously. Revoke after a grace period either way.
            if (url) { const u = url; setTimeout(() => URL.revokeObjectURL(u), 30_000); }
        }
    };

    const showVideo = state === 'loading' || state === 'playing';

    return (
        <div className={`clip-attachment ${refused ? 'refused' : ''}`} data-clip-state={state}>
            <div className="clip-attachment-plate">
                {showVideo ? (
                    <video ref={videoRef} className="clip-attachment-video" controls playsInline preload="none" />
                ) : (
                    <>
                        <span className="clip-attachment-glyph" aria-hidden="true"><ClipIcon size={28} /></span>
                        <button
                            type="button"
                            className="clip-attachment-play"
                            onClick={() => void play()}
                            disabled={refused}
                            aria-label={refused ? 'Playback refused' : `Play clip, ${formatClock(manifest.durationMs / 1000)}`}
                            title={refused ? 'This clip points at footage nobody approved.' : 'Play — the clip is decrypted here, in your browser'}
                        >
                            <PlayIcon size={22} />
                        </button>
                    </>
                )}
                {state === 'loading' && <span className="clip-attachment-overlay" aria-live="polite">Decrypting…</span>}
            </div>
            <div className="clip-attachment-meta">
                <span className="clip-attachment-chips">
                    <span className="clip-chip">{formatClock(manifest.durationMs / 1000)}</span>
                    <span className="clip-chip">{resolutionLabel(manifest)}</span>
                    <span className="clip-chip">{formatMB(manifest.totalCipherBytes)}</span>
                    <span className="clip-chip"><LockIcon size={11} /> Encrypted</span>
                </span>
                {badgeText && (
                    <span className={`clip-attachment-badge ${badge.kind}`}>
                        {badge.kind === 'mismatch' ? <WarningIcon size={13} /> : <ShieldCheckIcon size={13} />} {badgeText}
                    </span>
                )}
                {state === 'gone' && <span className="clip-attachment-note"><WarningIcon size={13} /> This clip is no longer on the server.</span>}
                {state === 'failed' && <span className="clip-attachment-note"><WarningIcon size={13} /> Could not play this clip{error ? `: ${error}` : ''}. <button type="button" className="clip-attachment-link" onClick={() => void play()}>Try again</button></span>}
                {state === 'unsupported' && <span className="clip-attachment-note"><WarningIcon size={13} /> This device cannot play clips of this size — open it on desktop.</span>}
                <div className="clip-attachment-actions">
                    <button
                        type="button"
                        className="clip-attachment-download"
                        onClick={() => void download()}
                        disabled={refused || tooLargeToDownload || dlState === 'downloading'}
                        aria-label={dlState === 'downloading' && dlProgress ? `Downloading, part ${dlProgress.done} of ${dlProgress.total}` : 'Download the original recording'}
                        title={refused ? 'This clip points at footage nobody approved.' : tooLargeToDownload ? 'This clip is too large to download in the app — play it here instead.' : 'Decrypted in your browser, then saved like any other file'}
                    >
                        <DownloadIcon size={14} />
                        {dlState === 'downloading' ? `Downloading${dlProgress ? ` ${dlProgress.done}/${dlProgress.total}` : '…'}` : dlState === 'saved' ? (savedWhere ? 'Saved' : 'Download started') : 'Download'}
                    </button>
                    {dlState === 'saved' && savedWhere && <span className="clip-attachment-saved">Saved to {savedWhere}</span>}
                </div>
                {dlState === 'gone' && <span className="clip-attachment-note"><WarningIcon size={13} /> This clip is no longer on the server.</span>}
                {dlState === 'failed' && <span className="clip-attachment-note"><WarningIcon size={13} /> Download failed{dlError ? `: ${dlError}` : ''}. <button type="button" className="clip-attachment-link" onClick={() => void download()}>Try again</button></span>}
            </div>
        </div>
    );
}
