/**
 * THE DESKTOP BAR AND KEYS, through the real stage.
 *
 * The owner, 2026-10-23: "Android to desktop control is much better with so
 * many more options." The phone had Ctrl+Alt+Del, Alt+Tab, Alt+F4, Lock, Shut
 * down, privacy mode, Copy diagnostics and typed text; the desktop had none of
 * them, and Esc — the key that closes a dialog or a game's menu over there —
 * paused control instead of being sent. Pinned here: every action reaches the
 * session layer as the phone's does, Esc goes over, the stage's own chords
 * (Ctrl+Alt+Home/End/Enter) never do, a held key is let go when control
 * pauses, an open menu keeps the keyboard, and a view-only share is offered
 * nothing that injects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    sendInput: vi.fn(() => true),
    sendPowerAction: vi.fn(() => true),
    setPrivacyMode: vi.fn(),
    requestMonitor: vi.fn(),
    sendStreamQuality: vi.fn(),
    endSession: vi.fn(),
    storage: new Map<string, string>(),
}));

vi.mock('../api/devices/session', () => ({
    sendViewSize: () => { /* noop */ },
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: () => () => { /* unsubscribe */ },
    setCaretTracking: () => { /* noop */ },
    sendInput: (...a: unknown[]) => (h.sendInput as unknown as (...x: unknown[]) => boolean)(...a),
    requestMonitor: (...a: unknown[]) => h.requestMonitor(...a),
    requestKeyframe: () => true,
    setCursorOwned: () => { /* noop */ },
    endSession: (...a: unknown[]) => h.endSession(...a),
    sendClipboard: async () => null,
    sendStreamQuality: (...a: unknown[]) => h.sendStreamQuality(...a),
    setPrivacyMode: (...a: unknown[]) => h.setPrivacyMode(...a),
    sendPowerAction: (...a: unknown[]) => (h.sendPowerAction as unknown as (...x: unknown[]) => boolean)(...a),
    deviceDiagnosticsWindow: async () => [],
    deviceStatsSample: async () => null,
    activeSessions: () => [],
    requestFileAccess: () => { /* noop */ },
}));
vi.mock('../api/devices/tunnel', () => ({
    tunnelStatus: async () => ({ listeners: [], inbound_streams: 0, outbound_streams: 0, forwards: [] }),
}));
vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isMobile: () => false, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

const { DeviceStage } = await import('../components/DeviceStage');

const BOX = { left: 0, top: 0, width: 1280, height: 720 };
beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.height });
    HTMLElement.prototype.getBoundingClientRect = () => ({
        ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON() { return this; },
    }) as DOMRect;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => { /* noop */ };
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ }
    };
    window.matchMedia = (() => ({
        matches: false, media: '', onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    for (const f of [h.sendInput, h.sendPowerAction, h.setPrivacyMode, h.requestMonitor, h.sendStreamQuality, h.endSession]) f.mockClear();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

function session(over: Snapshot = {}): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [
            { id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 },
            { id: 1, label: 'Display 2', left: 1920, top: 0, width: 1920, height: 1080 },
        ],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false, powerNotice: null, peerName: 'Work Laptop',
        ...over,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

async function mount(over: Snapshot = {}) {
    h.snapshot = [session(over)];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
}

const buttons = () => Array.from(host!.querySelectorAll('button'));
const byText = (t: string | RegExp) => buttons().find(b =>
    typeof t === 'string' ? b.textContent?.trim() === t : t.test(b.textContent ?? ''));
const menuItem = (label: string) => Array.from(host!.querySelectorAll<HTMLButtonElement>('.dsb-item'))
    .find(b => b.querySelector('.dsb-item-label')?.textContent === label);

async function click(el: Element | undefined | null) {
    expect(el, 'the control must be there').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
}

async function openMenu(name: string) {
    await click(name === 'More' ? host!.querySelector('button[aria-label="More"]') : byText(new RegExp(`^\\s*${name}`)));
}

/** A key press as the window sees it. */
async function key(type: 'keydown' | 'keyup', code: string, mods: Partial<KeyboardEventInit> = {}) {
    const keyName = code === 'Escape' ? 'Escape' : code.replace(/^Key/, '').toLowerCase();
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent(type, { code, key: keyName, bubbles: true, cancelable: true, ...mods }));
    });
    await flush();
}

