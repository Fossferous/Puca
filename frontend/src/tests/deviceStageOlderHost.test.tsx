/**
 * "<PC> runs an older Púca", through the real stage, on the two paths the
 * desktop bar's suite does not reach:
 *
 *  - the PHONE (390x844, coarse pointer, trackpad): its trackpad takes the
 *    pointer too, and an agent from before 0.9.847 sends no shape to it
 *    either — so the same silence says the same thing there;
 *  - the desktop's LATENCY PROBE, which since the review of 2026-10-26 can
 *    only say a computer is NOT older (an answer: the probe came with the
 *    shape) and never that it is (silence is a timeout, not a refusal). The
 *    probe clock itself is useLatencyProbe.test.tsx's; here it is a stand-in,
 *    so each reading the stage can be handed is handed on purpose.
 *
 * Every line that must appear has the case that must NOT beside it: a shape
 * that arrived, touch mode (nothing was handed over), the shape's channel
 * still opening, a probe answered.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LatencyReading } from '../api/devices/useLatencyProbe';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    storage: new Map<string, string>(),
    phone: true,
    reading: null as LatencyReading | null,
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
    sendInput: () => true,
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
vi.mock('../api/devices/useLatencyProbe', () => ({
    useLatencyProbe: () => ({
        reading: h.reading,
        comparison: { running: false, oldMs: null, newMs: null },
        compare: () => { /* noop */ },
    }),
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

let box = { left: 0, top: 0, width: 390, height: 844 };
beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => box.width });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => box.height });
    HTMLElement.prototype.getBoundingClientRect = () => ({
        ...box, right: box.width, bottom: box.height, x: 0, y: 0, toJSON() { return this; },
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
    h.reading = null;
    h.phone = true;
    box = { left: 0, top: 0, width: 390, height: 844 };
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

function session(over: Snapshot = {}): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false, powerNotice: null, peerName: 'Study PC',
        remoteCursor: null, caretOpen: true,
        ...over,
    };
}

async function mount(over: Snapshot = {}) {
    h.snapshot = [session(over)];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await act(async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); });
}
const emitSession = (over: Snapshot) => act(async () => {
    h.snapshot = [session(over)];
    for (const l of h.listeners) l(h.snapshot);
});
const olderLine = () => host?.querySelector('.device-stage-older-host span')?.textContent ?? null;
const LINE = 'Study PC runs an older Púca: the pointer is drawn there and can lag. Update Púca on Study PC.';

function reading(over: Partial<LatencyReading>): LatencyReading {
    return { totalMs: null, hostMs: null, samples: 0, unavailable: false, answered: false, ...over };
}

describe('on the phone (trackpad)', () => {
    beforeEach(() => { h.storage.set('device-stage-mouse-mode', 'trackpad'); });

    it('the host took the pointer and sent no shape in 3 s while its picture arrived: the line', async () => {
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true });
        act(() => { vi.advanceTimersByTime(2_900); });
        expect(olderLine()).toBeNull();
        act(() => { vi.advanceTimersByTime(200); });
        expect(olderLine()).toBe(LINE);
    });

    it('CONTROL: a current agent says its shape, and there is no line', async () => {
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true, remoteCursor: 'default' });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(olderLine()).toBeNull();
    });

    it('CONTROL: touch mode hands nothing over, so its silence says nothing', async () => {
        h.storage.set('device-stage-mouse-mode', 'touch');
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        // Even an ack would not count: nothing on the phone holds the pointer.
        await emitSession({ cursorOwned: true });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(olderLine()).toBeNull();
    });

    it('the picture still awaited: no verdict yet', async () => {
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true, awaitingMedia: true });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(olderLine()).toBeNull();
    });

    // Review 2026-10-26: the shape rides the caret channel, which can open
    // after the picture; counted from the picture, a current agent whose
    // channel was still opening was called older.
    it('the shape\'s channel still opening: no verdict, and the 3 s start when it opens', async () => {
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true, caretOpen: false });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(olderLine(), 'nothing could have said a shape yet').toBeNull();
        await emitSession({ cursorOwned: true, caretOpen: true });
        act(() => { vi.advanceTimersByTime(2_900); });
        expect(olderLine()).toBeNull();
        act(() => { vi.advanceTimersByTime(200); });
        expect(olderLine(), 'CONTROL: open, and still silent: the line').toBe(LINE);
    });

    it('its close button (a stage button, 44 px under the coarse-pointer rule) puts it away', async () => {
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true });
        act(() => { vi.advanceTimersByTime(3_100); });
        const close = host!.querySelector<HTMLButtonElement>('.device-stage-older-host button');
        expect(close?.className).toContain('device-stage-btn');
        await act(async () => { close!.click(); });
        expect(olderLine()).toBeNull();
    });
});

describe('on the desktop, and the latency probe', () => {
    beforeEach(() => {
        h.phone = false;
        box = { left: 0, top: 0, width: 1280, height: 720 };
    });

    // Review 2026-10-26: a current agent's answer can be late or dropped (a
    // busy loop, a channel full of a file transfer), and an older one refuses
    // only in its own log. So no silence, of any kind, says "older" — not
    // even the kind the first version called a refusal.
    it('probes that went unanswered say nothing about the other computer\'s Púca', async () => {
        // Game mode: the pointer is never taken, so only the probe could speak.
        h.storage.set('sovereign-fps-mode', 'on');
        h.reading = { ...reading({ unavailable: true }), refused: true } as LatencyReading;
        await mount();
        expect(olderLine()).toBeNull();
    });

    it('a probe answered: the pointer silence is waited out, never called older', async () => {
        h.reading = reading({ totalMs: 41, samples: 5, answered: true });
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true, remoteCursor: null });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(olderLine()).toBeNull();
    });

    it('…and an answer after the wait gave up takes the verdict back', async () => {
        await mount();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await emitSession({ cursorOwned: true, remoteCursor: null });
        act(() => { vi.advanceTimersByTime(3_100); });
        expect(olderLine(), 'CONTROL: silent, nothing answered: the line').toBe(LINE);
        h.reading = reading({ totalMs: 38, samples: 1, answered: true });
        // (A new snapshot, so the stage renders and reads the new reading.)
        await emitSession({ cursorOwned: true, remoteCursor: null });
        expect(olderLine()).toBeNull();
    });

    it('a shape that DID arrive: no line (only a current agent sends one)', async () => {
        await mount({ cursorOwned: true, remoteCursor: 'text' });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        act(() => { vi.advanceTimersByTime(10_000); });
        expect(olderLine()).toBeNull();
    });
});
