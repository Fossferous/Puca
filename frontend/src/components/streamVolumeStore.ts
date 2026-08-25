// Per-streamer stream-audio volume/mute preferences, persisted in localStorage.
// Separate from userVolumeStore (voice volume): you may want a friend's mic at
// 100% but their game audio at 40%. Volume range is 0-200 (%) —
// values above 100 are a boost applied via a Web Audio GainNode in StreamStage.

const STREAM_VOLUMES_KEY = 'sovereign_stream_volumes';
const STREAM_MUTES_KEY = 'sovereign_stream_mutes';

export const DEFAULT_STREAM_VOLUME = 100;
export const MAX_STREAM_VOLUME = 200;

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
