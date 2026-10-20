/**
 * How many bits a screen share may spend, by the quality being sent.
 *
 * WHY THIS IS NOT ONE NUMBER ANY MORE. Every SFU share used to be capped at
 * 4.5 Mbps whatever its size and frame rate. That is plenty for a desktop and
 * far too little for fast motion: measured on a live share, 1080p30 from a
 * hardware encoder sent ~3.3 Mbps against its 4.5 Mbps target with nothing
 * limiting it, and the fast parts smeared and broke into blocks while the
 * same source played locally was clean. 1080p60 and 1440p60 were worse off
 * still, splitting the same bits over twice the frames and up to 1.8x the
 * pixels.
 *
 * MEASURED with frontend/e2e/encode-cost.mjs (CONTENT=pan: a detailed picture
 * panned at half a screen a second with objects crossing it,
 * DEGRADATION=maintain-resolution as the single-layer share publishes, PIN=1
 * so the encoder really gets the cap, the NVIDIA H.264 encoder through
 * Chromium's MediaFoundation path; RTX 4080 SUPER, 2026-10-20). Mean H.264
 * quantiser at each cap: lower is finer; about 33 looks clean in motion, 38+
 * smears and 42+ is blocky.
 *
 *              3     4.5    6      8      10     12     16 Mb/s
 *   720p30    37.0  32.7*  30.0   27.7   26.0   24.4   21.9
 *   720p60    40.9  36.7   34.0   31.6   29.9   28.4   26.5
 *   1080p30   43.7  37.0   33.6   30.0   27.5   25.4   22.5
 *   1080p60    -    42.9   38.2   34.4   31.8   29.9   26.7
 *   1440p30    -    45.6   39.2   36.1   33.1   31.1   27.9
 *   1440p60    -    51     49.8   41.1   37.9   35.2   32.1
 *   (* unpinned run; the pinned one dropped frames)
 *
 * So the old cap put 1080p60 at 42.9 — the blocks people saw — and each
 * figure below brings its quality to about 32-34 on that picture. 4K could
 * not be measured (a headless browser cannot paint a 4K canvas at speed);
 * its row follows the others by pixel count and is held at 20 Mbps. Content
 * that needs less sends less: this is a ceiling, not a target. Read the
 * quantisers as a comparison between rows; they are one machine and one
 * test picture.
 *
 * THE SERVER HAS THE LAST WORD. Every viewer of a share costs the SFU node
 * this much egress, so the node names its own ceiling in the join grant
 * (`max_share_kbps`, from SFU_SHARE_MAX_MBPS or derived from its egress
 * budget: `share_ceiling_kbps` in src/sfu.rs) and admission charges every
 * live share at it. A server that predates the field names none, and a share
 * there keeps the old 4.5 Mbps, which is what that server's admission still
 * charges.
 *
 * Pure: no imports, so the test and the server's paired check can read it.
 */

/** What a share sent before this table, and what it still sends when the
 *  server names no ceiling. Mirrored as SHARE_LEGACY_KBPS in src/sfu.rs. */
export const LEGACY_SHARE_KBPS = 4500;

/** The ceiling (kbps) for each quality, by tier and frame rate. A tier is the
 *  capture's size: 720p, 1080p, 1440p, and 2160p for a "Source" share of a 4K
 *  screen. 15 fps is ~0.6x of 30 and 60 fps ~1.6x: twice the frames, each
 *  closer to the last. */
export const SHARE_KBPS_TABLE: Readonly<Record<ShareTier, Readonly<Record<ShareFpsTier, number>>>> = {
    720: { 15: 2500, 30: 4000, 60: 6000 },
    1080: { 15: 3500, 30: 6000, 60: 10000 },
    1440: { 15: 6000, 30: 10000, 60: 16000 },
    2160: { 15: 8000, 30: 14000, 60: 20000 },
};

/** The most any share asks for: the table's largest entry. Mirrored as
 *  SHARE_TOP_KBPS in src/sfu.rs, which never sets a ceiling above it. */
export const SHARE_TOP_KBPS = 20000;

export type ShareTier = 720 | 1080 | 1440 | 2160;
export type ShareFpsTier = 15 | 30 | 60;

/** Pixels in each tier's 16:9 frame. */
const TIER_PIXELS: ReadonlyArray<[ShareTier, number]> = [
    [720, 1280 * 720],
    [1080, 1920 * 1080],
    [1440, 2560 * 1440],
    [2160, 3840 * 2160],
];

/**
 * The tier a capture of `width` x `height` belongs to, by PIXELS rather than
 * lines: a 3440x1440 ultrawide is a third more picture than 2560x1440 and
 * needs the bits of it, and a 1080-line window cropped narrow needs fewer.
 * A capture is put in the smallest tier whose frame it fits into with 15%
 * to spare, so a window a few pixels over 1920x1080 (borders, a title bar)
 * stays 1080p.
 */
export function shareTier(width: number, height: number): ShareTier {
    // A capture that reports no size is read as 1080p (the dialog's default),
    // not as the smallest tier.
    const h = height > 0 ? height : 1080;
    const px = (width > 0 ? width : (h * 16) / 9) * h;
    for (const [tier, pixels] of TIER_PIXELS) {
        if (px <= pixels * 1.15) return tier;
    }
    return 2160;
}

/** 15, 30 or 60: what the capture runs at, rounded to the frame rates the
 *  dialog offers. Anything over 30 is the 60 fps budget — a 45 fps capture
 *  still sends half again as many frames as 30. */
export function shareFpsTier(fps: number): ShareFpsTier {
    if (!(fps > 0)) return 30;
    if (fps <= 20) return 15;
    if (fps <= 30) return 30;
    return 60;
}

/**
 * The bitrate (kbps) a share of `width` x `height` at `fps` may send, held to
 * the server's ceiling. `ceilingKbps` of 0, a missing value or garbage means
 * the server named none: LEGACY_SHARE_KBPS.
 */
export function shareBitrateKbps(width: number, height: number, fps: number, ceilingKbps: number | undefined): number {
    const ceiling = typeof ceilingKbps === 'number' && Number.isFinite(ceilingKbps) && ceilingKbps > 0
        ? ceilingKbps
        : LEGACY_SHARE_KBPS;
    return Math.min(SHARE_KBPS_TABLE[shareTier(width, height)][shareFpsTier(fps)], ceiling);
}
