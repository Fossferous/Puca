/**
 * Clip quality presets + the memory readout math. PURE.
 *
 * Bitrates were chosen from the Phase 0 spike on this repo's reference desktop
 * (WebView2 151, hardware H.264 via Media Foundation): a busy 1080p30 game
 * scene at 6 Mbps VBR is visually clean and one minute costs ~46 MB of ring.
 * The numbers are targets the encoder is asked for, not guarantees. The
 * worker measures the real rate (ReplayState.kbps, video + audio); no UI
 * shows it, and puca.log's per-minute capture heartbeat is the video-only
 * figure for a native capture.
 */

export type ClipPresetId = '480p30' | '720p30' | '720p60' | '1080p30' | '1080p60' | '1440p30' | '2160p30' | 'native';

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
    // 480p30: the low-memory / low-storage choice (2:00 ≈ 30 MB). 2 Mbps keeps
    // the ladder's shape — 2.25x the pixels costs ~1.7x the bits at each step
    // (720p30 3.5, 1080p30 6) — and stays above clip_capture.rs's 1.5 Mbps
    // scale_bitrate floor. It saves memory only when armed by hand: automatic
    // arming records the whole monitor (Settings says what that costs).
    { id: '480p30', label: '480p 30 fps — about 2 Mbps', maxWidth: 854, maxHeight: 480, fps: 30, videoBitrate: 2_000_000, audioBitrate: 128_000 },
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

// ---- what a SAVED clip costs, and which limit it hits ------------------------
//
// Copies of the limits the app enforces elsewhere, kept here so this module
// stays pure and importable everywhere (the trim module pulls in a muxer).
// clipStorageEstimate.test.ts asserts each equals its source, so none can drift.

/** clipCrypto.PART_MAX_PLAINTEXT — a sealed clip is cut into parts this big. */
export const CLIP_PART_PLAIN_BYTES = 24 * MIB;
/** clipCrypto.PART_HEADER_BYTES + PART_TAG_BYTES — what sealing adds per part. */
export const CLIP_PART_OVERHEAD_BYTES = 19 + 16;
/** clipRef.MAX_CLIP_PARTS — the most parts a clip reference can carry. */
export const CLIP_MAX_PARTS = 64;
/** clipPlayback.CLIP_DOWNLOAD_MAX_BYTES — larger clips cannot be downloaded in the app. */
export const CLIP_DOWNLOAD_LIMIT_BYTES = GIB;
/** clipTrim.TRIM_MAX_CIPHER_BYTES — larger clips cannot be trimmed in the app. */
export const CLIP_TRIM_LIMIT_BYTES = 768 * MIB;

/**
 * Bytes a saved (sealed, uploaded) clip of `seconds` takes at a bitrate: the
 * encoded media plus the per-part sealing overhead. An ESTIMATE — the encoder
 * is VBR — so every readout built on it says "about". Pass a preset, or
 * `{ videoBitrate: measuredBitsPerSecond, audioBitrate: 0 }` for a measured rate.
 */
export function clipStorageBytes(p: Pick<ClipPreset, 'videoBitrate' | 'audioBitrate'>, seconds: number): number {
    const media = Math.round(Math.max(0, seconds) * (p.videoBitrate + p.audioBitrate) / 8);
    if (media <= 0) return 0;
    return media + Math.ceil(media / CLIP_PART_PLAIN_BYTES) * CLIP_PART_OVERHEAD_BYTES;
}

export interface ClipLimits {
    parts: number;
    /** More parts than a clip reference can carry: the seal itself fails. */
    overParts: boolean;
    /** Posts, but cannot be downloaded in the app. */
    overDownload: boolean;
    /** Posts, but cannot be trimmed in the app. */
    overTrim: boolean;
    /** Fraction of the member's clip storage one such clip takes; null = quota unknown. */
    quotaShare: number | null;
}

export function clipLimits(bytes: number, quotaBytes?: number | null): ClipLimits {
    const parts = Math.max(1, Math.ceil(bytes / CLIP_PART_PLAIN_BYTES));
    return {
        parts,
        overParts: parts > CLIP_MAX_PARTS,
        overDownload: bytes > CLIP_DOWNLOAD_LIMIT_BYTES,
        overTrim: bytes > CLIP_TRIM_LIMIT_BYTES,
        quotaShare: typeof quotaBytes === 'number' && quotaBytes > 0 ? bytes / quotaBytes : null,
    };
}

