// Where the member profile popup goes (UserProfilePopup), as a pure function
// so the arithmetic is testable without a box model
// (src/tests/userProfilePopupPlacement.test.ts).
//
// It used to assume a 400px popup while the real one was up to 450px, and
// nothing capped the height to the window: a click low in the member list put
// the popup's bottom 34px below the window at ANY window height, with Manage
// Roles in the part that could not be reached. Now the height is the MEASURED
// content height, capped at the design maximum and at the window, and the box
// is clamped so all of it is on screen; the popup scrolls whatever the cap
// cuts off.

export const PROFILE_POPUP_WIDTH = 320;
export const PROFILE_POPUP_MAX_HEIGHT = 450;
const MARGIN = 16;
/** Gap between the click and the popup's near edge. */
const GAP = 12;

export interface ProfilePopupPlacementInput {
    /** The click that opened the popup (clientX/clientY). */
    anchor: { x: number; y: number };
    /** The popup's natural (unclipped) content height, measured. */
    contentHeight: number;
    viewport: { width: number; height: number };
}

export interface ProfilePopupPlacement {
    left: number;
    top: number;
    width: number;
    maxHeight: number;
}

export function placeProfilePopup({ anchor, contentHeight, viewport }: ProfilePopupPlacementInput): ProfilePopupPlacement {
    const width = Math.max(0, Math.min(PROFILE_POPUP_WIDTH, viewport.width - 2 * MARGIN));
    const maxHeight = Math.max(0, Math.min(PROFILE_POPUP_MAX_HEIGHT, viewport.height - 2 * MARGIN));
    const height = Math.min(Math.max(0, contentHeight), maxHeight);

    // Open to the LEFT of the click: the member list sits on the right, so
    // opening rightward would cover it and intercept clicks on other members.
    // If that runs off the left edge, fall back to just right of the click,
    // clamped into the window.
    let left = anchor.x - width - GAP;
    if (left < MARGIN) {
        left = Math.min(anchor.x + GAP, viewport.width - width - MARGIN);
        if (left < MARGIN) left = MARGIN;
    }

    // At the click, moved up only as far as the visible box needs.
    let top = Math.min(anchor.y, viewport.height - MARGIN - height);
    if (top < MARGIN) top = MARGIN;

    return { left, top, width, maxHeight };
}
