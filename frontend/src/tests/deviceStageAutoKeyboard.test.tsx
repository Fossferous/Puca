/**
 * THE STAGE'S OWN PLUMBING for the phone — mounted for real, for the first
 * time. Every DECISION here lives in a pure module with its own tests
 * (deviceAutoKeyboard.ts, deviceZoomFollow.ts); what this file pins is the
 * wiring between them and the session, which no pure test can see:
 *
 *  - a touch session on a phone asks the host to track the caret for its
 *    whole life (not only while the keyboard panel is up);
 *  - a press on the surface followed by a caret report opens the keyboard
 *    panel AND asks the native side to show the IME;
 *  - a press onto a caret that is ALREADY there opens it at the press;
 *  - a focused button ('field') after a press does not;
 *  - the preference off means none of it — and no tracking either;
 *  - after the first frame, an unattended session on an older multi-screen
 *    host is asked for every screen, once.
 *
 * jsdom has no layout, no PointerEvent capture and no media pipeline, so the
 * rig stubs exactly what the stage reads: a 1920x1080 video drawn in a 390x844
 * box, a coarse pointer, a ResizeObserver that never fires. Touch mode is
 * forced (the trackpad machine's taps are timer-driven and are tested in
 * deviceGestures.test.ts); in touch mode a pointerdown IS a press.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// ---- the session layer, under test control ---------------------------------
type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    caretSubs: new Map<string, Set<(r: unknown) => void>>(),
    sendInput: vi.fn(),
    setCaretTracking: vi.fn(),
    requestMonitor: vi.fn(),
    showMobileKeyboard: vi.fn(async () => true),
    inset: { visible: false, top: null as number | null, source: 'none' },
    insetWatchers: new Set<(i: unknown) => void>(),
    storage: new Map<string, string>(),
    /** The <video>'s intrinsic width: 0 = no frame has arrived yet. */
    videoW: 1920,
}));

vi.mock('../api/devices/session', () => ({
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: (id: string, cb: (r: unknown) => void) => {
        let set = h.caretSubs.get(id);
        if (!set) { set = new Set(); h.caretSubs.set(id, set); }
        set.add(cb);
        return () => { set!.delete(cb); };
    },
    setCaretTracking: (...a: unknown[]) => h.setCaretTracking(...a),
    sendInput: (...a: unknown[]) => h.sendInput(...a),
    requestMonitor: (...a: unknown[]) => h.requestMonitor(...a),
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
    currentKeyboardInset: () => h.inset,
    watchKeyboardInset: (cb: (i: unknown) => void) => {
        h.insetWatchers.add(cb);
        return () => { h.insetWatchers.delete(cb); };
    },
}));
vi.mock('../api/mobileApp', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/mobileApp')>();
    return { ...real, showMobileKeyboard: () => h.showMobileKeyboard() };
});

const { DeviceStage } = await import('../components/DeviceStage');

// ---- the DOM the stage measures ----------------------------------------------
const BOX = { left: 0, top: 0, width: 390, height: 844 };
beforeEach(() => {
    // A picture to aim at: the <video> is 1920x1080 intrinsically, drawn in a
    // 390x844 box (the 2026-08-11 black-bars geometry the caret tests use).
    h.videoW = 1920;
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => h.videoW });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => (h.videoW ? 1080 : 0) });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.height });
    HTMLElement.prototype.getBoundingClientRect = () => ({
        ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON() { return this; },
    }) as DOMRect;
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => {};
    // jsdom has neither; the stage guards neither (a real phone has both).
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() {} unobserve() {} disconnect() {}
    };
    window.matchMedia = (() => ({
        matches: true, media: '', onchange: null,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {}, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    // The setup.ts localStorage is a bag of vi.fn(); give it a real store so
    // the stage's preferences can be set per test. Touch mode, so a
    // pointerdown is a press without the trackpad machine's timers.
    h.storage.clear();
    h.storage.set('device-stage-mouse-mode', 'touch');
    (localStorage.getItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string) => h.storage.get(k) ?? null);
    (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string, v: string) => { h.storage.set(k, v); });

    h.listeners.clear();
    h.caretSubs.clear();
    h.snapshot = [];
    h.sendInput.mockClear();
    h.setCaretTracking.mockClear();
    h.requestMonitor.mockClear();
    h.showMobileKeyboard.mockClear();
    h.showMobileKeyboard.mockImplementation(async () => true);
    h.inset = { visible: false, top: null, source: 'none' };
    h.insetWatchers.clear();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

const MONITORS = [
    { id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 },
    { id: 1, label: 'Display 2', left: 1920, top: 0, width: 1920, height: 1080 },
];

function session(over: Snapshot = {}): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: MONITORS, activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: true,
        ...over,
    };
}

