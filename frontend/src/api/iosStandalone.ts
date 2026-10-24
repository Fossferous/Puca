/**
 * Púca added to an iPhone's or iPad's Home Screen from Safari
 * (docs/USER_GUIDE.md, "iPhone and iPad").
 *
 * WHAT THIS DOES. In that mode, and only that mode, it lets the page extend to
 * the screen's edges in PORTRAIT by adding `viewport-fit=cover` to the viewport
 * tag, which is what makes `env(safe-area-inset-bottom)` report the home
 * indicator's height: the phone layout (mobile.css) already pads its bottom bar
 * by that, and without `cover` iOS reports 0 there and the bar sits under the
 * indicator. In LANDSCAPE it takes `cover` back off: the notch and the rounded
 * corners then sit at the sides, where the layout has no inset to give them, and
 * iOS's own default (the page laid out inside the safe area) is correct for free.
 * Landscape stays that way on purpose: the stream takeover (phoneLandscape.css)
 * goes edge to edge inside that area, its letterbox bars are black like iOS's
 * margins, and no control can land under the notch.
 *
 * ONLY WHERE THE PHONE LAYOUT IS. `cover` hands the insets to the page, and only
 * mobile.css's layout (its gate: a coarse pointer, at most 1024 px wide) pads
 * for them. A 13-inch iPad in portrait is 1032 px wide and gets the DESKTOP
 * layout, which pads for nothing: with `cover` its composer and user bar sat
 * under the home indicator. So the query below carries that gate too.
 *
 * WHY NOT A STATIC `viewport-fit=cover` IN index.html. That file is also the
 * Android app's and the desktop app's. On Android, `cover` turns on real
 * env(safe-area-inset-*) app-wide and changes how Capacitor's SystemBars treats
 * the keyboard (api/keyboardInset.ts says so, and says the app deliberately does
 * not set it). `navigator.standalone` exists only on Apple's engine and is true
 * only for a Home Screen app, so nothing else is touched. A Safari TAB is left
 * alone too: `cover` there puts the page under the translucent toolbar.
 *
 * `navigator.standalone` is the one reliable signal on iOS: `(display-mode:
 * standalone)` reports it on recent versions but not on every one Púca runs on.
 */

/** When `cover` is on: portrait, in the phone layout (mobile.css's gate). */
export const COVER_QUERY = '(orientation: portrait) and (pointer: coarse) and (max-width: 1024px)';

export interface StandaloneNavigator {
    standalone?: boolean;
}

/** True only for a page opened from an iPhone or iPad Home Screen icon. */
export function isIosStandalone(nav: StandaloneNavigator = navigator as StandaloneNavigator): boolean {
    return nav.standalone === true;
}

/** The viewport content with `viewport-fit=cover` set or removed, other keys kept. */
export function viewportContent(base: string, cover: boolean): string {
    const rest = base
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && !/^viewport-fit\s*=/i.test(s));
    if (cover) rest.push('viewport-fit=cover');
    return rest.join(', ');
}

/**
 * Install the Home Screen behaviour. Returns a function that undoes it (tests,
 * and nothing else: the app never tears this down). A no-op, returning a no-op,
 * anywhere that is not a Home Screen app.
 */
export function installIosStandalone(win: Window = window): () => void {
    if (!isIosStandalone(win.navigator as StandaloneNavigator)) return () => {};
    const doc = win.document;
    const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const root = doc.documentElement;
    // Lets a stylesheet tell a Home Screen app from a Safari tab without
    // guessing from the user agent. Nothing reads it yet.
    root.dataset.iosStandalone = 'true';
    if (!meta) return () => { delete root.dataset.iosStandalone; };

    const original = meta.getAttribute('content') ?? '';
    const portrait = win.matchMedia(COVER_QUERY);
    const apply = () => meta.setAttribute('content', viewportContent(original, portrait.matches));
    apply();
    portrait.addEventListener('change', apply);
    return () => {
        portrait.removeEventListener('change', apply);
        meta.setAttribute('content', original);
        delete root.dataset.iosStandalone;
    };
}
