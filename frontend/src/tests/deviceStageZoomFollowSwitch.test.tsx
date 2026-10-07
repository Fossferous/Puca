/**
 * ZOOM-FOLLOW ACROSS A MONITOR SWITCH — "zoom is jumpy when switching
 * monitors" (owner report, 2026-10-07).
 *
 * Zooming into a screen of the All Displays picture switches the capture to
 * that screen and remaps the view so the same desktop point stays under the
 * middle of the phone at the same physical size. The field log of the report
 * shows the order that broke it: the zoom also makes the viewer report a
 * larger stage, so the agent's viewer fit re-encodes the COMPOSITE at a new
 * size (1360x640 -> 2720x1282) BEFORE the switch commits, and the switch's
 * confirmation (relay) usually lands before the new screen's first frame
 * (direct media, ~200 ms after the commit). The stage took "the picture
 * changed size after I asked" as "the new screen is showing" and remapped
 * against the composite — the view jumped to the wrong place and nothing
 * corrected it when the real frame arrived.
 *
 * Driven through the REAL stage (session mocked), with the owner's three
 * screens, a phone-shaped box, and the picture's intrinsic size changed the
 * way the host changes it. The assertion is the user's: the desktop point at
 * the middle of the screen before the switch is the one there after it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    requestMonitor: vi.fn(),
    sendInput: vi.fn(),
    storage: new Map<string, string>(),
    mobile: false,
    kb: { visible: false, top: null as number | null, source: 'none' as string },
    kbWatch: null as ((i: unknown) => void) | null,
}));

vi.mock('../api/devices/session', () => ({
    sendViewSize: () => { /* the fit is played by the test, below */ },
    ALL_DISPLAYS: 255,
    subscribeSessions: (l: (s: Snapshot[]) => void) => {
        h.listeners.add(l);
        l(h.snapshot);
        return () => { h.listeners.delete(l); };
    },
    subscribeCaret: () => () => { /* unsubscribe */ },
    setCaretTracking: () => { /* noop */ },
    sendInput: (...a: unknown[]) => h.sendInput(...a),
    requestMonitor: (...a: unknown[]) => h.requestMonitor(...a),
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
    return { ...real, isMobile: () => h.mobile, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => h.kb,
    watchKeyboardInset: (cb: (i: unknown) => void) => { h.kbWatch = cb; return () => { h.kbWatch = null; }; },
}));

const { DeviceStage } = await import('../components/DeviceStage');
const { pictureBox } = await import('../api/devices/pointerMapping');

/** The SURFACE's own box (what the picture is laid out in): a phone-shaped
 *  stage, which shrinks when the keyboard bar and the IME take their share. */
const BOX = { w: 390, h: 799 };
/** The keyboard bar's and the toolbar's measured heights. */
const KEYBAR_H = 140;
const TOOLBAR_H = 56;
/** The owner's screens, in the agent's (DXGI) order. */
const MONITORS = [
    { id: 0, label: 'Main display', left: 0, top: 0, width: 2560, height: 1440 },
    { id: 1, label: 'Display 2', left: 2560, top: -700, width: 1440, height: 2560 },
    { id: 2, label: 'Display 3', left: -1440, top: -707, width: 1440, height: 2560 },
];
const UNION = { left: -1440, top: -707, w: 5440, h: 2567 };

/** The picture's intrinsic size — what the host is encoding right now. */
let dims = { w: 1360, h: 640 };

beforeEach(() => {
    // A FAKE CLOCK, or the rig measures the machine: the follow decides 120 ms
    // after the LAST zoom step, and a slow act() between two wheel steps let
    // it decide mid-zoom, over whichever screen was in the middle then.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'Date'] });
    dims = { w: 1360, h: 640 };
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => dims.w });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => dims.h });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.w });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.h });
    BOX.w = 390;
    BOX.h = 799;
    h.kb = { visible: false, top: null, source: 'none' };
    h.kbWatch = null;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        const rect = (top: number, height: number) => ({
            x: 0, y: top, left: 0, top, right: BOX.w, bottom: top + height, width: BOX.w, height, toJSON: () => ({}),
        });
        // The chrome measures itself; the surface sits below the key bar's
        // reserved margin, exactly as the stage lays it out.
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
        matches: h.mobile && q.includes('coarse'), media: q, onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.requestMonitor.mockClear();
    h.sendInput.mockClear();
    h.mobile = false;
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

