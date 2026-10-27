// @vitest-environment jsdom
/**
 * Settings → Voice & Video → Open streams automatically (`autoOpenStreams`).
 *
 * OFF BY DEFAULT, for every stream: no share starts playing without a Watch
 * click unless the viewer chose that here (the owner, 2026-10-27). It shipped
 * defaulting to 'stream-only', and any save persists the WHOLE settings
 * object, so an existing device holds an explicit 'stream-only' that cannot be
 * told apart from that old default. A one-time switch (behind a marker, like
 * the other settings migrations) makes it 'off'; 'all' and 'off' are kept, and
 * a 'stream-only' chosen after the switch is a real choice and is kept too.
 *
 * And it reaches the call: fed to autoWatchPlan the way Chat.tsx feeds it
 * (`mode: loadSettings().autoOpenStreams`), the default opens nothing, a
 * stream-only account's share included; chosen, From stream-only accounts
 * opens that share and All streams every share, as before.
 *
 * Also kept: a profile from the build that had a single stream-only switch
 * (`autoWatchStreamOnly`) and turned it OFF stays off.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { autoWatchPlan } from '../utils/autoWatch';
import type { AutoOpenStreams } from '../components/settingsStore';

const SETTINGS_KEY = 'sovereign_settings';
const MARKER = 'autoOpenStreamsDefaultOff_v1';
/** What every older build leaves behind even on a device that never saved a
 *  setting: the other migrations mark themselves done on a fresh profile. */
const OLDER_MARKERS = [
    'micProcessingTogglesReset_v1', 'mobileBackgroundDeliveryEnabled_v1', 'requireMediaE2eeDefaultOn_v1',
    'requireMediaE2eeDefaultOn_v2', 'voiceKeybindDefaults_v1', 'voiceBindProvenance_v1',
];

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

/** A fresh module instance: what the next launch of the app gets. */
async function freshStore() {
    vi.resetModules();
    return await import('../components/settingsStore');
}

async function load(stored: Record<string, unknown> | null) {
    if (stored) localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
    return (await freshStore()).loadSettings();
}

const storedRaw = () => localStorage.getItem(SETTINGS_KEY);
const stored = () => JSON.parse(storedRaw() ?? 'null') as Record<string, unknown> | null;

/** The viewer picks a value in the Settings select (it writes the whole
 *  object, merged onto a fresh load: SettingsModal's commit). */
async function choose(mode: AutoOpenStreams) {
    const s = await freshStore();
    s.saveSettings({ ...s.loadSettings(), autoOpenStreams: mode });
}

beforeEach(() => { localStorage.clear(); });

