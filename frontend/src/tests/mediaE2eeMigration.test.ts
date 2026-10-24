// @vitest-environment jsdom
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
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

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

/** The engine's frame-transform API is what the migrations are gated on;
 *  drive it per test: Chromium's, the standard one (Firefox, Safari), or none. */
let api: 'encoded-streams' | 'script-transform' | null = 'encoded-streams';
vi.mock('../api/rtc/mediaCrypto', () => ({
    mediaTransformApi: () => api,
    isMediaE2eeSupported: () => api !== null,
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
    api = 'encoded-streams';
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
        api = null;
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

/**
 * The second one: Firefox and Safari encrypt mesh calls now (the standard
 * RTCRtpScriptTransform path), so the `false` the first migration had to
 * leave them is switched on — once, and SAID: the owner's decision was "turn
 * it on, with a notice". Chromium profiles are not this one's to touch.
 */
const MARKER_V2 = 'requireMediaE2eeDefaultOn_v2';
const NOTICE = 'requireMediaE2eeTurnedOnNotice_v2';

describe('require-media-E2EE migration, part two: the browsers that encrypt now', () => {
    it('Firefox / Safari: a stored off is switched on, persisted, and the notice is pending', async () => {
        api = 'script-transform';
        localStorage.setItem(MARKER, '1'); // the first migration ran, and passed it over
        store({ requireMediaE2ee: false, theme: 'dark' });
        const { loadSettings, callEncryptionNoticePending } = await freshStore();

        expect(loadSettings().requireMediaE2ee, 'left off in a browser that now encrypts calls').toBe(true);
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).requireMediaE2ee).toBe(true);
        expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).theme, 'the rest of the profile was lost').toBe('dark');
        expect(localStorage.getItem(MARKER_V2)).toBe('1');
        expect(callEncryptionNoticePending(), 'switched on WITHOUT saying so').toBe(true);
        expect(localStorage.getItem(NOTICE)).toBe('pending');
    });

    it('the notice survives a relaunch until it is dismissed, then never shows again — and a deliberate off after it sticks', async () => {
        api = 'script-transform';
        localStorage.setItem(MARKER, '1');
        store({ requireMediaE2ee: false });
        (await freshStore()).loadSettings();
        const relaunched = await freshStore();
        relaunched.loadSettings();
        expect(relaunched.callEncryptionNoticePending(), 'gone before it was read').toBe(true);
        relaunched.dismissCallEncryptionNotice();
        expect(relaunched.callEncryptionNoticePending()).toBe(false);

        store({ requireMediaE2ee: false }); // turned off on purpose, in Settings
        const again = await freshStore();
        expect(again.loadSettings().requireMediaE2ee, 'a deliberate off was undone').toBe(false);
        expect(again.callEncryptionNoticePending(), 'the notice came back').toBe(false);
    });

    it('a profile the first migration never reached is switched on by this one — with the notice, not silently', async () => {
        api = 'script-transform';
        store({ requireMediaE2ee: false });
        const { loadSettings, callEncryptionNoticePending } = await freshStore();
        expect(loadSettings().requireMediaE2ee).toBe(true);
        expect(callEncryptionNoticePending()).toBe(true);
        expect(localStorage.getItem(MARKER), 'the first one is disarmed too').toBe('1');
    });

    it('CONTROL: Chromium — an off kept after the first migration is a choice, and this one leaves it', async () => {
        api = 'encoded-streams';
        localStorage.setItem(MARKER, '1');
        store({ requireMediaE2ee: false });
        const { loadSettings, callEncryptionNoticePending } = await freshStore();
        expect(loadSettings().requireMediaE2ee, 'a Chromium profile was touched').toBe(false);
        expect(callEncryptionNoticePending()).toBe(false);
        expect(localStorage.getItem(MARKER_V2), 'still armed: it would fire on this profile later').toBe('1');
    });

    it('CONTROL: an engine with neither API is left off (on would mean no voice), with no notice', async () => {
        api = null;
        store({ requireMediaE2ee: false });
        const { loadSettings, callEncryptionNoticePending } = await freshStore();
        expect(loadSettings().requireMediaE2ee).toBe(false);
        expect(callEncryptionNoticePending()).toBe(false);
        expect(localStorage.getItem(MARKER_V2)).toBe('1');
    });

    it('nothing to say where it was already on, or nothing was stored', async () => {
        api = 'script-transform';
        store({ requireMediaE2ee: true });
        const on = await freshStore();
        expect(on.loadSettings().requireMediaE2ee).toBe(true);
        expect(on.callEncryptionNoticePending()).toBe(false);

        localStorage.clear();
        const fresh = await freshStore();
        expect(fresh.loadSettings().requireMediaE2ee).toBe(true);
        expect(fresh.callEncryptionNoticePending()).toBe(false);
        expect(localStorage.getItem(SETTINGS_KEY), 'a fresh profile was given a settings blob').toBeNull();
        expect(localStorage.getItem(MARKER_V2)).toBe('1');
    });

    it('the notice says what changed and where to change it, and goes when dismissed', async () => {
        api = 'script-transform';
        store({ requireMediaE2ee: false });
        const s = await freshStore();
        s.loadSettings();
        const { CallEncryptionNotice } = await import('../components/CallEncryptionNotice');
        const container = document.createElement('div');
        document.body.appendChild(container);
        const root = createRoot(container);
        try {
            await act(async () => { root.render(createElement(CallEncryptionNotice)); });
            const text = container.textContent ?? '';
            expect(text).toMatch(/now end-to-end encrypted/);
            expect(text).toContain('Require encryption for calls');
            expect(text).toContain('Settings → Privacy & Safety');
            const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
            expect(dismiss).not.toBeNull();
            await act(async () => { dismiss!.click(); });
            expect(container.textContent, 'still shown after Dismiss').toBe('');
            expect(localStorage.getItem(NOTICE)).toBe('seen');
        } finally {
            act(() => root.unmount());
            container.remove();
        }
    });

    it('CONTROL: the notice shows nothing where nothing was switched on', async () => {
        api = 'encoded-streams';
        store({ requireMediaE2ee: false });
        (await freshStore()).loadSettings();
        const { CallEncryptionNotice } = await import('../components/CallEncryptionNotice');
        const container = document.createElement('div');
        const root = createRoot(container);
        await act(async () => { root.render(createElement(CallEncryptionNotice)); });
        expect(container.textContent).toBe('');
        act(() => root.unmount());
    });
});
