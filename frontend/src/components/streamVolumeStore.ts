// Per-streamer stream-audio volume/mute preferences, persisted in localStorage.
// Separate from userVolumeStore (voice volume): you may want a friend's mic at
// 100% but their game audio at 40%. Volume range is 0-200 (%) —
// values above 100 are a boost applied via a Web Audio GainNode in StreamStage.
//
// Keyed by the STREAMER'S USER ID, never by a share or a track: the level set
// for someone is the level of every stream of theirs you watch on this
// device — after you stop and watch again, a new share of theirs, the stage
// or the small player over chat (StreamAudioHost reads it too, up to 100%:
// an element cannot boost), a reload. Someone never set plays at
// DEFAULT_STREAM_VOLUME. Pinned by src/tests/streamVolumeRemembered.test.tsx.

const STREAM_VOLUMES_KEY = 'sovereign_stream_volumes';
const STREAM_MUTES_KEY = 'sovereign_stream_mutes';

export const DEFAULT_STREAM_VOLUME = 100;
export const MAX_STREAM_VOLUME = 200;

/** The Stream Volume slider's step, in percent (it was 5). */
export const STREAM_VOLUME_STEP = 1;
/** Page Up / Page Down on the slider, in percent. */
export const STREAM_VOLUME_PAGE_STEP = 10;

/**
 * Where a key pressed on the Stream Volume slider takes its level (0..max,
 * whole percent), or null for a key the slider leaves alone. Arrows move it
 * one step, Page Up / Page Down ten, Home / End to the ends. A key held with
 * Ctrl, Cmd or Alt is never the slider's (Alt+Left stays Back).
 *
 * Handled here rather than left to the browser: a native range moves Page Up
 * / Page Down by a TENTH OF ITS RANGE, 20% on this 0-200% slider (measured in
 * headless Chromium and Firefox, 2026-10-26: 100 -> 120 / 80 whatever the
 * step), and jsdom moves it not at all.
 */
export function streamVolumeKeyStep(
    e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean },
    level: number,
    max: number,
): number | null {
    if (e.ctrlKey || e.metaKey || e.altKey) return null;
    let next: number;
    switch (e.key) {
        case 'ArrowUp':
        case 'ArrowRight':
            next = level + STREAM_VOLUME_STEP;
            break;
        case 'ArrowDown':
        case 'ArrowLeft':
            next = level - STREAM_VOLUME_STEP;
            break;
        case 'PageUp':
            next = level + STREAM_VOLUME_PAGE_STEP;
            break;
        case 'PageDown':
            next = level - STREAM_VOLUME_PAGE_STEP;
            break;
        case 'Home':
            next = 0;
            break;
        case 'End':
            next = max;
            break;
        default:
            return null;
    }
    return Math.max(0, Math.min(max, Math.round(next)));
}

export function getStreamVolumes(): Record<number, number> {
    try {
        const stored = localStorage.getItem(STREAM_VOLUMES_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

export function setStreamVolume(userId: number, volume: number) {
    const volumes = getStreamVolumes();
    volumes[userId] = Math.max(0, Math.min(MAX_STREAM_VOLUME, volume));
    localStorage.setItem(STREAM_VOLUMES_KEY, JSON.stringify(volumes));
}

export function getStreamMutes(): Record<number, boolean> {
    try {
        const stored = localStorage.getItem(STREAM_MUTES_KEY);
        return stored ? JSON.parse(stored) : {};
    } catch {
        return {};
    }
}

export function setStreamMuted(userId: number, muted: boolean) {
    const mutes = getStreamMutes();
    mutes[userId] = muted;
    localStorage.setItem(STREAM_MUTES_KEY, JSON.stringify(mutes));
}

// --- Stream attenuation: auto-duck stream audio while people
// in the voice channel are talking. Global preference, not per-streamer. ---

const ATTENUATION_KEY = 'sovereign_stream_attenuation';

export interface AttenuationSettings {
    enabled: boolean;
    /** How much to duck: 0 = no reduction, 1 = fully silent while talking. */
    strength: number;
}

const DEFAULT_ATTENUATION: AttenuationSettings = { enabled: true, strength: 0.5 };

export function getAttenuation(): AttenuationSettings {
    try {
        const stored = localStorage.getItem(ATTENUATION_KEY);
        return stored ? { ...DEFAULT_ATTENUATION, ...JSON.parse(stored) } : { ...DEFAULT_ATTENUATION };
    } catch {
        return { ...DEFAULT_ATTENUATION };
    }
}

export function setAttenuation(settings: AttenuationSettings) {
    localStorage.setItem(ATTENUATION_KEY, JSON.stringify(settings));
}
