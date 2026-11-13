/**
 * Where Share Screen is offered, and what a device that cannot share is told
 * (components/shareAvailability.ts). Real user agents, so a rule that only
 * worked on a made-up one goes red.
 */
import { describe, it, expect } from 'vitest';
import { shareAvailability, shareUnavailableWords, isIosDevice, type ShareEnv } from '../components/shareAvailability';

const UA = {
    androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
    androidWebView: 'Mozilla/5.0 (Linux; Android 16; sdk_gphone64_x86_64 Build/BP31.250610.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.0.0 Mobile Safari/537.36',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
    // An iPad asking for the desktop site: a Mac's user agent.
    ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
    windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
};

const env = (over: Partial<ShareEnv>): ShareEnv => ({
    userAgent: UA.windowsEdge, maxTouchPoints: 0, nativePlatform: 'web',
    nativeShare: false, hostShares: false, displayMedia: true, ...over,
});

describe('shareAvailability', () => {
    it('a desktop browser with getDisplayMedia shares', () => {
        expect(shareAvailability(env({}))).toEqual({ canShare: true });
        expect(shareAvailability(env({ userAgent: UA.mac }))).toEqual({ canShare: true });
    });

    it('the Android app shares from its native half; an APK without it is told to update', () => {
        expect(shareAvailability(env({ userAgent: UA.androidWebView, nativePlatform: 'android', nativeShare: true, displayMedia: false })))
            .toEqual({ canShare: true });
        expect(shareAvailability(env({ userAgent: UA.androidWebView, nativePlatform: 'android', displayMedia: false })))
            .toEqual({ canShare: false, reason: 'android-app' });
    });

    it('Chrome on Android cannot, and is pointed at the app, even if it ever exposed getDisplayMedia', () => {
        expect(shareAvailability(env({ userAgent: UA.androidChrome, maxTouchPoints: 5, displayMedia: false })))
            .toEqual({ canShare: false, reason: 'android-browser' });
        // Chrome Android 72-88 exposed it and it always failed.
        expect(shareAvailability(env({ userAgent: UA.androidChrome, maxTouchPoints: 5, displayMedia: true })))
            .toEqual({ canShare: false, reason: 'android-browser' });
        expect(shareUnavailableWords('android-browser').getApp).toBe(true);
    });

    it('an iPhone cannot; iOS 27 with the API is not offered untried', () => {
        expect(shareAvailability(env({ userAgent: UA.iphone, maxTouchPoints: 5, displayMedia: false })))
            .toEqual({ canShare: false, reason: 'ios' });
        expect(shareAvailability(env({ userAgent: UA.iphone, maxTouchPoints: 5, displayMedia: true })))
            .toEqual({ canShare: false, reason: 'ios-untested' });
    });

    it('an iPad asking for desktop sites is an iPad, not a Mac (the Share it used to get could only fail)', () => {
        expect(isIosDevice(UA.ipadDesktop, 5)).toBe(true);
        expect(isIosDevice(UA.mac, 0)).toBe(false);
        expect(shareAvailability(env({ userAgent: UA.ipadDesktop, maxTouchPoints: 5, displayMedia: false })))
            .toEqual({ canShare: false, reason: 'ios' });
    });

    it('a desktop browser without getDisplayMedia (an old engine) is told so', () => {
        expect(shareAvailability(env({ displayMedia: false }))).toEqual({ canShare: false, reason: 'browser' });
        expect(shareAvailability(env({ displayMedia: false, secure: true }))).toEqual({ canShare: false, reason: 'browser' });
    });

    it('a desktop browser on a page over plain http is told it is the address, not the browser', () => {
        expect(shareAvailability(env({ displayMedia: false, secure: false }))).toEqual({ canShare: false, reason: 'insecure' });
        expect(shareUnavailableWords('insecure').body).toMatch(/https/);
        // A phone over http is still told about the phone first.
        expect(shareAvailability(env({ userAgent: UA.androidChrome, maxTouchPoints: 5, displayMedia: false, secure: false })))
            .toEqual({ canShare: false, reason: 'android-browser' });
    });

    it('an embedding host that supplies the picture shares whatever the browser has', () => {
        expect(shareAvailability(env({ displayMedia: false, hostShares: true }))).toEqual({ canShare: true });
    });

    it('every reason has words, and only the Android ones offer the app', () => {
        for (const r of ['android-browser', 'android-app', 'ios', 'ios-untested', 'insecure', 'browser'] as const) {
            const w = shareUnavailableWords(r);
            expect(w.title.length).toBeGreaterThan(0);
            expect(w.body.length).toBeGreaterThan(20);
            expect(w.getApp).toBe(r === 'android-browser' || r === 'android-app');
        }
    });
});