const frames = () => h.sendInput.mock.calls.map(c => (c as unknown[])[1] as { t: string; code?: string; down?: boolean; text?: string });
const keyFrames = () => frames().filter(f => f.t === 'key').map(f => `${f.code}${f.down ? '↓' : '↑'}`);

describe('keys on the desktop stage', () => {
    it('Esc goes to the remote machine, and control stays on', async () => {
        await mount();
        await key('keydown', 'Escape');
        await key('keyup', 'Escape');
        expect(keyFrames()).toEqual(['Escape↓', 'Escape↑']);
        expect(host!.textContent, 'Esc no longer pauses').not.toContain('Control paused');
    });

    it('Ctrl+Alt+Home pauses — letting go of the held Ctrl and Alt on the host — and resumes', async () => {
        await mount();
        await key('keydown', 'ControlLeft', { ctrlKey: true });
        await key('keydown', 'AltLeft', { ctrlKey: true, altKey: true });
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(host!.textContent).toContain('Control paused');
        // The two modifiers went down to the host before the chord, and the
        // pause released them there — before, they stayed down until a blur.
        expect(keyFrames()).toEqual(['ControlLeft↓', 'AltLeft↓', 'ControlLeft↑', 'AltLeft↑']);
        expect(keyFrames(), 'Home itself never goes over').not.toContain('Home↓');
        // The physical releases find nothing held: nothing more goes out.
        await key('keyup', 'Home', { ctrlKey: true, altKey: true });
        await key('keyup', 'AltLeft', { ctrlKey: true });
        await key('keyup', 'ControlLeft');
        expect(keyFrames()).toHaveLength(4);
        // Paused: an ordinary key goes nowhere.
        await key('keydown', 'KeyA');
        expect(keyFrames()).toHaveLength(4);
        // The same chord resumes.
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(host!.textContent).not.toContain('Control paused');
    });

    it('Ctrl+Alt+End sends Ctrl+Alt+Del as the one {t:"sas"} frame', async () => {
        await mount();
        await key('keydown', 'End', { ctrlKey: true, altKey: true });
        expect(frames().filter(f => f.t === 'sas')).toHaveLength(1);
        expect(keyFrames(), 'End is not typed over there').toEqual([]);
    });

    it('while a bar menu is open no key goes over, and Esc closes the menu', async () => {
        await mount();
        await openMenu('Keyboard');
        expect(host!.querySelector('[role="menu"]')).toBeTruthy();
        await key('keydown', 'KeyA');
        await key('keydown', 'Escape');
        expect(keyFrames(), 'the menu has the keyboard').toEqual([]);
        expect(host!.querySelector('[role="menu"]'), 'Esc closed it').toBeNull();
        // POSITIVE CONTROL: with the menu closed, the same key goes over.
        await key('keydown', 'KeyB');
        expect(keyFrames()).toEqual(['KeyB↓']);
    });
});

