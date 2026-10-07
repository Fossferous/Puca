/**
 * Púca's video player: a <video> with OUR controls instead of the engine's.
 * Every recorded video a person plays in Púca goes through it — a chat or DM
 * attachment (MessageContent), a posted clip (ClipAttachment), the approved
 * clip's preview before it is posted (ClipComposerModal) and a Task's video
 * (TaskAttachments). Live pictures (calls, streams, cameras, remote control)
 * are not recordings and keep their own surfaces.
 *
 * WHY (the owner, 2026-10-07): "videos should have volume selecter, full
 * screen icon and speed selecter". Chromium's own controls fold volume,
 * fullscreen and speed away on a narrow player — a portrait video in a chat
 * message is ~170 px wide — leaving play, a three-dot menu and the timeline. Here
 * the bar keeps volume, speed and fullscreen at EVERY width; what gives way
 * on a narrow player is the bar's play button (the big one in the middle of
 * the picture plays and pauses instead) and the total time. See
 * videoPlayerModel.ts for the rules themselves.
 *
 * What it keeps from before, deliberately:
 *  - Nothing plays by itself. There is no autoplay, and play() is only ever
 *    called from a person's click, tap or key here (a clip's own Play button
 *    calls it in ClipAttachment, as before).
 *  - The caller's ref still gets the element (Output Device routing:
 *    followOutputDeviceRef / useOutputDeviceRef), and every media event the
 *    caller listened to still reaches it.
 *  - The volume is this video's level TIMES Settings > Output Volume, applied
 *    again whenever Settings change, so the master is never bypassed.
 *
 * Touch: a tap on the picture shows or hides the controls (a tap on the
 * picture never plays — that is the centre button), they hide by themselves
 * while it plays, every control is at least 44 px on a touch screen, and the
 * timeline lets a vertical swipe scroll the chat (touch-action: pan-y) and
 * only seeks on a tap or a sideways drag. The volume and speed panels open in
 * the top layer, placed inside the window, so a 390 px phone column, the
 * message list's edges and fullscreen never clip them.
 *
 * Keyboard (only while focus is inside the player): Space / K play-pause,
 * ← / → seek 5 s, ↑ / ↓ volume, M mute, F fullscreen, Esc closes a panel or
 * leaves fullscreen.
 *
 * Fullscreen is the player's own frame, so these controls stay with the
 * picture (elementFullscreen.ts says where the real Fullscreen API is used
 * and where the player fills the app's view itself). The caller hears about
 * it (onFullscreenChange) so a fullscreen video's decrypted copy and its
 * player are held like a playing one.
 *
 * A covered player (inside a spoiler not yet revealed) is inert: nothing in
 * it can be focused or pressed until the spoiler is revealed.
 */
import {
    useCallback, useEffect, useLayoutEffect, useRef, useState,
    type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent,
    type ReactNode, type RefObject, type SyntheticEvent,
} from 'react';
import { outputGain } from './settingsStore';
import { useLayerOnScreen } from './portalTarget';
import { interceptBack } from '../api/mobileApp';
import { isAndroidApp } from '../api/platform';
import { holdSystemBarsHidden } from '../api/systemBars';
import { FullscreenExitIcon, FullscreenIcon, PauseIcon, PlayIcon, SpeakerIcon, SpeakerLowIcon, SpeakerOffIcon } from './Icons';
import {
    PLAYBACK_RATES, clamp01, clampTime, effectiveVolume, formatTime, keyAction, knownDuration, rateLabel,
    rememberRate, rememberVolume, rememberedRate, rememberedVolume, sizeFor,
    type KeyTarget, type PlayerKey, type PlayerSize,
} from './videoPlayerModel';
import {
    canRequestFullscreen, exitElementFullscreen, fullscreenElement, onFullscreenChange as onDocFullscreenChange,
    requestElementFullscreen,
} from './elementFullscreen';
import './VideoPlayer.css';

type MediaHandler = (e: SyntheticEvent<HTMLVideoElement>) => void;
/** none; the Fullscreen API ('native'); or the player filling the app's own
 *  view ('app', the Android/iOS apps and any refused request). */
type FsMode = 'none' | 'native' | 'app';
type Panel = 'none' | 'volume' | 'speed';

