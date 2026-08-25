/** Pure helpers for the OS picture-in-picture popout (kept out of the
 *  component file so fast-refresh stays happy). See StreamPopout.tsx. */
import { nativePipKnownSupported, nativePipSupported } from '../api/mobileApp';

/** A <video> as WebKit (Safari, iOS, WKWebView) exposes picture-in-picture:
 *  no requestPictureInPicture, a "presentation mode" instead. */
export interface WebKitVideo extends HTMLVideoElement {
    webkitSupportsPresentationMode?: (mode: string) => boolean;
    webkitSetPresentationMode?: (mode: string) => void;
    webkitPresentationMode?: string;
}

/**
 * Which picture-in-picture mechanism THIS runtime has — three of them, one
 * per platform family, all reached through the same Pop-out button:
 *
 *  - `standard`: HTMLVideoElement.requestPictureInPicture — the WebView2 shell
 *    (verified, Edge 151), Chromium/Edge on desktop AND on Android phones in a
 *    browser tab. Chromium reports pictureInPictureEnabled=false when policy
 *    disables it, so both halves are checked.
 *  - `webkit`: Safari and iOS (and a Capacitor WKWebView) — the same idea under
 *    webkitSetPresentationMode('picture-in-picture'). Feature-detected on the
 *    prototype; a per-element webkitSupportsPresentationMode check happens at
 *    enter time.
 *  - `native`: the Android APP. Its WebView has neither API, so the Java side
 *    floats the whole WebView in an OS PiP window (PipActivity) while the page
 *    shows just the video. Known only after an async probe of the plugin —
 *    primePipSupport() runs it once at boot; until then this reads null and
 *    the control is not offered (never a button wired to nothing).
 *
 *  null: Firefox (no API at all), an old APK, jsdom.
 */
export type PipEngine = 'standard' | 'webkit' | 'native';

export function pipEngine(): PipEngine | null {
    if (typeof document === 'undefined' || typeof HTMLVideoElement === 'undefined') return null;
    if (!!document.pictureInPictureEnabled && 'requestPictureInPicture' in HTMLVideoElement.prototype) {
        return 'standard';
    }
    if ('webkitSetPresentationMode' in HTMLVideoElement.prototype) return 'webkit';
    if (nativePipKnownSupported()) return 'native';
    return null;
}

/** Is there any way to pop a stream out here? (The buttons render on this.) */
export function pipSupported(): boolean {
    return pipEngine() !== null;
}

/** Ask the Android plugin once so pipEngine() can answer 'native' at render
 *  time. Cheap and idempotent; a no-op everywhere but the Android app. */
export function primePipSupport(): Promise<boolean> {
    return nativePipSupported();
}

/** How long the host waits for its video's metadata before giving up — must
 *  stay well inside the click's transient-activation window (~5 s). */
export const PIP_METADATA_TIMEOUT_MS = 3000;

/** Native engine: how long after the plugin accepted the request the OS gets
 *  to actually float the window before the host gives up (activity launch +
 *  the PiP transition is hundreds of ms; a stuck one would otherwise leave a
 *  full-viewport black host over the app for ever). */
export const PIP_NATIVE_CONFIRM_TIMEOUT_MS = 8000;
