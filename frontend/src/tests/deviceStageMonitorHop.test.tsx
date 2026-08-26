/**
 * MONITOR HOP — the affordance, end to end through the real stage.
 *
 * The first version of this feature inferred "take me to the next screen"
 * from pan travel the clamp refused, and it shipped: in the field it switched
 * screens constantly, because reading a line to its end IS panning into an
 * edge and the tail of one ordinary swipe clears any threshold a deliberate
 * push could. What is pinned here is the shape of the replacement — the edge
 * OFFERS, and nothing happens until it is tapped:
 *
 *   fitted view          → no offer (the picker is the honest way)
 *   zoomed, mid-picture  → no offer
 *   zoomed, at the edge  → an offer NAMING the screen it goes to
 *   the offer, tapped    → and only then, a switch
 *
 * The unit tests next door cover the geometry; this covers the wiring, which
 * is where the accidental trigger lived.
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
    return { ...real, isMobile: () => false, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

const { DeviceStage } = await import('../components/DeviceStage');

/** The laid-out picture: a 1920x1080 capture in an 800x600 element letterboxes
 *  to 800x450. Every rect in the tree reports this, so the transform the stage
 *  computes and the bounds `availableEdgeHops` checks agree — in jsdom they
 *  are otherwise all zero and the two would be reasoning about nothing. */
const BOX = { w: 800, h: 600 };

beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => BOX.w });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => BOX.h });
    HTMLElement.prototype.getBoundingClientRect = function () {
        return { x: 0, y: 0, left: 0, top: 0, right: BOX.w, bottom: BOX.h, width: BOX.w, height: BOX.h, toJSON: () => ({}) };
    };
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
    h.requestMonitor.mockClear();
    h.sendInput.mockClear();
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

/** Two screens side by side; the view is on the RIGHT one, so its neighbour
 *  lies to the left and nothing lies to the right. */
function session(activeMonitor = 1): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [
            { id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 },
            { id: 1, label: 'Side display', left: 1920, top: 0, width: 1920, height: 1080 },
        ],
        activeMonitor,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false, powerNotice: null,
    };
}

async function mount(activeMonitor = 1) {
    h.snapshot = [session(activeMonitor)];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const surface = () => host!.querySelector('.device-stage-surface') as HTMLElement;
const chips = () => [...host!.querySelectorAll('.device-stage-hop')] as HTMLElement[];

/** Ctrl+wheel is the stage's zoom, anchored on the pointer. Anchoring FAR off
 *  the named side drives the pan hard into that side's clamp — the same state
 *  a finger reaches by panning to the end of the screen, which is the state
 *  the offer is about. */
async function zoomToEdge(side: 'left' | 'right' | 'top' | 'bottom', notches = 20) {
    const far = 100_000;
    const clientX = side === 'left' ? -far : side === 'right' ? far : BOX.w / 2;
    const clientY = side === 'top' ? -far : side === 'bottom' ? far : BOX.h / 2;
    for (let i = 0; i < notches; i++) {
        await act(async () => {
            surface().dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX, clientY,
            }));
        });
    }
    // The offers are derived per render; let the debounced follow timer run
    // too, so nothing else is mid-flight when they are read.
    await act(async () => { await new Promise(r => setTimeout(r, 200)); });
}

