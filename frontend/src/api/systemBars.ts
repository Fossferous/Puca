/**
 * Android's status and navigation bars, hidden while something is shown full
 * screen INSIDE the app: today a video in the player's in-app fullscreen
 * (components/VideoPlayer.tsx).
 *
 * WHY. The app has no Fullscreen API to hand a video to (elementFullscreen.ts),
 * so the player fills the WebView itself — and the WebView sits between the
 * status bar and the navigation bar. Measured on the emulator (2026-10-07):
 * the "full screen" video kept a light strip above and below it, about 12 %
 * of the short side in landscape. Someone who pressed Full screen saw a
 * framed picture.
 *
 * HOW. Capacitor's own SystemBars plugin (registered by the Capacitor 8
 * bridge itself, so every APK built from this tree already has it — no new
 * APK needed). Hiding the bars zeroes their insets, and SystemBars' own
 * insets listener then takes the WebView's padding away, so the WebView and
 * the player in it reach the screen's edges (measured on the emulator, portrait
 * and landscape). A swipe from the edge brings the bars back for the rest of
 * that fullscreen — the plugin hides them with Android's default behaviour and
 * cannot ask for its self-hiding "transient" bars; the player then fills the
 * smaller WebView. Leaving the fullscreen puts them back for good. An APK
 * without the plugin rejects the call, which is swallowed: the fullscreen
 * there is the framed one, as before.
 *
 * Off Android (the web, the desktop app, iOS) it does nothing at all.
 */
import { Capacitor, SystemBars } from '@capacitor/core';

function android(): boolean {
    return Capacitor.getPlatform() === 'android';
}

const holders = new Set<symbol>();

/**
 * Until the returned release is called, the system bars are hidden. More
 * than one holder at a time is allowed; the bars come back when the last one
 * lets go, and releasing twice is harmless.
 */
export function holdSystemBarsHidden(): () => void {
    if (!android()) return () => {};
    const me = Symbol('bars');
    holders.add(me);
    SystemBars.hide().catch(() => { /* an APK without SystemBars */ });
    return () => {
        if (!holders.delete(me) || holders.size > 0) return;
        SystemBars.show().catch(() => { /* an APK without SystemBars */ });
    };
}

/**
 * Boot-time (main.tsx): a page that starts with the bars hidden got them from
 * a page that is gone — an in-app update applied (a WebView reload, same
 * activity) while a video was full screen. Nothing on the new page holds them,
 * so they come back. Showing bars that are already shown changes nothing.
 */
export function restoreSystemBarsAtBoot(): void {
    if (!android() || holders.size > 0) return;
    SystemBars.show().catch(() => { /* an APK without SystemBars */ });
}

/** Tests only: forget every holder, without asking for anything. */
export function __resetSystemBars(): void {
    holders.clear();
}
