/**
 * WHILE TYPING, ONLY A TEXT BOX'S CARET MOVES THE PICTURE (2026-11-20, the
 * owner controlling a PC from the Android app: "a lot of clicks seem to
 * needlessly bring the keyboard up and change zoom" — what zooms is the PC's
 * picture on the stage).
 *
 * With the keyboard bar up, the stage's caret camera puts the remote caret in
 * the band between the bar and the soft keyboard. It also moved for things
 * that are not a caret:
 *
 *  - every TAP, a second after the caret last moved. The pointer fallback
 *    (the tap stands in for a caret the host does not report) judged "the
 *    host is silent" by how recently a report had come, and an agent reports
 *    only on change: a caret sitting still in its text box read as a silent
 *    peer, so a tap on a button zoomed and panned the picture to the button;
 *  - a focused BUTTON, which tier 3 reports as the element's box ('field'):
 *    the camera flew to it.
 *
 * Now the fallback places on the last aim only when the user TYPES, and only
 * while the latest report is not a measured caret; and only a measured caret
 * moves the picture. Driven through the REAL stage (session mocked) on a
 * phone-shaped box with a keyboard band, the rig of
 * deviceStageZoomFollowSwitch.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    caretSubs: new Set<(r: unknown) => void>(),
    sendInput: vi.fn(),
    storage: new Map<string, string>(),
    kb: { visible: false, top: null as number | null, source: 'none' as string },
    kbWatch: null as ((i: unknown) => void) | null,
}));

vi.mock('../api/devices/session', () => ({
    sendViewSize: () => { /* the fit is not under test */ },
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: (_id: string, cb: (r: unknown) => void) => {
        h.caretSubs.add(cb);
        return () => { h.caretSubs.delete(cb); };
    },
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
    deviceStatsSample: async () => null,
    latencyProbeUsable: () => false,
    sendLatencyProbe: () => false,
    noteFramePresented: () => { /* noop */ },
    subscribeLatency: () => () => { /* unsubscribe */ },
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
    currentKeyboardInset: () => h.kb,
    watchKeyboardInset: (cb: (i: unknown) => void) => { h.kbWatch = cb; return () => { h.kbWatch = null; }; },
}));

const { DeviceStage } = await import('../components/DeviceStage');

/** The surface's own box: a phone, its keyboard bar and soft keyboard over
 *  it (the WebView is not resized for the IME, so there is a band). */
const BOX = { w: 390, h: 799 };
const KEYBAR_H = 140;
const TOOLBAR_H = 56;
const MONITORS = [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }];

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.w });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.h });
    h.kb = { visible: false, top: null, source: 'none' };
    h.kbWatch = null;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const rect = (top: number, height: number) => ({
            x: 0, y: top, left: 0, top, right: BOX.w, bottom: top + height, width: BOX.w, height, toJSON: () => ({}),
        });
        if (this.classList.contains('device-stage-keyboard-overlay')) return rect(0, KEYBAR_H);
        if (this.classList.contains('device-stage-mobile-toolbar')) return rect(0, TOOLBAR_H);
        if (this.classList.contains('device-stage-surface')) return rect(parseFloat(this.style.marginTop) || 0, BOX.h);
        return rect(0, BOX.h);
    };
    HTMLMediaElement.prototype.play = () => Promise.resolve();
    HTMLMediaElement.prototype.pause = () => { /* noop */ };
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
        observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ }
    };
    window.matchMedia = ((q: string) => ({
        matches: q.includes('coarse'), media: q, onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    // Touch mode: a finger down is a press where it lands.
    h.storage.set('device-stage-mouse-mode', 'touch');
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.caretSubs.clear();
    h.snapshot = [];
    h.sendInput.mockClear();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
    vi.useRealTimers();
});

function session(): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: MONITORS, activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false, audioHub: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false, cursorClipped: false,
        shareUser: null, viewOnly: false, unattended: true, powerNotice: null,
    };
}

const sleep = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const surface = () => host!.querySelector('.device-stage-surface') as HTMLElement;
const field = () => host!.querySelector('input.device-stage-keyboard-capture') as HTMLInputElement;

