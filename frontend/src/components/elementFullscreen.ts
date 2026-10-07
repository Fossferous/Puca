/**
 * Fullscreen for ONE element (a video player's frame, so Púca's own controls
 * stay on screen with the picture), across the engines Púca runs in.
 *
 *  - Browsers and the desktop app (WebView2): the Fullscreen API, with the
 *    `webkit` spellings older WebKit still needs. In the desktop app the
 *    element fills the app's WINDOW, not the monitor: the shell does not turn
 *    the window itself fullscreen (that would need a window permission the
 *    app does not have, and a window left fullscreen if the page went away).
 *    Maximize the window for a bigger picture.
 *  - The Android and iOS apps: NOT the Fullscreen API; the player fills the
 *    app's whole view itself (VideoPlayer's in-app fullscreen), which needs
 *    nothing from the native app, so it arrives with the in-app update alone.
 *    Measured on the Android emulator (Capacitor 8.5.1, WebView 151,
 *    2026-10-07): a request there IS granted and the element fills the
 *    WebView — the same picture, under the same status bar — but only
 *    because this WebView ignores what Capacitor's BridgeWebChromeClient
 *    does with it: onShowCustomView answers onCustomViewHidden() at once, a
 *    "fullscreen is over" that another WebView version is free to act on.
 *    The in-app fullscreen does not depend on that, follows a rotation, and
 *    is what the BACK gesture can leave (api/mobileApp.ts interceptBack).
 *    iPhone WebKit has no element fullscreen at all.
 *
 * A refused request (an iframe without allowfullscreen, a permissions policy,
 * no user gesture) also falls back to the in-app fullscreen.
 */
import { isMobile } from '../api/platform';

type FsDocument = Document & {
    webkitFullscreenElement?: Element | null;
    webkitExitFullscreen?: () => void | Promise<void>;
};
type FsElement = HTMLElement & {
    webkitRequestFullscreen?: () => void | Promise<void>;
};

/** The element the Fullscreen API has put fullscreen, if any. */
export function fullscreenElement(doc: Document = document): Element | null {
    const d = doc as FsDocument;
    return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** May this element ask the Fullscreen API at all, here? */
export function canRequestFullscreen(el: HTMLElement | null): el is HTMLElement {
    if (!el) return false;
    if (isMobile()) return false; // see the header: the in-app fullscreen instead
    const e = el as FsElement;
    return typeof e.requestFullscreen === 'function' || typeof e.webkitRequestFullscreen === 'function';
}

/**
 * Ask for real fullscreen. MUST be called synchronously from the user's
 * click or key press (the browser requires the gesture). Resolves true when
 * the request was granted, false when it was refused or is unsupported —
 * the caller then shows its in-app fullscreen instead.
 */
export async function requestElementFullscreen(el: HTMLElement): Promise<boolean> {
    const e = el as FsElement;
    try {
        if (typeof e.requestFullscreen === 'function') {
            await e.requestFullscreen({ navigationUI: 'hide' });
        } else if (typeof e.webkitRequestFullscreen === 'function') {
            await e.webkitRequestFullscreen();
        } else {
            return false;
        }
    } catch {
        return false;
    }
    return true;
}

/** Leave real fullscreen, if the document is in it. Never throws. */
export async function exitElementFullscreen(doc: Document = document): Promise<void> {
    if (!fullscreenElement(doc)) return;
    const d = doc as FsDocument;
    try {
        if (typeof d.exitFullscreen === 'function') await d.exitFullscreen();
        else if (typeof d.webkitExitFullscreen === 'function') await d.webkitExitFullscreen();
    } catch {
        /* already out, or the document went away */
    }
}

/** Call `cb` whenever the document enters or leaves real fullscreen. */
export function onFullscreenChange(cb: () => void, doc: Document = document): () => void {
    doc.addEventListener('fullscreenchange', cb);
    doc.addEventListener('webkitfullscreenchange', cb);
    return () => {
        doc.removeEventListener('fullscreenchange', cb);
        doc.removeEventListener('webkitfullscreenchange', cb);
    };
}
