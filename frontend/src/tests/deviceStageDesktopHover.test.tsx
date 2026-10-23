/**
 * A HOVERING MOUSE AIMS THE REMOTE POINTER, through the real stage.
 *
 * Pinch-to-zoom (2026-07-30) gated every absolute move on a held contact, so
 * from then on a desktop viewer moved the host's pointer only when a button
 * went down: it sat still under hover and jumped on each click. The owner's
 * 2026-10-23 "mouse doesn't always work" report, read off the host's input
 * tallies, was exactly that shape — `move=1 down=1 up=1` per click on every
 * desktop session, against a continuous stream from the phone's trackpad.
 *
 * The rules pinned here: a contact-less mouse or pen sends absolute moves; a
 * touch never hovers; a phone's trackpad stays relative even with a mouse
 * plugged in; and the existing gates (paused control, the letterbox, Game
 * mode without its lock) still hold for hover.
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
    phone: false,
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
    return { ...real, isMobile: () => h.phone, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

const { DeviceStage } = await import('../components/DeviceStage');

/** A 1280x720 surface showing a 1920x1080 picture: no letterbox on either axis. */
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
        matches: h.phone, media: '', onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.sendInput.mockClear();
    h.phone = false;
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
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false, powerNotice: null,
        ...over,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

async function mount() {
    h.snapshot = [session()];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
}

function surface(): HTMLElement {
    const el = host!.querySelector<HTMLElement>('.device-stage-surface');
    expect(el, 'the stage must be up').toBeTruthy();
    return el!;
}

/** A PointerEvent-shaped MouseEvent: jsdom's MouseEvent has neither field. */
function pe(type: string, x: number, y: number, pointerType = 'mouse', button = 0): MouseEvent {
    const e = new MouseEvent(type, { bubbles: true, button, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: 1 });
    Object.defineProperty(e, 'pointerType', { value: pointerType });
    return e;
}

async function fire(...events: MouseEvent[]) {
    await act(async () => { for (const e of events) surface().dispatchEvent(e); });
    await flush();
}

const sent = (t: string) => h.sendInput.mock.calls
    .map(c => c[1] as { t?: string; x?: number; y?: number })
    .filter(e => e.t === t);

describe('a hovering desktop mouse', () => {
    it('moves the remote pointer with no button held, to where it hovers', async () => {
        await mount();
        await fire(pe('pointermove', 320, 180), pe('pointermove', 640, 360));
        const moves = sent('move');
        expect(moves, 'every hover move goes out (the 07-30 regression sent none)').toHaveLength(2);
        expect(moves[1].x).toBeCloseTo(0.5, 3);
        expect(moves[1].y).toBeCloseTo(0.5, 3);
        expect(sent('down'), 'hovering presses nothing').toEqual([]);
    });

    it('a pen hovering above the screen aims too', async () => {
        await mount();
        await fire(pe('pointermove', 320, 180, 'pen'));
        expect(sent('move')).toHaveLength(1);
    });

    it('a touch never hovers: a contact-less touch move sends nothing', async () => {
        await mount();
        await fire(pe('pointermove', 320, 180, 'touch'));
        expect(sent('move')).toEqual([]);
    });

    it('the drag path is unchanged: down, moves while held, up', async () => {
        await mount();
        await fire(pe('pointerdown', 100, 100), pe('pointermove', 200, 100), pe('pointerup', 200, 100));
        expect(sent('down')).toHaveLength(1);
        expect(sent('up')).toHaveLength(1);
        // pointerdown's own aim + the drag move.
        expect(sent('move')).toHaveLength(2);
    });

    it('paused control sends no hover', async () => {
        await mount();
        const pause = Array.from(host!.querySelectorAll('button')).find(b => b.textContent === 'Pause control');
        expect(pause, 'the desktop bar offers Pause control').toBeTruthy();
        await act(async () => { pause!.click(); });
        await flush();
        h.sendInput.mockClear();
        await fire(pe('pointermove', 320, 180));
        expect(sent('move')).toEqual([]);
    });

    it('Game mode without its pointer lock sends no absolute hover', async () => {
        h.storage.set('sovereign-fps-mode', 'on');
        await mount();
        const game = Array.from(host!.querySelectorAll('button')).find(b => /Game mode/.test(b.textContent ?? ''));
        expect(game?.getAttribute('aria-pressed'), 'precondition: Game mode is on').toBe('true');
        h.sendInput.mockClear();
        await fire(pe('pointermove', 320, 180));
        expect(sent('move'), 'relative mode never degrades to absolute moves').toEqual([]);
    });
});

describe('a phone', () => {
    beforeEach(() => { h.phone = true; });

    it('in trackpad mode leaves a plugged-in mouse to the machine: no absolute hover', async () => {
        h.storage.set('device-stage-mouse-mode', 'trackpad');
        await mount();
        await fire(pe('pointermove', 320, 180));
        expect(sent('move')).toEqual([]);
    });

    it('in touch mode a plugged-in mouse hovers like a desktop one', async () => {
        h.storage.set('device-stage-mouse-mode', 'touch');
        await mount();
        await fire(pe('pointermove', 320, 180));
        expect(sent('move')).toHaveLength(1);
    });
});