describe('the menus reach the session layer as the phone\'s do', () => {
    it('Keyboard: Ctrl+Alt+Del is one sas frame; Alt+Tab and Alt+F4 are chords', async () => {
        await mount();
        await openMenu('Keyboard');
        await click(menuItem('Ctrl + Alt + Del'));
        expect(frames().map(f => f.t)).toEqual(['sas']);
        h.sendInput.mockClear();
        await openMenu('Keyboard');
        await click(menuItem('Alt + Tab'));
        expect(keyFrames()).toEqual(['AltLeft↓', 'Tab↓', 'Tab↑', 'AltLeft↑']);
        h.sendInput.mockClear();
        await openMenu('Keyboard');
        await click(menuItem('Alt + F4'));
        expect(keyFrames()).toEqual(['AltLeft↓', 'F4↓', 'F4↑', 'AltLeft↑']);
    });

    it('Type text types lines as text with Enter between them', async () => {
        await mount();
        await openMenu('Keyboard');
        await click(menuItem('Type text…'));
        const area = host!.querySelector<HTMLTextAreaElement>('.device-stage-typetext textarea');
        expect(area, 'the dialog is open').toBeTruthy();
        // A key typed into the box stays here.
        await act(async () => {
            area!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true, cancelable: true }));
        });
        expect(keyFrames()).toEqual([]);
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(area, 'ab\ncd');
            area!.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(byText('Type it'));
        expect(frames()).toEqual([
            { t: 'text', text: 'ab' },
            { t: 'key', code: 'Enter', down: true },
            { t: 'key', code: 'Enter', down: false },
            { t: 'text', text: 'cd' },
        ]);
        expect(host!.querySelector('.device-stage-typetext'), 'and closes').toBeNull();
    });

    it('Screen: a monitor, privacy mode and display power', async () => {
        await mount();
        await openMenu('Screen');
        await click(menuItem('Display 2'));
        expect(h.requestMonitor).toHaveBeenCalledWith('ds-1', 1);
        await openMenu('Screen');
        await click(menuItem('All displays'));
        expect(h.requestMonitor).toHaveBeenLastCalledWith('ds-1', 255);
        await openMenu('Screen');
        await click(menuItem('Privacy mode (blank that computer\'s screen)'));
        expect(h.setPrivacyMode).toHaveBeenCalledWith('ds-1', true);
        await openMenu('Screen');
        await click(menuItem('Turn displays off'));
        expect(h.sendPowerAction).toHaveBeenCalledWith('ds-1', 'displays_off');
    });

    it('Quality: a preset goes to the host', async () => {
        await mount();
        await openMenu('Quality');
        await click(menuItem('Max (15Mbps, 60fps)'));
        expect(h.sendStreamQuality).toHaveBeenCalledWith('ds-1', 60, 15000);
    });

    it('More: Lock at once; Shut down only after the confirmation', async () => {
        await mount();
        await openMenu('More');
        await click(menuItem('Lock'));
        expect(h.sendPowerAction).toHaveBeenCalledWith('ds-1', 'lock');
        await openMenu('More');
        await click(menuItem('Shut down…'));
        expect(h.sendPowerAction, 'nothing sent before the confirmation').not.toHaveBeenCalledWith('ds-1', 'shutdown');
        expect(host!.textContent).toContain('Shut down the computer you are controlling?');
        await click(byText('Shut down'));
        expect(h.sendPowerAction).toHaveBeenCalledWith('ds-1', 'shutdown');
    });

    it('the paused banner has its own Resume', async () => {
        await mount();
        await click(byText(/Pause control/));
        expect(host!.textContent).toContain('Control paused');
        await click(host!.querySelector('.device-stage-paused button'));
        expect(host!.textContent).not.toContain('Control paused');
    });
});

describe('a view-only share', () => {
    it('is offered nothing that injects', async () => {
        await mount({ viewOnly: true });
        expect(byText(/^\s*Keyboard/), 'no Keyboard menu').toBeUndefined();
        expect(byText(/^\s*Mouse/), 'no Mouse menu').toBeUndefined();
        expect(byText(/Pause control/), 'nothing to pause').toBeUndefined();
        await openMenu('More');
        expect(menuItem('Lock')).toBeUndefined();
        expect(menuItem('Shut down…')).toBeUndefined();
        expect(menuItem('Copy diagnostics'), 'diagnostics are fine').toBeTruthy();
        await openMenu('Screen');
        expect(menuItem('Turn displays off')).toBeUndefined();
        expect(menuItem('Privacy mode (blank that computer\'s screen)')).toBeUndefined();
    });
});
