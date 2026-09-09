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
import { shareDimensions, type EncodeSample, type ShareQuality } from './shareHealth';
import { loadSettings } from '../../components/settingsStore';

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
    // NOT WHILE THE LADDER IS ON. LiveKit fixes each simulcast rung as a RATIO
    // of the source at publish time (`scaleResolutionDownBy`), so re-capping
    // the track shrinks every rung with it: a 1080p share whose rungs are
    // 640x360 / 960x540 / 1920x1080 becomes 426x240 / 640x360 / 1280x720, and
    // the bottom rung drops back under the 360-line height below which
    // Chromium will not use a hardware encoder at all — the exact thing
    // SHARE_LOW was raised to 640x360 to avoid. Re-publishing to fix the
    // ratios would end the share and drop every viewer, which is the cost
    // this button exists to avoid. So the setting is saved and takes effect on
    // the next share, and the caller says so rather than claiming otherwise.
    if (loadSettings().shareSimulcast === true) return false;
    const { width, height } = shareDimensions(q.resolution);
    return webrtcManager.applyShareQuality(width, height, q.fps);
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