async function mountWith(s: Snapshot) {
    h.snapshot = [s];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

function surface(): HTMLElement {
    const el = host!.querySelector<HTMLElement>('.device-stage-surface');
    expect(el, 'the stage must be up').toBeTruthy();
    return el!;
}

/** A finger down on the picture, at a fraction of it. The stage's own
 *  normalizedOverVideo maps client px back to the same fraction, so the
 *  press the auto-keyboard records is exactly this. */
async function pressAt(fx: number, fy: number) {
    // 390x844 box, 1920x1080 picture: contain-fit is 390 wide, 219.375 tall,
    // letterboxed 312.3125 down.
    const dispH = 390 * 1080 / 1920;
    const offY = (844 - dispH) / 2;
    const clientX = fx * 390;
    const clientY = offY + fy * dispH;
    await act(async () => {
        surface().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX, clientY, button: 0 }));
        surface().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX, clientY, button: 0 }));
    });
    await flush();
}

/** Client px of a picture fraction (the contain-fit geometry above). */
function clientOf(fx: number, fy: number) {
    const dispH = 390 * 1080 / 1920;
    const offY = (844 - dispH) / 2;
    return { clientX: fx * 390, clientY: offY + fy * dispH };
}

/** A finger down at one fraction, dragged to another, released — a
 *  selection or a window move, not a tap. */
async function dragFromTo(fx0: number, fy0: number, fx1: number, fy1: number) {
    const a = clientOf(fx0, fy0);
    const b = clientOf(fx1, fy1);
    await act(async () => {
        surface().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, ...a, button: 0 }));
        surface().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, ...b, button: 0 }));
        surface().dispatchEvent(new MouseEvent('pointerup', { bubbles: true, ...b, button: 0 }));
    });
    await flush();
}

/** Two fingers down (the first lands like a tap would), then both up. jsdom
 *  MouseEvents carry no pointerId, so the second contact is given one via a
 *  PointerEvent-shaped init; React reads `pointerId` off the native event. */
async function pinchAt(fx: number, fy: number) {
    const a = clientOf(fx, fy);
    const b = clientOf(fx + 0.2, fy + 0.2);
    const ev = (type: string, init: Record<string, unknown>) => {
        const e = new MouseEvent(type, { bubbles: true, button: 0, ...init }) as MouseEvent & { pointerId?: number };
        Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
        return e;
    };
    await act(async () => {
        surface().dispatchEvent(ev('pointerdown', { ...a, pointerId: 1 }));
        surface().dispatchEvent(ev('pointerdown', { ...b, pointerId: 2 }));
        surface().dispatchEvent(ev('pointerup', { ...b, pointerId: 2 }));
        surface().dispatchEvent(ev('pointerup', { ...a, pointerId: 1 }));
    });
    await flush();
}

async function caret(id: string, r: Record<string, unknown>) {
    await act(async () => {
        for (const cb of h.caretSubs.get(id) ?? []) cb(r);
    });
    await flush();
}

const WIN32 = (x: number, y: number) => ({
    vis: true, x, y, w: 1 / 1920, h: 18 / 1080, src: 'win32', mon: 0, surf: 1, seq: 1,
});
const HIDDEN = { vis: false, x: 0, y: 0, w: 0, h: 0, src: null, mon: 0, surf: 1, seq: 0 };

const panel = () => host!.querySelector('.device-stage-keyboard-overlay');

