/**
 * "Open this link outside the app" (api/openExternal.ts), per shell.
 *
 * The Capacitor branch is the one worth pinning. `window.open` /
 * target="_blank" is NOT a path there — @capacitor/android never calls
 * setSupportMultipleWindows, so the new window is simply refused — while a
 * top-level navigation to another host is handed to the system browser
 * (Bridge.launchIntent → ACTION_VIEW) and the app stays where it is, because
 * neither capacitor.config.ts allow-lists a foreign host. Without this test,
 * "simplifying" the branch back to window.open looks harmless and silently
 * makes every link in a note dead inside the Notes app.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/platform', () => ({ isTauri: vi.fn(() => false), isMobile: vi.fn(() => false) }));

import { isMobile, isTauri } from '../api/platform';
import { navigateAway, openExternalUrl, isExternalHref, loadsInsideTheApp } from '../api/openExternal';
import { setMessageToastSink } from '../components/messageToastBus';

let go: ReturnType<typeof vi.spyOn>;
let open: ReturnType<typeof vi.spyOn>;
let toasts: string[];

beforeEach(() => {
    go = vi.spyOn(navigateAway, 'go').mockImplementation(() => {});
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(isMobile).mockReturnValue(false);
    toasts = [];
    setMessageToastSink(t => { toasts.push(t.title); });
});
afterEach(() => { vi.restoreAllMocks(); setMessageToastSink(null); });

describe('openExternalUrl', () => {
    it('on the web it opens a new tab, noopener AND noreferrer', () => {
        openExternalUrl('https://example.com/a');
        expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer');
        expect(go).not.toHaveBeenCalled();
    });

    it('in the Capacitor app it navigates away, which the bridge turns into ACTION_VIEW', () => {
        vi.mocked(isMobile).mockReturnValue(true);
        openExternalUrl('https://example.com/a');
        expect(go).toHaveBeenCalledWith('https://example.com/a');
        // POSITIVE CONTROL: window.open is the web path and must NOT be used
        // here — this is the assertion a "simplification" would break.
        expect(open).not.toHaveBeenCalled();
    });

    it('refuses a scheme that is not an external link, on every shell', () => {
        for (const mobile of [false, true]) {
            vi.mocked(isMobile).mockReturnValue(mobile);
            openExternalUrl('javascript:alert(1)');
            openExternalUrl('sovereign-enc:abc');
            openExternalUrl('//evil.example/x');
        }
        expect(open).not.toHaveBeenCalled();
        expect(go).not.toHaveBeenCalled();
        expect(isExternalHref('https://example.com')).toBe(true);
        expect(isExternalHref('javascript:alert(1)')).toBe(false);
    });
});

/**
 * The one navigation the Capacitor branch must never make: to the app's OWN
 * host. Bridge.launchIntent keeps a same-host, same-scheme navigation in the
 * WebView (it does not compare the port), so `location.assign` there is the
 * app navigating itself away — a reboot that drops the socket and any call,
 * or an error page in place of the app — and no browser ever opens.
 */
describe('the Capacitor apps never navigate to their own host', () => {
    const APP = 'https://localhost/chat'; // both capacitor.config.ts: androidScheme https, default hostname

    it('loadsInsideTheApp mirrors the bridge: same scheme and host stays in the app, whatever the path or port', () => {
        for (const url of [
            'https://localhost/',
            'https://localhost/chat',
            'https://localhost/invite/abcd',
            'https://localhost:8443/',            // the bridge does not compare the port
            'HTTPS://LOCALHOST/x',                // the WebView canonicalises before the bridge looks
            'https://user@localhost/x',
        ]) expect(loadsInsideTheApp(url, APP), url).toBe(true);
        // POSITIVE CONTROL: what the bridge DOES hand to the system browser.
        for (const url of [
            'http://localhost/',                  // another scheme
            'https://127.0.0.1/',                 // another host, even if it is the same machine
            'https://localhost.example.com/',
            'https://example.com/localhost',
            'mailto:someone@localhost',
            'not a url',
        ]) expect(loadsInsideTheApp(url, APP), url).toBe(false);
        // A plain-http TEST build of the Notes app (NOTES_ALLOW_HTTP_API) is
        // served from http://localhost, and the rule follows the page.
        expect(loadsInsideTheApp('http://localhost:3320/x', 'http://localhost/')).toBe(true);
        expect(loadsInsideTheApp('https://localhost/x', 'http://localhost/')).toBe(false);
    });

    it('openExternalUrl on the phone: no navigation to the app\'s own host — and it says why instead of doing nothing', () => {
        vi.mocked(isMobile).mockReturnValue(true);
        vi.spyOn(navigateAway, 'pageHref').mockReturnValue(APP);
        openExternalUrl('https://localhost/chat');
        openExternalUrl('https://localhost:8443/');
        expect(go).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(toasts).toHaveLength(2);
        expect(toasts[0]).toMatch(/localhost/);
        // POSITIVE CONTROL, same page: another host still goes to the browser.
        openExternalUrl('https://example.com/a');
        openExternalUrl('http://localhost/a');
        expect(go.mock.calls.map((c: unknown[]) => c[0])).toEqual(['https://example.com/a', 'http://localhost/a']);
        expect(toasts).toHaveLength(2);
    });

    it('with the REAL page address: jsdom\'s own origin, any port, is refused the same way', () => {
        vi.mocked(isMobile).mockReturnValue(true);
        const here = new URL(window.location.href);
        openExternalUrl(`${here.origin}/chat`);
        openExternalUrl(`${here.protocol}//${here.hostname}:8443/`);
        expect(go).not.toHaveBeenCalled();
        expect(toasts).toHaveLength(2);
    });

    it('the web is not the bridge: the same address still opens a tab (the desktop: linkRouter.test.ts)', () => {
        vi.spyOn(navigateAway, 'pageHref').mockReturnValue(APP);
        openExternalUrl('https://localhost/chat');
        expect(open).toHaveBeenCalledWith('https://localhost/chat', '_blank', 'noopener,noreferrer');
        expect(toasts).toEqual([]);
    });
});
