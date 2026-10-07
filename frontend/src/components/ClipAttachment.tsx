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
 * (api/clipDownload.ts fetches + decrypts every part — concatenated on
 * desktop/web, streamed part by part to Documents/Puca on Android —
 * byte-for-byte the muxer's original output), same as the Play button already
 * decrypts it into a <video>. Refused for the same reason Play is: a manifest
 * whose parts are not a subset of what was actually approved (clipBadge
 * 'mismatch').
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { decodeClipRef, type ClipManifest } from '../api/clips/clipRef';
import { CLIP_DOWNLOAD_MAX_BYTES, createClipPlayer, type ClipPlayerHandle } from '../api/clips/clipPlayback';
import { clipBadge, clipBadgeText } from '../api/clips/clipConsentBadge';
import { formatClock, formatMB } from '../api/clips/clipPresets';
import type { ClipConsent } from '../api/servers';
import { saveClip } from '../api/clipDownload';
import { applyOutputDevice } from './settingsStore';
import { useOutputDeviceRef } from '../hooks/useOutputDeviceRef';
import { ClipIcon, DownloadIcon, LockIcon, PlayIcon, ShieldCheckIcon, WarningIcon } from './Icons';
import { VideoPlayer } from './VideoPlayer';
import { downloadPercent, downloadSaving, playLoadPercent, playLoadText } from '../api/loadProgressText';
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
    // The player follows Settings > Output Device while it is mounted.
    const videoSinkRef = useOutputDeviceRef(videoRef);
    const playerRef = useRef<ClipPlayerHandle | null>(null);
    // Strings and numbers, so a byte that does not change the readout
    // re-renders nothing (progress arrives once per network chunk).
    const [loadText, setLoadText] = useState('Loading…');
    // null = no total yet (indeterminate). Only ever moves forwards within a
    // Play: the total can grow when the link slows, and a bar that slid back
    // looked like the load had restarted (the words still say the new total).
    const [loadPct, setLoadPct] = useState<number | null>(null);
    const [dlState, setDlState] = useState<DownloadState>('idle');
    const [dlPct, setDlPct] = useState(0);
    const [dlSaving, setDlSaving] = useState(false);
    const [dlError, setDlError] = useState<string | null>(null);
    const [savedWhere, setSavedWhere] = useState<string | null>(null);
    // The running download's Cancel. Leaving the channel does NOT cancel it:
    // only the viewer's own Cancel (here, or the phone's notification) does.
    const dlAbortRef = useRef<AbortController | null>(null);

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
        setState('loading'); setError(null); setLoadText(playLoadText(null)); setLoadPct(null);
        const player = createClipPlayer(manifest);
        playerRef.current = player;
        if (player.mode === 'unsupported') { setState('unsupported'); return; }
        // What was counted only falls when a scrub before the first play
        // restarts the run: then the bar starts over with it — valueless
        // again if the player has no total for the new run yet. Otherwise a
        // report with no total leaves the bar where it is.
        let lastLoaded = 0;
        player.onLoadProgress = (p) => {
            if (playerRef.current !== player) return;
            setLoadText(playLoadText(p));
            const pct = playLoadPercent(p);
            const restarted = p.loaded < lastLoaded;
            lastLoaded = p.loaded;
            setLoadPct((prev) => (restarted ? pct : pct === null ? prev : Math.max(prev ?? 0, pct)));
        };
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
            // play() is OURS, not a click on the controls: make sure the
            // routing the ref started has landed first, or the clip's first
            // moments play on the OS default.
            await applyOutputDevice(el);
            setState('playing');
            void el.play().catch(() => { /* autoplay refused — controls are visible */ });
        } catch (e) {
            onFail(e);
        }
    };

    // Independent of Play: someone may want the file without watching inline
    // first. api/clipDownload.ts saves the exact original bytes: on the
    // desktop shell through the native command every attachment uses (a bare
    // `<a download>` is NOT honoured in the Tauri webview), in a browser
    // through a transient anchor, and in the Android app natively — the phone
    // fetches and decrypts the parts itself and writes Movies/Puca with the
    // clip's duration and a seek index added (api/nativeDownloads.ts) — or,
    // on an older APK, STREAMED part by part into Documents/Puca.
    const download = async () => {
        if (refused || tooLargeToDownload || dlState === 'downloading') return;
        const ac = new AbortController();
        dlAbortRef.current = ac;
        setDlState('downloading'); setDlPct(0); setDlSaving(false); setDlError(null); setSavedWhere(null);
        try {
            const res = await saveClip(manifest, (p) => { setDlPct(downloadPercent(p)); setDlSaving(downloadSaving(p)); }, ac.signal);
            if (res.cancelled) { setDlState('idle'); return; } // the Save As dialog was dismissed
            setSavedWhere(res.onDisk ? res.where : null);
            setDlState('saved');
        } catch (e) {
            if ((e as { name?: string })?.name === 'AbortError') { setDlState('idle'); return; } // the viewer's Cancel
            const status = (e as { status?: number })?.status;
            if (status === 404 || status === 410) { setDlState('gone'); return; }
            setDlError(e instanceof Error ? e.message : String(e));
            setDlState('failed');
        } finally {
            if (dlAbortRef.current === ac) dlAbortRef.current = null;
        }
    };

    const showVideo = state === 'loading' || state === 'playing';

    return (
        <div className={`clip-attachment ${refused ? 'refused' : ''}`} data-clip-state={state}>
            <div className="clip-attachment-plate">
                {showVideo ? (
                    // Púca's own controls (volume, speed, fullscreen), on the
                    // MediaSource the clip player attaches to this element.
                    // The manifest knows the length before MSE reports it.
                    <VideoPlayer
                        videoRef={videoSinkRef}
                        videoClassName="clip-attachment-video"
                        frameClassName="clip-attachment-player vpl-fill"
                        preload="none"
                        title={`Clip, ${formatClock(manifest.durationMs / 1000)}`}
                        durationHint={manifest.durationMs / 1000}
                        memoryKey={href}
                    />
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
                {/* One polite announcement that Play started loading: the MB
                    readout changes every network chunk, and a progressbar is
                    only read when focused. Always present, so a screen reader
                    hears the text appear. */}
                <span className="sr-only" aria-live="polite">{state === 'loading' ? 'Loading the clip' : ''}</span>
                {state === 'loading' && (
                    <span className="clip-attachment-overlay">
                        <span className="clip-attachment-overlay-text">{loadText}</span>
                        <span
                            className="clip-attachment-progress"
                            role="progressbar"
                            aria-label="Loading the clip"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={loadPct ?? undefined}
                        >
                            <span className="clip-attachment-progress-fill" style={{ width: `${loadPct ?? 0}%` }} />
                        </span>
                    </span>
                )}
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
                        className={`clip-attachment-download${dlState === 'downloading' ? ' busy' : ''}`}
                        onClick={() => void download()}
                        disabled={refused || tooLargeToDownload || dlState === 'downloading'}
                        aria-busy={dlState === 'downloading' || undefined}
                        aria-label={dlState === 'downloading' ? (dlSaving ? 'Saving the clip' : `Downloading, ${dlPct} percent`) : 'Download the original recording'}
                        title={refused ? 'This clip points at footage nobody approved.' : tooLargeToDownload ? 'This clip is too large to download in the app — play it here instead.' : 'Decrypted in your browser, then saved like any other file'}
                        // The fill behind the label is the share received (ClipAttachment.css).
                        style={dlState === 'downloading' ? ({ '--clip-dl-pct': `${dlSaving ? 100 : dlPct}%` } as CSSProperties) : undefined}
                    >
                        <DownloadIcon size={14} />
                        {dlState === 'downloading' ? (dlSaving ? 'Saving…' : `Downloading ${dlPct}%`) : dlState === 'saved' ? (savedWhere ? 'Saved' : 'Download started') : 'Download'}
                    </button>
                    {dlState === 'downloading' && (
                        <button type="button" className="clip-attachment-cancel" onClick={() => dlAbortRef.current?.abort()}>
                            Cancel
                        </button>
                    )}
                    {dlState === 'saved' && savedWhere && <span className="clip-attachment-saved">Saved to {savedWhere}</span>}
                </div>
                {dlState === 'gone' && <span className="clip-attachment-note"><WarningIcon size={13} /> This clip is no longer on the server.</span>}
                {dlState === 'failed' && <span className="clip-attachment-note"><WarningIcon size={13} /> Download failed{dlError ? `: ${dlError}` : ''}. <button type="button" className="clip-attachment-link" onClick={() => void download()}>Try again</button></span>}
            </div>
        </div>
    );
}
