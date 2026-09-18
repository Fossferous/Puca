/**
 * THE STRANDED-CONTACT WEDGE, through the real stage.
 *
 * The trackpad machine keeps its own map of fingers (touchGestures.ts), and
 * two entries is a pinch, which swallows every move. The stage already pruned
 * ITS map of fingers whose up never arrived — but never the machine's, and it
 * never told the machine when the app lost focus. So one lost pointerup in a
 * pinch left the trackpad dead: every later one-finger drag reached the
 * machine as a second finger, and not one move left the phone until the mode
 * was toggled. The keyboard kept working, which is the shape of the owner's
 * lock-screen report ("the mouse doesn't actually work").
 *
 * The machine's own tests cover prune() and cancel(); this pins the WIRING —
 * the two stage paths that must reach them — plus the "Copy diagnostics"
 * fields that would have shown the wedge in a field capture.
 *
 * jsdom has no pointer capture, so the rig emulates it: capture is granted on
 * pointerdown and released on pointerup, and a test "loses" a finger by
 * dropping its capture without ever dispatching its up — what a backgrounded
 * app does to a gesture in flight.
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
    captured: new Set<number>(),
    diagRows: [] as Record<string, unknown>[],
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
    deviceDiagnosticsWindow: async () => h.diagRows,
    activeSessions: () => [],
    requestFileAccess: () => { /* noop */ },
}));
vi.mock('../api/devices/tunnel', () => ({
    tunnelStatus: async () => ({ listeners: [], inbound_streams: 0, outbound_streams: 0, forwards: [] }),
}));
vi.mock('../api/devices/chords', () => ({ sendChord: () => true }));
vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isMobile: () => true, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

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
    HTMLMediaElement.prototype.pause = () => { /* noop */ };
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ }
    };
    // A phone: coarse pointer.
    window.matchMedia = (() => ({
        matches: true, media: '', onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    // Pointer capture, emulated (see the header).
    h.captured.clear();
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    proto.setPointerCapture = (id: number) => { h.captured.add(id); };
    proto.releasePointerCapture = (id: number) => { h.captured.delete(id); };
    proto.hasPointerCapture = (id: number) => h.captured.has(id);

    h.storage.clear();
    h.storage.set('device-stage-mouse-mode', 'trackpad');
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.sendInput.mockClear();
    h.diagRows = [];
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
    delete proto.setPointerCapture;
    delete proto.releasePointerCapture;
    delete proto.hasPointerCapture;
});

function session(over: Snapshot = {}): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: true, reconnecting: false,
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

/** A PointerEvent-shaped MouseEvent: React reads `pointerId` off the native
 *  event, and jsdom's MouseEvent has none. */
function pe(type: string, id: number, x: number, y: number): MouseEvent {
    const e = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y });
    Object.defineProperty(e, 'pointerId', { value: id });
    return e;
}

async function fire(...events: MouseEvent[]) {
    await act(async () => { for (const e of events) surface().dispatchEvent(e); });
    await flush();
}

/** A pinch whose SECOND finger's up never arrives. */
async function pinchLosingFinger2() {
    await fire(pe('pointerdown', 1, 150, 400), pe('pointerdown', 2, 250, 400), pe('pointerup', 1, 150, 400));
    h.sendInput.mockClear();
}

/** A one-finger drag, well past the tap slop, left DOWN (no up) so the
 *  machine's phase can be read mid-gesture. */
async function dragFinger3() {
    await fire(pe('pointerdown', 3, 100, 400), pe('pointermove', 3, 140, 400), pe('pointermove', 3, 180, 400));
}

const movesSent = () => h.sendInput.mock.calls.filter(c => (c[1] as { t?: string }).t === 'move');
const sentOf = (t: string) => h.sendInput.mock.calls.filter(c => (c[1] as { t?: string }).t === t);

/** Press "Copy diagnostics" in the Mouse menu and return the stage's pointer
 *  half of what it copied — read at that moment, mid-gesture if one is on. */