export interface VideoPlayerProps {
    /** The file's URL. Omitted for a player that sets its own source (a
     *  clip's MediaSource, attached through `videoRef`). */
    src?: string;
    /** The file's name: the player's accessible name, and the element's
     *  title as before. */
    title: string;
    /** Gets the <video> element, as a callback ref (React 19: it may return
     *  its cleanup) — followOutputDeviceRef, useOutputDeviceRef's. */
    videoRef?: (el: HTMLVideoElement | null) => (() => void) | void;
    videoClassName?: string;
    videoStyle?: CSSProperties;
    /** Classes and style for the player's frame — the box the picture and
     *  the controls share (a chat video's `video-box`). */
    frameClassName?: string;
    frameStyle?: CSSProperties;
    preload?: 'none' | 'metadata' | 'auto';
    /** Seconds, for a source that does not know its length yet (MSE). */
    durationHint?: number;
    /** Remembers this video's speed for the session (videoPlayerModel). */
    memoryKey?: string;
    /** Covered by an unrevealed spoiler: inert. */
    covered?: boolean;
    onPlay?: MediaHandler;
    onPause?: MediaHandler;
    onEnded?: MediaHandler;
    onTimeUpdate?: MediaHandler;
    onLoadedMetadata?: MediaHandler;
    onError?: MediaHandler;
    /** True while the player is fullscreen (either kind). */
    onFullscreenChange?: (fullscreen: boolean) => void;
    /** Drawn over the picture, under the controls (a clip's loading readout). */
    children?: ReactNode;
}

/** Speed applied so that it survives the element (re)loading its source:
 *  load() resets playbackRate to defaultPlaybackRate. Pitch is kept. */
function applyRate(v: HTMLVideoElement, rate: number): void {
    try {
        v.defaultPlaybackRate = rate;
        v.playbackRate = rate;
    } catch {
        /* an engine refusing a rate keeps the one it has */
    }
    const p = v as HTMLVideoElement & { webkitPreservesPitch?: boolean; mozPreservesPitch?: boolean };
    p.preservesPitch = true;
    if ('webkitPreservesPitch' in p) p.webkitPreservesPitch = true;
    if ('mozPreservesPitch' in p) p.mozPreservesPitch = true;
}

/** How far the file is loaded from where the playhead is. */
function bufferedEnd(v: HTMLVideoElement): number {
    const b = v.buffered;
    if (!b) return 0;
    for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= v.currentTime + 0.25 && v.currentTime <= b.end(i)) return b.end(i);
    }
    return 0;
}

/** play() without an unhandled rejection: a refusal (no gesture, the source
 *  went away) just leaves it paused, with the controls there to try again. */
function playSafely(v: HTMLVideoElement): void {
    try {
        const p = v.play() as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => { /* stays paused */ });
    } catch {
        /* stays paused */
    }
}

const HIDE_AFTER_MS = 2500;

/**
 * A transparent 1x1 GIF: the poster of every video in the ANDROID app.
 * Without a poster, the Android WebView paints its own default one — a large
 * grey frame with a black ring and a play triangle — until playback starts
 * (a seek while paused does not clear it either), and its triangle sat 22 px
 * from Púca's centre Play button: two offset play icons on every video
 * (review finding 2026-10-07, measured on the emulator). Transparent, the
 * player's own black shows instead. Never set elsewhere: the desktop app and
 * the web show the video's first frame, which any poster would hide. The
 * app's CSP allows data: images (scripts/cap-index-csp.mjs).
 */
