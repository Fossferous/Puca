/**
 * Can this device share its screen into a call, and if not, why not, in
 * words a person can act on. Pure over what it is handed (shareAvailability
 * tests drive every case), with `currentShareEnv` reading the real device.
 *
 * Where a share can come from (rtc/media.ts getScreenShareStream):
 *   - the Android app's native capture (nativeScreenShare.ts);
 *   - an embedding host that supplies the picture (embedHost.ts);
 *   - the browser's own getDisplayMedia.
 *
 * What browsers can do, by MDN's browser-compat-data (2026-11):
 *   - Chrome, Firefox and Samsung Internet on Android, and Android's WebView:
 *     no getDisplayMedia (Chrome Android 72-88 exposed it, but it always
 *     failed with NotAllowedError). So a phone browser on Android cannot
 *     share; the Púca app for Android can.
 *   - Safari on iPhone and iPad: none before iOS 27. iOS 27's Safari is now
 *     listed as having it (mdn/browser-compat-data#30732, from an existence
 *     test), which Apple's own Safari 27 notes do not announce and Púca has
 *     not been tried with. Not offered yet: a button whose capture nobody has
 *     seen work is the button this file exists to avoid.
 *   - an iPad asks for desktop sites with a Mac's user agent: told apart by
 *     its touch points (a Mac has none).
 */
import { screenShareOffered } from './settingsModal.utils';

export type ShareUnavailableReason = 'android-browser' | 'android-app' | 'ios' | 'ios-untested' | 'browser';

export interface ShareEnv {
    userAgent: string;
    maxTouchPoints: number;
    /** Capacitor's platform: 'web', 'android' or 'ios'. */
    nativePlatform: string;
    /** The Android app can share (nativeScreenShareAvailable). */
    nativeShare: boolean;
    /** An embedding host supplies the share's picture. */
    hostShares: boolean;
    /** navigator.mediaDevices.getDisplayMedia is there. */
    displayMedia: boolean;
}

export type ShareAvailability = { canShare: true } | { canShare: false; reason: ShareUnavailableReason };

export function isIosDevice(userAgent: string, maxTouchPoints: number): boolean {
    return /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
}

export function shareAvailability(env: ShareEnv): ShareAvailability {
    if (env.nativeShare || env.hostShares) return { canShare: true };
    const no = (reason: ShareUnavailableReason): ShareAvailability => ({ canShare: false, reason });
    if (env.nativePlatform === 'android') return no('android-app');
    if (env.nativePlatform === 'ios' || isIosDevice(env.userAgent, env.maxTouchPoints)) {
        return no(env.displayMedia ? 'ios-untested' : 'ios');
    }
    if (/Android/i.test(env.userAgent)) return no('android-browser');
    if (!screenShareOffered(env.userAgent)) return no('browser');
    if (!env.displayMedia) return no('browser');
    return { canShare: true };
}

/** What to tell the person, and whether the Android app's download is the answer. */
export function shareUnavailableWords(reason: ShareUnavailableReason): { title: string; body: string; getApp: boolean } {
    switch (reason) {
        case 'android-browser':
            return {
                title: 'Phone browsers can’t share a screen',
                body: 'Chrome, Firefox and the other browsers on Android can’t share a phone’s screen with a web page. To share this phone’s screen into a call, use the Púca app for Android.',
                getApp: true,
            };
        case 'android-app':
            return {
                title: 'This copy of Púca can’t share its screen',
                body: 'Screen sharing needs a newer Púca app, and an up-to-date Android System WebView. Update Púca from the download page to share this phone’s screen into a call.',
                getApp: true,
            };
        case 'ios':
            return {
                title: 'iPhone and iPad can’t share a screen here',
                body: 'Safari on iPhone and iPad can’t share a screen with a web page, so Púca can’t share yours from here. You can still watch other people’s screens.',
                getApp: false,
            };
        case 'ios-untested':
            return {
                title: 'Not on iPhone and iPad yet',
                body: 'Púca doesn’t offer screen sharing on iPhone and iPad yet: Safari’s new screen sharing hasn’t been tried with Púca. You can still watch other people’s screens.',
                getApp: false,
            };
        case 'browser':
        default:
            return {
                title: 'This browser can’t share a screen',
                body: 'Use a desktop browser or the Púca desktop app to share your screen into a call.',
                getApp: false,
            };
    }
}

/** The device this page runs on, read now. */
export function currentShareEnv(nativeShare: boolean, hostShares: boolean, nativePlatform: string): ShareEnv {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    return {
        userAgent: nav?.userAgent ?? '',
        maxTouchPoints: nav?.maxTouchPoints ?? 0,
        nativePlatform,
        nativeShare,
        hostShares,
        displayMedia: typeof nav?.mediaDevices?.getDisplayMedia === 'function',
    };
}
