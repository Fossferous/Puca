/**
 * Is this a PHONE held on its SIDE? The one answer phoneLandscape.css and the
 * stream takeover (components/streamTakeover.ts) both use, published on
 * <html data-phone-sideways>.
 *
 * WHY NOT `(orientation: landscape)`. That media feature is the VIEWPORT's
 * shape, and a viewport changes shape for reasons that are not the phone
 * turning: Android 14 and older WebViews shrink it for the soft keyboard
 * (api/keyboardInset.ts), so a 360x640 phone typing upright is a 360x278
 * "landscape" viewport. Keyed on the viewport, the sideways layout switched on
 * mid-sentence and, with the docked stream player beside the list, left the
 * composer's input 0 px wide. So the DEVICE decides here:
 *
 *  - `screen.orientation.type` (every engine Púca runs in; iOS from 16.4);
 *  - else `window.orientation` (±90 sideways: older iOS);
 *  - else the screen's own aspect (not the viewport's).
 *
 * A PHONE: the phone layout's own gate (mobile.css: a coarse pointer, at most
 * 1024 px wide) on a SCREEN whose short side is at most 500 px. Every phone
 * clears that (the largest, a Pro Max, is 440) and no tablet does (the
 * smallest iPad is 744); a short desktop window or a touch laptop never
 * matches, whatever shape its window is.
 */

export const PHONE_LAYOUT_QUERY = '(pointer: coarse) and (max-width: 1024px)';
/** The short side of the largest phone screen, in CSS px. */
export const PHONE_SCREEN_MAX = 500;

type OrientedWindow = Pick<Window, 'matchMedia' | 'screen'> & { orientation?: number };

/** The device on its side (not the viewport's shape). */
export function deviceLandscape(win: OrientedWindow = window as OrientedWindow): boolean {
    const type: string | undefined = win.screen?.orientation?.type;
    if (typeof type === 'string' && type !== '') return type.startsWith('landscape');
    if (typeof win.orientation === 'number') return Math.abs(win.orientation) === 90;
    const s = win.screen;
    return !!s && s.width > s.height;
}

export function isPhoneSideways(win: OrientedWindow = window as OrientedWindow): boolean {
    if (typeof win.matchMedia !== 'function' || !win.screen) return false;
    if (!win.matchMedia(PHONE_LAYOUT_QUERY).matches) return false;
    if (Math.min(win.screen.width, win.screen.height) > PHONE_SCREEN_MAX) return false;
    return deviceLandscape(win);
}

const listeners = new Set<() => void>();
let current = false;

/** The current answer (false before install: the upright layout). */
export function phoneSideways(): boolean {
    return current;
}

export function subscribePhoneSideways(cb: () => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/**
 * Keep <html data-phone-sideways> and the subscribers current. Returns the
 * undo (tests; the app never tears it down).
 */
export function installPhoneSideways(win: Window = window): () => void {
    const root = win.document.documentElement;
    const update = () => {
        const next = isPhoneSideways(win as unknown as OrientedWindow);
        if (next) root.dataset.phoneSideways = 'true';
        else delete root.dataset.phoneSideways;
        if (next === current) return;
        current = next;
        for (const cb of [...listeners]) cb();
    };
    update();
    const mq = typeof win.matchMedia === 'function' ? win.matchMedia(PHONE_LAYOUT_QUERY) : null;
    const so = win.screen?.orientation;
    win.addEventListener('resize', update);
    win.addEventListener('orientationchange', update);
    so?.addEventListener?.('change', update);
    mq?.addEventListener?.('change', update);
    return () => {
        win.removeEventListener('resize', update);
        win.removeEventListener('orientationchange', update);
        so?.removeEventListener?.('change', update);
        mq?.removeEventListener?.('change', update);
        delete root.dataset.phoneSideways;
        current = false;
    };
}
