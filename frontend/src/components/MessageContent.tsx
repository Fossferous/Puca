/**
 * Renders parsed message content (markdown + mentions + channels + emoji).
 *
 * The parsing lives in utils/messageParser (pure + unit-tested); this component
 * only maps the resulting node tree to React elements and resolves mention /
 * channel names against the current server context.
 */
import React, { useState, useEffect, useCallback, useReducer, useRef, type Ref } from 'react';
import { parseMessage, isSafeUrl, type Node } from '../utils/messageParser';
import { isImageUrl } from '../api/linkPreview';
import { isEncAttachment, parseEncAttachment, acquireAttachmentUrl, prefetchAttachmentUrl, noteAttachmentInterest, attachmentPictureSize, noteAttachmentPictureSize, videoMimeFor, audioMimeFor, isPlaylistBlobUrl, type AttachmentHold } from '../api/attachments';
import { isAbortError } from '../api/priorityLimiter';
import { useAttachmentZone, usePlayerGrant, loadUrgency, scrollRootOf } from './attachmentZone';
import { isClipRef, isScrubbedClipRef } from '../api/clips/clipRef';
import { ClipAttachment } from './ClipAttachment';
import { AttachmentLoading } from './AttachmentLoading';
import type { ClipConsent } from '../api/servers';
import { openExternalUrl } from '../api/openExternal';
import { ImageLightbox } from './ImageLightbox';
import { LockIcon, CheckCircleIcon, WarningIcon, PaperclipIcon, MusicIcon, SpeakerIcon } from './Icons';
import { saveEncryptedAttachment, saveFailureNote } from '../api/saveAttachment';
import type { EncRef } from '../api/nativeDownloads';
import { remoteImagesAllowed, followOutputDeviceRef } from './settingsStore';
import { bytesOfText } from '../api/loadProgressText';
import type { MemberWithRoles, Channel } from '../api/servers';

/**
 * A third-party image referenced by a message.
 *
 * The URL is chosen by whoever SENT the message, so fetching it automatically
 * reports the reader's IP address, user agent and read time to that host —
 * `![](https://attacker.example/px.png)` in a channel or an unsolicited DM is a
 * working locator for everyone who scrolls past. `referrerPolicy="no-referrer"`
 * (kept below) hides which app made the request but not that it was made.
 *
 * So by default this renders a placeholder and the fetch happens only when the
 * reader asks for it. Images on the user's own server are not third-party and
 * are never gated — see `remoteImagesAllowed`.
 */
function RemoteImage({ href, alt }: { href: string; alt?: string }) {
    const [show, setShow] = useState(() => remoteImagesAllowed(href));
    let host = '';
    try {
        host = new URL(href, window.location.href).hostname;
    } catch {
        host = 'another site';
    }

    if (!show) {
        return (
            <button
                type="button"
                className="message-image-blocked"
                onClick={() => setShow(true)}
                title={`Loads from ${host}, which will see your IP address`}
            >
                <PaperclipIcon />
                <span>Show image from {host}</span>
            </button>
        );
    }
    return (
        <span className="message-image">
            <img
                src={href}
                alt={alt ?? ''}
                loading="lazy"
                referrerPolicy="no-referrer"
                onClick={() => openExternalUrl(href)}
                onError={(e) => {
                    (e.currentTarget.closest('.message-image') as HTMLElement).style.display = 'none';
                }}
            />
        </span>
    );
}

/** The box an attachment takes on screen, for its placeholder while it shows
 *  nothing: a picture's <img>, a player's whole card (with the chip under it).
 *  null for anything else (the chips are all one size). */
function measureShown(el: Element): { width: number; height: number } | null {
    const box = el.classList.contains('message-image') ? el.querySelector('img')
        : (el.classList.contains('message-video') || el.classList.contains('message-audio')) ? el : null;
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return r.height > 0 ? { width: r.width, height: r.height } : null;
}

