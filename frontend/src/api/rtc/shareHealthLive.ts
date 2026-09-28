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
    try {
        const viaSfu = await sfuManager.shareEncodeSample();
        if (viaSfu) return viaSfu;
    } catch { /* not on an SFU call */ }
    try {
        return await webrtcManager.shareEncodeSample();
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
    // NOT WHILE THIS SHARE HAS A LADDER. LiveKit fixes each simulcast rung as a
    // RATIO of the source at publish time (`scaleResolutionDownBy`), so
    // re-capping the track shrinks every rung with it: a 1080p share whose
    // rungs are 640x360 / 960x540 / 1920x1080 becomes 426x240 / 640x360 /
    // 1280x720, and the bottom rung drops back under the 360-line height below
    // which Chromium will not use a hardware encoder at all — the exact thing
    // SHARE_LOW was raised to 640x360 to avoid. Re-publishing to fix the ratios
    // would end the share and drop every viewer, which is the cost this button
    // exists to avoid. So the setting is saved and takes effect on the next
    // share, and the caller says so rather than claiming otherwise.
    //
    // ASKED OF THE PUBLICATION, NOT OF THE SETTING. The first version of this
    // guard read `loadSettings().shareSimulcast`, which is wrong twice over: it
    // refused the re-cap on MESH calls, which have no LiveKit ladder to protect
    // and where the button therefore did nothing for no reason; and it answered
    // for the next share rather than the running one, so toggling the setting
    // mid-share changed the answer about a publication that had not changed.
    if (shareHasLadder()) return false;
    const { width, height } = shareDimensions(q.resolution);
    return webrtcManager.applyShareQuality(width, height, q.fps);
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
    /** An SFU share published with quality layers: see changeLiveShareQuality. */
    | { kind: 'ladder' }
    | { kind: 'no-share' }
    | { kind: 'refused' };

/**
 * Change the RUNNING share's resolution and frame rate, up or down, without
 * sending the person back through the picker (Stream quality while live).
 * The streamer's choice, where applyShareQuality above is the struggling
 * machine's one-way step down.
 *
 * Same ladder rule as applyShareQuality, for the same reason: LiveKit fixes
 * each quality layer as a RATIO of the capture at publish time, so re-sizing
 * the capture re-sizes every layer with it. Those shares report 'ladder' and
 * keep running as they are; the choice is still saved for the next share.
 * Quality layers are off by default, so most shares never meet this.
 */
export async function changeLiveShareQuality(q: ShareQuality): Promise<LiveQualityOutcome> {
    if (!shareCaptureSize()) return { kind: 'no-share' };
    if (shareHasLadder()) return { kind: 'ladder' };
    const { width, height } = shareDimensions(q.resolution);
    let capture: LiveCapture | null = null;
    try {
        capture = await webrtcManager.setShareQuality(width, height, q.fps);
    } catch {
        capture = null;
    }
    return capture ? { kind: 'applied', capture } : { kind: 'refused' };
}

/** Is the running share published with more than one encoding? False on mesh
 *  (no publications) and false for a single-layer SFU share. */
function shareHasLadder(): boolean {
    try {
        return sfuManager.shareHasLadder();
    } catch {
        return false;   // not on an SFU call
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
