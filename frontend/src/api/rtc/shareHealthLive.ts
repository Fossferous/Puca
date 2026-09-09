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
    const { width, height } = shareDimensions(q.resolution);
    return webrtcManager.applyShareQuality(width, height, q.fps);
}
