/**
 * Android's BACK and the remote stage's phone menus (components/DeviceStage.tsx).
 * The stage is mounted for the whole app; the keyboard bar (activeMobileMenu
 * 'keyboard', which the auto-keyboard also opens by itself) has no backdrop, so
 * the toolbar's Close and Chat stay tappable under it. A session that ended or a
 * stage minimised to its strip kept activeMobileMenu, and with it the menu's Back
 * layer: the next Back, with nothing on screen, closed the invisible menu and did
 * nothing visible (review finding). The layer is held only while a menu is DRAWN.
 *
 * The rig is deviceStageAutoKeyboard.test.tsx's (a 390x844 coarse-pointer phone,
 * a played session layer). interceptBack, the native boundary under
 * hooks/useBackClose.ts, is played as a stack the way api/mobileApp.ts keeps it:
 * the newest layer closes first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    storage: new Map<string, string>(),
    /** Held Back layers, oldest first (api/mobileApp.ts interceptBack). */
    layers: [] as Array<() => void>,
}));

vi.mock('../api/devices/session', () => ({
    sendViewSize: () => {},
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: () => () => {},
    setCaretTracking: () => {},
    sendInput: () => {},
    requestMonitor: () => {},
    requestKeyframe: () => true,
    setCursorOwned: () => {},
    endSession: () => {},
    sendClipboard: async () => null,
    sendStreamQuality: () => {},
    setPrivacyMode: () => {},
    sendPowerAction: () => true,
    deviceDiagnosticsWindow: async () => [],
    activeSessions: () => [],
    requestFileAccess: () => {},
    deviceStatsSample: async () => null,
    latencyProbeUsable: () => false,
    sendLatencyProbe: () => false,
    noteFramePresented: () => {},
    subscribeLatency: () => () => {},
}));
vi.mock('../api/devices/tunnel', () => ({
    tunnelStatus: async () => ({ inbound_streams: 0, outbound_streams: 0, forwards: [] }),
}));
vi.mock('../api/devices/chords', () => ({ sendChord: () => true }));
vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isMobile: () => true, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => {},
}));
vi.mock('../api/mobileApp', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/mobileApp')>();
    return {
        ...real,
        showMobileKeyboard: async () => true,
        interceptBack: (onBack: () => void) => {
            h.layers.push(onBack);
            let released = false;
            return () => {
                if (released) return;
                released = true;
                const i = h.layers.indexOf(onBack);
                if (i >= 0) h.layers.splice(i, 1);
            };
        },
    };
});

const { DeviceStage } = await import('../components/DeviceStage');

