// @vitest-environment jsdom
/**
 * Auto Gain Control is OFF by default in a browser, and stays on in the
 * desktop and Android apps (settingsStore.ts, autoGainOnByDefault).
 *
 * Why: getUserMedia's autoGainControl lets Chromium move the OS microphone
 * level, and on Windows the level stays where it was dragged (three of the
 * owner's mics at 7.8 %, 0.9.830). The desktop app stops that with a WebView2
 * flag (micLevelAgcFlag.test.ts); a web page has no such flag, so there the
 * only lever is not asking for auto gain. Chromium's Android capture streams
 * have no level to move, so the Android app keeps it.
 *
 * The load-bearing part is the stored profile. Any save writes the WHOLE
 * settings object, so an existing browser profile carries
 * `autoGainControl: true` that nobody chose; a default change alone would
 * reach nobody. A one-time migration turns that stored `true` off, and after
 * it a stored `true` is a choice and is kept.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';
const MARKER = 'autoGainDefaultOffInBrowser_v1';

type Win = Window & { __TAURI_INTERNALS__?: unknown };

/** A real in-memory localStorage (setup.ts installs stubs that keep nothing). */
function installStorage(): Map<string, string> {
    const store = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
            setItem: (k: string, v: string) => { store.set(k, String(v)); },
            removeItem: (k: string) => { store.delete(k); },
            clear: () => store.clear(),
        },
    });
    return store;
}

/** A fresh module instance: the default is decided as the module loads. */
async function fresh() {
    vi.resetModules();
    const store = await import('../components/settingsStore');
    const noise = await import('../api/noiseFilter');
    return { ...store, getMicConstraints: noise.getMicConstraints };
}

let store: Map<string, string>;
const stored = () => JSON.parse(store.get(SETTINGS_KEY) ?? '{}') as Record<string, unknown>;

beforeEach(() => {
    store = installStorage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
    delete (window as Win).__TAURI_INTERNALS__;
    vi.doUnmock('../api/platform');
    vi.restoreAllMocks();
});

