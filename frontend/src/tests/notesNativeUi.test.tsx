/**
 * The Notes-app native UI pieces, mounted with react-dom/client + act (the
 * repo's component-test pattern):
 *
 *  - useNotesNativeSession: signing out (any way — the gate's one flag) clears
 *    every native alarm/token/fence; signed in, it must NOT (control);
 *  - NativeReminderBanners: the banner matches the notification state, and
 *    shows nothing at all without the plugin (browser / older APK);
 *  - NativeTokenGate: children wait for the token hand-back in the app and
 *    render at once without the plugin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let available = true;
let notif: { granted: boolean; needsRequest: boolean; blocked: boolean } | null = null;
let exact: { exact: boolean } | null = { exact: true };
let battery: { ignoring: boolean } | null = { ignoring: true };
const clearNativeSession = vi.fn(async () => undefined);
let adoptResolve: (() => void) | null = null;
const setPlacesAuthed = vi.fn();
const syncTaskPlacesToNative = vi.fn(async () => undefined);

vi.mock('../notes/native/notesNative', () => ({
    notesNativeAvailable: () => available,
    clearNativeSession: () => clearNativeSession(),
    nativeNotificationStatus: async () => (available ? notif : null),
    nativeExactAlarmStatus: async () => (available ? exact : null),
    nativeBatteryStatus: async () => (available ? battery : null),
    requestNativeNotificationPermission: vi.fn(async () => true),
    openNativeNotificationSettings: vi.fn(async () => true),
    openNativeExactAlarmSettings: vi.fn(async () => true),
    requestNativeBatteryExemption: vi.fn(async () => true),
    adoptNativeRenewedToken: () => new Promise<boolean>(r => { adoptResolve = () => r(false); }),
}));
vi.mock('../api/taskPlaces', () => ({
    setPlacesAuthed: (b: boolean) => setPlacesAuthed(b),
    syncTaskPlacesToNative: () => syncTaskPlacesToNative(),
}));

const { useNotesNativeSession } = await import('../notes/native/useNotesNativeSession');
const { NativeReminderBanners } = await import('../notes/native/NativeReminderBanners');
const { NativeTokenGate } = await import('../notes/native/NativeTokenGate');

const settle = async () => { await act(async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); }); };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
    available = true;
    notif = null;
    exact = { exact: true };
    battery = { ignoring: true };
    clearNativeSession.mockClear();
    setPlacesAuthed.mockClear();
    syncTaskPlacesToNative.mockClear();
    adoptResolve = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

function Session({ signedIn }: { signedIn: boolean }) {
    useNotesNativeSession(signedIn);
    return null;
}

describe('useNotesNativeSession', () => {
    it('signed in: nothing is cleared (control), places may push', async () => {
        act(() => root.render(<Session signedIn={true} />));
        await settle();
        expect(clearNativeSession).not.toHaveBeenCalled();
        expect(setPlacesAuthed).toHaveBeenLastCalledWith(true);
    });
    it('signing out clears the native side and stops the place store', async () => {
        act(() => root.render(<Session signedIn={true} />));
        await settle();
        act(() => root.render(<Session signedIn={false} />));
        await settle();
        expect(clearNativeSession).toHaveBeenCalledTimes(1);
        expect(setPlacesAuthed).toHaveBeenLastCalledWith(false);
    });
    it('a settings save re-syncs the fences', async () => {
        act(() => root.render(<Session signedIn={true} />));
        await settle();
        syncTaskPlacesToNative.mockClear();
        window.dispatchEvent(new CustomEvent('settingsChanged', { detail: {} }));
        expect(syncTaskPlacesToNative).toHaveBeenCalledTimes(1);
    });
});

describe('NativeReminderBanners', () => {
    it('asks to enable when the permission is still askable', async () => {
        notif = { granted: false, needsRequest: true, blocked: false };
        act(() => root.render(<NativeReminderBanners />));
        await settle();
        expect(container.querySelector('[data-native-banner="enable"]')?.textContent).toMatch(/even when Notes is closed/);
        expect(container.querySelector('[data-native-banner="blocked"]')).toBeNull();
    });
    it('routes to settings when notifications are blocked', async () => {
        notif = { granted: true, needsRequest: false, blocked: true };
        act(() => root.render(<NativeReminderBanners />));
        await settle();
        expect(container.querySelector('[data-native-banner="blocked"]')).not.toBeNull();
        expect(container.querySelector('[data-native-banner="enable"]')).toBeNull();
    });
    it('says when exact timing or battery rules will delay reminders', async () => {
        notif = { granted: true, needsRequest: false, blocked: false };
        exact = { exact: false };
        battery = { ignoring: false };
        act(() => root.render(<NativeReminderBanners />));
        await settle();
        expect(container.querySelector('[data-native-banner="exact"]')).not.toBeNull();
        expect(container.querySelector('[data-native-banner="battery"]')).not.toBeNull();
    });
    it('all good: nothing to say', async () => {
        notif = { granted: true, needsRequest: false, blocked: false };
        act(() => root.render(<NativeReminderBanners />));
        await settle();
        expect(container.innerHTML).toBe('');
    });
    it('no plugin: renders nothing even with a status the browser could fake', async () => {
        available = false;
        notif = { granted: false, needsRequest: true, blocked: false };
        act(() => root.render(<NativeReminderBanners />));
        await settle();
        expect(container.innerHTML).toBe('');
    });
});

describe('NativeTokenGate', () => {
    it('in the app, children wait for the token hand-back', async () => {
        act(() => root.render(<NativeTokenGate><p id="child">x</p></NativeTokenGate>));
        await settle();
        expect(container.querySelector('#child')).toBeNull();
        await act(async () => { adoptResolve?.(); });
        await settle();
        expect(container.querySelector('#child')).not.toBeNull();
    });
    it('without the plugin, children render at once', async () => {
        available = false;
        act(() => root.render(<NativeTokenGate><p id="child">x</p></NativeTokenGate>));
        expect(container.querySelector('#child')).not.toBeNull();
    });
});
