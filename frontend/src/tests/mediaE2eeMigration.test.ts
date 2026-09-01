/**
 * `requireMediaE2ee` defaulted OFF, which made the mesh media-encryption layer
 * downgradable by the very party it defends against: the frame crypto is
 * tamper-evident, but with enforcement off a failed handshake fell back to
 * transport-only — server-readable — instead of refusing. Flipping the default
 * fixes only fresh installs, because SettingsModal persists the WHOLE settings
 * object on every change, so every profile that has ever been touched carries
 * an explicit `false` and stored values beat defaults.
 *
 * Hence a one-time migration. It differs from its three siblings in one way
 * that matters: this is the only fail-CLOSED setting of the four, and a browser
 * engine without WebRTC Encoded Transform (Safari and Firefox on the web, the
 * WebKit Tauri shells on macOS and Linux) cannot satisfy it — there, `true`
 * means the manager publishes no local media and drops inbound tracks, i.e. no
 * voice in either direction. So the flip carries a capability term, while the
 * marker is still written unconditionally to preserve the disarm contract.
 *
 * These pin all three halves: that it flips where encryption is possible, that
 * it does NOT where that would only mute the user, and that it never overrides
 * a deliberate later choice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';
const MARKER = 'requireMediaE2eeDefaultOn_v1';

/**
 * A REAL localStorage for this file — src/tests/setup.ts installs `vi.fn()`
 * stubs that store nothing, against which every assertion about persistence
 * would pass for the wrong reason (getItem always undefined = "never
 * migrated", forever).
 */
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

/** Engine capability is what the migration is gated on; drive it per test. */
let supported = true;
vi.mock('../api/rtc/mediaCrypto', () => ({
    isMediaE2eeSupported: () => supported,
}));

async function freshStore() {
    vi.resetModules();
    return await import('../components/settingsStore');
}

function store(partial: Record<string, unknown>): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(partial));
}

beforeEach(() => {
    localStorage.clear();
    supported = true;
});

describe('require-media-E2EE migration', () => {
    it('turns enforcement ON for an existing profile on an engine that can encrypt', async () => {
        store({ requireMediaE2ee: false, theme: 'dark' });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.requireMediaE2ee, 'a stored false kept mesh calls downgradable').toBe(true);
        // Persisted, not merely patched in memory — the next load must not have
        // to migrate again.
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).requireMediaE2ee).toBe(true);
        expect(localStorage.getItem(MARKER), 'the marker disarms the migration').toBe('1');
    });

    it('leaves it OFF where turning it on could only mean "no voice at all"', async () => {
        // Safari/Firefox on the web, and the WebKit Tauri shells. Enforcement
        // there publishes nothing and drops inbound tracks, so a blind flip
        // would take working calls away from a user who never asked.
        supported = false;
        store({ requireMediaE2ee: false, theme: 'dark' });
        const { loadSettings } = await freshStore();

        expect(loadSettings().requireMediaE2ee).toBe(false);
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).requireMediaE2ee).toBe(false);
        // The marker is still set: the contract is "run once", and re-arming on
        // a later launch would undo a deliberate choice.
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it('never re-arms after the user deliberately turns it back off', async () => {
        store({ requireMediaE2ee: false });
        const { loadSettings: first } = await freshStore();
        expect(first().requireMediaE2ee).toBe(true);

        // The user disables it — SettingsModal writes the whole object.
        store({ requireMediaE2ee: false });
        const { loadSettings: second } = await freshStore();
        expect(second().requireMediaE2ee, 'a deliberate off must stick').toBe(false);
    });

    it('disarms on a fresh profile without writing settings', async () => {
        const { loadSettings } = await freshStore();

        // The default already carries the secure value; nothing to migrate.
        expect(loadSettings().requireMediaE2ee).toBe(true);
        expect(localStorage.getItem(MARKER), 'armed migrations must disarm').toBe('1');
        expect(
            localStorage.getItem(SETTINGS_KEY),
            'a fresh profile must not be given a settings blob it never saved',
        ).toBeNull();
    });
});