describe('autoOpenStreams is Off by default', () => {
    it("'off' is the default", async () => {
        expect((await freshStore()).defaultSettings.autoOpenStreams).toBe('off');
    });

    it('a fresh device reads Off, invents no settings, and is marked so the switch never runs there', async () => {
        expect((await load(null)).autoOpenStreams).toBe('off');
        expect(storedRaw(), 'nothing written for a device that saved nothing').toBeNull();
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it('an old device that never saved settings reads Off too', async () => {
        for (const k of OLDER_MARKERS) localStorage.setItem(k, '1');
        expect((await load(null)).autoOpenStreams).toBe('off');
        expect(storedRaw()).toBeNull();
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it('a profile saved before the setting existed (no key at all) reads Off', async () => {
        expect((await load({ voiceTTS: true })).autoOpenStreams).toBe('off');
    });
});

describe('the one-time switch', () => {
    it("an old device's stored 'stream-only' (the old default, written by every save) becomes 'off', persisted", async () => {
        for (const k of OLDER_MARKERS) localStorage.setItem(k, '1');
        // What the old build's saveSettings wrote: the whole object, the old
        // default in it, beside whatever the user did change.
        const old = { ...(await freshStore()).defaultSettings, autoOpenStreams: 'stream-only', voiceTTS: true };
        const s = await load(old);
        expect(s.autoOpenStreams).toBe('off');
        expect(s.voiceTTS, 'the rest of the profile is kept').toBe(true);
        expect(stored()?.autoOpenStreams, 'persisted, not just patched in memory').toBe('off');
        expect(stored()?.voiceTTS).toBe(true);
        expect(localStorage.getItem(MARKER), 'the marker disarms the switch').toBe('1');
    });

    it("'all' is kept, and the profile is left as it was: All streams was always a choice", async () => {
        const before = JSON.stringify({ autoOpenStreams: 'all', voiceTTS: true });
        localStorage.setItem(SETTINGS_KEY, before);
        expect((await freshStore()).loadSettings().autoOpenStreams).toBe('all');
        expect(storedRaw(), 'a profile the switch did not change is not rewritten').toBe(before);
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it("'off' is kept, and the profile is left as it was", async () => {
        const before = JSON.stringify({ autoOpenStreams: 'off' });
        localStorage.setItem(SETTINGS_KEY, before);
        expect((await freshStore()).loadSettings().autoOpenStreams).toBe('off');
        expect(storedRaw()).toBe(before);
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it("runs ONCE: From stream-only accounts chosen after it is kept, on every later launch", async () => {
        expect((await load({ autoOpenStreams: 'stream-only' })).autoOpenStreams).toBe('off');
        await choose('stream-only');
        for (let launch = 0; launch < 2; launch++) {
            expect((await freshStore()).loadSettings().autoOpenStreams, 'a switch that ran again would undo a real choice').toBe('stream-only');
        }
        expect(stored()?.autoOpenStreams).toBe('stream-only');
    });

    it('a fresh device that then chooses From stream-only accounts keeps it', async () => {
        expect((await load(null)).autoOpenStreams).toBe('off');
        await choose('stream-only');
        expect((await freshStore()).loadSettings().autoOpenStreams).toBe('stream-only');
    });
});

describe('the old single switch (autoWatchStreamOnly)', () => {
    it("turned off, it reads as 'off'; left on (the old default), it is Off like any profile that never chose", async () => {
        expect((await load({ autoWatchStreamOnly: false })).autoOpenStreams).toBe('off');
        localStorage.clear();
        expect((await load({ autoWatchStreamOnly: true })).autoOpenStreams).toBe('off');
    });

    it('a choice made in the new control wins over the old switch, and the old key is gone', async () => {
        const s = await load({ autoWatchStreamOnly: false, autoOpenStreams: 'all' });
        expect(s.autoOpenStreams).toBe('all');
        expect('autoWatchStreamOnly' in s).toBe(false);
    });
});

describe('what it does in a call (autoWatchPlan, fed as Chat.tsx feeds it)', () => {
    const BOT = 7;      // a stream-only account, sharing
    const HUMAN = 8;    // a person, sharing
    const ME = 1;
    const opened = (mode: AutoOpenStreams) => autoWatchPlan({
        streamers: [BOT, HUMAN],
        me: ME,
        selected: [],
        handled: new Set(),
        isStreamOnly: (id) => id === BOT,
        mode,
        saveData: false,
        viewerIsStreamOnly: false,
    }).open;

    it("with the default, a stream-only account's share does NOT open by itself: fresh, never saved, or switched", async () => {
        expect(opened((await load(null)).autoOpenStreams), 'a fresh device').toEqual([]);
        localStorage.clear();
        for (const k of OLDER_MARKERS) localStorage.setItem(k, '1');
        expect(opened((await load(null)).autoOpenStreams), 'an old device that never saved settings').toEqual([]);
        localStorage.clear();
        expect(opened((await load({ autoOpenStreams: 'stream-only' })).autoOpenStreams), 'an old device saved with the old default').toEqual([]);
    });

    it("chosen, From stream-only accounts opens that account's share and nobody else's; All streams opens every share", async () => {
        await load(null);
        await choose('stream-only');
        expect(opened((await freshStore()).loadSettings().autoOpenStreams)).toEqual([BOT]);
        await choose('all');
        expect(opened((await freshStore()).loadSettings().autoOpenStreams)).toEqual([BOT, HUMAN]);
        // And back to Off: nothing again.
        await choose('off');
        expect(opened((await freshStore()).loadSettings().autoOpenStreams)).toEqual([]);
    });
});
