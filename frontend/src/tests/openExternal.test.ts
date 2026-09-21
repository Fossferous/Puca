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
import { navigateAway, openExternalUrl, isExternalHref } from '../api/openExternal';

let go: ReturnType<typeof vi.spyOn>;
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    go = vi.spyOn(navigateAway, 'go').mockImplementation(() => {});
    open = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.mocked(isTauri).mockReturnValue(false);
    vi.mocked(isMobile).mockReturnValue(false);
});
afterEach(() => { vi.restoreAllMocks(); });

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
