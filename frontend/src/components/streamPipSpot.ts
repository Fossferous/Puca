/**
 * Where the desktop's small player (StreamPip) first appears.
 *
 * It used to open 420 px from the window's right edge and 280 px from its
 * bottom whatever was there. At 1280x800 that is over the right end of the
 * composer and its Send button (and the bottom of the member list): the
 * player you opened to keep chatting while you watch sat on what you type
 * into. Now it opens just above the composer, at the right of the chat
 * column, and falls back to the old spot only when there is no composer on
 * screen to stay clear of.
 */

export interface PipSize { width: number; height: number }
export interface Box { left: number; top: number; right: number; bottom: number }

/** Space between the player and what it stays clear of. */
export const PIP_GAP = 12;

/** The old spot, for when there is no composer on screen. */
export function fallbackPipSpot(viewport: { width: number; height: number }, size: PipSize): { x: number; y: number } {
    return clampPipSpot({ x: viewport.width - size.width - 20, y: viewport.height - size.height - 30 }, viewport, size);
}

/** Keep the whole player inside the window. */
export function clampPipSpot(spot: { x: number; y: number }, viewport: { width: number; height: number }, size: PipSize): { x: number; y: number } {
    return {
        x: Math.max(0, Math.min(spot.x, viewport.width - size.width)),
        y: Math.max(0, Math.min(spot.y, viewport.height - size.height)),
    };
}

/** Above the composer, its right edge at the chat column's right less a gap.
 *  `column` is the chat column (.chat-main) and `composer` the message form;
 *  either missing gives the old spot. */
export function defaultPipSpot(
    viewport: { width: number; height: number },
    size: PipSize,
    column: Box | null,
    composer: Box | null,
): { x: number; y: number } {
    if (!column || !composer || composer.bottom <= composer.top) return fallbackPipSpot(viewport, size);
    const spot = {
        x: column.right - size.width - PIP_GAP,
        y: composer.top - size.height - PIP_GAP,
    };
    // A window too short to fit the player above the composer: the top of
    // the window, which still leaves the composer free unless the player is
    // taller than everything above it.
    return clampPipSpot(spot, viewport, size);
}

/** The spot from what the page shows now. */
export function defaultPipSpotOnPage(size: PipSize): { x: number; y: number } {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const rect = (sel: string): Box | null => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };
    return defaultPipSpot(viewport, size, rect('.chat-main'), rect('.chat-main .message-form'));
}