/** A native <audio controls>'s height here (54 px in Chromium and the
 *  Android WebView), learned from the players mounted, so an audio file
 *  waiting for a player keeps a card exactly as tall as the one it gets. */
let audioControlsHeight = 54;
function audioPlayerRef(el: HTMLAudioElement | null): (() => void) | undefined {
    if (el) {
        const h = el.getBoundingClientRect().height;
        if (h > 0) audioControlsHeight = h;
    }
    // On the Output Device chosen in Settings, not the OS default.
    return followOutputDeviceRef(el);
}

/** Fetch + decrypt an E2EE attachment and render it (image, video and audio
 *  inline, else a download link). The plaintext bytes only ever exist in this
 *  browser.
 *
 *  Loading is automatic but not all at once (components/attachmentZone.ts):
 *  what is on screen first, then the closest, a few at a time; one within two
 *  screen heights of the screen is shown, one further away is loaded ahead
 *  (api/attachments.ts prefetchAttachmentUrl) and shown when it comes near;
 *  one that scrolls far away again, or whose channel is left, gives its
 *  decrypted copy back to the cache (acquireAttachmentUrl) and keeps its
 *  space with a placeholder of the same size; and only the few players
 *  closest to the screen are mounted. A loaded video or audio file waiting
 *  for a player is its player's card already, with a stand-in of the same
 *  size where the player goes, so getting one moves nothing; a paused one
 *  that gets a player again starts where it was. One that is playing, open
 *  in the lightbox or being saved from this copy is never let go; only one
 *  that is playing keeps its player beyond the closest few. */
