// @vitest-environment jsdom
/**
 * Settings → Voice & Video → Open streams automatically (`autoOpenStreams`):
 * 'stream-only' by default, and a profile from the build that had a single
 * stream-only switch (`autoWatchStreamOnly`) and turned it OFF stays off - it
 * must not find streams opening again after the update.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';

/** A REAL localStorage (the shared setup's stubs store nothing; see
 *  backgroundDeliveryMigration.test.ts). */
const backing = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
        getItem: (k: string) => (backing.has(k) ? backing.get(k)! : null),
        setItem: (k: string, v: string) => { backing.set(k, String(v)); },
        removeItem: (k: string) => { backing.delete(k); },
        clear: () => { backing.clear(); },
    },
});

async function load(stored: Record<string, unknown> | null) {
    if (stored) localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
    vi.resetModules();
    return (await import('../components/settingsStore')).loadSettings();
}

beforeEach(() => { localStorage.clear(); });

describe('autoOpenStreams', () => {
    it("defaults to 'stream-only', fresh and on an existing profile", async () => {
        expect((await load(null)).autoOpenStreams).toBe('stream-only');
        expect((await load({ voiceTTS: true })).autoOpenStreams).toBe('stream-only');
    });

    it("the old single switch, turned off, reads as 'off'", async () => {
        expect((await load({ autoWatchStreamOnly: false })).autoOpenStreams).toBe('off');
        // Negative control: left on, it is the default.
        expect((await load({ autoWatchStreamOnly: true })).autoOpenStreams).toBe('stream-only');
    });

    it('a choice made in the new control wins over the old switch, and the old key is gone', async () => {
        const s = await load({ autoWatchStreamOnly: false, autoOpenStreams: 'all' });
        expect(s.autoOpenStreams).toBe('all');
        expect('autoWatchStreamOnly' in s).toBe(false);
    });
});
