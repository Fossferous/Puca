/**
 * The decisions behind Púca's own video controls (components/VideoPlayer.tsx),
 * kept apart from React so each one can be tested on its own.
 *
 * WHY OUR OWN CONTROLS. The owner, 2026-10-07, with a screenshot of a
 * portrait .mp4 in a chat message: "videos should have volume selecter, full
 * screen icon and speed selecter". Chromium's native controls drop or fold
 * away exactly those three on a narrow player (a 9:16 video under the 300 px
 * height cap is ~169 px wide): play, a three-dot overflow menu and the timeline were
 * all that was left. Our controls keep volume, speed and fullscreen on the
 * player at every width (VideoPlayer.css).
 *
 * VOLUME COMPOSES WITH SETTINGS. The player's own level is the user's level
 * for THIS video; Settings > Output Volume is the master. What reaches the
 * element is their product (`effectiveVolume`), so turning the master down
 * turns every video down, a video's slider never overrides the master, and
 * a master change reaches a video that is already playing.
 */

/** The speeds offered, slowest first. 1 is the default. */
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** ← / → move the playhead this many seconds. */
export const SEEK_STEP_S = 5;

/** ↑ / ↓ move the volume this much (0..1). */
export const VOLUME_STEP = 0.05;

export function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/** What the element's `volume` must be: this video's level times the master
 *  Output Volume, both 0..1. */
export function effectiveVolume(videoVolume: number, master: number): number {
    return clamp01(clamp01(videoVolume) * clamp01(master));
}

/** 0:05, 1:05, 12:34, 1:02:03. A time the element cannot know yet (a stream
 *  with no duration, NaN before the metadata) reads as 0:00. */
export function formatTime(seconds: number): string {
    const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1×", "0.5×", "1.25×" — the speed button's label. */
export function rateLabel(rate: number): string {
    return `${Number(rate.toFixed(2))}×`;
}

/** The duration to show and seek against: the element's own once it knows
 *  it, else the hint (a clip's manifest knows its length before MSE does). */
export function knownDuration(elementDuration: number, hint?: number): number {
    if (Number.isFinite(elementDuration) && elementDuration > 0) return elementDuration;
    if (hint !== undefined && Number.isFinite(hint) && hint > 0) return hint;
    return NaN;
}

/** A seek target kept inside the video. */
export function clampTime(t: number, duration: number): number {
    if (!Number.isFinite(t) || t < 0) return 0;
    return Number.isFinite(duration) ? Math.min(t, duration) : t;
}

/* ==========================================================================
   Keyboard. Handled only while focus is INSIDE the player (its own keydown
   handler), so the message box, the remote-control stage and every other
   shortcut never see a key taken from them.
   ========================================================================== */

export type PlayerKey =
    | { kind: 'toggle-play' }
    | { kind: 'seek'; by: number }
    | { kind: 'seek-to'; fraction: number }
    | { kind: 'volume'; by: number }
    | { kind: 'mute' }
    | { kind: 'fullscreen' }
    | { kind: 'escape' };

/** Where the key was pressed inside the player: the picture itself (or the
 *  player's own frame), one of its buttons, its timeline or its volume
 *  slider. A menu handles its own keys. */
export type KeyTarget = 'surface' | 'button' | 'seek' | 'volume';

export interface KeyLike {
    key: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
}

/**
 * The player's shortcuts: Space / K play-pause, ← / → seek 5 s, ↑ / ↓ volume
 * 5 %, M mute, F fullscreen, Esc leaves fullscreen. Home / End jump to the
 * start / end on the timeline. On the volume slider every arrow is the
 * volume (it is that slider's own axis). A key with Ctrl, Cmd or Alt is never
 * ours (Ctrl+F stays find, Alt+← stays back). Space on a BUTTON presses that
 * button, as everywhere else, so it is not taken here.
 */
export function keyAction(e: KeyLike, target: KeyTarget): PlayerKey | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    const k = e.key;
    if (k === 'Escape') return { kind: 'escape' };
    if (k === ' ' || k === 'Spacebar') return target === 'button' ? null : { kind: 'toggle-play' };
    switch (k.length === 1 ? k.toLowerCase() : k) {
        case 'k': return { kind: 'toggle-play' };
        case 'm': return { kind: 'mute' };
        case 'f': return { kind: 'fullscreen' };
        case 'ArrowLeft':
        case 'Left':
            return target === 'volume' ? { kind: 'volume', by: -VOLUME_STEP } : { kind: 'seek', by: -SEEK_STEP_S };
        case 'ArrowRight':
        case 'Right':
            return target === 'volume' ? { kind: 'volume', by: VOLUME_STEP } : { kind: 'seek', by: SEEK_STEP_S };
        case 'ArrowUp':
        case 'Up':
            return { kind: 'volume', by: VOLUME_STEP };
        case 'ArrowDown':
        case 'Down':
            return { kind: 'volume', by: -VOLUME_STEP };
        case 'Home':
            return target === 'seek' ? { kind: 'seek-to', fraction: 0 } : target === 'volume' ? { kind: 'volume', by: -1 } : null;
        case 'End':
            return target === 'seek' ? { kind: 'seek-to', fraction: 1 } : target === 'volume' ? { kind: 'volume', by: 1 } : null;
        default:
            return null;
    }
}

