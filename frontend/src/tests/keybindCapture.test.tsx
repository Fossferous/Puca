/**
 * The Keybinds tab, driven for real, against the registry: a key pressed to BE a
 * binding must not also run the action. The save that ends a capture starts
 * watching that key while it is still down, so the native poll reports it as a
 * press the hook missed about 40 ms later, with capture already over. Rebinding
 * Toggle Mute while muted then unmuted you.
 *
 * hotkeys.test.ts holds the rule; this holds the modal to telling the registry.
 *
 * Mounted with raw `react-dom/client` + `act`, as the repo's other component
 * tests are.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../api/profile', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/profile')>()),
    getProfile: async () => ({ id: 1, username: 'me', display_name: null, email: null }),
}));
vi.mock('../components/blockStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../components/blockStore')>()),
    fetchBlockedUsers: async () => [],
}));
vi.mock('../api/client', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/client')>();
    return { ...real, apiClient: { ...real.apiClient, get: async () => ({}) } };
});

const { SettingsModal } = await import('../components/SettingsModal');
const { nativeKeyEvent, registerPress, resetHotkeysForTest } = await import('../api/hotkeys');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const K = 75;
const noModifiers = { ctrlKey: false, altKey: false, shiftKey: false };

let container: HTMLDivElement;
let root: Root;
let presses = 0;
const settle = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };

const bindButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.keybind-btn')];
const capturing = () => bindButtons().some(b => b.textContent?.includes('Press a key'));

/** Open Keybinds and start capturing on the first row. */
async function startCapture() {
    await act(async () => { root.render(<SettingsModal isOpen onClose={() => {}} onLogout={() => {}} />); });
    await settle();
    const nav = [...container.querySelectorAll('.settings-nav-item')].find(b => b.textContent?.includes('Keybinds'));
    expect(nav, 'the Keybinds section exists').toBeTruthy();
    await act(async () => { nav!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    await act(async () => { bindButtons()[0].click(); });
    expect(capturing(), 'capture started').toBe(true);
}

function press(type: 'keydown' | 'keyup', keyCode: number, init: KeyboardEventInit = {}) {
    const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, 'keyCode', { value: keyCode });
    window.dispatchEvent(e);
}

beforeEach(() => {
    presses = 0;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPress('voice.toggleMute', () => ({ keyCode: K, ctrl: false, alt: false, shift: false, label: 'K' }), () => { presses++; });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});
afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetHotkeysForTest();
    vi.restoreAllMocks();
});

describe('the keystroke that ends a capture', () => {
    it('a key captured as a binding: its own press from the native feed runs nothing', async () => {
        await startCapture();
        await act(async () => { press('keydown', K, { key: 'k' }); });
        expect(capturing(), 'the capture committed and ended').toBe(false);

        nativeKeyEvent('down', { keyCode: K, ...noModifiers });
        expect(presses).toBe(0);

        // And it is only that keystroke.
        nativeKeyEvent('up', { keyCode: K, ...noModifiers });
        nativeKeyEvent('down', { keyCode: K, ...noModifiers });
        expect(presses).toBe(1);
    });

    it('a mouse button captured as a binding: the same', async () => {
        registerPress('voice.saveClip', () => ({ keyCode: 5, ctrl: false, alt: false, shift: false, label: 'Mouse 4' }), () => { presses++; });
        await startCapture();
        await act(async () => { window.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true })); });
        expect(capturing(), 'the capture committed and ended').toBe(false);

        nativeKeyEvent('down', { keyCode: 5, ...noModifiers });
        expect(presses).toBe(0);
    });

    it('Escape, cancelling a capture, does not run what Escape is bound to either', async () => {
        registerPress('voice.toggleDeafen', () => ({ keyCode: 27, ctrl: false, alt: false, shift: false, label: 'Esc' }), () => { presses++; });
        await startCapture();
        await act(async () => { press('keydown', 27, { key: 'Escape' }); });
        expect(capturing(), 'the capture was cancelled').toBe(false);

        nativeKeyEvent('down', { keyCode: 27, ...noModifiers });
        expect(presses).toBe(0);
    });

    it('positive control: a key the capture refused is not spent, and neither is one nobody pressed', async () => {
        const D = 68;
        registerPress('voice.toggleDeafen', () => ({ keyCode: D, ctrl: true, alt: false, shift: true, label: 'D' }), () => { presses++; });
        await startCapture();
        // Ctrl+Shift+D is Toggle Deafen's default: refused, still capturing, and
        // nothing about that key was saved.
        await act(async () => { press('keydown', D, { key: 'd', ctrlKey: true, shiftKey: true }); });
        expect(capturing(), 'the clash stays in capture').toBe(true);
        await act(async () => { press('keydown', 66, { key: 'b' }); });
        expect(capturing()).toBe(false);

        nativeKeyEvent('down', { keyCode: D, ctrlKey: true, altKey: false, shiftKey: true });
        expect(presses).toBe(1);
        nativeKeyEvent('down', { keyCode: K, ...noModifiers });
        expect(presses).toBe(2);
    });
});
