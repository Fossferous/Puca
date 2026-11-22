/**
 * A PAUSE is the session's own, like put away (components/DeviceStage.tsx,
 * `pausedIds`). The review of 0.9.869: "Pause control" was one flag on the
 * stage, turned back on whenever a different session took the stage. So a
 * session the person had paused, then left behind a newer one (a second PC
 * connected), came back onto the stage with control ON when the newer one
 * ended, and when that newer one had been put away the paused session fell
 * back put away, behind the chat, armed, and on Android with its pinned keys
 * back on the notification ("Device session active"), from which a press
 * types on the PC with Púca in the background.
 *
 * The rig is deviceStageReturn.test.tsx's (a 390x844 coarse-pointer phone, a
 * played session layer), with the Android notification's plugin played as
 * deviceStagePinnedKeys.test.tsx plays it. Pausing is the stage's own chord,
 * Ctrl+Alt+Home (a Bluetooth keyboard on a phone); resuming, the paused
 * banner's Resume.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    storage: new Map<string, string>(),
    /** Every input the stage sent, by session. */
    sent: [] as Array<{ id: string; ev: unknown }>,
    /** Every list of buttons the notification was given, in order. */
    shadeSets: [] as Array<{ keys: Array<{ id: string; label: string }>; status: string | null }>,
    press: null as ((d: { id: string }) => void) | null,
}));

vi.mock('@capacitor/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@capacitor/core')>();
    const absent = () => new Proxy({}, {
        get: (_t, p) => (p === 'then' ? undefined : () => Promise.reject(new Error('not here'))),
    });
    return {
        ...real,
        Capacitor: {
            ...real.Capacitor,
            getPlatform: () => 'android',
            isNativePlatform: () => true,
            isPluginAvailable: (name: string) => name === 'SovereignShadeKeys',
        },
        registerPlugin: (name: string) => (name === 'SovereignShadeKeys'
            ? {
                set: async (o: { keys: Array<{ id: string; label: string }>; status: string | null }) => { h.shadeSets.push(o); },
                addListener: async (_e: string, cb: (d: { id: string }) => void) => {
                    h.press = cb;
                    return { remove: async () => { h.press = null; } };
                },
            }
            : absent()),
    };
});
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
    sendInput: (id: string, ev: unknown) => { h.sent.push({ id, ev }); return true; },
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
    return { ...real, showMobileKeyboard: async () => true, interceptBack: () => () => {} };
});

const { DeviceStage } = await import('../components/DeviceStage');
const { PINS_STORE_KEY } = await import('../api/devices/pinnedKeys');
const { __resetShadeKeysForTests } = await import('../api/devices/shadeKeys');

const F5 = { id: 'f5', code: 'F5', mods: [], shade: true };

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
    h.storage.set(PINS_STORE_KEY, JSON.stringify([F5]));
    (localStorage.getItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string) => h.storage.get(k) ?? null);
    (localStorage.setItem as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        (k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.sent = [];
    h.shadeSets = [];
    h.press = null;
    __resetShadeKeysForTests();
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
        shareUser: null, viewOnly: false, unattended: true, handoverFrom: null,
        ...over,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
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
const wayBack = () => host!.querySelector<HTMLElement>('.device-stage-minimized');
const stage = () => host!.querySelector('.device-stage');
const pausedBanner = () => host!.querySelector('.device-stage-paused');
/** What the notification offers now: the last list it was given. */
const shadeNow = () => (h.shadeSets.at(-1)?.keys ?? []).map(k => k.label);
/** Ctrl+Alt+Home, the stage's pause chord. */
async function togglePause() {
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', key: 'Home', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    });
    await flush();
}
/** A key typed with the stage on screen: what went to which PC. */
async function typeA() {
    const before = h.sent.length;
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
    });
    return h.sent.slice(before).filter(s => (s.ev as { t?: string }).t === 'key');
}
/** A press of the notification's F5, as the plugin delivers one. */
async function shadePress() {
    const before = h.sent.length;
    await act(async () => { h.press?.({ id: 'f5' }); });
    await flush();
    return h.sent.slice(before);
}

