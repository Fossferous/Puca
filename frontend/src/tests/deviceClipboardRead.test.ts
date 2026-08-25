/**
 * readLocalClipboardDetailed — the platform branching that "Send clipboard"
 * from a PHONE depends on.
 *
 * The bug: the Android System WebView implements clipboard WRITE but not
 * READ, so `navigator.clipboard.readText()` rejects with NotAllowedError, the
 * old code swallowed that to `null`, and every phone reported "could not read
 * this device's clipboard". Nothing covered it: every clipboard test mocked
 * the module away. This file exercises the real function with the platform
 * and the native plugin stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
    tauri: false,
    /** 'android' | 'ios' | null — the two Capacitor platforms are DIFFERENT
     *  here: only Android has the native reader. */
    app: null as 'android' | 'ios' | null,
    native: vi.fn<() => Promise<{ text: string } | { unsupported: true } | { reason: string }>>(),
}));

vi.mock('../api/platform', () => ({
    isTauri: () => h.tauri,
    isMobile: () => h.app !== null,
    isAndroidApp: () => h.app === 'android',
}));
vi.mock('../api/mobileApp', () => ({
    readMobileClipboard: () => h.native(),
}));

import { readLocalClipboardDetailed, readLocalClipboard } from '../api/devices/clipboard';

const webReadText = vi.fn<() => Promise<string>>();

beforeEach(() => {
    h.tauri = false;
    h.app = null;
    h.native.mockReset();
    webReadText.mockReset();
    vi.stubGlobal('navigator', { clipboard: { readText: () => webReadText() } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('readLocalClipboardDetailed', () => {
    it('on Android reads NATIVELY and never touches the WebView clipboard API', async () => {
        h.app = 'android';
        h.native.mockResolvedValue({ text: 'from the phone' });
        // The WebView API rejects, exactly as the real System WebView does.
        webReadText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));

        expect(await readLocalClipboardDetailed()).toEqual({ ok: true, text: 'from the phone' });
        expect(webReadText).not.toHaveBeenCalled();
        expect(h.native).toHaveBeenCalledTimes(1);
    });

    it('an APK without the native method reads as UNSUPPORTED, not as denied', async () => {
        // The user cannot grant their way out of this one; the message must
        // say "update the app", not "permission".
        h.app = 'android';
        h.native.mockResolvedValue({ unsupported: true });
        expect(await readLocalClipboardDetailed()).toEqual({ ok: false, why: 'unsupported' });
    });

    it('a native refusal reads as denied', async () => {
        h.app = 'android';
        h.native.mockResolvedValue({ reason: 'not in the foreground' });
        expect(await readLocalClipboardDetailed()).toEqual({ ok: false, why: 'denied' });
    });

    it('an empty phone clipboard is a successful read of ""', async () => {
        h.app = 'android';
        h.native.mockResolvedValue({ text: '' });
        expect(await readLocalClipboardDetailed()).toEqual({ ok: true, text: '' });
    });

    it('iOS is NOT Android: it keeps the browser path instead of a false "update the app"', async () => {
        // The native reader lives in the Android plugin only. Gated on
        // isMobile() this branch caught iOS too, where readMobileClipboard
        // answers `unsupported` unconditionally — so iOS lost the working
        // WebKit path and was told to update an app that had nothing to update.
        h.app = 'ios';
        h.native.mockResolvedValue({ unsupported: true });
        webReadText.mockResolvedValue('from the iPhone');
        expect(await readLocalClipboardDetailed()).toEqual({ ok: true, text: 'from the iPhone' });
        expect(h.native).not.toHaveBeenCalled();
    });

    it('a plain browser tab still uses the async clipboard API', async () => {
        webReadText.mockResolvedValue('web text');
        expect(await readLocalClipboardDetailed()).toEqual({ ok: true, text: 'web text' });
        expect(h.native).not.toHaveBeenCalled();
    });

    it('a browser refusal reads as denied (the user CAN grant that one)', async () => {
        webReadText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
        expect(await readLocalClipboardDetailed()).toEqual({ ok: false, why: 'denied' });
    });

    it('the string-or-null wrapper collapses both failure kinds to null', async () => {
        h.app = 'android';
        h.native.mockResolvedValue({ unsupported: true });
        expect(await readLocalClipboard()).toBeNull();
        h.native.mockResolvedValue({ text: 'x' });
        expect(await readLocalClipboard()).toBe('x');
    });
});
