/**
 * Mute/deafen now ship BOUND (Ctrl+Shift+M / Ctrl+Shift+D) — "toggle mute
 * doesn't work" was a field report whose cause was that nothing was bound and
 * nothing said so. Changing the default fixes only fresh installs: every
 * existing profile has an explicit `null` written, and stored values beat
 * defaults — so a one-time migration rewrites exactly those nulls. These pin
 * both halves: that it fires, and that it never overrides a real choice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';
const MARKER = 'voiceKeybindDefaults_v1';

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

describe('voice-keybind default migration', () => {
    it('rewrites a stored explicit null to the default binding, and persists it', async () => {
        store({ toggleMuteBinding: null, toggleDeafenBinding: null });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.toggleMuteBinding).toEqual({ keyCode: 77, ctrl: true, alt: false, shift: true, label: 'M' });
        expect(s.toggleDeafenBinding).toEqual({ keyCode: 68, ctrl: true, alt: false, shift: true, label: 'D' });
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).toggleMuteBinding?.keyCode).toBe(77);
        expect(localStorage.getItem(MARKER), 'the marker disarms the migration').toBe('1');
    });

    it('POSITIVE CONTROL: a custom stored binding is untouched', async () => {
        const custom = { keyCode: 121, ctrl: false, alt: true, shift: false, label: 'F10' };
        store({ toggleMuteBinding: custom, toggleDeafenBinding: null });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.toggleMuteBinding, 'a rebind is a real choice').toEqual(custom);
        expect(s.toggleDeafenBinding?.keyCode, 'the null sibling still migrates').toBe(68);
    });

    it('runs ONCE: clearing the binding after the migration sticks', async () => {
        store({ toggleMuteBinding: null });
        const first = await freshStore();
        expect(first.loadSettings().toggleMuteBinding?.keyCode).toBe(77);

        // The user then clears it on purpose.
        first.saveSettings({ ...first.loadSettings(), toggleMuteBinding: null });

        const second = await freshStore();
        expect(
            second.loadSettings().toggleMuteBinding,
            'a migration that re-fires would silently undo a real clear',
        ).toBeNull();
    });

    it('a fresh profile gets the defaults WITHOUT anything being written', async () => {
        const { loadSettings } = await freshStore();
        const s = loadSettings();
        expect(s.toggleMuteBinding?.keyCode).toBe(77);
        expect(localStorage.getItem(MARKER)).toBe('1');
        // Persisting a full blob on first load would freeze today's defaults
        // into storage for every later default change.
        expect(localStorage.getItem(SETTINGS_KEY)).toBeNull();
    });

    it('leaves the older migrations intact (they share a load path)', async () => {
        store({
            toggleMuteBinding: null,
            mobileNotifications: true,
            mobileBackgroundDelivery: false,
        });
        const { loadSettings } = await freshStore();
        const s = loadSettings();
        expect(s.toggleMuteBinding?.keyCode).toBe(77);
        expect(s.mobileBackgroundDelivery, 'the background-delivery migration still fires').toBe(true);
    });
});