function EncryptedAttachment({ href, name }: { href: string; name: string }) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    // Bumping this re-runs the fetch effect — `failed` used to latch forever,
    // making "reload the channel" the only retry. The common failure is the
    // SENDER's own phone fetching its just-uploaded image while the uplink is
    // still saturated; one bounded auto-retry heals that without user action,
    // and the failed state offers a manual Retry after.
    const [attempt, setAttempt] = useState(0);
    // The player couldn't decode the container (an extension-guessed video
    // that turned out unplayable) — drop back to the download chip.
    const [embedFailed, setEmbedFailed] = useState(false);
    // The video player loaded a file with no picture (an audio-only .webm or
    // .mp4 — what most "download the audio" tools write, and which the OS
    // labels video/*): show it as the audio player instead of a black box.
    const [audioOnly, setAudioOnly] = useState(false);
    // Whatever element stands for this attachment right now (chip, picture,
    // player or placeholder): the one watched for distance from the screen.
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    const slotRef = useRef<HTMLElement | null>(null);
    const bindSlot = useCallback((el: HTMLElement | null) => { slotRef.current = el; setSlot(el); }, []);
    const [playing, setPlaying] = useState(false);
    // The Download chip's save, kept here rather than in the chip: the chip
    // is unmounted whenever its card shows a placeholder (far off screen, or
    // its player handed to a closer one), and a save outlives that.
    const save = useAttachmentSave();
    // A player reported its picture size (noteAttachmentPictureSize): render
    // again with it.
    const [, pictureReported] = useReducer((n: number) => n + 1, 0);
    // Where a paused player was when it was taken away (scrolled far off, or
    // no longer among the closest few): the next player starts there, as the
    // old always-mounted one kept its place (review finding 2026-10-05).
    // Back to the start once it has played to the end.
    const resumeAt = useRef(0);
    const zone = useAttachmentZone(slot, measureShown);
    // In use: its copy is never let go, however far it scrolls. A save holds
    // it only while the save reads it — not for the Android app's native
    // save, which downloads the file again (api/saveAttachment.ts).
    const busy = playing || zoomed || save.reading;
    const want = zone.near || busy;
    const info = parseEncAttachment(href);
    // Not just `mime.startsWith('video/')`: refs recorded before the upload
    // side inferred types (and any browser that reports "" for .mkv) carry
    // application/octet-stream for real videos — the NAME is the signal then.
    const videoMime = info ? videoMimeFor(name, info.mime) : null;
    // Asked only when it is not a video, so `.webm`/`.mp4` stay with the
    // video player. Same name fallback (an old `.mp3` ref says octet-stream),
    // and only types the engines can play — an .amr keeps its chip.
    const audioMime = info && !videoMime ? audioMimeFor(name, info.mime) : null;
    // Type the blob with the resolved media MIME so the player gets a
    // media-typed source even when the ref said octet-stream.
    const fileMime = info ? (videoMime ?? audioMime ?? info.mime) : '';
    // Its place in the fetch queue: on screen first (the ones that will stay
    // in view first), then the closest; asked each time a fetch slot frees,
    // not when it asked (the reader may have scrolled since).
    const rootOf = useRef<{ el: Element; root: Element | null } | null>(null);
    const urgency = useCallback(() => {
        const el = slotRef.current;
        if (!el) return Number.MAX_SAFE_INTEGER;
        if (rootOf.current?.el !== el) rootOf.current = { el, root: scrollRootOf(el) };
        return loadUrgency(el, rootOf.current.root);
    }, []);
    // The URL only while it is wanted: the effect below gives it back after
    // the render that stopped showing it, so a released URL is never in the DOM.
    const shown = want ? url : null;
    const playlist = isPlaylistBlobUrl(shown);
    const wantsPlayer = !!shown && !playlist && !embedFailed && !!(videoMime || audioMime);
    // Only one that is playing keeps its player beyond the closest few: a
    // save reads the file, not the player (review finding 2026-10-05: tapping
    // Download and scrolling on left a fifth player live for the whole save).
    const player = usePlayerGrant(slot, wantsPlayer, playing, measureShown);
    useEffect(() => {
        setFailed(false);
        setEmbedFailed(false);
        setAudioOnly(false);
        if (!info) setFailed(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [href, attempt]);
    // On the page: a copy it may scroll back to is kept before one nothing
    // shows any more (api/attachments.ts noteAttachmentInterest).
    useEffect(() => {
        if (!info) return;
        return noteAttachmentInterest(info.id, info.key, fileMime);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [href, fileMime]);
    // Far from the screen it still loads by itself, after everything nearer
    // and while the cache has room (prefetchAttachmentUrl), so it is here when
    // the reader scrolls to it; it is shown (held) only once it comes near.
    useEffect(() => {
        if (!info || want || !zone.placed || failed) return;
        const ac = new AbortController();
        void prefetchAttachmentUrl(info.id, info.key, fileMime, info.cap, { urgency, signal: ac.signal });
        return () => ac.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [href, fileMime, want, zone.placed, failed, attempt]);
    useEffect(() => {
        if (!info || !want) return;
        let alive = true;
        let hold: AttachmentHold | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | undefined;
        const ac = new AbortController();
        acquireAttachmentUrl(info.id, info.key, fileMime, info.cap, { urgency, signal: ac.signal })
            .then((h) => {
                if (!alive) { h.release(); return; }
                hold = h;
                setUrl(h.url);
            })
            .catch((err) => {
                if (!alive || isAbortError(err)) return;
                if (attempt === 0) {
                    // One automatic retry, delayed enough for the uplink to drain.
                    retryTimer = setTimeout(() => { if (alive) setAttempt(1); }, 2000);
                } else {
                    setFailed(true);
                }
            });
        return () => {
            alive = false;
            ac.abort();
            if (retryTimer !== undefined) clearTimeout(retryTimer);
            // Runs after the commit that stopped rendering the URL (no longer
            // wanted, another ref, or unmounted), so letting it go is safe.
            hold?.release();
            setUrl(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [href, fileMime, attempt, want]);

    if (failed || !info) {
        return (
            <span className="message-attachment failed">
                <LockIcon /> [Attachment unavailable]
                {info && (
                    <button type="button" className="attachment-retry" onClick={() => setAttempt(a => a + 1)}>
                        Retry
                    </button>
                )}
            </span>
        );
    }
    const isImage = info.mime.startsWith('image/');
    const asVideo = !!videoMime && !embedFailed && !audioOnly;
    const asAudio = (!!audioMime || (!!videoMime && audioOnly)) && !embedFailed;
    // A video's picture size when it is known before its player has the
    // metadata: read from the file as it was decrypted (api/videoDims.ts),
    // or what a player reported. The player takes exactly that box from its
    // first frame (.video-box in Chat.css), and so does the stand-in a video
    // has while it waits for a player, so swapping one for the other moves
    // nothing. Review finding 2026-10-05: a loaded video with no player was a
    // 30 px chip that became a ~260 px player when it reached the screen;
    // scrolling up through videos posted back to back, that pushed what the
    // reader was looking at 100-380 px down.
    const picture = asVideo ? attachmentPictureSize(info.id) : null;
    const pictureBox = picture ? ({ '--vw': picture.width, '--vh': picture.height } as React.CSSProperties) : undefined;
    // Loaded, but not among the few closest that have a player (every one
    // ON the screen has one: attachmentZone.ts).
    const waiting = !!shown && wantsPlayer && !player.granted;
    const keepPlace = (e: React.SyntheticEvent<HTMLMediaElement>) => {
        resumeAt.current = e.currentTarget.ended ? 0 : e.currentTarget.currentTime;
    };
    const resumePlace = (m: HTMLMediaElement) => {
        if (resumeAt.current > 0 && m.currentTime === 0) m.currentTime = resumeAt.current;
    };
    const onEnded = () => { setPlaying(false); resumeAt.current = 0; };
    // A video's card: its player, or the stand-in, over the download chip.
    // The same element either way, so getting a player swaps only the box.
    const videoCard = (box: React.ReactNode) => (
        // stopPropagation: native <video> control clicks (play/seek/
        // volume) COMPOSE out of the UA shadow root and would bubble to a
        // wrapping Spoiler's toggle — pressing Play re-hid the spoiler,
        // which re-applied pointer-events:none over the controls while
        // the clip kept playing (review finding, 0811). Unrevealed
        // spoilers are unaffected: pointer-events:none means this span
        // never sees the revealing tap.
        <span className="message-video" ref={bindSlot} onClick={(e) => e.stopPropagation()}>
            {box}
            {shown ? <AttachmentDownload url={shown} name={name || 'attachment'} encRef={info} save={save} /> : <AttachmentLoading fileId={info.id} />}
        </span>
    );
    // An audio file's card: its name over the player (or the stand-in), the
    // download chip under it. A VIDEO file handed over because it showed no
    // picture (see the audio branch below) says so instead of a music note.
    const soundOnly = !!videoMime && audioOnly;
    const audioCard = (url: string, box: React.ReactNode) => (
        // stopPropagation: the same spoiler-toggle reason as the video.
        <span className="message-audio" ref={bindSlot} onClick={(e) => e.stopPropagation()}>
            <span className="message-audio-card">
                <span className="message-audio-name">
                    {soundOnly ? <SpeakerIcon /> : <MusicIcon />}
                    <span className="message-audio-title">{name || 'audio'}</span>
                </span>
                {soundOnly && <span className="message-audio-note">Sound only: no picture to show</span>}
                {box}
            </span>
            <AttachmentDownload url={url} name={name || 'attachment'} encRef={info} save={save} />
        </span>
    );
    // Nothing to show (not loaded yet, out of range, or a player that is not
    // among the closest few).
    if (!shown || waiting) {
        const reserve = (shown ? player.size : null) ?? zone.size;
        // Its player's card with a stand-in for the player: loaded and
        // waiting for one, or — its picture size known from an earlier load
        // and no space measured — still on its way.
        if (pictureBox && (shown || !reserve)) {
            return videoCard(<span className="message-video-standin video-box" style={pictureBox} />);
        }
        if (asAudio && shown) {
            return audioCard(shown, <span className="message-audio-standin" style={{ height: audioControlsHeight }} />);
        }
        // Otherwise, once it has been on screen, its placeholder keeps the
        // space it took there — far away, and on the way back until it shows
        // again — so nothing shifts; before that, the loading chip.
        if (reserve && isImage) {
            return (
                <span className="message-image" ref={bindSlot}>
                    <span className="attachment-reserve" style={{ display: 'inline-block', overflow: 'hidden', width: reserve.width, height: reserve.height }} />
                </span>
            );
        }
        if (reserve && (asVideo || asAudio)) {
            return (
                <span className={`${asVideo ? 'message-video' : 'message-audio'} attachment-reserve`} ref={bindSlot} style={{ height: reserve.height }}>
                    <AttachmentLoading fileId={info.id} />
                </span>
            );
        }
        return <AttachmentLoading fileId={info.id} ref={bindSlot} />;
    }
    if (isImage) {
        return (
            // stopPropagation for the same reason as the video branch below:
            // a revealed spoiler wraps this span, and the zoom click would
            // bubble into its toggle — opening the lightbox while re-hiding
            // the spoiler underneath it. Unrevealed spoilers never see this
            // (pointer-events:none), so the revealing tap still works.
            <span className="message-image" ref={bindSlot} onClick={(e) => e.stopPropagation()}>
                {/* Enlarge in-app. openAttachmentBlob's window.open of a blob:
                    URL is a no-op in the Tauri and Capacitor shells. */}
                <img src={shown} alt={name} loading="lazy" onClick={() => setZoomed(true)} />
                {zoomed && <ImageLightbox url={shown} name={name} encRef={info} onClose={() => setZoomed(false)} />}
            </span>
        );
    }
    // A playlist (its BYTES open with #EXTM3U, whatever the ref says) never
    // reaches a player: a <video>/<audio> handed one fetches the URLs inside
    // on its own. It is the download chip (api/attachments.ts).
    if (playlist) return <AttachmentDownload url={shown} name={name || 'attachment'} encRef={info} ref={bindSlot} save={save} />;
    if (asVideo) {
        // Inline player, same pattern TaskAttachments already uses: the
        // decrypted blob URL feeds a native <video> directly (safeBlobType
        // keeps the real MIME on video/* blobs for exactly this).
        // preload="metadata" so a channel of clips doesn't buffer them all;
        // playsInline so Capacitor/iOS doesn't hijack into fullscreen; no
        // autoplay ever. The download chip stays underneath — the embed
        // replaces the NEED to download, not the ability. onError: an
        // extension-guessed container the engine can't demux falls back to
        // the plain chip instead of a dead player.
        return videoCard(
            <video
                // On the Output Device chosen in Settings, not the OS default.
                ref={followOutputDeviceRef}
                className={pictureBox ? 'video-box' : undefined}
                style={pictureBox}
                src={shown}
                controls
                preload="metadata"
                playsInline
                title={name}
                onError={() => { setPlaying(false); setEmbedFailed(true); }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={onEnded}
                onTimeUpdate={keepPlace}
                // Metadata is in: a file with no video track has no
                // dimensions (the spec makes videoWidth 0 until there is
                // a frame size to report, and one is known by now for a
                // real video), so it is sound only.
                onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    if (v.videoWidth === 0 && v.videoHeight === 0) { setAudioOnly(true); return; }
                    // What this engine shows is the box from now on, for this
                    // player and any later one (or stand-in) of the file.
                    if (picture?.width !== v.videoWidth || picture?.height !== v.videoHeight) {
                        noteAttachmentPictureSize(info.id, { width: v.videoWidth, height: v.videoHeight });
                        pictureReported();
                    }
                    resumePlace(v);
                }}
            />,
        );
    }
    if (asAudio) {
        // A VIDEO file handed over because it showed no picture: an audio-only
        // .webm/.mp4, or a real video whose picture this engine cannot decode
        // (MPEG-4 Part 2; HEVC without a decoder), which reports the same
        // zero frame size. Either way it is not a song the sender posted, so
        // it does not wear the music note, and a line says what the reader is
        // getting (soundOnly, audioCard). No codec sniffing: onError still
        // covers a file that will not open at all.
        //
        // Inline audio player — the video branch above, minus the picture.
        // With nothing to look at, the NAME is what says which file this is,
        // so it heads the card. Same rules otherwise: the decrypted blob URL
        // feeds a native <audio> (safeBlobType keeps plain audio/* types);
        // preload="metadata" fetches the duration and nothing else; no
        // autoplay, ever, and nothing here calls play(); on the Output
        // Device chosen in Settings; onError (a file that lied about being
        // audio, or a codec this engine lacks) falls back to the plain chip;
        // and the download chip stays underneath.
        return audioCard(
            shown,
            <audio
                ref={audioPlayerRef}
                src={shown}
                controls
                preload="metadata"
                title={name}
                aria-label={name || 'audio'}
                onError={() => { setPlaying(false); setEmbedFailed(true); }}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={onEnded}
                onTimeUpdate={keepPlace}
                onLoadedMetadata={(e) => resumePlace(e.currentTarget)}
            />,
        );
    }
    return <AttachmentDownload url={shown} name={name || 'attachment'} encRef={info} ref={bindSlot} save={save} />;
}

/** What a Download chip shows about its save (useAttachmentSave). */
interface ChipSave {
    phase: 'idle' | 'saving' | 'saved' | 'error';
    /** Where the file went, for "Saved to …". */
    where: string;
    /** The Android app's native save reports how much has arrived; null elsewhere. */
    arrived: string | null;
    failure: string;
}
const IDLE_SAVE: ChipSave = { phase: 'idle', where: '', arrived: null, failure: 'could not save' };

interface AttachmentSave {
    state: ChipSave;
    /** The save is reading the page's copy: its URL must stay valid until
     *  then. False for the Android app's native save as soon as it starts. */
    reading: boolean;
    start: (url: string, encRef: EncRef | null, name: string) => Promise<void>;
}

/**
 * An attachment's save, owned by the attachment rather than by its chip, so
 * a chip unmounted mid-save (its card turned into a placeholder) comes back
 * saying how far the save got — not as a fresh button that starts a second
 * one.
 */
function useAttachmentSave(): AttachmentSave {
    const [state, setState] = useState<ChipSave>(IDLE_SAVE);
    const [reading, setReading] = useState(false);
    const start = useCallback(async (url: string, encRef: EncRef | null, name: string) => {
        setState({ ...IDLE_SAVE, phase: 'saving' });
        setReading(true);
        try {
            // The Android app saves natively from the ref (api/saveAttachment.ts)
            // and never reads `url`: it says so, and the copy may go.
            const res = await saveEncryptedAttachment(
                url, encRef, name, undefined,
                (got, total) => setState((s) => ({ ...s, arrived: got > 0 ? bytesOfText(got, total) : null })),
                () => setReading(false),
            );
            if (res.cancelled) { setState(IDLE_SAVE); return; } // the Save As dialog was dismissed
            setState({ ...IDLE_SAVE, phase: 'saved', where: res.where });
        } catch (err) {
            console.error('[attachment] save failed:', err);
            setState({ ...IDLE_SAVE, phase: 'error', failure: saveFailureNote(err) });
        } finally {
            setReading(false);
        }
    }, []);
    return { state, reading, start };
}

/**
 * A BUTTON, not a link. `download` on an anchor is honoured only for a plain
 * left click — middle-click and "Open link in new tab" ignore it and navigate
 * to the blob, which inherits this app's origin while its MIME comes from
 * whoever sent the attachment. No blob URL is exposed as a link anywhere.
 * `save` is the attachment's (useAttachmentSave), which keeps the URL valid
 * while a save reads it.
 */
function AttachmentDownload({ url, name, encRef, ref, save }: { url: string; name: string; encRef: EncRef | null; ref?: Ref<HTMLButtonElement>; save: AttachmentSave }) {
    const { phase, where, arrived, failure } = save.state;
    return (
        <button
            type="button"
            ref={ref}
            className={`message-attachment ${phase}`}
            title={phase === 'saved' ? `Saved to ${where}` : `Download ${name}`}
            disabled={phase === 'saving'}
            onClick={() => { void save.start(url, encRef, name); }}
        >
            {phase === 'saved' ? <CheckCircleIcon /> : phase === 'error' ? <WarningIcon /> : <PaperclipIcon />} {name}
            {phase === 'saving' && arrived !== null && <span className="attachment-saved"> — {arrived}</span>}
            {phase === 'saved' && <span className="attachment-saved"> — saved</span>}
            {phase === 'error' && <span className="attachment-saved"> — {failure}</span>}
        </button>
    );
}

// A small set of common shortcode emoji. Unknown shortcodes render literally.
// icon-lint:allow-emoji — message CONTENT: typing :fire: puts this glyph in the
// user's own text. Replacing these with icons would change what people send.
const EMOJI: Record<string, string> = {
    smile: '😄', smiley: '😃', grin: '😁', joy: '😂', laughing: '😆',
    wink: '😉', blush: '😊', heart: '❤️', fire: '🔥', tada: '🎉',
    thumbsup: '👍', '+1': '👍', thumbsdown: '👎', '-1': '👎', eyes: '👀',
    rocket: '🚀', ok_hand: '👌', wave: '👋', pray: '🙏', clap: '👏',
    thinking: '🤔', sob: '😭', sunglasses: '😎', poop: '💩', '100': '💯',
    check: '✅', x: '❌', warning: '⚠️', star: '⭐', skull: '💀',
};
// icon-lint:end

function Spoiler({ children }: { children: React.ReactNode }) {
    const [revealed, setRevealed] = useState(false);
    return (
        <span
            className={`spoiler ${revealed ? 'revealed' : ''}`}
            onClick={() => setRevealed(!revealed)}
        >
            {children}
        </span>
    );
}

interface Ctx {
    members: MemberWithRoles[];
    channels: Channel[];
    onChannelClick?: (channel: Channel) => void;
    /** Server-stamped consent for the message being rendered (clip posts only). */
    clipConsent?: ClipConsent | null;
}

function renderNodes(nodes: Node[], ctx: Ctx, keyPrefix = ''): React.ReactNode[] {
    return nodes.map((node, i) => {
        const key = `${keyPrefix}${i}`;
        switch (node.type) {
            case 'text':
                return <React.Fragment key={key}>{node.value}</React.Fragment>;
            case 'strong':
                return <strong key={key}>{renderNodes(node.children, ctx, key + '.')}</strong>;
            case 'em':
                return <em key={key}>{renderNodes(node.children, ctx, key + '.')}</em>;
            case 'underline':
                return <u key={key}>{renderNodes(node.children, ctx, key + '.')}</u>;
            case 'strike':
                return <del key={key}>{renderNodes(node.children, ctx, key + '.')}</del>;
            case 'spoiler':
                return <Spoiler key={key}>{renderNodes(node.children, ctx, key + '.')}</Spoiler>;
            case 'code':
                return <code key={key} className="inline-code">{node.value}</code>;
            case 'codeblock':
                return (
                    <pre key={key} className="code-block" data-lang={node.lang || undefined}>
                        <code>{node.value}</code>
                    </pre>
                );
            case 'blockquote':
                return <blockquote key={key} className="message-quote">{renderNodes(node.children, ctx, key + '.')}</blockquote>;
            case 'link':
                // A clip ref is dispatched BEFORE any <a> could be emitted: the
                // href carries the clip key and must never be navigable.
                if (isClipRef(node.href)) return <ClipAttachment key={node.href} href={node.href} consent={ctx.clipConsent} />;
                if (isScrubbedClipRef(node.href)) return <span key={key} className="clip-attachment-broken">{node.label} (clip removed)</span>;
                if (isEncAttachment(node.href)) return <EncryptedAttachment key={key} href={node.href} name={node.label} />;
                // Belt-and-suspenders with the parser: never emit a raw href for a
                // disallowed scheme (javascript:, data:, …) — render the label as
                // plain text instead. (H7)
                if (!isSafeUrl(node.href)) return <React.Fragment key={key}>{node.label}</React.Fragment>;
                return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="message-link">{node.label}</a>;
            case 'url':
                if (!isSafeUrl(node.href)) return <React.Fragment key={key}>{node.href}</React.Fragment>;
                // Bare image/GIF links embed inline (matching how most chat apps handle them); others are links.
                if (isImageUrl(node.href)) {
                    return <RemoteImage key={key} href={node.href} />;
                }
                return <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="message-link">{node.href}</a>;
            case 'image':
                if (isClipRef(node.href)) return <ClipAttachment key={node.href} href={node.href} consent={ctx.clipConsent} />;
                if (isScrubbedClipRef(node.href)) return <span key={key} className="clip-attachment-broken">{node.alt} (clip removed)</span>;
                if (isEncAttachment(node.href)) return <EncryptedAttachment key={key} href={node.href} name={node.alt} />;
                if (!isSafeUrl(node.href)) return node.alt ? <React.Fragment key={key}>{node.alt}</React.Fragment> : null;
                return <RemoteImage key={key} href={node.href} alt={node.alt} />;
            case 'mentionEveryone':
                return <span key={key} className="mention everyone">@everyone</span>;
            case 'mentionHere':
                return <span key={key} className="mention everyone">@here</span>;
            case 'mentionUser': {
                const name = node.name.toLowerCase();
                const m = ctx.members.find(
                    (mem) =>
                        mem.username.toLowerCase() === name ||
                        (mem.display_name && mem.display_name.toLowerCase() === name) ||
                        (mem.server_nickname && mem.server_nickname.toLowerCase() === name)
                );
                if (m) {
                    const label = m.server_nickname || m.display_name || m.username;
                    return <span key={key} className="mention">@{label}</span>;
                }
                return <React.Fragment key={key}>@{node.name}</React.Fragment>;
            }
            case 'channel': {
                const name = node.name.toLowerCase();
                const c = ctx.channels.find((ch) => ch.name.toLowerCase() === name);
                if (c) return (
                    <span
                        key={key}
                        className="mention channel"
                        onClick={ctx.onChannelClick ? () => ctx.onChannelClick!(c) : undefined}
                        role={ctx.onChannelClick ? 'button' : undefined}
                    >#{c.name}</span>
                );
                return <React.Fragment key={key}>#{node.name}</React.Fragment>;
            }
            case 'emoji': {
                const glyph = EMOJI[node.name.toLowerCase()];
                return <React.Fragment key={key}>{glyph ?? `:${node.name}:`}</React.Fragment>;
            }
            default:
                return null;
        }
    });
}

interface MessageContentProps {
    content: string;
    members: MemberWithRoles[];
    channels?: Channel[];
    onChannelClick?: (channel: Channel) => void;
    /** `msg.clip_consent` — lets a clip ref in this message render its badge. */
    clipConsent?: ClipConsent | null;
}

export function MessageContent({ content, members, channels = [], onChannelClick, clipConsent }: MessageContentProps) {
    const nodes = parseMessage(content);
    return <>{renderNodes(nodes, { members, channels, onChannelClick, clipConsent })}</>;
}