describe('a paused session stays paused when it comes back onto the stage', () => {
    it('THE FINDING: A paused, B connected and put away, B ends: A falls back put away, still paused, no keys in the notification', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        expect(shadeNow(), 'premise: A live, its key on the notification').toEqual(['F5']);
        await togglePause();
        expect(pausedBanner(), 'premise: A paused').toBeTruthy();
        expect(shadeNow(), 'premise: paused, no keys').toEqual([]);
        // A second PC: its session takes the stage, not paused.
        const b = session({ id: 'ds-b', peerName: 'Den laptop' });
        await publish([a, b]);
        expect(pausedBanner(), 'CONTROL: the new session is not paused').toBeNull();
        expect(shadeNow(), "CONTROL: B's key on the notification").toEqual(['F5']);
        await tap(toolbarButton('Chat'));
        // B goes offline: A falls back onto the stage, put away.
        await publish([a]);
        expect(stage(), "premise: A's stage stays away").toBeNull();
        expect(wayBack()?.textContent?.trim(), 'premise: the way back names A').toBe('Return to Office PC');
        expect(shadeNow(), 'A is still paused: no keys in the notification').toEqual([]);
        expect(await shadePress(), 'and a press from a notification a moment behind sends nothing').toEqual([]);
        // Back on the stage: still paused, and says so.
        await tap(wayBack()!);
        expect(stage(), 'its own press brings A back').toBeTruthy();
        expect(pausedBanner(), 'A comes back paused').toBeTruthy();
        expect(await typeA(), 'a key goes nowhere').toEqual([]);
        // Resume is the person's, and works.
        await tap(host!.querySelector<HTMLElement>('.device-stage-paused button')!);
        expect(pausedBanner()).toBeNull();
        expect(shadeNow()).toEqual(['F5']);
        expect((await typeA()).map(s => s.id)).toEqual(['ds-a', 'ds-a']);
    });

    it('…and on screen too: A paused, B connected and ended on screen, A comes back paused', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        await togglePause();
        await publish([a, session({ id: 'ds-b', peerName: 'Den laptop' })]);
        expect(pausedBanner(), 'premise: B is not paused').toBeNull();
        await publish([a]);
        expect(stage(), 'A on screen').toBeTruthy();
        expect(pausedBanner(), 'A still paused').toBeTruthy();
        expect(shadeNow()).toEqual([]);
        expect(await typeA()).toEqual([]);
    });

    it('a follow of a paused, put-away session (the PC locked or signed into) is paused too', async () => {
        await mountWith(session({ id: 'ds-a', peerName: 'Office PC' }));
        await togglePause();
        await tap(toolbarButton('Chat'));
        await publish([]);
        await publish([session({ id: 'ds-a2', peerName: 'Office PC (sign-in screen)', handoverFrom: 'ds-a' })]);
        expect(stage(), 'premise: the follow is put away').toBeNull();
        expect(shadeNow(), 'no keys in the notification for it').toEqual([]);
        await tap(wayBack()!);
        expect(pausedBanner(), 'it comes back paused').toBeTruthy();
        expect(await typeA()).toEqual([]);
    });

    it('CONTROL: a session that newly opens after a paused one ended is not paused', async () => {
        await mountWith(session({ id: 'ds-a', peerName: 'Office PC' }));
        await togglePause();
        expect(pausedBanner(), 'premise: paused').toBeTruthy();
        await publish([]);
        await publish([session({ id: 'ds-b', peerName: 'Den laptop' })]);
        expect(stage()).toBeTruthy();
        expect(pausedBanner(), 'the next connection is not paused').toBeNull();
        expect(shadeNow()).toEqual(['F5']);
        expect((await typeA()).map(s => s.id)).toEqual(['ds-b', 'ds-b']);
    });

    it('CONTROL: an unpaused session falling back put away keeps its keys in the notification (they work with Púca in the background)', async () => {
        const a = session({ id: 'ds-a', peerName: 'Office PC' });
        await mountWith(a);
        await publish([a, session({ id: 'ds-b', peerName: 'Den laptop' })]);
        await tap(toolbarButton('Chat'));
        await publish([a]);
        expect(stage(), 'premise: A put away').toBeNull();
        expect(shadeNow()).toEqual(['F5']);
        expect((await shadePress()).map(s => s.id), "the notification's press goes to A").toEqual(['ds-a', 'ds-a']);
    });
});