function session(activeMonitor: number, unattended = true): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: MONITORS,
        activeMonitor,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false, audioHub: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false, cursorClipped: false,
        shareUser: null, viewOnly: false, unattended, powerNotice: null,
    };
}

async function mount(active = 255, unattended = true) {
    h.snapshot = [session(active, unattended)];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    // Past the first animation frames, so the work mount schedules (the
    // pointer's first paint) is done before anything is zoomed.
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}

const surface = () => host!.querySelector('.device-stage-surface') as HTMLElement;
const video = () => host!.querySelector('video.device-stage-video') as HTMLVideoElement;
const sleep = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** The host re-encodes (a fit change, or a switch's first frame). */
async function frame(w: number, h2: number) {
    dims = { w, h: h2 };
    await act(async () => { video().dispatchEvent(new Event('resize')); });
}
/** The relay's monitor-active confirm. */
async function confirm(active: number) {
    await act(async () => {
        h.snapshot = [session(active)];
        for (const l of h.listeners) l(h.snapshot);
    });
}

function transform(): { scale: number; x: number; y: number } {
    const el = host!.querySelector('.device-stage-canvas') as HTMLElement;
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(el.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), scale: Number(m[3]) };
}

/** The DESKTOP point under the middle of the stage, given what is captured. */
function centreDesktop(capturing: number): { x: number; y: number } {
    const t = transform();
    const p = pictureBox(dims.w, dims.h, BOX.w, BOX.h)!;
    const cx = (BOX.w / 2 - t.x) / t.scale;
    const cy = (BOX.h / 2 - t.y) / t.scale;
    const fx = (cx - p.offX) / p.dispW;
    const fy = (cy - p.offY) / p.dispH;
    const r = capturing === 255
        ? UNION
        : (() => { const m = MONITORS.find(x => x.id === capturing)!; return { left: m.left, top: m.top, w: m.width, h: m.height }; })();
    return { x: r.left + fx * r.w, y: r.top + fy * r.h };
}

/** The client point of a desktop point on the composite picture. */
function clientOnComposite(dx: number, dy: number): { x: number; y: number } {
    const p = pictureBox(dims.w, dims.h, BOX.w, BOX.h)!;
    return { x: p.offX + p.dispW * (dx - UNION.left) / UNION.w, y: p.offY + p.dispH * (dy - UNION.top) / UNION.h };
}

/** Ctrl+wheel, the stage's zoom, anchored on a client point. */
async function zoomAt(at: { x: number; y: number }, notches: number) {
    for (let i = 0; i < notches; i++) {
        await act(async () => {
            surface().dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, ctrlKey: true, deltaY: -60, clientX: at.x, clientY: at.y,
            }));
        });
    }
}

/** Where on Display 2 the zoom is aimed: its upper third, so a remap that
 *  confuses the composite's letterbox with the portrait screen's cannot land
 *  on the right row by the coincidence that both are centred. */
const AIM = { x: 2560 + 720, y: -700 + 700 };

/** Zoom over Display 2 until the follow asks for it. */
async function zoomIntoDisplay2(): Promise<{ x: number; y: number }> {
    const at = clientOnComposite(AIM.x, AIM.y);
    await zoomAt(at, 12);
    const before = centreDesktop(255);
    await sleep(200);
    expect(h.requestMonitor.mock.calls.map(c => c[1]), 'precondition: zooming in followed Display 2').toEqual([1]);
    return before;
}

const near = (a: { x: number; y: number }, b: { x: number; y: number }, tol: number) =>
    Math.hypot(a.x - b.x, a.y - b.y) <= tol;