describe('the monitor-hop offer', () => {
    it('a FITTED view offers nothing — there is no edge to have reached', async () => {
        await mount();
        expect(chips()).toHaveLength(0);
    });

    it('zoomed against the shared edge, the neighbour is offered BY NAME', async () => {
        await mount(1);
        await zoomToEdge('left');
        const labels = chips().map(c => c.getAttribute('aria-label'));
        expect(labels, 'the neighbour must be named, not just pointed at').toEqual(['Show Main display']);
        // ...and only that way. There is no third screen to the right.
        expect(labels.some(l => l === 'Show Side display')).toBe(false);
    });

    it('the offer does NOTHING until it is tapped — the whole point', async () => {
        await mount(1);
        await zoomToEdge('left');
        expect(chips().length, 'precondition: an offer is on screen').toBe(1);
        expect(
            h.requestMonitor,
            'reaching the edge is what reading does; it must not switch screens',
        ).not.toHaveBeenCalled();

        const chip = chips().find(c => c.getAttribute('aria-label') === 'Show Main display')!;
        // A real tap is a POINTER sequence, and this chip sits INSIDE the
        // input surface — whose own handlers turn a single contact into a
        // move+down on the far desktop. Driving real PointerEvents is what
        // makes the next assertion mean anything.
        await act(async () => {
            for (const type of ['pointerdown', 'pointerup'] as const) {
                const ev = new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1, clientX: 20, clientY: 300,
                });
                chip.dispatchEvent(ev);
            }
            chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(h.requestMonitor).toHaveBeenCalledTimes(1);
        expect(h.requestMonitor.mock.calls[0][1]).toBe(0);
        expect(
            h.sendInput.mock.calls.map(c => (c[1] as { t?: string })?.t),
            'tapping the chip must not also click the remote machine',
        ).toEqual([]);
    });

    it('POSITIVE CONTROL: the same pointer sequence on the PICTURE does click it', async () => {
        await mount(1);
        await zoomToEdge('left');
        await act(async () => {
            for (const type of ['pointerdown', 'pointerup'] as const) {
                surface().dispatchEvent(new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1, clientX: 400, clientY: 300,
                }));
            }
        });
        expect(
            h.sendInput.mock.calls.map(c => (c[1] as { t?: string })?.t),
            'if this is empty the chip test above proves nothing',
        ).toContain('down');
    });

    it('an edge with nothing beyond it offers nothing', async () => {
        // Same gesture on screen 0, whose LEFT has no neighbour.
        await mount(0);
        await zoomToEdge('left');
        expect(chips()).toHaveLength(0);
        // POSITIVE CONTROL: the OTHER side of the same screen does have one.
        await zoomToEdge('right');
        expect(chips().map(c => c.getAttribute('aria-label'))).toEqual(['Show Side display']);
    });

    /**
     * THE POINTER CROSSES WITH THE VIEW — the far-edge regression. The remap
     * lands the VIEW at the near edge, but every retained fraction (the aim,
     * the trackpad position, the drawn cursor) still means "the far edge of
     * the screen just hopped onto", and the next consumer dragged the whole
     * session there. The fix walks the pointer across the seam with ONE
     * absolute move, sent only after the host CONFIRMS the switch — a move
     * sent earlier would land on the old monitor.
     */
    it('confirming the hop seeds the pointer just inside the shared edge — and not before', async () => {
        await mount(1);
        await zoomToEdge('left');
        // Give the stage an aim: a press on the picture sends a move first
        // (send() records every absolute move as the aim).
        await act(async () => {
            for (const type of ['pointerdown', 'pointerup'] as const) {
                surface().dispatchEvent(new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1, clientX: 40, clientY: 300,
                }));
            }
        });
        const moves = h.sendInput.mock.calls
            .map(c => c[1] as { t?: string; x?: number; y?: number })
            .filter(e => e?.t === 'move');
        expect(moves.length, 'precondition: the press must have aimed').toBeGreaterThan(0);
        const aim = moves[moves.length - 1];
        h.sendInput.mockClear();

        const chip = chips().find(c => c.getAttribute('aria-label') === 'Show Main display')!;
        await act(async () => {
            for (const type of ['pointerdown', 'pointerup'] as const) {
                chip.dispatchEvent(new PointerEvent(type, {
                    bubbles: true, cancelable: true, pointerId: 1, clientX: 20, clientY: 300,
                }));
            }
            chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        });
        expect(h.sendInput.mock.calls, 'nothing may be sent before the host confirms').toEqual([]);

        // The host confirms: active monitor is now 0 (same capture dims, so
        // the 350 ms fallback path applies the remap — still confirmation-
        // gated inside applyPendingFollow).
        await act(async () => {
            h.snapshot = [session(0)];
            for (const l of h.listeners) l(h.snapshot);
        });
        await act(async () => { await new Promise(r => setTimeout(r, 400)); });

        const seeded = h.sendInput.mock.calls
            .map(c => c[1] as { t?: string; x?: number; y?: number })
            .filter(e => e?.t === 'move');
        expect(seeded, 'exactly one placement move').toHaveLength(1);
        // Hopping LEFT from the right-hand screen: the aim's desktop point is
        // on monitor 1, which lies past monitor 0's RIGHT edge — the shared
        // seam — so the carry clamps to x = 1, the near edge. y crosses
        // unchanged (equal-height screens).
        expect(seeded[0].x).toBe(1);
        expect(seeded[0].y).toBeCloseTo(aim.y!, 10);
    });
});
