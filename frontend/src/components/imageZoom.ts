/**
 * Pure zoom maths + double-tap detection for the image viewer (ImageLightbox).
 *
 * The transform model is the one DeviceStage uses: a canvas carrying
 * `translate(x, y) scale(s)` with `transformOrigin: '0 0'`, so a zoom that
 * keeps the point under the finger fixed is a fixed-point map about the focal
 * point, and panning is a translate clamped so the PICTURE (not the letterbox
 * canvas) can never leave the surface — `clampPanTo` from deviceZoomFollow is
 * "THE pan clamp", imported here rather than copied for the same reason
 * DeviceStage imports it.
 *
 * The double-tap thresholds duplicate `api/devices/touchGestures.ts` (300 ms,
 * 40 px) on purpose rather than sharing: that copy is welded to the remote
 * trackpad's Contact/GestureClock state machine in the api/devices layer, and
 * re-pointing it at a components/ module to save six lines would put the
 * remote-trackpad gesture suite at risk for no behavioural gain. If they ever
 * need to move together, `utils/doubleTap.ts` that both import is the shape.
 */
import { clampPanTo, type Box, type Picture, type Transform } from './deviceZoomFollow';

export type { Box, Picture, Transform };

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
/** What a double-tap zooms to from 1x. */
export const DOUBLE_TAP_SCALE = 2.5;
/** Movement past this during a contact makes it a drag, never a tap. */
export const TAP_SLOP_PX = 12;
/** Second tap must land within this of the first (time)... */
export const DOUBLE_TAP_MS = 300;
/** ...and within this of it (distance). */
export const DOUBLE_TAP_SLOP_PX = 40;

export interface TapMark { at: number; x: number; y: number }

/** Is a clean tap at `pt`/`now` the second half of a double-tap after `prev`? */
export function isDoubleTap(prev: TapMark | null, now: number, pt: { x: number; y: number }): boolean {
    if (!prev) return false;
    if (now - prev.at > DOUBLE_TAP_MS) return false;
    return Math.hypot(pt.x - prev.x, pt.y - prev.y) <= DOUBLE_TAP_SLOP_PX;
}

/**
 * Zoom `t` to `wanted` about `focal` (surface-local px), then clamp the pan.
 * Clamps the scale into [MIN_SCALE, MAX_SCALE]; returns `t` itself when the
 * scale would not move; snaps to the identity at the floor (the picture comes
 * back centred, exactly like scale 1 always looks — DeviceStage does the same).
 */
export function zoomAt(
    t: Transform,
    focal: { x: number; y: number },
    wanted: number,
    box: Box,
    pict: Picture | null,
): Transform {
    const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, wanted));
    if (scale === t.scale) return t;
    if (scale === MIN_SCALE) return { scale: 1, x: 0, y: 0 };
    const ratio = scale / t.scale;
    // Fixed point: the surface point under `focal` maps to the same picture
    // point before and after. x' = fx − (fx − x)·ratio.
    const x = focal.x - (focal.x - t.x) * ratio;
    const y = focal.y - (focal.y - t.y) * ratio;
    return clampPanTo(box, pict, scale, x, y);
}