const ANDROID_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function VideoPlayer(props: VideoPlayerProps) {
    const {
        src, title, videoRef, videoClassName, videoStyle, frameClassName, frameStyle,
        preload = 'metadata', durationHint, memoryKey, covered = false, children,
        onPlay, onPause, onEnded, onTimeUpdate, onLoadedMetadata, onError,
    } = props;
    const frameRef = useRef<HTMLSpanElement | null>(null);
    const videoEl = useRef<HTMLVideoElement | null>(null);
    const [video, setVideo] = useState<HTMLVideoElement | null>(null);
    const [paused, setPaused] = useState(true);
    const [time, setTime] = useState(0);
    const [elDuration, setElDuration] = useState(NaN);
    const [loaded, setLoaded] = useState(0);
    const [volume, setVolume] = useState(() => rememberedVolume().volume);
    const [muted, setMuted] = useState(() => rememberedVolume().muted);
    const [master, setMaster] = useState(() => outputGain());
    const [rate, setRate] = useState(() => rememberedRate(memoryKey));
    const [fs, setFs] = useState<FsMode>('none');
    const [shown, setShown] = useState(true);
    const [panel, setPanel] = useState<Panel>('none');
    /** Where the timeline is being dragged to (0..1), or null. */
    const [scrub, setScrub] = useState<number | null>(null);
    const [size, setSize] = useState<PlayerSize>('medium');
    const [short, setShort] = useState(false);
    /** Bumped by any interaction: restarts the auto-hide timer. */
    const [poke, setPoke] = useState(0);
    const lastPointer = useRef<string>('mouse');
    const volumeBtn = useRef<HTMLButtonElement | null>(null);
    const speedBtn = useRef<HTMLButtonElement | null>(null);
    const fsBtn = useRef<HTMLButtonElement | null>(null);
    /** The press on the picture that closed an open panel (VpPanel's press
     *  outside it): its click only closes, it does not also play or pause.
     *  The native event itself, so the next press — this one's click never
     *  came (dragged off) — forgets it. */
    const dismissPress = useRef<Event | null>(null);
    const lastSeekAt = useRef(Number.NEGATIVE_INFINITY);
    const lastWakeAt = useRef(Number.NEGATIVE_INFINITY);

    const duration = knownDuration(elDuration, durationHint);
    const canSeek = Number.isFinite(duration) && duration > 0;

    // The caller's ref and ours, on one element. A callback ref's cleanup
    // (React 19) runs instead of ref(null), so ours does both.
    const bindVideo = useCallback((el: HTMLVideoElement | null) => {
        videoEl.current = el;
        setVideo(el);
        if (!el) return undefined;
        const cleanup = videoRef?.(el);
        return () => {
            if (videoEl.current === el) videoEl.current = null;
            setVideo((cur) => (cur === el ? null : cur));
            if (typeof cleanup === 'function') cleanup();
            else videoRef?.(null);
        };
    }, [videoRef]);

    // Volume: this video's level times the master, and the mute. (`video`
    // is the dependency that re-applies it to a new element.)
    useEffect(() => {
        const el = videoEl.current;
        if (!el) return;
        el.volume = effectiveVolume(volume, master);
        el.muted = muted;
    }, [video, volume, muted, master]);
    // The master follows Settings while the player is up (a slider moved
    // in Settings during playback reaches this video at once).
    useEffect(() => {
        const on = () => setMaster(outputGain());
        window.addEventListener('settingsChanged', on);
        return () => window.removeEventListener('settingsChanged', on);
    }, []);
    // Speed.
    useEffect(() => {
        if (videoEl.current) applyRate(videoEl.current, rate);
    }, [video, rate]);

    // Real fullscreen entered or left (Esc, the browser's own UI, another
    // element taking it).
    useEffect(() => onDocFullscreenChange(() => {
        const el = fullscreenElement();
        setFs((m) => (el && el === frameRef.current ? 'native' : m === 'native' ? 'none' : m));
    }), []);
    // The caller hears while it lasts, and again when the player goes away
    // fullscreen (the cleanup), so its "in use" hold always ends.
    const onFsRef = useRef(props.onFullscreenChange);
    useLayoutEffect(() => { onFsRef.current = props.onFullscreenChange; });
    const isFs = fs !== 'none';
    useEffect(() => {
        if (!isFs) return;
        onFsRef.current?.(true);
        return () => onFsRef.current?.(false);
    }, [isFs]);
    // The in-app fullscreen: the frame put in the top layer (the Popover API,
    // in place — moving a <video> in the DOM pauses it), so no ancestor's
    // overflow, transform or stacking can cut it down; where that API is
    // missing, CSS position: fixed alone.
    const appFs = fs === 'app';
    useLayoutEffect(() => {
        const el = frameRef.current;
        if (!appFs || !el) return;
        let popped = false;
        if (typeof el.showPopover === 'function') {
            try { el.showPopover(); popped = true; } catch { /* fixed position alone */ }
        }
        return () => {
            if (popped) {
                try { el.hidePopover(); } catch { /* already hidden */ }
            }
        };
    }, [appFs]);

    // Measure the player itself, not the window.
    useLayoutEffect(() => {
        const el = frameRef.current;
        if (!el) return;
        const measure = () => {
            const r = el.getBoundingClientRect();
            if (r.width > 0) setSize(sizeFor(r.width));
            if (r.height > 0) setShort(r.height < 120);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Auto-hide while it plays (not while a panel is open or the timeline is
    // held). Paused, the controls stay.
    useEffect(() => {
        if (paused || !shown || panel !== 'none' || scrub !== null) return;
        const t = setTimeout(() => setShown(false), HIDE_AFTER_MS);
        return () => clearTimeout(t);
    }, [paused, shown, panel, scrub, poke]);

    const wake = () => { setShown(true); setPoke((n) => n + 1); };

    const togglePlay = () => {
        const v = videoEl.current;
        if (!v) return;
        if (v.paused || v.ended) playSafely(v);
        else v.pause();
        wake();
    };

    const seekTo = (t: number) => {
        const v = videoEl.current;
        if (!v || !canSeek) return;
        const to = clampTime(t, duration);
        try { v.currentTime = to; } catch { /* not seekable yet */ }
        setTime(to);
    };

    const changeVolume = (next: number, mute: boolean = muted) => {
        const vol = clamp01(next);
        // Raising the level unmutes, as on every player.
        const m = vol > volume && mute ? false : mute;
        setVolume(vol);
        setMuted(m);
        rememberVolume(vol, m);
    };

    const toggleMute = () => {
        if (muted || volume === 0) {
            // Unmuting a slider left at 0 would still be silent: half way.
            const vol = volume === 0 ? 0.5 : volume;
            setVolume(vol);
            setMuted(false);
            rememberVolume(vol, false);
        } else {
            setMuted(true);
            rememberVolume(volume, true);
        }
        wake();
    };

    const chooseRate = (r: number) => {
        setRate(r);
        rememberRate(memoryKey, r);
        const v = videoEl.current;
        if (v) applyRate(v, r);
    };

    const toggleFullscreen = () => {
        wake();
        // An open panel closes first, focus back on its button: the
        // fullscreen frame joins the top layer AFTER the panel and covered it,
        // leaving focus — and the arrow keys — in a panel nobody could see
        // (F pressed inside the volume panel; review finding 2026-10-07).
        if (panel !== 'none') closePanel(true);
        if (fs === 'app') { setFs('none'); return; }
        if (fs === 'native') { void exitElementFullscreen(); return; }
        const el = frameRef.current;
        if (!canRequestFullscreen(el)) { setFs('app'); return; }
        // Asked synchronously, inside the person's click or key press.
        void requestElementFullscreen(el).then((granted) => {
            if (!granted) { setFs('app'); return; }
            if (fullscreenElement() === el) setFs('native');
        });
    };

    const closePanel = (focusAnchor: boolean) => {
        const was = panel;
        setPanel('none');
        if (focusAnchor) (was === 'speed' ? speedBtn : volumeBtn).current?.focus({ preventScroll: true });
    };

    const run = (a: PlayerKey) => {
        switch (a.kind) {
            case 'toggle-play': togglePlay(); break;
            case 'seek': seekTo((videoEl.current?.currentTime ?? time) + a.by); wake(); break;
            case 'seek-to': seekTo(a.fraction * duration); wake(); break;
            case 'volume': changeVolume(volume + a.by); wake(); break;
            case 'mute': toggleMute(); break;
            case 'fullscreen': toggleFullscreen(); break;
            case 'escape':
                if (panel !== 'none') closePanel(true);
                else if (fs === 'app') setFs('none');
                else if (fs === 'native') void exitElementFullscreen();
                break;
        }
    };

    const onKeyDown = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
        const t = e.target as HTMLElement;
        const inPanel = t.closest('.vpl-panel');
        if (inPanel && e.key === 'Tab') { onPanelTab(e, inPanel); return; }
        if (t.closest('[role="menu"]')) { onMenuKey(e); return; }
        const where: KeyTarget = t.dataset.vplKey === 'seek' ? 'seek'
            : t.dataset.vplKey === 'volume' ? 'volume'
                : t.tagName === 'BUTTON' ? 'button' : 'surface';
        const a = keyAction(e, where);
        if (!a) return;
        // Esc with nothing to close or leave is not ours (a dialog around
        // the player may want it).
        if (a.kind === 'escape' && panel === 'none' && fs === 'none') return;
        e.preventDefault();
        e.stopPropagation();
        run(a);
    };

    // The speed menu: ↑ / ↓ / Home / End move between the speeds, Esc closes,
    // Enter / Space choose (the item is a button).
    const onMenuKey = (e: ReactKeyboardEvent<HTMLSpanElement>) => {
        const menu = (e.target as HTMLElement).closest('[role="menu"]');
        const items = menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')] : [];
        const i = items.indexOf(e.target as HTMLElement);
        let next = -1;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (i + 1) % items.length;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (i - 1 + items.length) % items.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = items.length - 1;
        else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePanel(true);
            return;
        } else {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        items[next]?.focus();
    };

    // Tab out of a panel: as if the panel came right after the button that
    // opened it (what a popover opened by its button does natively) — on to
    // what follows that button, or with Shift back to the button — and the
    // panel closes. Inside the volume panel, Tab moves between its Mute and
    // its slider as usual; the speed menu is one stop (its speeds are arrow
    // keys), so any Tab leaves it. Review finding 2026-10-07: Tab from the
    // volume slider left the player with the panel still open, and Shift+Tab
    // from its Mute landed on Full screen (the panels sit after the bar in
    // the DOM).
    const onPanelTab = (e: ReactKeyboardEvent<HTMLSpanElement>, panelEl: Element) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        const t = e.target as HTMLElement;
        const stops = [...panelEl.querySelectorAll<HTMLElement>('button, [role="slider"]')].filter((el) => el.tabIndex >= 0);
        const leaving = panelEl.getAttribute('role') === 'menu'
            || (e.shiftKey ? t === panelEl || t === stops[0] : t === stops[stops.length - 1]);
        if (!leaving) return;
        e.preventDefault();
        e.stopPropagation();
        const from = panel;
        setPanel('none');
        const to = e.shiftKey ? (from === 'speed' ? speedBtn : volumeBtn) : (from === 'speed' ? fsBtn : speedBtn);
        to.current?.focus({ preventScroll: true });
    };

    // The panels' own "press elsewhere" (VpPanel): a press on the picture
    // closes the panel and nothing else.
    const dismissPanel = (press?: Event) => {
        if (press && press.target === videoEl.current) dismissPress.current = press;
        closePanel(false);
    };

    // Leaving the in-app fullscreen from outside the player's own keys: Esc
    // wherever focus is, and Android's BACK gesture (with an APK that can
    // report it: api/mobileApp.ts interceptBack). An open panel closes first.
    const leaveAppFsRef = useRef<() => void>(() => {});
    useLayoutEffect(() => {
        leaveAppFsRef.current = () => {
            if (panel !== 'none') closePanel(false);
            else setFs('none');
        };
    });
    // Only while the player's layer is on screen: inside Púca Notes in the
    // desktop app, a player left fullscreen in the hidden view must not take
    // an Escape meant for the chat (components/portalTarget.ts).
    const onScreen = useLayerOnScreen();
    useEffect(() => {
        if (!appFs || !onScreen) return;
        const on = (e: KeyboardEvent) => {
            if (e.key !== 'Escape' || e.defaultPrevented) return;
            if (frameRef.current?.contains(e.target as Node)) return; // onKeyDown has it
            e.preventDefault();
            leaveAppFsRef.current();
        };
        document.addEventListener('keydown', on);
        return () => document.removeEventListener('keydown', on);
    }, [appFs, onScreen]);
    useEffect(() => {
        if (!appFs) return;
        return interceptBack(() => leaveAppFsRef.current());
    }, [appFs]);
    // The Android app's status and navigation bars go while it lasts: the
    // WebView sits between them, so without this the "full screen" video kept
    // a strip above and below it (api/systemBars.ts). Nothing elsewhere.
    useEffect(() => {
        if (!appFs) return;
        return holdSystemBarsHidden();
    }, [appFs]);

    // A tap on the picture shows or hides the controls; a click plays or
    // pauses (lastPointer is set as the press begins).
    const onSurfaceClick = () => {
        // The click of a press that closed an open panel: closing was all it
        // meant (review finding 2026-10-07: dismissing the speed menu by
        // clicking the picture also started the video).
        if (dismissPress.current) { dismissPress.current = null; return; }
        if (lastPointer.current === 'mouse' || lastPointer.current === 'pen') {
            togglePlay();
            return;
        }
        if (shown) setShown(false);
        else wake();
    };
    const onPointerDownCapture = (e: ReactPointerEvent) => {
        lastPointer.current = e.pointerType || 'mouse';
        // A later press: the dismissing one's click never came.
        if (dismissPress.current && dismissPress.current !== e.nativeEvent) dismissPress.current = null;
    };
    // A moving mouse shows the controls and restarts the hide timer — at
    // most four times a second, not one render per mouse event.
    const onPointerMove = (e: ReactPointerEvent) => {
        if (e.pointerType !== 'mouse') return;
        const now = performance.now();
        if (!shown || now - lastWakeAt.current > 250) {
            lastWakeAt.current = now;
            wake();
        }
    };
    const onPointerLeave = (e: ReactPointerEvent) => {
        if (e.pointerType === 'mouse' && !paused && panel === 'none' && scrub === null) setShown(false);
    };

    // The timeline: preview while held, the video follows (at most every
    // 120 ms while dragging — a clip seeks through its parts), and lands on
    // release.
    const onSeekScrub = (f: number, final: boolean, at: number) => {
        if (!canSeek) return;
        setScrub(final ? null : f);
        if (final || at - lastSeekAt.current > 120) {
            lastSeekAt.current = at;
            seekTo(f * duration);
        }
        wake();
    };

    const shownTime = scrub !== null && canSeek ? scrub * duration : time;
    const playedFrac = canSeek ? clamp01(shownTime / duration) : 0;
    const loadedFrac = canSeek ? clamp01(loaded / duration) : 0;
    const silent = muted || volume === 0;
    const VolIcon = silent ? SpeakerOffIcon : volume < 0.5 ? SpeakerLowIcon : SpeakerIcon;
    const pct = Math.round(volume * 100);
    const masterPct = Math.round(master * 100);
    const volumeText = `${pct}%${muted ? ', muted' : ''}`;
    const playLabel = paused ? 'Play' : 'Pause';
    const PlayGlyph = paused ? PlayIcon : PauseIcon;
    const fsLabel = isFs ? 'Exit full screen' : 'Full screen';
    // The wide bar has the slider: the speaker button mutes. Narrower, it
    // opens the volume panel (mute + slider).
    const volumeOpensPanel = size !== 'wide';

    return (
        <span
            ref={frameRef}
            className={`vpl${frameClassName ? ` ${frameClassName}` : ''}${isFs ? ' vpl-fs' : ''}${appFs ? ' vpl-app-fs' : ''}`}
            style={frameStyle}
            role="group"
            aria-label={`Video player: ${title}`}
            tabIndex={covered ? -1 : 0}
            inert={covered}
            popover={appFs ? 'manual' : undefined}
            data-paused={paused}
            data-shown={shown || panel !== 'none' || scrub !== null}
            data-size={size}
            data-short={short}
            data-fs={fs}
            onKeyDown={onKeyDown}
            onPointerDownCapture={onPointerDownCapture}
            onPointerMove={onPointerMove}
            onPointerLeave={onPointerLeave}
            // Nothing pressed in a player acts on what is around it (a
            // spoiler's toggle, a task row, a message).
            onClick={(e) => e.stopPropagation()}
        >
            <video
                ref={bindVideo}
                className={videoClassName}
                style={videoStyle}
                src={src}
                preload={preload}
                poster={isAndroidApp() ? ANDROID_POSTER : undefined}
                playsInline
                title={title}
                onClick={onSurfaceClick}
                onPlay={(e) => { setPaused(false); onPlay?.(e); }}
                onPause={(e) => { setPaused(true); setShown(true); onPause?.(e); }}
                onEnded={(e) => { setPaused(true); setShown(true); onEnded?.(e); }}
                onTimeUpdate={(e) => { setTime(e.currentTarget.currentTime); setLoaded(bufferedEnd(e.currentTarget)); onTimeUpdate?.(e); }}
                onSeeked={(e) => setTime(e.currentTarget.currentTime)}
                onProgress={(e) => setLoaded(bufferedEnd(e.currentTarget))}
                onDurationChange={(e) => setElDuration(e.currentTarget.duration)}
                onLoadedMetadata={(e) => {
                    const v = e.currentTarget;
                    setElDuration(v.duration);
                    applyRate(v, rate);
                    onLoadedMetadata?.(e);
                    setTime(v.currentTime);
                }}
                onEmptied={() => { setPaused(true); setTime(0); setElDuration(NaN); setLoaded(0); }}
                onVolumeChange={(e) => {
                    // Muted from outside (the engine's own menu, a media key):
                    // the button says so too.
                    if (e.currentTarget.muted !== muted) setMuted(e.currentTarget.muted);
                }}
                onError={onError}
            />
            {children}
            <button
                type="button"
                className="vpl-center"
                aria-label={playLabel}
                title={playLabel}
                onClick={togglePlay}
            >
                <PlayGlyph size={26} />
            </button>
            <span className="vpl-bar">
                <VpSlider
                    kind="seek"
                    className="vpl-seek"
                    label="Seek"
                    fraction={playedFrac}
                    loaded={loadedFrac}
                    disabled={!canSeek}
                    valueNow={Math.floor(shownTime)}
                    valueMax={canSeek ? Math.floor(duration) : 0}
                    valueText={canSeek ? `${formatTime(shownTime)} of ${formatTime(duration)}` : formatTime(shownTime)}
                    onScrub={onSeekScrub}
                    onCancel={() => setScrub(null)}
                />
                <span className="vpl-row">
                    <button type="button" className="vpl-btn vpl-play" aria-label={playLabel} title={playLabel} onClick={togglePlay}>
                        <PlayGlyph size={18} />
                    </button>
                    <span className="vpl-time" aria-hidden="true">
                        {formatTime(shownTime)}
                        {canSeek && <span className="vpl-time-total"> / {formatTime(duration)}</span>}
                    </span>
                    <span className="vpl-spacer" />
                    <button
                        ref={volumeBtn}
                        type="button"
                        className="vpl-btn vpl-volume"
                        aria-label={volumeOpensPanel ? `Volume, ${volumeText}` : (muted ? 'Unmute' : 'Mute')}
                        title={volumeOpensPanel ? `Volume ${volumeText}` : (muted ? 'Unmute (M)' : 'Mute (M)')}
                        aria-haspopup={volumeOpensPanel ? 'dialog' : undefined}
                        aria-expanded={volumeOpensPanel ? panel === 'volume' : undefined}
                        onClick={() => {
                            if (!volumeOpensPanel) { toggleMute(); return; }
                            setPanel((p) => (p === 'volume' ? 'none' : 'volume'));
                            wake();
                        }}
                    >
                        <VolIcon size={18} />
                    </button>
                    <VpSlider
                        kind="volume"
                        className="vpl-volume-inline"
                        label="Volume"
                        fraction={silent ? 0 : volume}
                        valueNow={silent ? 0 : pct}
                        valueMax={100}
                        valueText={masterPct < 100 ? `${volumeText}, Output Volume ${masterPct}%` : volumeText}
                        title={masterPct < 100 ? `Output Volume in Settings: ${masterPct}%` : undefined}
                        onScrub={(f) => { changeVolume(f, false); wake(); }}
                    />
                    <button
                        ref={speedBtn}
                        type="button"
                        className="vpl-btn vpl-speed"
                        aria-label={`Playback speed, ${rateLabel(rate)}`}
                        title="Playback speed"
                        aria-haspopup="menu"
                        aria-expanded={panel === 'speed'}
                        onClick={() => { setPanel((p) => (p === 'speed' ? 'none' : 'speed')); wake(); }}
                    >
                        {rateLabel(rate)}
                    </button>
                    <button ref={fsBtn} type="button" className="vpl-btn vpl-fullscreen" aria-label={fsLabel} title={`${fsLabel} (F)`} onClick={toggleFullscreen}>
                        {isFs ? <FullscreenExitIcon size={18} /> : <FullscreenIcon size={18} />}
                    </button>
                </span>
            </span>
            <VpPanel open={panel === 'volume'} anchor={volumeBtn} onDismiss={dismissPanel} role="dialog" label="Volume" className="vpl-panel-volume">
                <button type="button" className="vpl-panel-mute" onClick={toggleMute}>
                    <VolIcon size={18} /> {muted ? 'Unmute' : 'Mute'}
                </button>
                <VpSlider
                    kind="volume"
                    className="vpl-panel-slider"
                    label="Volume"
                    autoFocus
                    fraction={silent ? 0 : volume}
                    valueNow={silent ? 0 : pct}
                    valueMax={100}
                    valueText={masterPct < 100 ? `${volumeText}, Output Volume ${masterPct}%` : volumeText}
                    onScrub={(f) => { changeVolume(f, false); }}
                />
                <span className="vpl-panel-value" aria-hidden="true">{silent ? 0 : pct}%</span>
                {masterPct < 100 && <span className="vpl-panel-note">Output Volume in Settings: {masterPct}%</span>}
            </VpPanel>
            <VpPanel open={panel === 'speed'} anchor={speedBtn} onDismiss={dismissPanel} role="menu" label="Playback speed" className="vpl-panel-speed">
                {PLAYBACK_RATES.map((r) => (
                    <button
                        key={r}
                        type="button"
                        role="menuitemradio"
                        aria-checked={r === rate}
                        className="vpl-rate"
                        aria-label={r === 1 ? `${rateLabel(r)}, normal speed` : rateLabel(r)}
                        tabIndex={r === rate ? 0 : -1}
                        onClick={() => { chooseRate(r); closePanel(true); }}
                    >
                        {rateLabel(r)}
                    </button>
                ))}
            </VpPanel>
        </span>
    );
}

interface VpSliderProps {
    kind: 'seek' | 'volume';
    className: string;
    label: string;
    /** 0..1 */
    fraction: number;
    /** 0..1, the seek bar's loaded part. */
    loaded?: number;
    disabled?: boolean;
    valueNow: number;
    valueMax: number;
    valueText: string;
    title?: string;
    autoFocus?: boolean;
    /** A position while held (final=false) and where it was let go (true),
     *  with the pointer event's timestamp. */
    onScrub: (fraction: number, final: boolean, at: number) => void;
    onCancel?: () => void;
}

/**
 * A horizontal slider that a scrolling finger cannot move. A mouse acts at
 * once; a touch acts on a TAP (lifted where it went down) or once it has
 * moved sideways more than it has moved down. `touch-action: pan-y` hands a
 * vertical swipe to the page (the browser sends pointercancel), so swiping
 * the chat past a video never seeks it.
 */
function VpSlider({ kind, className, label, fraction, loaded, disabled = false, valueNow, valueMax, valueText, title, autoFocus, onScrub, onCancel }: VpSliderProps) {
    // The track's place is taken as the press begins and kept for the whole
    // drag: a label beside it that changes as the value does (Mute/Unmute)
    // must not move the scale under the finger.
    const drag = useRef<{ id: number; x0: number; y0: number; moving: boolean; left: number; width: number } | null>(null);
    const at = (clientX: number) => {
        const d = drag.current;
        return d && d.width > 0 ? clamp01((clientX - d.left) / d.width) : 0;
    };
    const ref = useRef<HTMLSpanElement | null>(null);
    useEffect(() => {
        if (autoFocus) ref.current?.focus({ preventScroll: true });
    }, [autoFocus]);
    return (
        <span
            ref={ref}
            className={`vpl-slider ${className}`}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={valueMax}
            aria-valuenow={valueNow}
            aria-valuetext={valueText}
            aria-disabled={disabled || undefined}
            aria-orientation="horizontal"
            title={title}
            data-vpl-key={kind}
            onPointerDown={(e) => {
                if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
                const mouse = e.pointerType === 'mouse' || e.pointerType === 'pen';
                const r = e.currentTarget.getBoundingClientRect();
                drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moving: mouse, left: r.left, width: r.width };
                try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
                if (mouse) onScrub(at(e.clientX), false, e.timeStamp);
            }}
            onPointerMove={(e) => {
                const d = drag.current;
                if (!d || d.id !== e.pointerId) return;
                if (!d.moving) {
                    const dx = Math.abs(e.clientX - d.x0);
                    const dy = Math.abs(e.clientY - d.y0);
                    if (dx < 8 || dx <= dy) return;
                    d.moving = true;
                }
                onScrub(at(e.clientX), false, e.timeStamp);
            }}
            onPointerUp={(e) => {
                const d = drag.current;
                if (!d || d.id !== e.pointerId) return;
                // A touch that wandered off downwards was a scroll the
                // browser did not take: nothing.
                if (d.moving || Math.abs(e.clientY - d.y0) < 10) onScrub(at(e.clientX), true, e.timeStamp);
                else onCancel?.();
                drag.current = null;
            }}
            onPointerCancel={() => {
                if (!drag.current) return;
                drag.current = null;
                onCancel?.();
            }}
        >
            <span className="vpl-track">
                {loaded !== undefined && <span className="vpl-track-loaded" style={{ width: `${loaded * 100}%` }} />}
                <span className="vpl-track-fill" style={{ width: `${fraction * 100}%` }} />
                <span className="vpl-thumb" style={{ left: `${fraction * 100}%` }} />
            </span>
        </span>
    );
}

interface VpPanelProps {
    open: boolean;
    anchor: RefObject<HTMLElement | null>;
    /** Closed from outside: a press elsewhere (that press), focus gone
     *  elsewhere, or its button out of sight. */
    onDismiss: (press?: Event) => void;
    role: 'dialog' | 'menu';
    label: string;
    className: string;
    children: ReactNode;
}

/**
 * The volume and speed panels. Shown in the top layer (the Popover API —
 * also above a fullscreen player) and placed against their button inside the
 * window, above it when there is room, else below; where the Popover API is
 * missing, `position: fixed` places them the same way. A press anywhere else
 * closes one; so does Esc (the player's key handler), Tab out of it (the
 * player's too), focus going anywhere outside it and its button, and its
 * button leaving the screen — scrolled out of the chat, say. Kept open and
 * pinned to the window's edge, it covered the app's header with its button
 * 364 px away (review finding 2026-10-07).
 */
function VpPanel({ open, anchor, onDismiss, role, label, className, children }: VpPanelProps) {
    const ref = useRef<HTMLSpanElement | null>(null);
    const dismissRef = useRef(onDismiss);
    useLayoutEffect(() => { dismissRef.current = onDismiss; });
    useLayoutEffect(() => {
        const el = ref.current;
        if (!open || !el) return;
        let popped = false;
        if (typeof el.showPopover === 'function') {
            try { el.showPopover(); popped = true; } catch { /* fixed position alone */ }
        }
        const place = () => {
            const a = anchor.current?.getBoundingClientRect();
            if (!a) return;
            const r = el.getBoundingClientRect();
            const vw = document.documentElement.clientWidth || window.innerWidth;
            const vh = document.documentElement.clientHeight || window.innerHeight;
            const gap = 6;
            let top = a.top - r.height - gap;
            if (top < gap) top = Math.min(a.bottom + gap, vh - r.height - gap);
            const left = Math.max(gap, Math.min(a.right - r.width, vw - r.width - gap));
            el.style.top = `${Math.max(gap, top)}px`;
            el.style.left = `${left}px`;
        };
        place();
        const focusIn = el.querySelector<HTMLElement>('[aria-checked="true"]');
        focusIn?.focus({ preventScroll: true });
        const onDown = (e: PointerEvent) => {
            const t = e.target as Node;
            if (el.contains(t) || anchor.current?.contains(t)) return;
            dismissRef.current(e);
        };
        document.addEventListener('pointerdown', onDown, true);
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        // Its button out of sight — the viewport AND every scrolling box
        // around it, which an IntersectionObserver takes into account (a
        // fullscreen player is in the top layer, clipped by nothing but the
        // screen) — closes it. Partly hidden is still there to place against.
        let io: IntersectionObserver | null = null;
        const a = anchor.current;
        if (a && typeof IntersectionObserver !== 'undefined') {
            io = new IntersectionObserver((entries) => {
                const last = entries[entries.length - 1];
                if (last && !last.isIntersecting) dismissRef.current();
            });
            io.observe(a);
        }
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
            io?.disconnect();
            if (popped) {
                try { el.hidePopover(); } catch { /* already hidden */ }
            }
        };
    }, [open, anchor]);
    if (!open) return null;
    return (
        <span
            ref={ref}
            className={`vpl-panel ${className}`}
            role={role}
            aria-label={label}
            popover="manual"
            // Focusable (not tabbable): a press on its own blank space or
            // text focuses the panel, not the player around it — which would
            // read as focus leaving it.
            tabIndex={-1}
            onBlur={(e) => {
                const to = e.relatedTarget;
                if (!(to instanceof Node)) return; // to another window, or nowhere
                if (e.currentTarget.contains(to) || anchor.current?.contains(to)) return;
                dismissRef.current();
            }}
        >
            {children}
        </span>
    );
}
