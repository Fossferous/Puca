/**
 * Pointer-travel scaling for a video letterboxed into its tile.
 *
 * WHY IT IS ITS OWN MODULE. This is pure geometry that a NORMAL screen share
 * needs — StreamStage fits every stream into its tile whether or not remote
 * control is possible — but it lived in api/remoteControl.ts, which a build
 * without remote control excludes entirely. Duplicating it into the lite
 * stand-in was the obvious move and the wrong one: the copy silently returned
 * the fit-scale instead of the inverse, which would have misplaced the pointer
 * in every lite build while both files still looked plausible.
 *
 * One implementation, imported by both, so the two can never disagree.
 */

/**
 * A `<video>` is letterboxed by `object-fit: contain` inside its element, so
 * the content on screen is videoW * min(rectW/videoW, rectH/videoH) wide; one
 * viewer pixel of mouse travel must become videoW/displayedW host pixels for a
 * full sweep to cover the same arc it would locally. Falls back to 1 on
 * degenerate sizes (video metadata not loaded yet). Pure so tests can drive it.
 */
export function computeRmoveScale(videoW: number, videoH: number, rectW: number, rectH: number): number {
    if (!(videoW > 0) || !(videoH > 0) || !(rectW > 0) || !(rectH > 0)) return 1;
    const displayedW = videoW * Math.min(rectW / videoW, rectH / videoH);
    if (!Number.isFinite(displayedW) || !(displayedW > 0)) return 1;
    return videoW / displayedW;
}
