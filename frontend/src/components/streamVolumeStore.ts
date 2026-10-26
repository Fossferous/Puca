// Per-streamer stream-audio volume/mute preferences, persisted in localStorage.
// Separate from userVolumeStore (voice volume): you may want a friend's mic at
// 100% but their game audio at 40%.
//
// A stream's LEVEL is the Stream Volume slider's position, 0-200 %, and the
// slider follows loudness (streamGain): square-law up to 100 %, then even in
// decibels up to +6 dB at 200 %. A linear gain put most of what you can hear
// into the bottom tenth of the slider (1 -> 2 % was +6 dB, 50 -> 51 % +0.17).
//
// Keyed by the STREAMER'S USER ID, never by a share or a track: the level set
// for someone is the level of every stream of theirs you watch on this
// device, on the stage and in the small player alike (each stream through
// its own gain), after a reload too. Someone you have never set is SEEDED,
// the first time you watch them, with the LAST level you set on anyone (100 %
// before you have set any) — once, and then it is theirs: setting someone
// else later never moves them. Mute stays per person, unseeded.
// Pinned by src/tests/streamVolumeRemembered.test.tsx and
// src/tests/streamVolumeCurve.test.ts.

/** Levels as slider positions, and the last one set: `{ levels, last }`. */
const LEVELS_KEY = 'sovereign_stream_levels';
/** Before the loudness curve: linear percentages, `{ [userId]: percent }`.
 *  Read ONCE, to convert, and left as it is: a web app rolled back to a
 *  release before the curve still finds the levels it knows. */
const LEGACY_VOLUMES_KEY = 'sovereign_stream_volumes';
const STREAM_MUTES_KEY = 'sovereign_stream_mutes';

export const DEFAULT_STREAM_VOLUME = 100;
export const MAX_STREAM_VOLUME = 200;

/**
 * The gain a slider position plays at: (p/100)^2 up to 100 % (50 % is
 * -12 dB, 10 % -40 dB), then 2^((p-100)/100) above it (150 % is +3 dB, 200 %
 * +6 dB, the 2x the boost always had). 0 is silence, 100 is unity.
 */
export function streamGain(level: number): number {
    if (!Number.isFinite(level) || level <= 0) return 0;
    const p = Math.min(level, MAX_STREAM_VOLUME);
    return p <= 100 ? (p / 100) ** 2 : 2 ** ((p - 100) / 100);
}

/** The slider position that plays at linear `gain` (streamGain's inverse). */
export function levelForGain(gain: number): number {
    if (!Number.isFinite(gain) || gain <= 0) return 0;
    const p = gain <= 1 ? 100 * Math.sqrt(gain) : 100 + 100 * Math.log2(gain);
    return Math.min(MAX_STREAM_VOLUME, p);
}

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

interface LevelsRecord {
    /** userId -> slider position, 0..MAX_STREAM_VOLUME. */
    levels: Record<string, number>;
    /** The level last SET on any stream; seeding never changes it. */
    last?: number;
}

const toLevel = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(MAX_STREAM_VOLUME, v)) : null;

function sanitize(raw: unknown): LevelsRecord {
    const out: LevelsRecord = { levels: {} };
    if (!raw || typeof raw !== 'object') return out;
    const r = raw as { levels?: unknown; last?: unknown };
    if (r.levels && typeof r.levels === 'object') {
        for (const [id, v] of Object.entries(r.levels as Record<string, unknown>)) {
            const level = toLevel(v);
            if (level !== null) out.levels[id] = level;
        }
    }
    const last = toLevel(r.last);
    if (last !== null) out.last = last;
    return out;
}

/**
 * The levels from before the curve, converted so that each plays at exactly
 * the gain it played at (a linear p % was gain p/100). A pure function of the
 * legacy key, which is never written: converting again gives the same answer.
 */
function convertLegacy(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
        const stored = localStorage.getItem(LEGACY_VOLUMES_KEY);
        const old: unknown = stored ? JSON.parse(stored) : null;
        if (old && typeof old === 'object') {
            for (const [id, v] of Object.entries(old as Record<string, unknown>)) {
                const percent = toLevel(v);
                if (percent !== null) out[id] = levelForGain(percent / 100);
            }
        }
    } catch { /* nothing usable: those people start afresh */ }
    return out;
}

/**
 * The record, converting the pre-curve levels the first time this device
 * reads it. The record's existence is the mark that the conversion is done:
 * once it is written nothing reads the legacy key again, so a level is never
 * converted twice, and nothing anyone set plays louder or quieter for it.
 */
function readRecord(): LevelsRecord {
    let stored: string | null;
    try {
        stored = localStorage.getItem(LEVELS_KEY);
    } catch {
        return { levels: {} };
    }
    if (stored !== null) {
        try {
            return sanitize(JSON.parse(stored));
        } catch { /* unreadable: rebuilt from the legacy levels below */ }
    }
    const record: LevelsRecord = { levels: convertLegacy() };
    try {
        localStorage.setItem(LEVELS_KEY, JSON.stringify(record));
    } catch { /* not written: converted again next time, from the same source */ }
    return record;
}

/** Every remembered level (slider positions), by user id. */
export function getStreamVolumes(): Record<number, number> {
    return readRecord().levels as Record<number, number>;
}

/** The level last set on any stream, or null if none ever was. */
export function getLastStreamVolume(): number | null {
    return readRecord().last ?? null;
}

/** The user set `userId`'s level: theirs from now on, and the last level. */
export function setStreamVolume(userId: number, level: number) {
    const record = readRecord();
    const v = toLevel(level) ?? DEFAULT_STREAM_VOLUME;
    record.levels[String(userId)] = v;
    record.last = v;
    localStorage.setItem(LEVELS_KEY, JSON.stringify(record));
}

/**
 * Give everyone in `userIds` without a level of their own one: the last
 * level set on any stream (100 % before any was). Called when streams start
 * being watched, so a person's FIRST level is seeded once and kept — a later
 * change to someone else (which moves the last level) never moves theirs.
 */
export function seedStreamVolumes(userIds: readonly number[]): void {
    if (userIds.length === 0) return;
    const record = readRecord();
    const seed = record.last ?? DEFAULT_STREAM_VOLUME;
    let changed = false;
    for (const id of userIds) {
        const key = String(id);
        if (key in record.levels) continue;
        record.levels[key] = seed;
        changed = true;
    }
    if (!changed) return;
    try {
        localStorage.setItem(LEVELS_KEY, JSON.stringify(record));
    } catch { /* not kept: seeded again from the same last level next time */ }
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
