import { describe, it, expect, beforeEach, vi } from 'vitest';
import { outputGain, applyOutputDevice, saveSettings, loadSettings } from '../components/settingsStore';

/**
 * "Output volume" and "Output device" were applied ONLY to the settings panel's
 * own test sound — real call audio read the per-user volume store and nothing
 * else, so both controls did nothing in an actual call. These pin the pieces
 * every playing element now goes through.
 */

// settingsStore reads localStorage directly; setup.ts stubs it with no-op vi.fns.
let store: Record<string, string> = {};
beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store[k] ?? null,
        setItem: (k: string, v: string) => { store[k] = v; },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { store = {}; },
    });
});

describe('master output gain', () => {
    it('is 1 by default so nothing is quieter than before', () => {
        expect(outputGain()).toBe(1);
    });

    it('follows the slider', () => {
        saveSettings({ ...loadSettings(), outputVolume: 50 });
        expect(outputGain()).toBe(0.5);
        saveSettings({ ...loadSettings(), outputVolume: 0 });
        expect(outputGain()).toBe(0);
    });

    it('clamps values outside 0..100 rather than producing a silent or distorted element', () => {
        // HTMLMediaElement.volume THROWS outside 0..1, which would break audio
        // for everyone in the call rather than just being loud.
        saveSettings({ ...loadSettings(), outputVolume: 400 });
        expect(outputGain()).toBe(1);
        saveSettings({ ...loadSettings(), outputVolume: -20 });
        expect(outputGain()).toBe(0);
    });

    it('survives a corrupt stored value', () => {
        // NOTE the exact key: settingsStore uses 'sovereign_settings' with an
        // UNDERSCORE. An earlier version of this test wrote 'sovereign-settings'
        // with a hyphen, so it asserted against a key nothing reads and passed
        // no matter what outputGain() did.
        store['sovereign_settings'] = JSON.stringify({ outputVolume: 'loud' });
        expect(outputGain()).toBe(1);
    });
});

describe('output device routing', () => {
    function fakeAudio(withSink: boolean) {
        const calls: string[] = [];
        const el = {
            calls,
            ...(withSink ? { setSinkId: (id: string) => { calls.push(id); return Promise.resolve(); } } : {}),
        };
        return el as unknown as HTMLMediaElement & { calls: string[] };
    }

    it('leaves the element alone on the default device', () => {
        const el = fakeAudio(true);
        applyOutputDevice(el);
        expect(el.calls).toEqual([]);
    });

    it('routes to the chosen device', () => {
        saveSettings({ ...loadSettings(), outputDeviceId: 'headset-1' });
        const el = fakeAudio(true);
        applyOutputDevice(el);
        expect(el.calls).toEqual(['headset-1']);
    });

    it('does nothing where setSinkId is unavailable (Firefox, Safari)', () => {
        saveSettings({ ...loadSettings(), outputDeviceId: 'headset-1' });
        const el = fakeAudio(false);
        expect(() => applyOutputDevice(el)).not.toThrow();
    });

    it('swallows a rejection so an unplugged device cannot silence the call', async () => {
        saveSettings({ ...loadSettings(), outputDeviceId: 'gone' });
        const el = {
            setSinkId: () => Promise.reject(new Error('device not found')),
        } as unknown as HTMLMediaElement;
        expect(() => applyOutputDevice(el)).not.toThrow();
        // Give the rejected promise a turn; an unhandled rejection would fail
        // the run.
        await new Promise(r => setTimeout(r, 0));
    });
});
