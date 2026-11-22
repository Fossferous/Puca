/**
 * The way back to a minimised remote-control session (components/DeviceStageReturn.tsx).
 * The owner's report (2026-11-22): the minimised stage was a blue pill reading
 * "Return to remote device (ds7babefb5bd2042d38d9c)" fixed over the bottom-right
 * corner, which on a phone with the keyboard up is the message box. It is now a
 * real button in a strip the layout makes room for: named for the computer,
 * never by the session's id, and its height published for the reservations
 * that keep the composer and every panel above it. Where it lands on screen is
 * e2e/return-pill-live.mjs's (the real app in a real browser); this pins the
 * words, the element and the measured height.
 *
 * The rig is deviceStageBackMenu.test.tsx's (a 390x844 coarse-pointer phone, a
 * played session layer).
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

const strip = () => host!.querySelector<HTMLElement>('.device-stage-minimized-strip');
const wayBack = () => host!.querySelector<HTMLElement>('.device-stage-minimized');
const heightVar = () => document.documentElement.style.getPropertyValue('--device-return-h');

describe('minimised to the chat, the stage is a button named for the PC', () => {
    it("is a real button reading 'Return to <the PC>', with no session id anywhere, and a press brings the stage back", async () => {
        await mountWith(session({ id: 'ds7babefb5bd2042d38d9c', peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        const b = wayBack();
        expect(b, 'the way back is drawn').toBeTruthy();
        expect(b!.tagName, 'a button: Tab reaches it, Enter and Space press it').toBe('BUTTON');
        expect(b!.getAttribute('type')).toBe('button');
        expect(b!.textContent!.trim()).toBe('Return to Office PC');
        expect(host!.textContent, 'the session id is on no part of it').not.toContain('ds7babefb5bd2042d38d9c');
        expect(strip()!.contains(b!), 'inside the strip the layout makes room for').toBe(true);
        expect(host!.querySelector('.device-stage'), 'the stage is away').toBeNull();
        await tap(b!);
        expect(host!.querySelector('.device-stage'), 'the stage is back').toBeTruthy();
        expect(wayBack(), 'and the way back is gone').toBeNull();
    });

    it("with no name for the PC it says 'the remote computer', and follows a name that arrives later", async () => {
        await mountWith(session({ id: 'ds-1', peerName: null }));
        await tap(toolbarButton('Chat'));
        expect(wayBack()!.textContent!.trim()).toBe('Return to the remote computer');
        expect(host!.textContent).not.toContain('ds-1');
        await publish([session({ id: 'ds-1', peerName: '  Den laptop ' })]);
        expect(wayBack()!.textContent!.trim(), 'the name as the session layer has it, trimmed').toBe('Return to Den laptop');
        await publish([session({ id: 'ds-1', peerName: '   ' })]);
        expect(wayBack()!.textContent!.trim(), 'a blank name is no name').toBe('Return to the remote computer');
    });

    it('a key pressed on it is left to the button (the stage forwards nothing while minimised)', async () => {
        await mountWith(session({ peerName: 'Office PC' }));
        await tap(toolbarButton('Chat'));
        for (const key of ['Enter', ' ']) {
            const ev = new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : 'Enter', bubbles: true, cancelable: true });
            await act(async () => { wayBack()!.dispatchEvent(ev); });
            expect(ev.defaultPrevented, `${key === ' ' ? 'Space' : 'Enter'} is not taken from the button`).toBe(false);
        }
    });

    it('publishes its height for the reservations while it is up, and takes it away when the stage comes back or the session ends', async () => {
        document.documentElement.style.removeProperty('--device-return-h');
        await mountWith(session({ peerName: 'Office PC' }));
        expect(heightVar(), 'nothing reserved while the stage is up').toBe('');
        await tap(toolbarButton('Chat'));
        expect(heightVar(), 'its measured height, in px').toBe(`${BOX.height}px`);
        await tap(wayBack()!);
        expect(heightVar(), 'the stage is back: nothing reserved').toBe('');
        await tap(toolbarButton('Chat'));
        expect(heightVar()).toBe(`${BOX.height}px`);
        await publish([]);
        expect(wayBack(), 'the session ended').toBeNull();
        expect(heightVar(), 'and the room it held is given back').toBe('');
    });
});
