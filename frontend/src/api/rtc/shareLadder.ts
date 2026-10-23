/**
 * Whether a screen share goes out at several sizes (a simulcast "ladder"),
 * and which sizes.
 *
 * WHY A VIEWER NEEDS IT. A share sent at one size gives the SFU nothing smaller
 * to send to a viewer whose connection cannot carry it, and LiveKit does not
 * pause it either: that viewer's picture simply freezes. Measured 2026-10-21
 * (frontend/e2e/share-adapt-shaped.mjs SHAPE=viewer, loopback LiveKit 1.13.4,
 * 1080p60 fast motion): a 6 Mbps viewer of a 10 Mbps one-size share got 0 fps
 * and ~1,300 lost packets every 2 s, and `allow_pause` / send-side bandwidth
 * estimation in LiveKit changed nothing. The same viewer of a laddered share
 * settled on the middle size at ~57 fps. Since the share's bitrate follows its
 * quality (shareBitrate.ts: 10 Mbps for 1080p60), more viewers are below it.
 *
 * WHY "AUTOMATIC" AND NOT ALWAYS. Three sizes are three encodes. On a machine
 * with a hardware H.264 encoder that is cheap (measured: 1080p56 + 540p56 +
 * 360p30 all on the GPU, no CPU limit, ~1.5-2.5 Mbps more upload). In software
 * (OpenH264) every rung was CPU-limited, and those are the machines whose
 * game already stutters while they share. So Automatic ladders a share only
 * when this machine offers the encoder's High profile — the one entry
 * software H.264 never advertises (h264Profiles.ts hasHardwareH264) — and the
 * share sends more than the old one-size cap, where the viewers who can carry
 * it start to run out. If the encoder turns out to be software after all,
 * sfuManager drops the ladder (startSoftwareWatch there).
 *
 * Pure: no imports from LiveKit or the app, so the dialog, the settings and
 * the tests can all read it.
 */

/** Settings → Voice & Video → Screen Sharing → Send my screen at several sizes. */
export type ShareLadderMode = 'auto' | 'always' | 'never';

/** The bitrate (kbps) above which Automatic ladders a hardware-encoded share:
 *  the old one-size cap (LEGACY_SHARE_KBPS in shareBitrate.ts). */
export const AUTO_LADDER_ABOVE_KBPS = 4500;

/**
 * The remembered mode. `shareSimulcast` was the on/off setting before this
 * one; a profile that turned it ON keeps getting the ladder ('always'), and
 * one that never touched it (off was the default) gets the new default. The
 * settings control writes both fields together (ladderSettingsFor), so the
 * old flag never contradicts a choice made since.
 */
export function rememberedShareLadder(s: { shareLadder?: unknown; shareSimulcast?: unknown }): ShareLadderMode {
    const m = s.shareLadder;
    if (m === 'always' || m === 'never') return m;
    if (s.shareSimulcast === true) return 'always';
    return 'auto';
}

/** The fields to store for `mode`: the new one, and the old flag kept in step. */
export function ladderSettingsFor(mode: ShareLadderMode): { shareLadder: ShareLadderMode; shareSimulcast: boolean } {
    return { shareLadder: mode, shareSimulcast: mode === 'always' };
}

/** Should a share of `kbps`, on a machine whose hardware encoder is `hardware`,
 *  go out at several sizes? (Whether its capture HAS smaller sizes worth
 *  sending is ladderRungs' question.) */
export function shareWantsLadder(mode: ShareLadderMode, hardware: boolean, kbps: number): boolean {
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return hardware && kbps > AUTO_LADDER_ABOVE_KBPS;
}

/** One rung below the full picture. */
export interface LadderRung { width: number; height: number; kbps: number; fps: number }

/**
 * The bottom rung: 640x360, never lower. Chromium will not use a hardware
 * H.264 encoder below 360 lines on any machine (kForceSoftwareForRtcLowResolutions;
 * measured 2026-09-09, see the rung history in sfuManager.ts).
 */
export const LADDER_LOW: LadderRung = { width: 640, height: 360, kbps: 600, fps: 30 };
/** The middle rung for a capture under 1080 lines: 540p, as it always was. */
export const LADDER_MID_540: LadderRung = { width: 960, height: 540, kbps: 1200, fps: 60 };
/**
 * The middle rung for a capture of 1080 lines or more: 720p at 2.5 Mbps. The
 * viewer this rung serves has 3-10 Mbps; measured, a 6 Mbps viewer settled on
 * 720p @ ~57 fps with it against 540p @ ~58 with the old one. Not used below
 * 1080 lines: a 720p capture would be encoded at 720p twice.
 * src/sfu.rs keeps every server ceiling above this (SHARE_MIN_KBPS), and
 * ladderRungs drops it under a top that is not above it (an older server's
 * lower ceiling), so no rung of a ladder ever sends more than its top.
 */
export const LADDER_MID_720: LadderRung = { width: 1280, height: 720, kbps: 2500, fps: 60 };
/** The largest middle rung, for the server's paired check. */
export const LADDER_MID_TOP_KBPS = 2500;

