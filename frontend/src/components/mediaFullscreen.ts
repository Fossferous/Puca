/**
 * Fullscreen for a LIVE picture — a watched screen share, a camera tile —
 * on every engine Púca runs in, including the one with no element fullscreen.
 *
 * Three routes, tried in order:
 *
 *  1. The Fullscreen API on the TILE (the element holding the <video>), so
 *     Púca's own overlay — the name, the controls, the remote-control capture
 *     surface — stays on top of the picture. Browsers, the desktop app, the
 *     Android app and iPad Safari all have it; this is the route those took
 *     before this file existed, unchanged.
 *  2. The <video>'s own `webkitEnterFullscreen()`: iPhone Safari. WebKit on
 *     the iPhone has no element fullscreen at all (`requestFullscreen` is
 *     simply absent, which is why the stage's `target?.requestFullscreen?.()`
 *     did nothing there), but it does hand a video to the system player, and
 *     that player takes the whole screen — over Safari's toolbars too, which
 *     nothing inside the page can do. It works for a MediaStream source. Two
 *     things it does that the caller has to undo: on the way out it can leave
 *     the inline element paused, and its volume control can unmute an element
 *     that is muted on purpose (stream audio plays through the stage's own
 *     Web Audio graph; an unmuted element would play it a second time). Both
 *     are handled here, for every video this file puts there.
 *  3. Neither: the caller's in-app fullscreen (`fallback`). Also taken when
 *     route 1 is REFUSED (an iframe without allowfullscreen, no gesture) or
 *     route 2 never actually begins.
 *
 * MUST be called synchronously from the user's tap or click: both APIs
 * require the gesture.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

type FsDocument = Document & {
    webkitFullscreenEnabled?: boolean;
};
type FsElement = HTMLElement & {
    webkitRequestFullscreen?: () => void | Promise<void>;
};
export type IosVideo = HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitSupportsFullscreen?: boolean;
    webkitDisplayingFullscreen?: boolean;
};

/** Which route took (or was asked for). */
export type MediaFullscreenRoute = 'element' | 'video' | 'app';

export interface MediaFullscreenOptions {
    /** Show the caller's in-app fullscreen. Called at most once per request. */
    fallback: () => void;
    /** The video left the system player (route 2 only). */
    onVideoExit?: () => void;
    /** The system player tried to unmute a video that must stay muted
     *  (route 2 only). The element is muted again before this runs; the
     *  caller may treat it as "sound on, please". */
    onUnmuteRequest?: () => void;
    /** How long route 2 may take to begin before the fallback (ms). */
    beginTimeoutMs?: number;
}

/** Does the document allow element fullscreen here? Unknown counts as yes:
 *  only an explicit `false` (iPhone Safari, a sandboxed frame) rules it out. */
function elementFullscreenEnabled(doc: Document): boolean {
    const d = doc as FsDocument;
    const enabled = d.fullscreenEnabled ?? d.webkitFullscreenEnabled;
    return enabled !== false;
}

/** Can this video be handed to the system player (iPhone)? */
export function canVideoFullscreen(video: HTMLVideoElement | null): video is IosVideo {
    if (!video) return false;
    const v = video as IosVideo;
    // `webkitSupportsFullscreen` is false until the video has metadata; a
    // missing property (older engines) says nothing, so it does not rule out.
    return typeof v.webkitEnterFullscreen === 'function' && v.webkitSupportsFullscreen !== false;
}

/**
 * Enter fullscreen for `tile` (whose picture is `video`). Returns the route
 * asked for; with 'element' or 'video' a refusal can still arrive later, and
 * then `fallback` runs.
 */
export function enterMediaFullscreen(
    tile: HTMLElement | null,
    video: HTMLVideoElement | null,
    opts: MediaFullscreenOptions,
): MediaFullscreenRoute {
    let fellBack = false;
    const fallback = () => {
        if (fellBack) return;
        fellBack = true;
        opts.fallback();
    };

    const el = tile as FsElement | null;
    if (el && elementFullscreenEnabled(el.ownerDocument)) {
        const request = typeof el.requestFullscreen === 'function'
            ? () => el.requestFullscreen()
            : typeof el.webkitRequestFullscreen === 'function'
                ? () => el.webkitRequestFullscreen!()
                : null;
        if (request) {
            try {
                // Older engines return nothing rather than a promise.
                void Promise.resolve(request()).catch(fallback);
            } catch {
                fallback();
                return 'app';
            }
            return 'element';
        }
    }

    if (canVideoFullscreen(video)) {
        watchSystemPlayer(video, opts, fallback);
        try {
            video.webkitEnterFullscreen!();
        } catch {
            fallback();
            return 'app';
        }
        return 'video';
    }

    fallback();
    return 'app';
}

/** Listeners for one trip through the system player, removed when it ends. */
function watchSystemPlayer(video: IosVideo, opts: MediaFullscreenOptions, fallback: () => void): void {
    // The muted state the page chose (React's `muted`), held while the
    // system player is up so its speaker button cannot double the audio.
    const keepMuted = video.muted;
    let began = false;

    const onBegin = () => { began = true; };
    const onVolume = () => {
        if (!keepMuted || video.muted) return;
        video.muted = true;
        opts.onUnmuteRequest?.();
    };
    const onEnd = () => {
        cleanup();
        if (keepMuted) video.muted = true;
        // The system player leaves the inline element paused on the way out;
        // a live picture that silently stops is the bug, not a choice.
        if (video.paused) void video.play().catch(() => { /* gone, or no longer allowed */ });
        opts.onVideoExit?.();
    };
    const timer = setTimeout(() => {
        if (began || video.webkitDisplayingFullscreen) return;
        cleanup();
        fallback();
    }, opts.beginTimeoutMs ?? 1000);
    function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('webkitbeginfullscreen', onBegin);
        video.removeEventListener('webkitendfullscreen', onEnd);
        video.removeEventListener('volumechange', onVolume);
    }
    video.addEventListener('webkitbeginfullscreen', onBegin);
    video.addEventListener('webkitendfullscreen', onEnd);
    video.addEventListener('volumechange', onVolume);
}

/**
 * The in-app fullscreen for a camera tile (route 3), keyed by whose camera.
 * Published on <html data-media-fullscreen> so the phone layout lets a fixed
 * tile reach the viewport (phoneLandscape.css); Escape leaves it, and so does
 * the camera going away (`isLive` false): a key left behind would keep the
 * page in that state with no tile on screen.
 */
export function useAppMediaFullscreen(
    isLive: (key: number) => boolean,
    onLeave?: () => void,
): [number | null, (key: number | null) => void] {
    const [raw, setKey] = useState<number | null>(null);
    const key = raw !== null && isLive(raw) ? raw : null;
    const leaveRef = useRef(onLeave);
    useEffect(() => { leaveRef.current = onLeave; });
    useLayoutEffect(() => {
        if (key === null) return;
        const root = document.documentElement;
        root.dataset.mediaFullscreen = 'on';
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setKey(null); };
        window.addEventListener('keydown', onKey);
        return () => {
            delete root.dataset.mediaFullscreen;
            window.removeEventListener('keydown', onKey);
            leaveRef.current?.();
        };
    }, [key]);
    return [key, setKey];
}
