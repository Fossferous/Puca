/**
 * The stage's key forwarding vs the hotkey registry.
 *
 * While controlling a device, DeviceStage forwards every injectable key to the
 * controlled machine. A key bound to a REGISTERED hotkey (toggle mute, PTT)
 * used to fire the local action AND be typed into the remote PC — "toggle mute
 * both muted me and typed M into the game". Policy pinned here: a registered
 * hotkey wins and is never forwarded; a plain unbound key forwards (positive
 * control); typing into a LOCAL editable field inside the stage forwards
 * nothing.
 *
 * Uses the REAL hotkey registry — mocking it would let this pass while the
 * predicate and dispatch disagree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    sendInput: vi.fn(),
    storage: new Map<string, string>(),
}));

vi.mock('../api/devices/session', () => ({
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: () => () => { /* unsubscribe */ },
    setCaretTracking: () => { /* noop */ },
    sendInput: (...a: unknown[]) => h.sendInput(...a),
    requestMonitor: () => { /* noop */ },
    requestKeyframe: () => true,
    setCursorOwned: () => { /* noop */ },
    endSession: () => { /* noop */ },
    sendClipboard: async () => null,
    sendStreamQuality: () => { /* noop */ },
    setPrivacyMode: () => { /* noop */ },
    sendPowerAction: () => true,
    deviceDiagnosticsWindow: async () => [],
    activeSessions: () => [],
    requestFileAccess: () => { /* noop */ },
}));
vi.mock('../api/devices/tunnel', () => ({
    tunnelStatus: async () => ({ listeners: [], inbound_streams: 0, outbound_streams: 0, forwards: [] }),
}));
vi.mock('../api/devices/chords', () => ({ sendChord: () => true }));
vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isMobile: () => false, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

const { DeviceStage } = await import('../components/DeviceStage');
const { registerPress, resetHotkeysForTest } = await import('../api/hotkeys');

beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
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
    (localStorage.getItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string) => h.storage.get(k) ?? null);
    (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.sendInput.mockClear();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    resetHotkeysForTest();
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

function session(): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false,
    };
}

async function mount() {
    h.snapshot = [session()];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

function pressKey(keyCode: number, code: string, mods: Partial<KeyboardEventInit> = {}, target: EventTarget = window) {
    for (const type of ['keydown', 'keyup'] as const) {
        const e = new KeyboardEvent(type, { bubbles: true, code, cancelable: true, ...mods });
        Object.defineProperty(e, 'keyCode', { value: keyCode });
        target.dispatchEvent(e);
    }
}

const keyFrames = () => h.sendInput.mock.calls.filter(c => (c[1] as { t?: string })?.t === 'key');

describe('DeviceStage key forwarding vs hotkeys', () => {
    it('a key bound to a registered hotkey fires locally once and is NOT forwarded', async () => {
        const fired = vi.fn();
        registerPress('voice.toggleMute',
            () => ({ keyCode: 77, ctrl: true, alt: false, shift: true, label: 'M' }),
            fired);
        await mount();

        await act(async () => {
            pressKey(77, 'KeyM', { ctrlKey: true, shiftKey: true });
        });
        expect(fired, 'the local action must fire, exactly once').toHaveBeenCalledTimes(1);
        expect(keyFrames(), 'the bound combo must not be typed into the remote PC').toEqual([]);
    });

    it('POSITIVE CONTROL: a plain unbound key IS forwarded', async () => {
        await mount();
        await act(async () => {
            pressKey(77, 'KeyM');
        });
        expect(keyFrames().map(c => c[1])).toEqual([
            { t: 'key', code: 'KeyM', down: true },
            { t: 'key', code: 'KeyM', down: false },
        ]);
    });

    it('typing into a local editable field inside the stage forwards nothing', async () => {
        await mount();
        const input = document.createElement('input');
        host!.appendChild(input);
        await act(async () => {
            pressKey(77, 'KeyM', {}, input);
        });
        expect(keyFrames()).toEqual([]);
    });

    it('a key forwarded DOWN is always released, even if modifiers changed mid-hold', async () => {
        // The strand: hold D (forwarded), add Ctrl+Shift (sprint/crouch),
        // release D — the keyup now matches the Ctrl+Shift+D binding, and
        // suppressing it left D logically held on the controlled machine.
        registerPress('voice.toggleDeafen',
            () => ({ keyCode: 68, ctrl: true, alt: false, shift: true, label: 'D' }),
            () => { /* noop */ });
        await mount();

        await act(async () => {
            const down = new KeyboardEvent('keydown', { bubbles: true, code: 'KeyD', cancelable: true });
            Object.defineProperty(down, 'keyCode', { value: 68 });
            window.dispatchEvent(down);
            const up = new KeyboardEvent('keyup', { bubbles: true, code: 'KeyD', cancelable: true, ctrlKey: true, shiftKey: true });
            Object.defineProperty(up, 'keyCode', { value: 68 });
            window.dispatchEvent(up);
        });
        expect(keyFrames().map(c => c[1])).toEqual([
            { t: 'key', code: 'KeyD', down: true },
            { t: 'key', code: 'KeyD', down: false },
        ]);
    });

    it('a keyup for a key never forwarded down is dropped (no phantom release)', async () => {
        registerPress('voice.toggleMute',
            () => ({ keyCode: 77, ctrl: true, alt: false, shift: true, label: 'M' }),
            () => { /* noop */ });
        await mount();
        await act(async () => {
            // The down is suppressed (bound combo); its up must not produce a
            // release the host never saw a press for.
            pressKey(77, 'KeyM', { ctrlKey: true, shiftKey: true });
        });
        expect(keyFrames()).toEqual([]);
    });

    it('a bare-letter PTT hold suppresses only the bare letter — Ctrl+V still pastes remotely', async () => {
        const { registerHold } = await import('../api/hotkeys');
        registerHold('voice.ptt',
            () => ({ keyCode: 86, ctrl: false, alt: false, shift: false, label: 'V' }),
            { onDown: () => { /* noop */ }, onUp: () => { /* noop */ } });
        await mount();

        await act(async () => {
            pressKey(86, 'KeyV'); // the PTT key itself: suppressed
        });
        expect(keyFrames()).toEqual([]);

        await act(async () => {
            pressKey(86, 'KeyV', { ctrlKey: true }); // paste: must reach the host
        });
        expect(keyFrames().map(c => c[1])).toEqual([
            { t: 'key', code: 'KeyV', down: true },
            { t: 'key', code: 'KeyV', down: false },
        ]);
    });
});