describe('a phone session tracks the caret for its whole life', () => {
    it('asks the host on mount, before any keyboard panel exists', async () => {
        await mountWith(session());
        expect(h.setCaretTracking).toHaveBeenCalledWith('ds-1', true);
        expect(panel(), 'no panel yet — this is tracking for the auto-keyboard').toBeNull();
    });

    it('does not ask when the auto-keyboard is off (the camera asks later, on its own)', async () => {
        h.storage.set('device-stage-auto-keyboard', 'off');
        await mountWith(session());
        expect(h.setCaretTracking).not.toHaveBeenCalled();
    });

    it('does not ask for a view-only share — it cannot type, so there is nothing to open', async () => {
        await mountWith(session({ viewOnly: true }));
        expect(h.setCaretTracking).not.toHaveBeenCalled();
    });
});

describe('a press that lands in a text box opens the keyboard', () => {
    it('a press, then a caret that was not there: the panel mounts and the native show is asked', async () => {
        await mountWith(session());
        await caret('ds-1', HIDDEN);                 // the channel's ACK: no caret on the host
        await pressAt(0.5, 0.5);
        expect(h.sendInput, 'the press went out').toHaveBeenCalledWith('ds-1', { t: 'down', button: 0 });
        expect(panel(), 'nothing yet — the host has not answered').toBeNull();

        await caret('ds-1', WIN32(0.5, 0.5));
        expect(panel(), 'the caret appeared where the finger went').toBeTruthy();
        expect(h.showMobileKeyboard, 'and the IME is asked for natively — this is long after the gesture')
            .toHaveBeenCalled();
    });

    it('a press ONTO a caret already there opens it at the press, with no report needed', async () => {
        await mountWith(session());
        await caret('ds-1', WIN32(0.4, 0.3));       // an already-focused field
        expect(panel()).toBeNull();
        await pressAt(0.5, 0.3 + 9 / 1080);          // same line, a little to the right
        expect(panel(), 'decided from the known caret, inside the tap').toBeTruthy();
    });

    it('a press elsewhere while that caret sits still does NOT open it', async () => {
        await mountWith(session());
        await caret('ds-1', WIN32(0.4, 0.3));
        await pressAt(0.4, 0.8);                     // far below the caret's line
        expect(panel()).toBeNull();
        // Positive control for the rig: the same press, then the caret
        // MOVING to it, does.
        await caret('ds-1', WIN32(0.4, 0.8));
        expect(panel()).toBeTruthy();
    });

    it('a focused button after the press is not a text box', async () => {
        await mountWith(session());
        await caret('ds-1', HIDDEN);
        await pressAt(0.7, 0.9);
        await caret('ds-1', { ...WIN32(0.7, 0.9), src: 'field', w: 0.08, h: 0.03 });
        expect(panel()).toBeNull();
    });

    it('a caret that appears with no press behind it (a page autofocusing) opens nothing', async () => {
        await mountWith(session());
        await caret('ds-1', HIDDEN);
        await caret('ds-1', WIN32(0.5, 0.5));
        expect(panel()).toBeNull();
    });

    it('with the preference off, a press and a caret open nothing', async () => {
        h.storage.set('device-stage-auto-keyboard', 'off');
        await mountWith(session());
        await pressAt(0.5, 0.5);
        // No tracking was asked for, so no subscriber exists to feed; the
        // stage simply never learns of a caret.
        expect(h.caretSubs.get('ds-1')?.size ?? 0).toBe(0);
        expect(panel()).toBeNull();
    });
});