function transform(): { scale: number; x: number; y: number } {
    const el = host!.querySelector('.device-stage-canvas') as HTMLElement;
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(el.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

/** Mounted, with the keyboard bar opened by its button and the soft keyboard
 *  up over the lower part of the surface: the caret camera is live. */
async function typing() {
    h.snapshot = [session()];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await sleep(100);
    const kbBtn = host.querySelector('button[title="Keyboard"]') as HTMLButtonElement;
    await act(async () => { kbBtn.click(); });
    await sleep(50);
    h.kb = { visible: true, top: KEYBAR_H + 360, source: 'native' };
    await act(async () => { h.kbWatch?.(h.kb); });
    await sleep(50);
}

async function caret(r: Record<string, unknown>) {
    await act(async () => { for (const cb of [...h.caretSubs]) cb({ mon: 0, surf: 1, seq: 1, ...r }); });
    await sleep(50);
}
const TEXT = (x: number, y: number) => ({ vis: true, x, y, w: 1 / 1920, h: 18 / 1080, src: 'win32' });

/** A finger tapping the picture at a client point. jsdom draws no zoom, so
 *  the stage maps the point onto the picture as fitted: 390x219 letterboxed
 *  from y 290 down. The aim that went out is returned, to prove it did. */
async function tap(x: number, y: number): Promise<{ x: number; y: number }> {
    const ev = (type: string) => new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 5, pointerType: 'touch', button: 0, clientX: x, clientY: y,
    });
    h.sendInput.mockClear();
    await act(async () => { surface().dispatchEvent(ev('pointerdown')); });
    await act(async () => { surface().dispatchEvent(ev('pointerup')); });
    await sleep(100);
    const move = h.sendInput.mock.calls.map(c => c[1] as { t?: string; x?: number; y?: number }).find(e => e.t === 'move');
    expect(move, 'precondition: the tap aimed somewhere on the picture').toBeTruthy();
    return { x: move!.x!, y: move!.y! };
}

const same = (a: { scale: number; x: number; y: number }, b: { scale: number; x: number; y: number }) =>
    Math.abs(a.scale - b.scale) < 1e-9 && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

describe('a host that reports the caret', () => {
    it('a tap on a button while typing does not move the picture, however long the caret has sat still', async () => {
        await typing();
        await caret(TEXT(0.3, 0.7));
        const placed = transform();
        expect(placed.scale, 'precondition: the camera zoomed to the caret').toBeGreaterThan(1);
        // The caret sits still in its text box; the agent says nothing more.
        await sleep(2_000);
        await tap(60, 300);
        await tap(330, 480);
        expect(same(transform(), placed), `the picture moved for a tap: ${JSON.stringify(placed)} -> ${JSON.stringify(transform())}`).toBe(true);
    });

    it('a focused button, reported by its box, does not move the picture', async () => {
        await typing();
        await caret(TEXT(0.3, 0.7));
        const placed = transform();
        await caret({ vis: true, x: 0.8, y: 0.1, w: 0.08, h: 0.03, src: 'field' });
        expect(same(transform(), placed), `the camera flew to the button: ${JSON.stringify(transform())}`).toBe(true);
        // Nor does Chromium's hidden caret (an older agent's report of it).
        await caret({ vis: true, x: 0.8, y: 0.1, w: 0, h: 18 / 1080, src: 'msaa' });
        expect(same(transform(), placed)).toBe(true);
        // POSITIVE CONTROL: a text box's caret over there does.
        await caret(TEXT(0.8, 0.1));
        expect(same(transform(), placed), 'a measured caret out of view must move the picture').toBe(false);
    });
});

describe('a host that reports no caret (the pointer stands in for it)', () => {
    it('places on the last tap when the user TYPES, never on the tap itself', async () => {
        await typing();
        // Nobody reports a caret: after its grace the camera places on the
        // aim, the readable band the documented fallback gives.
        await sleep(700);
        const placed = transform();
        expect(placed.scale, 'precondition: the fallback placed the band').toBeGreaterThan(1);
        await tap(40, 470);
        expect(same(transform(), placed), `the picture moved for a tap: ${JSON.stringify(transform())}`).toBe(true);
        // A key goes out: now the tap stands in for the caret.
        await act(async () => { field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
        await sleep(100);
        expect(h.sendInput.mock.calls.some(c => (c[1] as { t?: string; code?: string }).code === 'Enter'), 'precondition: the key went out').toBe(true);
        expect(same(transform(), placed), 'typing after the tap places the band on it').toBe(false);
    });
});
