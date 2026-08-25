import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The 0813 field report: task reminders arrived in the Android shade, new
 * message notifications never did — same device, same setting, same native
 * plugin, same notification channel.
 *
 * The two paths differ by exactly one gate: `notifyNewMessage` suppresses when
 * the user is "already looking at the app", and `notifyTasksDue` deliberately
 * does not. That gate read `document.hasFocus()`, which on Android reports DOM
 * focus WITHIN the document and stays TRUE while the Activity is paused — so a
 * backgrounded app answered "yes, they're looking at it" to every message and
 * suppressed the lot.
 *
 * `appIsForeground` asks the platform-appropriate question instead. These tests
 * pin the split, because it is invisible in any desktop or jsdom run: jsdom's
 * `document.hasFocus()` happens to agree with visibility, so the bug could only
 * ever be observed on a real phone.
 */

const isMobileMock = vi.fn<() => boolean>();
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => isMobileMock(),
        getPlatform: () => (isMobileMock() ? 'android' : 'web'),
    },
}));

const { appIsForeground } = await import('../api/platform');

/** Drive the two signals independently — the whole point is that they diverge. */
function setEnvironment(opts: { visibility: DocumentVisibilityState; hasFocus: boolean }) {
    Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => opts.visibility,
    });
    vi.spyOn(document, 'hasFocus').mockReturnValue(opts.hasFocus);
}

beforeEach(() => { isMobileMock.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('appIsForeground on MOBILE', () => {
    beforeEach(() => { isMobileMock.mockReturnValue(true); });

    it('reports BACKGROUND when hidden, even though hasFocus() insists otherwise', () => {
        // Precisely the Android state that swallowed every notification.
        setEnvironment({ visibility: 'hidden', hasFocus: true });
        expect(appIsForeground()).toBe(false);
    });

    // POSITIVE CONTROL. The assertion above is a "must be false", and on its own
    // it would be satisfied by a function that always returned false — which
    // would fire an OS notification for every message while the user is reading
    // it. This is what proves the rig can see a true.
    it('reports FOREGROUND when visible', () => {
        setEnvironment({ visibility: 'visible', hasFocus: true });
        expect(appIsForeground()).toBe(true);
    });

    it('still reports FOREGROUND when visible but hasFocus() is false', () => {
        // A WebView can lose DOM focus to a native overlay (the keyboard, a
        // permission dialog) while the app is very much on screen. Suppression
        // must follow visibility, not focus, on this platform.
        setEnvironment({ visibility: 'visible', hasFocus: false });
        expect(appIsForeground()).toBe(true);
    });
});

describe('appIsForeground on DESKTOP', () => {
    beforeEach(() => { isMobileMock.mockReturnValue(false); });

    it('follows window focus, NOT visibility', () => {
        // A desktop window is "visible" while fully covered by another app, and
        // a notification there is exactly what the user wants. Applying the
        // mobile rule here would silence desktop notifications entirely.
        setEnvironment({ visibility: 'visible', hasFocus: false });
        expect(appIsForeground()).toBe(false);
    });

    it('reports foreground when the window has focus', () => {
        setEnvironment({ visibility: 'visible', hasFocus: true });
        expect(appIsForeground()).toBe(true);
    });
});
