/**
 * The mic-processing toggles were retroactively activated. This undoes it once.
 *
 * Until v0.7.0, Echo Cancellation / Auto Gain / Noise Suppression affected ONLY
 * the settings-panel mic test; real calls used hardcoded constraints
 * (`echoCancellation: true, autoGainControl: true` for the ML modes). v0.7.0
 * correctly wired them to calls — and thereby activated whatever was sitting in
 * storage, set at a time when flipping it visibly did nothing.
 *
 * Confirmed in the wild: a user reporting worse noise suppression read back
 * `autoGainControl: false` with `echoCancellation: true`, having changed no
 * Windows or hardware setting. They had never meaningfully chosen it.
 *
 * The load-bearing behaviour is the SECOND load: a value set after the
 * migration is a real choice and must survive, or the toggle becomes
 * impossible to turn off — trading one silent override for another.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';
const MIGRATION_KEY = 'micProcessingTogglesReset_v1';

/** A real in-memory localStorage — setup.ts installs vi.fn() stubs that
 *  return undefined, which cannot model "written, then read back". */
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

/** Fresh module instance each time — loadSettings is import-time stateful. */
async function freshLoad() {
    vi.resetModules();
    const mod = await import('../components/settingsStore');
    return mod.loadSettings();
}

let store: Map<string, string>;
beforeEach(() => { store = installStorage(); });

describe('mic processing toggle migration', () => {
    it('resets a stored autoGainControl:false — the confirmed real case', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false, echoCancellation: true }));
        const s = await freshLoad();
        expect(s.autoGainControl).toBe(true);
        expect(s.echoCancellation).toBe(true);
    });

    it('resets echoCancellation and noiseSuppression too', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({
            echoCancellation: false, autoGainControl: false, noiseSuppression: false,
        }));
        const s = await freshLoad();
        expect(s.echoCancellation).toBe(true);
        expect(s.autoGainControl).toBe(true);
        expect(s.noiseSuppression).toBe(true);
    });

    it('PERSISTS the reset, not just the in-memory value', async () => {
        // Without the write-back the migration marker is set while storage still
        // says false, so the very next load restores the bad value and the fix
        // silently lasts exactly one session.
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false }));
        await freshLoad();
        expect(JSON.parse(store.get(SETTINGS_KEY)!).autoGainControl).toBe(true);
        expect(store.get(MIGRATION_KEY)).toBe('1');
    });

    // THE CONTROL. Everything above passes on a migration that runs on EVERY
    // load — which would make these three toggles impossible to switch off,
    // replacing a silent override with a louder one.
    it('does NOT touch a deliberate choice made after the migration', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false }));
        await freshLoad();                       // migration runs
        expect(store.get(MIGRATION_KEY)).toBe('1');

        // User now turns it off ON PURPOSE, with the toggles fully live.
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false }));
        const s = await freshLoad();
        expect(s.autoGainControl).toBe(false);
    });

    it('leaves enabled toggles alone and still marks itself done', async () => {
        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: true, inputVolume: 80 }));
        const s = await freshLoad();
        expect(s.autoGainControl).toBe(true);
        expect(s.inputVolume).toBe(80);          // unrelated settings survive
        expect(store.get(MIGRATION_KEY)).toBe('1');
    });

    it('does not invent a settings blob for a brand-new user', async () => {
        const s = await freshLoad();
        expect(s.autoGainControl).toBe(true);
        expect(store.has(SETTINGS_KEY)).toBe(false);
    });

    it('disarms on a fresh profile, so a first-ever save is not undone', async () => {
        // The migration originally ran only when a settings blob already
        // existed, which left it armed on a new profile: the user's FIRST save
        // turning auto-gain off was then reset on the next load — the exact
        // silent override this migration exists to undo, aimed at a real
        // choice. inputGain.test.ts caught it.
        await freshLoad();                                  // fresh profile
        expect(store.get(MIGRATION_KEY)).toBe('1');         // must disarm here

        store.set(SETTINGS_KEY, JSON.stringify({ autoGainControl: false }));
        const s = await freshLoad();
        expect(s.autoGainControl).toBe(false);
    });

    it('survives corrupt stored JSON', async () => {
        store.set(SETTINGS_KEY, '{not json');
        const s = await freshLoad();
        expect(s.autoGainControl).toBe(true);
    });
});
