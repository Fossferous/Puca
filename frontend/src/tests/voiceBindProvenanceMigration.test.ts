/**
 * voiceBindProvenance_v1 — records, once, who chose the mute/deafen binds a
 * profile already holds. Before `voiceBindsUserSet` existed the desktop-global
 * feed inferred "chosen" from the value; that inference is sound in exactly one
 * direction (a stored bind that differs from the shipped default can only have
 * been set by the user), so it is converted into a record for those and left
 * unknown for a bind that equals the default. See settingsStore.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';
const MARKER = 'voiceBindProvenance_v1';
const DEF_MUTE = { keyCode: 77, ctrl: true, alt: false, shift: true, label: 'M' };
const DEF_DEAFEN = { keyCode: 68, ctrl: true, alt: false, shift: true, label: 'D' };
const F10 = { keyCode: 121, ctrl: false, alt: true, shift: false, label: 'F10' };

// A REAL localStorage for this file — the shared setup's vi.fn() stubs store
// nothing, and a migration is defined entirely by what persists across loads.
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

async function freshStore() {
    vi.resetModules();
    return await import('../components/settingsStore');
}

function store(partial: Record<string, unknown>): void {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(partial));
}

beforeEach(() => {
    localStorage.clear();
});

describe('voice-bind provenance migration', () => {
    it('marks a stored bind that differs from the default as user-set, and persists it', async () => {
        store({ toggleMuteBinding: F10, toggleDeafenBinding: DEF_DEAFEN });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.voiceBindsUserSet).toEqual({ toggleMuteBinding: true });
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).voiceBindsUserSet).toEqual({ toggleMuteBinding: true });
        expect(localStorage.getItem(MARKER), 'the marker disarms the migration').toBe('1');
    });

    it('a bind that EQUALS the default is left unknown — nothing can say who set it', async () => {
        store({ toggleMuteBinding: DEF_MUTE });
        const { loadSettings } = await freshStore();

        expect(loadSettings().voiceBindsUserSet).toEqual({});
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it('a default the older migration wrote over a cleared bind is NOT mistaken for a choice', async () => {
        store({ toggleMuteBinding: null, toggleDeafenBinding: F10 });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.toggleMuteBinding?.keyCode, 'the older migration still restores the default').toBe(77);
        expect(s.voiceBindsUserSet).toEqual({ toggleDeafenBinding: true });
    });

    it('runs ONCE: a later Reset (an explicit false) survives the next load', async () => {
        store({ toggleMuteBinding: F10 });
        const first = await freshStore();
        expect(first.loadSettings().voiceBindsUserSet).toEqual({ toggleMuteBinding: true });

        // The user then puts the bind back to the shipped default with Reset.
        first.saveSettings({ ...first.loadSettings(), toggleMuteBinding: DEF_MUTE, voiceBindsUserSet: { toggleMuteBinding: false } });

        const second = await freshStore();
        expect(
            second.loadSettings().voiceBindsUserSet,
            'a migration that re-fired would silently promote the default back to system-wide',
        ).toEqual({ toggleMuteBinding: false });
    });

    it('a fresh profile gets nothing written', async () => {
        const { loadSettings } = await freshStore();
        expect(loadSettings().voiceBindsUserSet).toEqual({});
        expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
        expect(localStorage.getItem(MARKER)).toBe('1');
    });
});
