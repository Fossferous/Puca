/**
 * Android notifications only ever had a window in which they COULD NOT fire.
 *
 * `mobileNotifications` defaulted ON and `mobileBackgroundDelivery` defaulted
 * OFF. Foregrounded, a notification is (correctly) suppressed as "you are
 * looking at it"; backgrounded without the foreground service, Android freezes
 * the process, so no message frame ever arrives to notify about. Between them
 * there was no state in which anything could be delivered — reported from the
 * field as "the only notification that works is the one saying there is a
 * session" (that one belongs to the device-session service, held for an
 * unrelated reason).
 *
 * Changing the default fixes only fresh installs — every existing profile has
 * `false` written, and stored values beat defaults — so a one-time migration
 * flips it for anyone who still wants notifications. These pin both halves:
 * that it flips, and that it never overrides a deliberate later choice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const SETTINGS_KEY = 'sovereign_settings';
const MARKER = 'mobileBackgroundDeliveryEnabled_v1';

/**
 * A REAL localStorage for this file.
 *
 * The shared setup (src/tests/setup.ts) installs `vi.fn()` stubs that store
 * nothing, which is fine for code that only wants storage not to explode — but
 * a migration is defined entirely by what persists across loads, so against
 * those stubs every assertion here would pass or fail for the wrong reason
 * (getItem always undefined = "never migrated", forever).
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

describe('background-delivery migration', () => {
    it('turns delivery ON for an existing profile that still wants notifications', async () => {
        store({ mobileNotifications: true, mobileBackgroundDelivery: false });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.mobileBackgroundDelivery, 'notifications with no delivery window is the bug').toBe(true);
        // Persisted, not just patched in memory: the next load must not have
        // to migrate again (and App.tsx reads the saved value to start the
        // service).
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).mobileBackgroundDelivery).toBe(true);
        expect(localStorage.getItem(MARKER), 'the marker disarms the migration').toBe('1');
    });

    it('POSITIVE CONTROL: the rig CAN observe delivery staying off — silence is respected', async () => {
        // Someone who turned notifications off is asking for silence; starting
        // a foreground service for them would be the opposite.
        store({ mobileNotifications: false, mobileBackgroundDelivery: false });
        const { loadSettings } = await freshStore();

        expect(loadSettings().mobileBackgroundDelivery).toBe(false);
        expect(localStorage.getItem(MARKER), 'still disarmed, so it cannot fire later').toBe('1');
    });

    it('runs ONCE: a deliberate later "off" is kept', async () => {
        store({ mobileNotifications: true, mobileBackgroundDelivery: false });
        const first = await freshStore();
        expect(first.loadSettings().mobileBackgroundDelivery).toBe(true);

        // The user then turns it off on purpose, knowing what it costs.
        const off = { ...first.loadSettings(), mobileBackgroundDelivery: false };
        first.saveSettings(off);

        const second = await freshStore();
        expect(
            second.loadSettings().mobileBackgroundDelivery,
            'a migration that re-fires would silently undo a real choice',
        ).toBe(false);
    });

    it('disarms itself on a fresh profile, so the first real choice survives', async () => {
        const { loadSettings } = await freshStore();
        // Nothing stored: defaults apply and the migration must mark itself
        // done anyway — left armed, it would reset the very first save.
        expect(loadSettings().mobileBackgroundDelivery).toBe(true);
        expect(localStorage.getItem(MARKER)).toBe('1');
    });

    it('leaves the mic-toggle migration intact (they share a load path)', async () => {
        store({ mobileNotifications: true, mobileBackgroundDelivery: false, echoCancellation: false });
        const { loadSettings } = await freshStore();

        const s = loadSettings();
        expect(s.mobileBackgroundDelivery).toBe(true);
        expect(s.echoCancellation, 'the older migration still resets its own keys').toBe(true);
    });
});
