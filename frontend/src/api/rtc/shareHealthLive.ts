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
import { shareDimensions, type EncodeSample, type LiveCapture, type ShareQuality } from './shareHealth';

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
 */
export async function applyShareQuality(q: ShareQuality): Promise<boolean> {
    // A SHARE SENT AT SEVERAL SIZES IS RE-SIZED TOO, since 2026-10-21. LiveKit
    // fixes each rung as a RATIO of the capture at publish, so re-capping the
    // capture alone would shrink every rung with it (the bottom one under the
    // 360 lines below which Chromium will not encode in hardware). That is
    // why this used to refuse a laddered share; retuneSfuShare now puts the
    // rungs back in proportion in place, or re-publishes when the share should
    // change between one size and several (sfuManager.retuneShare).
    const { width, height } = shareDimensions(q.resolution);
    const ok = await webrtcManager.applyShareQuality(width, height, q.fps);
    if (ok) await retuneSfuShare();
    return ok;
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
