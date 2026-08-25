import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mobile showed "Unknown" as its version from the day it shipped, because
 * SettingsModal asked Tauri — which does not exist on Capacitor — and wrote the
 * catch-block fallback on every phone.
 *
 * These pin the platform routing, because the bug was invisible: it needed a
 * phone to see, and the desktop path worked perfectly.
 */
const isTauri = vi.fn(() => false);
const isMobile = vi.fn(() => false);
vi.mock('../api/platform', () => ({
    isTauri: () => isTauri(),
    isMobile: () => isMobile(),
    getApiBaseUrl: () => 'https://example.test',
    getWebSocketUrl: () => 'wss://example.test',
}));
vi.mock('../api/config', () => ({ API_BASE_URL: 'https://example.test' }));

const current = vi.fn();
vi.mock('@capgo/capacitor-updater', () => ({ CapacitorUpdater: { current: () => current() } }));
vi.mock('@tauri-apps/api/app', () => ({ getVersion: async () => '9.9.9' }));

const { currentAppVersion } = await import('../api/appVersion');

beforeEach(() => { isTauri.mockReturnValue(false); isMobile.mockReturnValue(false); current.mockReset(); });

describe('currentAppVersion', () => {
    it('asks Tauri on desktop', async () => {
        isTauri.mockReturnValue(true);
        expect(await currentAppVersion()).toBe('9.9.9');
    });

    /** THE BUG. Mobile must never fall through to the Tauri path. */
    it('reports the OTA bundle version on mobile, not Unknown', async () => {
        isMobile.mockReturnValue(true);
        current.mockResolvedValue({ bundle: { version: '0.8.2' }, native: '0.8.0' });
        expect(await currentAppVersion()).toBe('0.8.2');
    });

    /**
     * "builtin" means the OTA has NOT applied — the app is running the bundle
     * baked into the APK. Saying so is the whole point: it is the difference
     * between "updated" and "silently did not".
     */
    it('says built-in when the OTA has not applied', async () => {
        isMobile.mockReturnValue(true);
        current.mockResolvedValue({ bundle: { version: 'builtin' }, native: '0.8.0' });
        expect(await currentAppVersion()).toBe('0.8.0 (built-in)');
    });

    /** A missing plugin means OTA cannot work at all — surface that, don't shrug. */
    it('says updates are unavailable when the plugin is missing', async () => {
        isMobile.mockReturnValue(true);
        current.mockRejectedValue(new Error('plugin not implemented'));
        expect(await currentAppVersion()).toContain('updates unavailable');
    });

    it('uses the build-time constant on the web', async () => {
        expect(await currentAppVersion()).toBe(__APP_VERSION__);
    });
});