describe('the view across a zoom-follow switch', () => {
    it('POSITIVE CONTROL: confirm, then the new screen\'s frame — the same desktop point stays in the middle', async () => {
        await mount();
        const before = await zoomIntoDisplay2();
        await confirm(1);
        await frame(720, 1280);
        await sleep(400);
        const after = centreDesktop(1);
        expect(near(before, after, 40), `centre ${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(true);
    });

    it('the composite re-encoded for the zoom BEFORE the switch committed (the field order) — no jump', async () => {
        await mount();
        const before = await zoomIntoDisplay2();
        // The zoom grew the reported stage, so the agent's fit re-encoded the
        // COMPOSITE natively before the switch committed: same picture, twice
        // the pixels.
        await frame(2720, 1282);
        expect(near(centreDesktop(255), before, 15), 'a fit change moves nothing that matters on screen').toBe(true);
        // The relay confirm lands first, then the new screen's first frame.
        await confirm(1);
        await frame(1440, 2560);
        await sleep(400);
        const after = centreDesktop(1);
        expect(near(before, after, 40), `centre ${JSON.stringify(before)} -> ${JSON.stringify(after)}`).toBe(true);
    });

    it('the new screen\'s frames arriving BEFORE the confirm are not shown under the composite\'s view', async () => {
        await mount();
        const before = await zoomIntoDisplay2();
        // Direct media beats the relay: the new screen is on the stage while
        // `monitor-active` is still in flight. The view must already be the
        // new screen's — the composite's transform over a portrait picture
        // shows some other part of it, or its black bars.
        await frame(720, 1280);
        const shown = centreDesktop(1);
        expect(near(before, shown, 40), `centre ${JSON.stringify(before)} -> ${JSON.stringify(shown)}`).toBe(true);
        await confirm(1);
        await sleep(400);
        expect(near(before, centreDesktop(1), 40)).toBe(true);
    });

    it('a zoom that CONTINUES while the switch is in flight is kept, not undone', async () => {
        await mount();
        await zoomIntoDisplay2();
        // The fingers did not stop: more zoom over the same point, before the
        // host has switched.
        const at = clientOnComposite(AIM.x, AIM.y);
        await zoomAt(at, 4);
        const before = centreDesktop(255);
        const scaleBefore = transform().scale;
        await confirm(1);
        await frame(720, 1280);
        await sleep(400);
        expect(near(before, centreDesktop(1), 40), 'the point the user ended on stays in the middle').toBe(true);
        // Physical continuity: one desktop pixel covers the same screen
        // area. Composite: 5440 desktop px across the picture's width;
        // Display 2: 1440.
        const pc = pictureBox(1360, 640, BOX.w, BOX.h)!;
        const pm = pictureBox(720, 1280, BOX.w, BOX.h)!;
        const before1px = scaleBefore * pc.dispW / UNION.w;
        const after1px = transform().scale * pm.dispW / 1440;
        expect(after1px / before1px).toBeGreaterThan(0.9);
        expect(after1px / before1px).toBeLessThan(1.1);
    });
});

/** How much of the surface the picture actually covers, 0..1 — 0 is a black
 *  stage. */
function pictureCover(): number {
    const t = transform();
    const p = pictureBox(dims.w, dims.h, BOX.w, BOX.h)!;
    const l = Math.max(0, t.x + t.scale * p.offX), r = Math.min(BOX.w, t.x + t.scale * (p.offX + p.dispW));
    const top = Math.max(0, t.y + t.scale * p.offY), b = Math.min(BOX.h, t.y + t.scale * (p.offY + p.dispH));
    return Math.max(0, r - l) * Math.max(0, b - top) / (BOX.w * BOX.h);
}

describe('"selecting a text field sometimes shows all black" (owner report, 2026-10-07)', () => {
    /**
     * Zoomed into the lower part of a screen — where chat boxes, search bars
     * and the taskbar live — and the keyboard comes up. The key bar takes
     * the top of the stage and, where the WebView is resized for the IME (the
     * owner's phone: its reported stage went from 7137x10991 to 7137x4581 as
     * the keyboard rose), the IME takes the bottom: the surface shrinks to a
     * strip and the picture is laid out again, much smaller. The pan was
     * legal for the old box and points past the bottom of the new picture.
     * The re-clamp that bounds exactly that stood down for the caret camera —
     * which never drives on such a phone, because a band that IS the whole
     * surface is no keyboard band at all (caretBandFrom returns null). Nobody
     * clamped: a black stage until the next pinch. Reproduced in the real
     * Android WebView with Gboard before this test was written.
     */
    it('raising the keyboard over a zoomed picture leaves the picture on the stage', async () => {
        h.mobile = true;
        dims = { w: 2560, h: 1440 };
        await mount(0, false);
        // Zoom into the bottom of the picture.
        const p = pictureBox(dims.w, dims.h, BOX.w, BOX.h)!;
        await zoomAt({ x: BOX.w / 2, y: p.offY + p.dispH - 8 }, 8);
        await sleep(200);
        expect(pictureCover(), 'precondition: the zoomed picture fills the stage').toBeGreaterThan(0.99);
        expect(transform().scale, 'precondition: zoomed in').toBeGreaterThan(3);

        // The keyboard comes up (the toolbar's button), and the IME with it:
        // the WebView shrinks, so the surface does, and the IME does not
        // overlap what is left of it.
        const kbBtn = host!.querySelector('button[title="Keyboard"]') as HTMLButtonElement;
        await act(async () => { kbBtn.click(); });
        await sleep(50);
        BOX.h = 300;
        h.kb = { visible: true, top: KEYBAR_H + BOX.h, source: 'native' };
        await act(async () => { h.kbWatch?.(h.kb); });
        await act(async () => { video().dispatchEvent(new Event('resize')); });
        await sleep(600);

        expect(host!.querySelector('.device-stage-keyboard-overlay'), 'precondition: the keyboard bar is up').toBeTruthy();
        expect(pictureCover(), 'the stage must still show the picture, not black').toBeGreaterThan(0.99);
    });
});

describe('the trackpad pointer across a zoom-follow switch', () => {
    /**
     * The trackpad's pointer, the aim and the drawn cursor are FRACTIONS OF
     * THE CAPTURED SURFACE. Following a screen out of the composite changed
     * the surface and kept the fractions, so the pointer at the middle of the
     * composite (on the main display, 40% down it) became the middle of the
     * main display — and the next finger movement re-centred the camera there
     * and moved the remote pointer with it: a jump on every switch.
     */
    it('the first move after the switch continues from the same desktop point', async () => {
        h.mobile = true;
        await mount();
        // The trackpad starts the session at the middle of the picture:
        // desktop (1280, 576) on the composite — the main display, 40% down.
        const at = clientOnComposite(1280, 720);
        await zoomAt(at, 12);
        await sleep(200);
        expect(h.requestMonitor.mock.calls.map(c => c[1]), 'precondition: the main display was followed').toEqual([0]);
        await confirm(0);
        await frame(1280, 720);
        await sleep(400);
        h.sendInput.mockClear();

        // A small trackpad drag: a few pixels of finger.
        const s = surface();
        const ev = (type: string, x: number, y: number) => new PointerEvent(type, {
            bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', clientX: x, clientY: y,
        });
        await act(async () => { s.dispatchEvent(ev('pointerdown', 200, 400)); });
        for (let i = 1; i <= 6; i++) {
            await act(async () => { s.dispatchEvent(ev('pointermove', 200 + i * 3, 400)); });
            await sleep(20);
        }
        await act(async () => { s.dispatchEvent(ev('pointerup', 218, 400)); });
        await sleep(100);

        const moves = h.sendInput.mock.calls.map(c => c[1] as { t?: string; x?: number; y?: number }).filter(e => e?.t === 'move');
        expect(moves.length, 'precondition: the drag moved the pointer').toBeGreaterThan(0);
        const last = moves[moves.length - 1];
        // 576 desktop px down the main display is 0.40 of its 1440.
        expect(last.y!, `the pointer must stay on the row it was on (sent y=${last.y})`).toBeCloseTo(576 / 1440, 2);
    });
});