async function copyStageInput(): Promise<Record<string, unknown>> {
    const writeText = vi.fn(async (_t: string) => { /* accepted */ });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    h.diagRows = [{ id: 'ds-1', inputSentPerSecond: 0 }];
    const mouseBtn = host!.querySelector<HTMLButtonElement>('button[title="Mouse"]');
    expect(mouseBtn, 'the phone toolbar must offer the Mouse menu').toBeTruthy();
    await act(async () => { mouseBtn!.click(); });
    await flush();
    const copy = Array.from(host!.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Copy diagnostics');
    expect(copy, 'the Mouse menu must offer Copy diagnostics').toBeTruthy();
    await act(async () => { copy!.click(); });
    await flush();
    expect(writeText).toHaveBeenCalledTimes(1);
    const rows = JSON.parse(writeText.mock.calls[0][0]) as Array<Record<string, unknown>>;
    return rows[0].stageInput as Record<string, unknown>;
}

describe('a trackpad left with a stranded finger', () => {
    it('POSITIVE CONTROL: while finger 2 still holds capture, a new finger IS a pinch and sends no move', async () => {
        // Proves the rig can see "no move went out" — without it, the two
        // recovery tests below could pass on a stage that never wedged.
        await mount();
        await pinchLosingFinger2();
        await dragFinger3();
        expect(movesSent()).toEqual([]);
    });

    it('recovers on the next touch once the lost finger has lost capture (the prune reaches the machine)', async () => {
        await mount();
        await pinchLosingFinger2();
        h.captured.delete(2);          // the OS took the gesture away; no up arrived
        await dragFinger3();
        expect(movesSent().length, 'a one-finger drag must move the pointer again').toBeGreaterThan(0);
        // And the recovery leaves evidence: silent by design, so this counter
        // is the only thing a capture taken afterwards can show.
        const diag = await copyStageInput();
        expect(diag.gesturePruned, 'the prune is counted').toBe(1);
        expect(diag.gestureBlurCancels).toBe(0);
        expect(diag.stageContacts).toBe(1);
    });

    it('recovers after the app loses focus, even with the stale capture still reported', async () => {
        await mount();
        await pinchLosingFinger2();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await flush();
        await dragFinger3();
        expect(movesSent().length, 'blur must reset the trackpad machine as well as the held keys').toBeGreaterThan(0);
        // THE STAGE AGREES WITH THE MACHINE, mid-drag. Clearing only the
        // machine left the stage counting two fingers, so this same drag
        // pinch-zoomed the picture while the pointer moved.
        const diag = await copyStageInput();
        expect(diag.stageContacts, 'the stage must have forgotten finger 2 too').toBe(1);
        expect(diag.gestureContacts).toBe(1);
        expect(diag.gesturePhase).not.toBe('pinch');
        expect(diag.gestureBlurCancels, 'the blur that dropped a finger is counted').toBe(1);
        expect(diag.gesturePruned).toBe(0);
    });
});

describe('a touch-mode stage left with a stranded finger', () => {
    beforeEach(() => { h.storage.set('device-stage-mouse-mode', 'touch'); });

    async function tapFinger3() {
        await fire(pe('pointerdown', 3, 100, 400), pe('pointerup', 3, 100, 400));
    }

    it('POSITIVE CONTROL: with finger 2 still counted, a tap arrives as a second contact and presses nothing', async () => {
        await mount();
        await pinchLosingFinger2();
        await tapFinger3();
        expect(sentOf('down'), 'the rig must see the swallowed tap').toEqual([]);
    });

    it('taps work again after the app loses focus', async () => {
        await mount();
        await pinchLosingFinger2();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await flush();
        h.sendInput.mockClear();
        await fire(pe('pointerdown', 3, 100, 400));
        expect(sentOf('down'), 'a tap after blur must press the button').toHaveLength(1);
        // The forgotten finger may really still be down; its moves must not
        // steer the pointer the live finger now owns.
        h.sendInput.mockClear();
        await fire(pe('pointermove', 2, 300, 700));
        expect(movesSent(), 'a finger the stage let go of drives nothing').toEqual([]);
        await fire(pe('pointerup', 3, 100, 400));
        expect(sentOf('up')).toHaveLength(1);
    });

    it('a touch press held when the app loses focus is released, once', async () => {
        // Forgetting the finger must not strand the button it pressed on the
        // host: the same let-go-first rule the mode switch follows.
        await mount();
        await fire(pe('pointerdown', 1, 100, 400));
        expect(sentOf('down'), 'precondition: the finger pressed').toHaveLength(1);
        h.sendInput.mockClear();
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        await flush();
        expect(sentOf('up'), 'blur releases the press').toHaveLength(1);
        // Its late up, if it ever comes, releases nothing a second time.
        await fire(pe('pointerup', 1, 100, 400));
        expect(sentOf('up')).toHaveLength(1);
    });
});

describe('"Copy diagnostics" shows the trackpad state', () => {
    it('carries the mouse mode, the machine phase and contacts, and who draws the pointer', async () => {
        const writeText = vi.fn(async (_t: string) => { /* accepted */ });
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
        h.diagRows = [{ id: 'ds-1', inputSentPerSecond: 0 }];
        await mount();
        // The wedge itself, mid-drag: what a field capture would have shown.
        await pinchLosingFinger2();
        await dragFinger3();

        const mouseBtn = host!.querySelector<HTMLButtonElement>('button[title="Mouse"]');
        expect(mouseBtn, 'the phone toolbar must offer the Mouse menu').toBeTruthy();
        await act(async () => { mouseBtn!.click(); });
        await flush();
        const copy = Array.from(host!.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Copy diagnostics');
        expect(copy, 'the Mouse menu must offer Copy diagnostics').toBeTruthy();
        await act(async () => { copy!.click(); });
        await flush();

        expect(writeText).toHaveBeenCalledTimes(1);
        const rows = JSON.parse(writeText.mock.calls[0][0]) as Array<Record<string, unknown>>;
        expect(rows[0].id, 'the session row is carried through').toBe('ds-1');
        expect(rows[0].stageInput).toMatchObject({
            mouseMode: 'trackpad',
            controlEnabled: true,
            gesturePhase: 'pinch',
            gestureContacts: 2,
            // Nothing has recovered it yet: the wedge is live, not history.
            gesturePruned: 0,
            gestureBlurCancels: 0,
            cursorOwned: true,
        });
        expect((rows[0].stageInput as Record<string, unknown>).stageContacts).toBe(2);
    });
});
