import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings, notifEnabled } from '../components/settingsStore';
import { isChannelMuted, toggleChannelMute } from '../components/mutedChannelsStore';

// The shared test setup stubs localStorage as no-op vi.fn()s; these stores are
// all about the localStorage round-trip, so install a real in-memory one.
beforeEach(() => {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
            setItem: (k: string, v: string) => { store.set(k, String(v)); },
            removeItem: (k: string) => { store.delete(k); },
            clear: () => { store.clear(); },
        },
    });
});

describe('notifEnabled gating', () => {
    it('defaults: chime/message/stream on, TTS off', () => {
        expect(notifEnabled('message')).toBe(true);
        expect(notifEnabled('voiceChime')).toBe(true);
        expect(notifEnabled('stream')).toBe(true);
        expect(notifEnabled('voiceTTS')).toBe(false); // opt-in
    });

    it('master toggle off silences every category', () => {
        saveSettings({ ...loadSettings(), soundsEnabled: false });
        expect(notifEnabled('message')).toBe(false);
        expect(notifEnabled('voiceChime')).toBe(false);
        expect(notifEnabled('stream')).toBe(false);
        expect(notifEnabled('voiceTTS')).toBe(false);
    });

    it('a category can be enabled/disabled independently', () => {
        saveSettings({ ...loadSettings(), voiceTTS: true, streamSound: false });
        expect(notifEnabled('voiceTTS')).toBe(true);
        expect(notifEnabled('stream')).toBe(false);
        expect(notifEnabled('message')).toBe(true);
    });
});

describe('channel mute store', () => {
    it('toggles and persists per channel', () => {
        expect(isChannelMuted(42)).toBe(false);
        expect(toggleChannelMute(42)).toBe(true);
        expect(isChannelMuted(42)).toBe(true);
        expect(isChannelMuted(99)).toBe(false); // independent
        expect(toggleChannelMute(42)).toBe(false);
        expect(isChannelMuted(42)).toBe(false);
    });

    it('accepts number or string ids interchangeably', () => {
        toggleChannelMute(7);
        expect(isChannelMuted('7')).toBe(true);
        expect(isChannelMuted(7)).toBe(true);
    });
});