describe('in a browser (the web app)', () => {
    it('a new profile starts with auto gain OFF, and the microphone is opened without it', async () => {
        const m = await fresh();
        expect(m.autoGainOnByDefault()).toBe(false);
        expect(m.defaultSettings.autoGainControl).toBe(false);
        expect(m.loadSettings().autoGainControl).toBe(false);
        // What getUserMedia is actually asked for: the whole point.
        expect(m.getMicConstraints('standard').autoGainControl).toBe(false);
        expect(m.getMicConstraints('rnnoise').autoGainControl).toBe(false);
        expect(store.has(SETTINGS_KEY), 'no settings blob invented').toBe(false);
        expect(store.get(MARKER), 'disarmed on a fresh profile').toBe('1');
    });

    it('THE OLD DEFAULT: a stored `true` from before the change becomes off, once, and is persisted', async () => {
        // What every browser profile that ever saved Settings looks like: the
        // whole object, auto gain at the old default.
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true, inputVolume: 80, theme: 'light' }));
        const m = await fresh();
        const s = m.loadSettings();
        expect(s.autoGainControl).toBe(false);
        expect(s.inputVolume, 'other settings untouched').toBe(80);
        expect(s.theme).toBe('light');
        expect(stored().autoGainControl, 'written back, not just this load').toBe(false);
        expect(store.get(MARKER)).toBe('1');
        expect(m.getMicConstraints('standard').autoGainControl).toBe(false);
    });

    it('a stored `false` was always a choice and stays off', async () => {
        store.set('micProcessingTogglesReset_v1', '1'); // a profile from after 0.7.0's reset
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false, manualGain: 150 }));
        const s = (await fresh()).loadSettings();
        expect(s.autoGainControl).toBe(false);
        expect(s.manualGain).toBe(150);
    });

    // THE CONTROL. Everything above also passes on a migration that runs on
    // every load, which would make auto gain impossible to turn ON in a
    // browser: the user's explicit choice must be kept.
    it('turned ON after the change, it stays on across loads', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true }));
        (await fresh()).loadSettings(); // the one-time migration
        expect(stored().autoGainControl).toBe(false);

        store.set(SETTINGS_KEY, JSON.stringify({ ...stored(), autoGainControl: true })); // Settings: switched on
        const again = await fresh();
        expect(again.loadSettings().autoGainControl).toBe(true);
        expect(again.getMicConstraints('standard').autoGainControl).toBe(true);
        expect((await fresh()).loadSettings().autoGainControl, 'and on the load after that').toBe(true);
    });

    it('a first-ever save that turns it on is kept (the migration disarmed on the empty profile)', async () => {
        (await fresh()).loadSettings();
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true }));
        expect((await fresh()).loadSettings().autoGainControl).toBe(true);
    });

    it('with Auto Gain off, Manual Gain is what sets the level', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false, manualGain: 150 }));
        expect((await fresh()).inputGain()).toBe(1.5);
    });

    it('switched off by the migration, Manual Gain starts at 100 %, not at a value left from an earlier off', async () => {
        // Set to 0 % while auto gain was once off, then auto gain switched
        // back on (Manual Gain hidden and ignored): flipped off with it kept,
        // this person would be silent in the next call.
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true, manualGain: 0, inputVolume: 80 }));
        const m = await fresh();
        const s = m.loadSettings();
        expect(s.autoGainControl).toBe(false);
        expect(s.manualGain).toBe(100);
        expect(stored().manualGain, 'persisted').toBe(100);
        expect(m.inputGain(), 'Input Volume still applies').toBe(0.8);
        // CONTROL: a Manual Gain chosen after the change is kept.
        store.set(SETTINGS_KEY, JSON.stringify({ ...stored(), manualGain: 150 }));
        expect((await fresh()).loadSettings().manualGain).toBe(150);
    });

    it('a profile from before 0.7.0 (no mic-toggle marker) ends with auto gain off too', async () => {
        // migrateMicProcessingToggles resets a stored `false` to the DEFAULT,
        // which in a browser is now off.
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false, echoCancellation: false }));
        const s = (await fresh()).loadSettings();
        expect(s.autoGainControl).toBe(false);
        expect(s.echoCancellation, 'the old reset still applies to the others').toBe(true);
    });

    it('the hint says why it is off by default here', async () => {
        const note = (await fresh()).autoGainLevelNote();
        expect(note).toMatch(/^Off by default in the web app/);
        expect(note).toContain('lower your system microphone level');
        expect(note).toContain('The desktop and Android apps never change it.');
    });
});

describe('in the desktop app: unchanged', () => {
    beforeEach(() => { (window as Win).__TAURI_INTERNALS__ = {}; });

    it('defaults to on, keeps a stored `true`, and writes no browser marker', async () => {
        const m = await fresh();
        expect(m.defaultSettings.autoGainControl).toBe(true);
        expect(m.loadSettings().autoGainControl).toBe(true);
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true }));
        expect((await fresh()).loadSettings().autoGainControl).toBe(true);
        expect(stored().autoGainControl).toBe(true);
        expect(store.has(MARKER)).toBe(false);
    });

    it('keeps a deliberate off', async () => {
        (await fresh()).loadSettings(); // the older migrations disarm
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false }));
        expect((await fresh()).loadSettings().autoGainControl).toBe(false);
    });

    it("says the Windows level is never changed", async () => {
        expect((await fresh()).autoGainLevelNote()).toContain("never changes your microphone's Windows input level");
    });
});

describe('in the Android app: on (its capture has no system level to move)', () => {
    beforeEach(() => {
        vi.doMock('../api/platform', async (importOriginal) => ({
            ...(await importOriginal<typeof import('../api/platform')>()),
            isAndroidApp: () => true,
            isMobile: () => true,
        }));
    });

    it('defaults to on and keeps a stored `true`', async () => {
        const m = await fresh();
        expect(m.autoGainOnByDefault()).toBe(true);
        expect(m.loadSettings().autoGainControl).toBe(true);
        expect(m.getMicConstraints('standard').autoGainControl).toBe(true);
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true }));
        expect((await fresh()).loadSettings().autoGainControl).toBe(true);
        expect(store.has(MARKER)).toBe(false);
        expect(m.autoGainLevelNote()).toContain('In the Android app');
    });
});