const BOX = { left: 0, top: 0, width: 390, height: 844 };
beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.height });
    HTMLElement.prototype.getBoundingClientRect = () => ({
        ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON() { return this; },
    }) as DOMRect;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {} unobserve() {} disconnect() {}
    };
    window.matchMedia = (() => ({
        matches: true, media: '', onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    h.storage.set('device-stage-mouse-mode', 'touch');
    (localStorage.getItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string) => h.storage.get(k) ?? null);
    (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.layers = [];
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
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }], activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: true,
        ...over,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

async function mountWith(s: Snapshot) {
    h.snapshot = [s];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
}

async function publish(s: Snapshot[]) {
    h.snapshot = s;
    await act(async () => { for (const l of h.listeners) l(s); });
    await flush();
}

const toolbarButton = (title: string) => {
    const b = host!.querySelector<HTMLButtonElement>(`.device-stage-mobile-toolbar button[title="${title}"]`);
    expect(b, `the toolbar's ${title}`).toBeTruthy();
    return b!;
};
const tap = async (b: HTMLElement) => { await act(async () => { b.click(); }); await flush(); };
/** The Back gesture: the newest held layer closes. */
const back = async () => { await act(async () => { h.layers.at(-1)?.(); }); await flush(); };
const keyboardBar = () => host!.querySelector('.device-stage-keyboard-overlay');

describe("the stage's phone menus hold Back only while they are drawn", () => {
    it('positive control: with the keyboard bar up, Back closes it', async () => {
        await mountWith(session());
        expect(h.layers).toHaveLength(0);
        await tap(toolbarButton('Keyboard'));
        expect(keyboardBar(), 'the keyboard bar is drawn').toBeTruthy();
        expect(h.layers, 'its Back layer is held').toHaveLength(1);
        await back();
        expect(keyboardBar()).toBeNull();
        expect(h.layers).toHaveLength(0);
    });

    it("minimised with the keyboard bar up (the toolbar's Chat): no layer is left holding Back", async () => {
        await mountWith(session());
        await tap(toolbarButton('Keyboard'));
        expect(h.layers).toHaveLength(1);
        await tap(toolbarButton('Chat'));
        expect(host!.querySelector('.device-stage-minimized'), 'the minimised strip').toBeTruthy();
        expect(h.layers, 'nothing drawn holds Back').toHaveLength(0);
        // Back from the strip: the bar comes back with its layer.
        await tap(host!.querySelector<HTMLElement>('.device-stage-minimized')!);
        expect(keyboardBar(), 'the keyboard bar is back').toBeTruthy();
        expect(h.layers).toHaveLength(1);
    });

    it('the session ends with the keyboard bar up: no layer is left holding Back', async () => {
        await mountWith(session());
        await tap(toolbarButton('Keyboard'));
        expect(h.layers).toHaveLength(1);
        await publish([]);
        expect(host!.querySelector('.device-stage'), 'the stage is gone').toBeNull();
        expect(h.layers, 'nothing drawn holds Back').toHaveLength(0);
    });
});

// activeMobileMenu outlived its session: the stage reset the pinned-keys editor
// for a new session but not the open menu, so a menu left up when a session
// ended came back, with its Back layer, on the next one (review finding).
describe('a phone menu belongs to the session it was opened in', () => {
    const MENUS = [
        { button: 'Keyboard', drawn: () => keyboardBar() },
        { button: 'More', drawn: () => host!.querySelector('.device-stage-mobile-menu') },
    ];

    it.each(MENUS)('control: $button stays up, holding Back, while the same session goes on', async ({ button, drawn }) => {
        await mountWith(session());
        await tap(toolbarButton(button));
        expect(drawn(), `${button} is drawn`).toBeTruthy();
        expect(h.layers).toHaveLength(1);
        // The session layer publishes the same session again (a notice, a monitor, privacy).
        await publish([session({ privacyActive: true })]);
        expect(drawn(), `${button} is still drawn`).toBeTruthy();
        expect(h.layers).toHaveLength(1);
    });

    it.each(MENUS)('$button left up when the session ended is not up in the next one', async ({ button, drawn }) => {
        await mountWith(session());
        await tap(toolbarButton(button));
        expect(drawn(), `${button} is drawn`).toBeTruthy();
        await publish([]);
        expect(h.layers).toHaveLength(0);
        await publish([session({ id: 'ds-2' })]);
        expect(host!.querySelector('.device-stage'), 'the next session is on the stage').toBeTruthy();
        expect(drawn(), `${button} is not drawn`).toBeNull();
        expect(h.layers, 'and nothing holds Back').toHaveLength(0);
    });

    it.each(MENUS)('$button up when a newer session takes the stage is not up in it', async ({ button, drawn }) => {
        await mountWith(session());
        await tap(toolbarButton(button));
        expect(drawn(), `${button} is drawn`).toBeTruthy();
        // A second controller session, newer: the stage shows the newest.
        await publish([session(), session({ id: 'ds-2' })]);
        expect(host!.querySelector('.device-stage')).toBeTruthy();
        expect(drawn(), `${button} is not drawn`).toBeNull();
        expect(h.layers).toHaveLength(0);
    });
});
