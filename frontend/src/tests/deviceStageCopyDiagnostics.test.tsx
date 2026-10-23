/**
 * "COPY DIAGNOSTICS" ON THE STAGE NEVER HANGS, and says what stopped it.
 *
 * Every step was an unbounded await: the measurement's `getStats` calls and
 * the clipboard write. In 0.9.819 a clipboard permission prompt nobody could
 * see ("tauri.localhost wants to see clipboard") held exactly such a
 * `writeText` open for good, and the note's own six-second lifetime took the
 * "Measuring…" away meanwhile, so the button simply looked dead. Each step is
 * now bounded with the bound "Send diagnostics" uses (the leaf module's
 * `withTimeout`), the note stays up until the copy ends, and a step that gave
 * no answer is named.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
type Bound = <T>(step: Promise<T>, label: string) => Promise<T>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    sendInput: vi.fn(),
    storage: new Map<string, string>(),
    diagWindow: vi.fn(),
    writeText: vi.fn(),
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
    deviceDiagnosticsWindow: (...a: unknown[]) => h.diagWindow(...a),
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
    return { ...real, isMobile: () => false, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));
const { DeviceStage } = await import('../components/DeviceStage');
const { QUICK_TIMEOUT_MS } = await import('../api/withTimeout');

const BOX = { left: 0, top: 0, width: 1280, height: 720 };
beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
    HTMLElement.prototype.getBoundingClientRect = () => ({
        ...BOX, right: BOX.width, bottom: BOX.height, x: 0, y: 0, toJSON() { return this; },
    }) as DOMRect;
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
    h.sendInput.mockReset();
    h.diagWindow.mockReset();
    h.diagWindow.mockResolvedValue([{ id: 'ds-1', fps: 30 }]);
    h.writeText.mockReset();
    h.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t: string) => h.writeText(t) } });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
    vi.useRealTimers();
    if (root) await act(async () => root!.unmount());
    host?.remove();
    root = null;
    host = null;
});

function session(): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null,
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false, powerNotice: null,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

/** Up, with the More menu open, then the clock faked for what follows. */
async function mountWithMoreOpen() {
    h.snapshot = [session()];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
    await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click(); });
    await flush();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}
const copyItem = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('.dsb-item'))
    .find(b => b.querySelector('.dsb-item-label')?.textContent === 'Copy diagnostics');
async function pressCopy() {
    const item = copyItem();
    expect(item, 'More › Copy diagnostics').toBeTruthy();
    await act(async () => { item!.click(); });
}
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const text = () => host!.textContent ?? '';

describe('Copy diagnostics on the stage', () => {
    it('POSITIVE CONTROL: measures, copies the rows with the stage\'s own state, and says so', async () => {
        await mountWithMoreOpen();
        await pressCopy();
        await advance(10);
        expect(h.diagWindow).toHaveBeenCalledTimes(1);
        expect(h.diagWindow.mock.calls[0][0], 'the five-second window').toBe(5_000);
        expect(text()).toContain('Diagnostics copied — paste them into the chat');
        const copied = JSON.parse(String(h.writeText.mock.calls[0][0])) as Array<Record<string, unknown>>;
        expect(copied[0]).toMatchObject({ id: 'ds-1', fps: 30 });
        expect(copied[0]).toHaveProperty('caret');
        expect(copied[0]).toHaveProperty('stageInput');
    });

    it('a measurement that never answers ends in a note naming it — and "Measuring…" stays up meanwhile', async () => {
        h.diagWindow.mockImplementation(() => new Promise(() => { /* never */ }));
        await mountWithMoreOpen();
        await pressCopy();
        await advance(8_000);
        expect(text(), 'past the 6 s note lifetime, still saying what it is doing').toContain('Measuring for 5s');
        await advance(7_500);
        expect(text()).toContain('Could not copy diagnostics: the measurement gave no answer within');
        expect(h.writeText, 'nothing half-measured is copied').not.toHaveBeenCalled();
    });

    it('a clipboard that never answers (a permission prompt nobody can see) ends in a note naming it', async () => {
        h.writeText.mockImplementation(() => new Promise(() => { /* never */ }));
        await mountWithMoreOpen();
        await pressCopy();
        await advance(QUICK_TIMEOUT_MS + 50);
        expect(text()).toContain(
            `Could not copy diagnostics: the clipboard gave no answer within ${Math.round(QUICK_TIMEOUT_MS / 1000)} s. Is a permission prompt waiting?`,
        );
    });

    it('a clipboard that refuses says so', async () => {
        h.writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
        await mountWithMoreOpen();
        await pressCopy();
        await advance(10);
        expect(text()).toContain('Could not copy diagnostics: the clipboard refused it');
    });

    it('the stats reads inside the measurement are handed a bound that gives up', async () => {
        let gaveUp = '';
        h.diagWindow.mockImplementation(async (_ms: number, bound: Bound) => {
            await bound(new Promise(() => { /* a getStats that never answers */ }), 'the picture statistics')
                .catch((e: Error) => { gaveUp = e.message; });
            return [{ id: 'ds-1', stats: 'unavailable' }];
        });
        await mountWithMoreOpen();
        await pressCopy();
        await advance(QUICK_TIMEOUT_MS + 50);
        expect(gaveUp).toBe(`the picture statistics gave no answer within ${Math.round(QUICK_TIMEOUT_MS / 1000)} s`);
        expect(text(), 'and the rest of the reading still goes out').toContain('Diagnostics copied');
    });

    it('one at a time: a second press while the first is measuring starts nothing', async () => {
        h.diagWindow.mockImplementation(() => new Promise(() => { /* never */ }));
        await mountWithMoreOpen();
        await pressCopy();
        await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click(); });
        await pressCopy();
        expect(h.diagWindow).toHaveBeenCalledTimes(1);
    });
});
