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
 *  - a press on the line of a caret that does not move opens nothing — a
 *    button beside a focused text box, the line of Chromium's hidden caret
 *    (2026-11-20, "a lot of clicks seem to needlessly bring the keyboard
 *    up and change zoom");
 *  - a focused button ('field') after a press does not;
 *  - closing the keyboard (its button, or Android's Back under the open bar)
 *    sticks until a text box takes the focus or the keyboard comes up;
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
    // The stage reports its size to the host on mount; the fit is not
    // under test here, and a mock without it is an effect that throws.
    sendViewSize: () => { /* noop */ },
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
    deviceStatsSample: async () => null,
    latencyProbeUsable: () => false,
    sendLatencyProbe: () => false,
    noteFramePresented: () => { /* noop */ },
    subscribeLatency: () => () => { /* unsubscribe */ },
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

describe('a finger on the picture never takes focus off the keyboard bar\'s field', () => {
    // A touch is followed by compatibility mouse events, and that mousedown's
    // default action moves focus to what was tapped — BODY, for the picture.
    // The IME stayed up (the native show) attached to nothing: typing went
    // nowhere, and a tap into a field that already held the caret undid the
    // very focus the at-press raise had just given (owner report,
    // 2026-10-07, "kb no longer seems to input"; reproduced in the Android
    // WebView with Gboard). Cancelling the pointerdown suppresses those mouse
    // events — jsdom has none to suppress, so this pins the cancellation and
    // e2e/device-stage-real-browser.mjs proves the focus in a real browser.
    const down = (pointerType: string) => new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 3, pointerType, button: 0, ...clientOf(0.5, 0.5),
    });

    it('a touch pointerdown on the picture is cancelled', async () => {
        await mountWith(session());
        const ev = down('touch');
        await act(async () => { surface().dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(true);
        await act(async () => {
            surface().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, pointerType: 'touch', ...clientOf(0.5, 0.5) }));
        });
    });

    it('POSITIVE CONTROL: a mouse keeps its ordinary semantics', async () => {
        await mountWith(session());
        const ev = down('mouse');
        await act(async () => { surface().dispatchEvent(ev); });
        expect(ev.defaultPrevented).toBe(false);
        await act(async () => {
            surface().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3, pointerType: 'mouse', ...clientOf(0.5, 0.5) }));
        });
    });
});