describe('a gesture that is not a tap never opens the keyboard', () => {
    it('a DRAG across a known caret (a selection) does not open it, at the press or after', async () => {
        await mountWith(session());
        await caret('ds-1', WIN32(0.4, 0.3));
        await dragFromTo(0.4, 0.3 + 9 / 1080, 0.7, 0.3 + 9 / 1080);
        expect(panel(), 'the at-press verdict was "near", but the gesture was a drag').toBeNull();
        // And a caret moving to where the drag ended is not credited either:
        // the drag forgot its press.
        await caret('ds-1', WIN32(0.7, 0.3));
        expect(panel()).toBeNull();
        // Positive control for the rig: the same two points as a TAP open it.
        await pressAt(0.4, 0.3 + 9 / 1080);
        expect(panel()).toBeTruthy();
    });

    it('a PINCH whose first finger lands on a known caret does not open it', async () => {
        await mountWith(session());
        await caret('ds-1', WIN32(0.4, 0.3));
        await pinchAt(0.4, 0.3 + 9 / 1080);
        expect(panel()).toBeNull();
        // Nor does a caret that then moves within the window — the pinch
        // cancelled the press.
        await caret('ds-1', WIN32(0.5, 0.3));
        expect(panel()).toBeNull();
    });

    it('a collapsed toolbar stays collapsed across an auto-raise', async () => {
        await mountWith(session());
        const collapse = host!.querySelector<HTMLButtonElement>('button[title="Collapse"]');
        expect(collapse, 'the toolbar is up').toBeTruthy();
        await act(async () => { collapse!.click(); });
        await flush();
        expect(host!.querySelector('.device-stage-mobile-toolbar'), 'collapsed').toBeNull();
        expect(host!.querySelector('.device-stage-mobile-toolbar-toggle'), 'the expand button is there').toBeTruthy();

        await caret('ds-1', HIDDEN);
        await pressAt(0.5, 0.5);
        await caret('ds-1', WIN32(0.5, 0.5));
        expect(panel(), 'the keyboard opened').toBeTruthy();
        expect(host!.querySelector('.device-stage-mobile-toolbar'), 'and the bar the user hid stayed hidden').toBeNull();
    });
});

describe('every screen by default — the viewer\'s half', () => {
    it('an unattended session on an older two-screen host is asked for the composite, once', async () => {
        await mountWith(session({ activeMonitor: 0 }));
        expect(h.requestMonitor).toHaveBeenCalledTimes(1);
        expect(h.requestMonitor).toHaveBeenCalledWith('ds-1', 255);
        // A later snapshot of the same session (the host confirming) must not
        // re-ask — nor may it re-ask while the host is still switching.
        await act(async () => {
            h.snapshot = [session({ activeMonitor: 255 })];
            for (const l of h.listeners) l(h.snapshot);
        });
        await flush();
        expect(h.requestMonitor).toHaveBeenCalledTimes(1);
    });

    it('a screen the VIEWER picked before the first frame is left alone', async () => {
        // The screens are announced seconds before any frame; the user taps
        // "Display 2" in the picker meanwhile; then the first frame lands.
        h.videoW = 0;
        await mountWith(session({ activeMonitor: 0 }));
        expect(h.requestMonitor, 'no frame yet, no request').not.toHaveBeenCalled();
        await act(async () => {
            h.snapshot = [session({ activeMonitor: 1 })];   // the pick, confirmed by the host
            for (const l of h.listeners) l(h.snapshot);
        });
        await flush();
        h.videoW = 1920;
        await act(async () => {
            host!.querySelector('video')!.dispatchEvent(new Event('resize'));
        });
        await flush();
        expect(h.requestMonitor, 'the first frame must not widen the pick back to every screen').not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: the same late first frame WITHOUT a pick does ask', async () => {
        h.videoW = 0;
        await mountWith(session({ activeMonitor: 0 }));
        expect(h.requestMonitor).not.toHaveBeenCalled();
        h.videoW = 1920;
        await act(async () => {
            host!.querySelector('video')!.dispatchEvent(new Event('resize'));
        });
        await flush();
        expect(h.requestMonitor).toHaveBeenCalledWith('ds-1', 255);
    });

    it('a host already on the composite (0.8.104+) is not asked', async () => {
        await mountWith(session({ activeMonitor: 255 }));
        expect(h.requestMonitor).not.toHaveBeenCalled();
    });

    it('an ATTENDED session is never asked — the starting screen is the person\'s choice', async () => {
        await mountWith(session({ unattended: false, activeMonitor: 1 }));
        expect(h.requestMonitor).not.toHaveBeenCalled();
    });

    it('a webview host (no geometry) is never asked — its setMonitor would refuse', async () => {
        await mountWith(session({ monitors: [{ id: 0, label: 'A' }, { id: 1, label: 'B' }] }));
        expect(h.requestMonitor).not.toHaveBeenCalled();
    });
});