// ---- the ring never holds what can never be posted -----------------------------

/** The keyframe interval both capture paths encode at (replayBuffer gopMs). */
export const CLIP_RING_GOP_SECONDS = 2;

/**
 * Seconds the ring keeps when armed in a server whose longest clip is
 * `serverMaxSeconds`. A clip can never be longer than that cap (the composer
 * seals at most the cap and the server refuses more), so footage older than
 * it only costs memory. One keyframe interval of slack lets a full-length
 * clip still find a keyframe at its start. No (valid) cap: the setting stands.
 */
export function ringSecondsFor(bufferSeconds: number, serverMaxSeconds?: number | null): number {
    if (typeof serverMaxSeconds !== 'number' || !Number.isFinite(serverMaxSeconds) || serverMaxSeconds <= 0) return bufferSeconds;
    return Math.min(bufferSeconds, serverMaxSeconds + CLIP_RING_GOP_SECONDS);
}

// ---- what AUTOMATIC arming really records ---------------------------------------
//
// A TS port of frontend/src-tauri/src/clip_capture.rs `scale_bitrate` and
// `effective_encode_settings`. Native capture (armNative) never scales frames:
// it records the monitor at its own size, and when that is bigger than the
// preset assumed it trades FRAME RATE for the pixels and rescales the bitrate.
// So "720p 60 fps" records 24 fps on a 1080p monitor. Integer arithmetic
// mirrors the Rust (u64 division floors). Both sides are pinned to ONE table:
// src/tests/fixtures/clip-native-encode-table.json.

const BITRATE_FLOOR = 1_500_000;
const BITRATE_CEIL = 20_000_000;
const clampBitrate = (v: number) => Math.min(BITRATE_CEIL, Math.max(BITRATE_FLOOR, v));

export function scaleBitrate(requested: number, assumedPixels: number, actualPixels: number): number {
    if (assumedPixels === 0) return clampBitrate(requested);
    return clampBitrate(Math.floor((requested * actualPixels) / assumedPixels));
}

export function effectiveEncodeSettings(requestedFps: number, requestedBitrate: number, assumedPixels: number, actualPixels: number): { fps: number; bitrate: number } {
    const bitrate = scaleBitrate(requestedBitrate, assumedPixels, actualPixels);
    if (assumedPixels === 0 || actualPixels <= assumedPixels || requestedFps === 0) return { fps: requestedFps, bitrate };
    const budget = Math.floor((requestedFps * assumedPixels) / actualPixels);
    const fps = Math.min(budget <= 29 ? 24 : budget <= 47 ? 30 : budget <= 59 ? 48 : requestedFps, requestedFps);
    return { fps, bitrate: clampBitrate(Math.floor((bitrate * fps) / requestedFps)) };
}

export interface NativeEncodeEstimate {
    width: number;
    height: number;
    fps: number;
    videoBitrate: number;
    audioBitrate: number;
    /** Ring/clip growth, video + audio. */
    bytesPerSecond: number;
    /** The monitor is bigger than the preset assumed, so it records fewer frames than the preset's. */
    reducedFps: boolean;
}

/** What automatic arming records on a `monitorW` x `monitorH` monitor (physical pixels). */
export function nativeEncodeEstimate(p: ClipPreset, monitorW: number, monitorH: number): NativeEncodeEstimate {
    // replayBuffer.armNative passes assumedPixels = max(1, maxWidth * maxHeight).
    const assumed = Math.max(1, p.maxWidth * p.maxHeight);
    const width = Math.max(0, Math.round(monitorW)), height = Math.max(0, Math.round(monitorH));
    const { fps, bitrate } = effectiveEncodeSettings(p.fps, p.videoBitrate, assumed, width * height);
    return { width, height, fps, videoBitrate: bitrate, audioBitrate: p.audioBitrate, bytesPerSecond: (bitrate + p.audioBitrate) / 8, reducedFps: fps < p.fps };
}

export function formatMbps(bitsPerSecond: number): string {
    return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
}
