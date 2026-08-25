/**
 * Clip quality presets + the memory readout math. PURE.
 *
 * Bitrates were chosen from the Phase 0 spike on this repo's reference desktop
 * (WebView2 151, hardware H.264 via Media Foundation): a busy 1080p30 game
 * scene at 6 Mbps VBR is visually clean and one minute costs ~46 MB of ring.
 * The numbers are targets the encoder is asked for, not guarantees — the pill
 * shows the MEASURED kbps while armed.
 */

export type ClipPresetId = '720p30' | '720p60' | '1080p30' | '1080p60' | '1440p30' | '2160p30' | 'native';

export interface ClipPreset {
    id: ClipPresetId;
    label: string;
    /** Capture is CONSTRAINED to at most this geometry (getDisplayMedia max width/height). */
    maxWidth: number;
    maxHeight: number;
    fps: number;
    videoBitrate: number; // bps
    audioBitrate: number; // bps
}

export const CLIP_PRESETS: readonly ClipPreset[] = [
    { id: '720p30', label: '720p 30 fps — about 3.5 Mbps', maxWidth: 1280, maxHeight: 720, fps: 30, videoBitrate: 3_500_000, audioBitrate: 128_000 },
    // 720p60: smoothness on a budget — the low-RAM answer to "my game is 60fps".
    { id: '720p60', label: '720p 60 fps — about 5 Mbps', maxWidth: 1280, maxHeight: 720, fps: 60, videoBitrate: 5_000_000, audioBitrate: 128_000 },
    { id: '1080p30', label: '1080p 30 fps — about 6 Mbps', maxWidth: 1920, maxHeight: 1080, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    { id: '1080p60', label: '1080p 60 fps — about 9 Mbps', maxWidth: 1920, maxHeight: 1080, fps: 60, videoBitrate: 9_000_000, audioBitrate: 128_000 },
    { id: '1440p30', label: '1440p 30 fps — about 10 Mbps', maxWidth: 2560, maxHeight: 1440, fps: 30, videoBitrate: 10_000_000, audioBitrate: 128_000 },
    // 2160p30: 18 Mbps sits under clip_capture.rs's 20 Mbps scale_bitrate
    // clamp, so a native auto-arm of a real 4K monitor is not silently capped
    // below what the preset promises.
    { id: '2160p30', label: '4K 30 fps — about 18 Mbps', maxWidth: 3840, maxHeight: 2160, fps: 30, videoBitrate: 18_000_000, audioBitrate: 160_000 },
    { id: 'native', label: 'Native (up to 1440p 60 fps) — about 14 Mbps', maxWidth: 2560, maxHeight: 1440, fps: 60, videoBitrate: 14_000_000, audioBitrate: 160_000 },
];

export const DEFAULT_CLIP_PRESET: ClipPresetId = '1080p30';

export function clipPreset(id: string | null | undefined): ClipPreset {
    return CLIP_PRESETS.find(p => p.id === id) ?? CLIP_PRESETS.find(p => p.id === DEFAULT_CLIP_PRESET)!;
}

/** Bytes per second the ring grows at for a preset (video + audio). */
export function presetBytesPerSecond(p: ClipPreset): number {
    return (p.videoBitrate + p.audioBitrate) / 8;
}

/** Ring cost per minute at a preset, in MB — the per-option readout the
 *  buffer-length menu shows so "15 minutes" is a number, not a surprise. */
export function presetMbPerMinute(p: ClipPreset): number {
    return (presetBytesPerSecond(p) * 60) / MIB;
}

export const MIB = 1024 * 1024;
export const GIB = 1024 * MIB;
/** Sealing a clip doubles peak memory (ring + sealed parts coexist) plus slack. */
export const SEAL_HEADROOM_BYTES = 32 * MIB;
/** Fraction of physical memory the ring may claim, before doubling for the seal. */
export const RING_MEMORY_FRACTION = 0.4;
/** `navigator.deviceMemory` is GiB (spec-capped at 8) and missing outside Chromium. */
export const DEVICE_MEMORY_FALLBACK_GIB = 4;

/**
 * Bytes the whole feature may spend on this machine. `deviceMemoryGib` is
 * `navigator.deviceMemory` (GiB, may be undefined) — passed in so this stays
 * pure and both branches are testable. Result is in BYTES.
 */
export function memoryBudgetBytes(deviceMemoryGib: number | undefined | null): number {
    const gib = typeof deviceMemoryGib === 'number' && deviceMemoryGib > 0 ? deviceMemoryGib : DEVICE_MEMORY_FALLBACK_GIB;
    return Math.floor(RING_MEMORY_FRACTION * gib * GIB);
}

/**
 * The largest ring (bytes) the budget allows: 2 × ring + headroom ≤ budget.
 * The Settings slider derives its max from this so the UI can never offer a
 * value the clamp will reject.
 */
export function maxRingBytesForBudget(budgetBytes: number): number {
    return Math.max(0, Math.floor((budgetBytes - SEAL_HEADROOM_BYTES) / 2));
}

export interface RingEstimate {
    /** Seconds the ring actually holds under both bounds. */
    seconds: number;
    /** Bytes that ring occupies. */
    bytes: number;
    /** Which bound won: 'seconds' (asked-for length fits) or 'bytes' (memory cap binds). */
    boundBy: 'seconds' | 'bytes';
    /** Bytes the asked-for length WOULD need. */
    wantBytes: number;
}

/**
 * What the ring holds for `wantSeconds` at preset `p` under a byte cap
 * `capBytes` (the user's memory limit, already clamped by the budget).
 * The pill/readout copy is built from this — a readout computed inline in JSX
 * is a readout nobody tests.
 */
export function estimateRing(p: ClipPreset, wantSeconds: number, capBytes: number): RingEstimate {
    const bps = presetBytesPerSecond(p);
    const wantBytes = Math.round(wantSeconds * bps);
    if (wantBytes <= capBytes) return { seconds: wantSeconds, bytes: wantBytes, boundBy: 'seconds', wantBytes };
    const seconds = Math.floor(capBytes / bps);
    return { seconds, bytes: Math.round(seconds * bps), boundBy: 'bytes', wantBytes };
}

export function formatMB(bytes: number): string {
    if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GB`;
    return `${Math.round(bytes / MIB)} MB`;
}

export function formatClock(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
