/**
 * The half of shareHealth.ts that has to touch a transport.
 *
 * Split out because its neighbour must stay dependency-free: the screen-share
 * dialog imports the ladder and the validation, and pulling LiveKit and the
 * mesh manager in behind them made an unrelated dialog test fail to even load
 * (`No "getApiBaseUrl" export is defined on the "../api/platform" mock`). The
 * decisions live there and are tested without a browser; the wiring lives here.
 */
import { sfuManager } from './sfuManager';
import { webrtcManager } from '../webrtc';
import {
    shareDimensions, shareLoadOffer,
    type EncodeSample, type LiveCapture, type ShareLoadOffer, type ShareLoadReason, type ShareQuality,
} from './shareHealth';

/**
 * Read the local share's encode health from whichever transport is carrying
 * it. The SFU is asked first: on an SFU channel the mesh manager still holds
 * the captured stream object but has no peers, so it would answer null anyway
 * — asking in this order just avoids the pointless walk.
 */
export async function sampleShareEncode(): Promise<EncodeSample | null> {
    const stamped = (s: EncodeSample | null): EncodeSample | null =>
        // Stamped as it is read: the frame watch turns two readings' counters
        // into a rate over the time between them (shareHealth.ts).
        s ? { ...s, atMs: s.atMs ?? performance.now() } : null;
    try {
        const viaSfu = await sfuManager.shareEncodeSample();
        if (viaSfu) return stamped(viaSfu);
    } catch { /* not on an SFU call */ }
    try {
        return stamped(await webrtcManager.shareEncodeSample());
    } catch {
        return null;
    }
}

/**
 * Apply a quality to the share that is ALREADY RUNNING, without sending the
 * person back through the OS picker — which would end the share, drop every
 * viewer, and make "lower it" cost more than putting up with the stutter.
 *
 * Returns false when there is nothing to re-cap or the engine refused, so the
 * caller can tell the difference between "done" and "said done".
 *
 * `remember: false` is a step for THIS share only (the frame watch's,
 * shareHealth.ts framesOffer): the caller saves nothing, and the live quality
 * panel is told what the running share really is (liveShareQuality).
 */
export async function applyShareQuality(q: ShareQuality, opts: { remember?: boolean } = {}): Promise<boolean> {
    // A SHARE SENT AT SEVERAL SIZES IS RE-SIZED TOO, since 2026-10-21. LiveKit
    // fixes each rung as a RATIO of the capture at publish, so re-capping the
    // capture alone would shrink every rung with it (the bottom one under the
    // 360 lines below which Chromium will not encode in hardware). That is
    // why this used to refuse a laddered share; retuneSfuShare now puts the
    // rungs back in proportion in place, or re-publishes when the share should
    // change between one size and several (sfuManager.retuneShare).
    const { width, height } = shareDimensions(q.resolution);
    const ok = await webrtcManager.applyShareQuality(width, height, q.fps);
    if (ok) {
        const track = shareTrack();
        appliedOnly = opts.remember === false && track ? { quality: q, track } : null;
        await retuneSfuShare();
    }
    return ok;
}

/** A quality applied to the running share WITHOUT being remembered, and the
 *  capture it was applied to: once that capture has ended it says nothing. */
let appliedOnly: { quality: ShareQuality; track: MediaStreamTrack } | null = null;

/** The running share's video track, or null. */
function shareTrack(): MediaStreamTrack | null {
    try {
        return webrtcManager.getScreenShareStreamForPreview()?.getVideoTracks()[0] ?? null;
    } catch {
        return null;
    }
}

/**
 * What the live quality panel should show: the remembered quality, unless the
 * share running now was stepped down for itself alone. Without this, the panel
 * opened after such a step would highlight the remembered 60 fps while the
 * share went out at 30.
 */
export function liveShareQuality(remembered: ShareQuality): ShareQuality {
    const a = appliedOnly;
    if (!a) return remembered;
    const now = shareTrack();
    if (now !== a.track || a.track.readyState === 'ended') {
        appliedOnly = null;
        return remembered;
    }
    return a.quality;
}

/**
 * The offer for what the watch found (shareHealth.ts shareLoadOffer), stepping
 * down from what the RUNNING share is at. After a step taken for this share
 * alone the remembered quality is not that: an offer built from it raised
 * what it meant to lower (a CPU offer after a 30 fps step read "Drop to 720p
 * at 60 fps", put a starved share back to 60 and saved it; a third frames step
 * read "1080p at 15 fps", sending the capture back up from 720p).
 */
export function liveShareOffer(
    why: ShareLoadReason,
    remembered: ShareQuality,
    capture?: { width: number; height: number } | null,
): ShareLoadOffer | null {
    return shareLoadOffer(why, liveShareQuality(remembered), capture);
}

/** Window event asking VoicePanel to open the live Stream quality panel —
 *  how the stream tile's own right-click menu reaches a panel it does not own. */
export const OPEN_SHARE_QUALITY_EVENT = 'sovereign:open-share-quality';

export function requestShareQualityPanel(): void {
    try { window.dispatchEvent(new CustomEvent(OPEN_SHARE_QUALITY_EVENT)); } catch { /* non-DOM env */ }
}

/** What became of a live quality change (changeLiveShareQuality). */
export type LiveQualityOutcome =
    | { kind: 'applied'; capture: LiveCapture }
    | { kind: 'no-share' }
    | { kind: 'refused' };

/**
 * Change the RUNNING share's resolution and frame rate, up or down, without
 * sending the person back through the picker (Stream quality while live).
 * The streamer's choice, where applyShareQuality above is the struggling
 * machine's one-way step down.
 *
 * A share sent at several sizes changes too, as in applyShareQuality: its
 * rungs are re-sized with the capture (retuneSfuShare).
 */
export async function changeLiveShareQuality(q: ShareQuality): Promise<LiveQualityOutcome> {
    if (!shareCaptureSize()) return { kind: 'no-share' };
    const { width, height } = shareDimensions(q.resolution);
    let capture: LiveCapture | null = null;
    try {
        capture = await webrtcManager.setShareQuality(width, height, q.fps);
    } catch {
        capture = null;
    }
    if (!capture) return { kind: 'refused' };
    // The person's own choice, and remembered by the panel: it replaces any
    // step taken for this share alone.
    appliedOnly = null;
    await retuneSfuShare();
    return { kind: 'applied', capture };
}

/** After the capture changed: the SFU share's cap, ladder and rungs follow it.
 *  Nothing to do on mesh (no publications); a failure here leaves the share
 *  running as it was, which is no worse than before the change. */
async function retuneSfuShare(): Promise<void> {
    try {
        await sfuManager.retuneShare();
    } catch (e) {
        console.warn('[share] could not re-tune the SFU share after a quality change', e);
    }
}

/** The live share's real capture size, for building the step-down offer out of
 *  what is actually being encoded rather than the ceiling somebody picked. */
export function shareCaptureSize(): { width: number; height: number } | null {
    try {
        return webrtcManager.shareCaptureSize();
    } catch {
        return null;
    }
}