/* ==========================================================================
   What a player starts with. Remembered for this session only, in memory:
   no stored setting (a stored value would need a control in Settings).
    - Volume and mute are the reader's surroundings, so the last level set on
      any video is where the next one starts.
    - Speed belongs to one video: a 2x lecture does not make the next clip
      fast. A video keeps its speed when its player is handed back and given
      again (MessageContent mounts only the few players nearest the screen).
   ========================================================================== */

let sessionVolume = 1;
let sessionMuted = false;
const sessionRates = new Map<string, number>();
/** Enough for a long session of scrolling; the oldest are forgotten first. */
const MAX_REMEMBERED_RATES = 200;

export function rememberedVolume(): { volume: number; muted: boolean } {
    return { volume: sessionVolume, muted: sessionMuted };
}

export function rememberVolume(volume: number, muted: boolean): void {
    sessionVolume = clamp01(volume);
    sessionMuted = muted;
}

export function rememberedRate(key: string | undefined): number {
    return (key !== undefined && sessionRates.get(key)) || 1;
}

export function rememberRate(key: string | undefined, rate: number): void {
    if (key === undefined) return;
    sessionRates.delete(key);
    if (rate === 1) return;
    sessionRates.set(key, rate);
    if (sessionRates.size > MAX_REMEMBERED_RATES) {
        const oldest = sessionRates.keys().next().value;
        if (oldest !== undefined) sessionRates.delete(oldest);
    }
}

/** Tests only: forget the session. */
export function __resetVideoPlayerMemory(): void {
    sessionVolume = 1;
    sessionMuted = false;
    sessionRates.clear();
}

/** How much of the player's width its controls get. Measured on the
 *  player's own box (ResizeObserver), never the window: a 170 px portrait
 *  video on a 1920 px desktop is the narrow case.
 *  - narrow: the picture's centre button plays and pauses; the bar keeps
 *    volume, speed and fullscreen and the current time.
 *  - medium: the bar adds play/pause and the total time.
 *  - wide:   the volume slider sits in the bar (the speaker button mutes);
 *    otherwise the speaker button opens the volume panel. */
export type PlayerSize = 'narrow' | 'medium' | 'wide';
export const MEDIUM_MIN_PX = 260;
export const WIDE_MIN_PX = 360;

export function sizeFor(width: number): PlayerSize {
    if (width >= WIDE_MIN_PX) return 'wide';
    if (width >= MEDIUM_MIN_PX) return 'medium';
    return 'narrow';
}