describe('a PHYSICAL keyboard while the keyboard bar is up (a Bluetooth keyboard, DeX)', () => {
    // The bar's field has focus, and the stage's full key forwarding stands
    // aside for editable targets — so only text and the bar's own keys
    // (Enter, Tab, Esc, arrows) reached the PC: Ctrl/Alt combos, Delete,
    // Home/End and the F-keys did not. (Before the focus fix a tap on the
    // picture moved focus to BODY and so, by accident, handed them to the
    // full forwarder.) Text must still go as TEXT, once.
    async function withBar(): Promise<HTMLInputElement> {
        await mountWith(session());
        const btn = host!.querySelector('button[title="Keyboard"]') as HTMLButtonElement;
        await act(async () => { btn.click(); });
        await flush();
        const field = host!.querySelector('input.device-stage-keyboard-capture') as HTMLInputElement;
        expect(field, 'precondition: the bar is up').toBeTruthy();
        field.focus();
        h.sendInput.mockClear();
        return field;
    }
    const press = async (field: HTMLElement, type: 'keydown' | 'keyup', init: KeyboardEventInit & { keyCode?: number }) => {
        const ev = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
        if (init.keyCode !== undefined) Object.defineProperty(ev, 'keyCode', { value: init.keyCode });
        await act(async () => { field.dispatchEvent(ev); });
        return ev;
    };
    const keys = () => h.sendInput.mock.calls.map(c => c[1] as { t?: string; code?: string; down?: boolean; text?: string });

    it('Delete, Home, End and the F-keys go to the PC, down and up, and stay out of the field', async () => {
        const field = await withBar();
        for (const [key, code] of [['Delete', 'Delete'], ['Home', 'Home'], ['End', 'End'], ['F5', 'F5']] as const) {
            const down = await press(field, 'keydown', { key, code });
            expect(down.defaultPrevented, `${key} must not also act locally`).toBe(true);
            await press(field, 'keyup', { key, code });
            expect(keys().filter(e => e.t === 'key' && e.code === code).map(e => e.down), key).toEqual([true, false]);
        }
    });

    it('Ctrl+C is a chord on the PC, and types nothing', async () => {
        const field = await withBar();
        await press(field, 'keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true });
        await press(field, 'keydown', { key: 'c', code: 'KeyC', ctrlKey: true });
        await press(field, 'keyup', { key: 'c', code: 'KeyC', ctrlKey: true });
        await press(field, 'keyup', { key: 'Control', code: 'ControlLeft' });
        expect(keys().filter(e => e.t === 'key').map(e => `${e.code}${e.down ? '+' : '-'}`))
            .toEqual(['ControlLeft+', 'KeyC+', 'KeyC-', 'ControlLeft-']);
        expect(keys().filter(e => e.t === 'text')).toEqual([]);
    });

    it('a plain character is left to the field, so it goes once, as text', async () => {
        const field = await withBar();
        const down = await press(field, 'keydown', { key: 'a', code: 'KeyA' });
        expect(down.defaultPrevented, 'the field must get it').toBe(false);
        expect(keys().filter(e => e.t === 'key'), 'no key event as well as the text').toEqual([]);
    });

    it('a soft keyboard\'s keydown (229 / Unidentified) is left to the field', async () => {
        const field = await withBar();
        const down = await press(field, 'keydown', { key: 'Unidentified', code: '', keyCode: 229 });
        expect(down.defaultPrevented).toBe(false);
        expect(keys()).toEqual([]);
    });

    it('Enter is sent once — by the bar, not twice', async () => {
        const field = await withBar();
        await press(field, 'keydown', { key: 'Enter', code: 'Enter' });
        await press(field, 'keyup', { key: 'Enter', code: 'Enter' });
        expect(keys().filter(e => e.t === 'key' && e.code === 'Enter').map(e => e.down)).toEqual([true, false]);
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

    it('a press onto the line of a caret already there opens nothing until the caret moves to it', async () => {
        // Until 2026-11-20 this opened the keyboard at the press, decided from
        // the known caret alone ("near"): and so it did for every button on
        // that line. The host's word is the caret moving.
        await mountWith(session());
        await caret('ds-1', WIN32(0.4, 0.3));       // an already-focused field
        expect(panel()).toBeNull();
        await pressAt(0.5, 0.3 + 9 / 1080);          // same line, a little to the right
        expect(panel(), 'no report says the press went into the text').toBeNull();
        await caret('ds-1', WIN32(0.5, 0.3));       // the press put the caret there
        expect(panel(), 'the caret moved to the finger: the press went into the text').toBeTruthy();
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
        // Positive control for the rig: the same press as a TAP, the caret
        // moving to it, opens it.
        await pressAt(0.4, 0.3 + 9 / 1080);
        await caret('ds-1', WIN32(0.4, 0.3));
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

describe('a tap that is not into a text box opens nothing (2026-11-20)', () => {
    // The owner, controlling a PC from the Android app: "a lot of clicks seem
    // to needlessly bring the keyboard up and change zoom".
    it('a button BESIDE a focused text box, on its line: left of it, right of it', async () => {
        await mountWith(session());
        await caret('ds-1', WIN32(0.4, 0.3));       // the text box has the focus
        for (const dx of [-200, 300, 600]) {
            await pressAt(0.4 + dx / 1920, 0.3 + 9 / 1080);
            expect(panel(), `a button ${dx} px from the caret`).toBeNull();
            // A tier flip re-sending the same caret is no move either.
            await caret('ds-1', { ...WIN32(0.4, 0.3), src: 'msaa' });
            expect(panel(), `…and the same caret re-sent (${dx} px)`).toBeNull();
            await caret('ds-1', WIN32(0.4, 0.3));
        }
        expect(h.showMobileKeyboard).not.toHaveBeenCalled();
    });

    it("the line Chromium's hidden caret was left on (msaa, 0 px wide)", async () => {
        await mountWith(session());
        const hidden = { ...WIN32(0.4, 0.3), src: 'msaa', w: 0 };
        await caret('ds-1', hidden);
        await pressAt(0.6, 0.3 + 9 / 1080);
        expect(panel(), 'a tap beside it').toBeNull();
        await pressAt(0.45, 0.3 + 9 / 1080);
        expect(panel(), 'a tap on it').toBeNull();
        // POSITIVE CONTROL: the tap gives the box the focus back and Chromium
        // shows its caret in place, 1 px wide: a text box took the focus.
        await caret('ds-1', { ...hidden, w: 1 / 1920 });
        expect(panel()).toBeTruthy();
    });
});

describe('closing the keyboard sticks', () => {
    const kbButton = () => host!.querySelector('button[title="Keyboard"]') as HTMLButtonElement;
    async function raiseByTap() {
        await caret('ds-1', HIDDEN);
        await pressAt(0.5, 0.5);
        await caret('ds-1', WIN32(0.5, 0.5));
        expect(panel(), 'precondition: a tap into a text box opened it').toBeTruthy();
    }
    afterEach(() => { vi.useRealTimers(); });

    it('closed with its button: a caret the next taps move, on its line or another, leaves it closed, however long after', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await mountWith(session());
        await raiseByTap();
        await act(async () => { kbButton().click(); });
        await flush();
        expect(panel(), 'precondition: the button closed it').toBeNull();
        // Past the 5 s the stand-down used to last.
        vi.setSystemTime(Date.now() + 6_000);
        await pressAt(0.6, 0.5 + 9 / 1080);
        await caret('ds-1', WIN32(0.6, 0.5));       // same text box, same line
        expect(panel(), 'same line, 6 s later').toBeNull();
        await pressAt(0.5, 0.8 + 9 / 1080);
        await caret('ds-1', WIN32(0.5, 0.8));       // another line of the text
        expect(panel(), 'another line').toBeNull();
        // The focus leaves the text (a button), then a text box takes it.
        await caret('ds-1', HIDDEN);
        await pressAt(0.3, 0.2 + 9 / 1080);
        await caret('ds-1', WIN32(0.3, 0.2));
        expect(panel(), 'POSITIVE CONTROL: a text box taking the focus opens it').toBeTruthy();
    });

    it("Android's Back under the open bar is a close too; the keyboard coming up again ends it", async () => {
        h.inset = { visible: true, top: 500, source: 'native' };
        await mountWith(session());
        await raiseByTap();
        const ime = async (visible: boolean) => {
            h.inset = { visible, top: visible ? 500 : 844, source: 'native' };
            await act(async () => { for (const w of h.insetWatchers) w(h.inset); });
            await flush();
        };
        // POSITIVE CONTROL: with the IME up, a tap that moves the caret
        // raises again (the native show is asked).
        h.showMobileKeyboard.mockClear();
        await pressAt(0.6, 0.5 + 9 / 1080);
        await caret('ds-1', WIN32(0.6, 0.5));
        expect(h.showMobileKeyboard, 'precondition: a raise asks the native show').toHaveBeenCalled();

        await ime(false);                            // the back gesture
        expect(panel(), 'the bar stays up').toBeTruthy();
        h.showMobileKeyboard.mockClear();
        await pressAt(0.7, 0.5 + 9 / 1080);
        await caret('ds-1', WIN32(0.7, 0.5));
        await pressAt(0.5, 0.8 + 9 / 1080);
        await caret('ds-1', WIN32(0.5, 0.8));
        expect(h.showMobileKeyboard, 'after Back, taps in the text bring no keyboard back').not.toHaveBeenCalled();

        await ime(true);                             // "Tap to type", or the button
        h.showMobileKeyboard.mockClear();
        await pressAt(0.6, 0.8 + 9 / 1080);
        await caret('ds-1', WIN32(0.6, 0.8));
        expect(h.showMobileKeyboard, 'the keyboard up again ends the close').toHaveBeenCalled();
    });

    // A host before 2026-11-20 (no `rev`) on a screen wider than 2000 px:
    // Chromium's caret object hides by going from 1 px wide to 0 in place,
    // and that agent sends nothing for it (under its 1/2000 epsilon). So the
    // address bar's caret stays "measured" here after a tap on the page took
    // the focus, and a text box tapped on the page next is a caret that MOVED.
    const WIDE = [{ id: 0, label: 'Main display', left: 0, top: 0, width: 2560, height: 1440 }];
    const CHROMIUM = (x: number, y: number, rev?: number) => ({
        vis: true, x, y, w: 1 / 2560, h: 24 / 1440, src: 'msaa', mon: 0, surf: 1, seq: 1,
        ...(rev === undefined ? {} : { rev }),
    });
    async function raiseInChromium(rev?: number) {
        await caret('ds-1', { ...HIDDEN, ...(rev === undefined ? {} : { rev }) });
        await pressAt(0.5, 0.5);
        await caret('ds-1', CHROMIUM(0.5, 0.5, rev));
        expect(panel(), 'precondition: a tap into the address bar opened it').toBeTruthy();
        await act(async () => { kbButton().click(); });
        await flush();
        expect(panel(), 'precondition: the button closed it').toBeNull();
    }

    it("an OLDER host's Chromium caret, whose hide never arrives: held 5 s on its line, then the next text box opens it", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await mountWith(session({ monitors: WIDE }));
        await raiseInChromium();
        vi.setSystemTime(Date.now() + 2_000);
        await pressAt(0.6, 0.5 + 12 / 1440);
        await caret('ds-1', CHROMIUM(0.6, 0.5));     // further along the address bar
        expect(panel(), 'within 5 s, on the line it was closed on: held, as before 2026-11-20').toBeNull();
        vi.setSystemTime(Date.now() + 4_000);
        await pressAt(0.7, 0.3);                     // the page: Chromium hides its caret, nothing is sent
        await pressAt(0.3, 0.2 + 12 / 1440);
        await caret('ds-1', CHROMIUM(0.3, 0.2));     // a search box on the page
        expect(panel(), 'the text box tapped on the page opens the keyboard').toBeTruthy();
    });

    it("CONTROL: a CURRENT host's (rev 2) Chromium caret sticks like any other, until its hide arrives", async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        await mountWith(session({ monitors: WIDE }));
        await raiseInChromium(2);
        vi.setSystemTime(Date.now() + 6_000);
        await pressAt(0.6, 0.5 + 12 / 1440);
        await caret('ds-1', CHROMIUM(0.6, 0.5, 2));
        expect(panel(), 'the same text, 6 s later').toBeNull();
        await pressAt(0.3, 0.2 + 12 / 1440);
        await caret('ds-1', CHROMIUM(0.3, 0.2, 2));  // the focus went straight into another box
        expect(panel(), 'another box the focus went straight into').toBeNull();
        // The page takes the focus: this host says so.
        await caret('ds-1', { ...HIDDEN, rev: 2 });
        await pressAt(0.4, 0.8 + 12 / 1440);
        await caret('ds-1', CHROMIUM(0.4, 0.8, 2));
        expect(panel(), 'POSITIVE CONTROL: a text box taking the focus opens it').toBeTruthy();
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