/** The longer side livekit-client needs for each rung count
 *  (computeVideoEncodings: a middle rung from 960, any rung from 480). */
const LK_TWO_RUNGS_FROM = 960;
const LK_ONE_RUNG_FROM = 480;

/**
 * The rungs below the full picture for a `width` x `height` capture whose top
 * sends `topKbps`, lowest first (the order livekit-client's
 * screenShareSimulcastLayers wants): none, one or two.
 *
 * EXACTLY WHAT livekit-client WILL BUILD FROM THEM, and no more. It builds
 * three encodings only when the capture's longer side is 960 or more and
 * there is a middle rung, two from 480, and scales each rung by the capture's
 * SHORT side, never upward (encodingsFromPresets). So a rung that is not
 * smaller than the capture would be a second full-size encode for nothing,
 * and a rung count livekit-client would not build would leave sfuManager
 * re-sizing encodings that are not there. A rung must also send less than
 * the top: anything above it is egress the server never charged for, and a
 * middle copy that looks better than the full one.
 *
 * Empty = nothing smaller is worth sending (a capture of 360 lines or less),
 * and the share goes out at one size whatever the setting says.
 */
export function ladderRungs(width: number, height: number, topKbps: number): LadderRung[] {
    const short = Math.min(width, height);
    const long = Math.max(width, height);
    if (!(short > 0) || !(topKbps > 0)) return [];
    const fits = (r: LadderRung) => Math.min(r.width, r.height) < short && r.kbps < topKbps;
    if (long < LK_ONE_RUNG_FROM || !fits(LADDER_LOW)) return [];
    if (long < LK_TWO_RUNGS_FROM) return [LADDER_LOW];
    const mid = short >= 1080 && fits(LADDER_MID_720) ? LADDER_MID_720
        : fits(LADDER_MID_540) ? LADDER_MID_540
            : null;
    return mid ? [LADDER_LOW, mid] : [LADDER_LOW];
}

/** One encoding of a laddered sender, as setParameters takes it. */
export interface LadderEncoding { rid: 'q' | 'h' | 'f'; scaleResolutionDownBy: number; maxBitrate: number; maxFramerate: number }

/** livekit-client's rids, by position (videoRids): the lowest rung is always
 *  `q`, and the full picture takes the next free one — `h` on a two-encoding
 *  ladder, `f` on a three. */
const RIDS: ReadonlyArray<LadderEncoding['rid']> = ['q', 'h', 'f'];

/** The frame rate the full picture is published at (screenShareEncoding in
 *  sfuManager.ts); no rung runs faster. */
const TOP_FPS = 60;

/**
 * The encodings a share of a `width` x `height` capture, topped at `topKbps`,
 * should have with these `rungs` below the full picture — computed exactly as
 * livekit-client does at publish (encodingsFromPresets: scale by the SHORT
 * side, never up; each rung's frame rate no higher than the top's), so a live
 * quality change can re-size the rungs in place instead of publishing the
 * share again. One entry per encoding, in the sender's order.
 */
export function ladderEncodings(
    width: number,
    height: number,
    topKbps: number,
    rungs: readonly LadderRung[] = ladderRungs(width, height, topKbps),
): LadderEncoding[] {
    const short = Math.min(width, height);
    const enc = rungs.map((r, i): LadderEncoding => ({
        rid: RIDS[i],
        scaleResolutionDownBy: Math.max(1, short / Math.min(r.width, r.height)),
        maxBitrate: r.kbps * 1000,
        maxFramerate: Math.min(TOP_FPS, r.fps),
    }));
    enc.push({ rid: RIDS[rungs.length], scaleResolutionDownBy: 1, maxBitrate: topKbps * 1000, maxFramerate: TOP_FPS });
    return enc;
}

/** Is this `encoderImplementation` a software encoder? Covers Chromium's
 *  simulcast wrapper, which names each rung's encoder in brackets. */
export function isSoftwareEncoder(name: string | undefined): boolean {
    return typeof name === 'string' && /OpenH264|libvpx|libaom/i.test(name);
}

/**
 * What an `encoderImplementation` says: software, hardware, or nothing yet.
 * ANY software rung inside Chromium's simulcast wrapper makes it software.
 * Hardware is only what Chromium names its accelerated encoders with
 * (MediaFoundationVideoEncodeAccelerator on Windows, and the VideoToolbox /
 * VA-API / V4L2 / MediaCodec ones elsewhere; "ExternalEncoder" in older
 * builds). Anything else — empty, "unknown", a name this does not know — is
 * no evidence either way, rather than a hardware encoder by default.
 */
export function encoderKind(name: string | undefined): 'software' | 'hardware' | 'unknown' {
    if (typeof name !== 'string' || name.trim() === '') return 'unknown';
    if (isSoftwareEncoder(name)) return 'software';
    return /EncodeAccelerator|ExternalEncoder|MediaFoundation|VideoToolbox|Vaapi|V4L2|MediaCodec/i.test(name) ? 'hardware' : 'unknown';
}
