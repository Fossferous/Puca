/**
 * THE DESKTOP BAR AND KEYS, through the real stage.
 *
 * The owner, 2026-10-23: "Android to desktop control is much better with so
 * many more options." The phone had Ctrl+Alt+Del, Alt+Tab, Alt+F4, Lock, Shut
 * down, privacy mode, Copy diagnostics and typed text; the desktop had none of
 * them, and Esc — the key that closes a dialog or a game's menu over there —
 * paused control instead of being sent. Pinned here: every action reaches the
 * session layer as the phone's does, Esc goes over, the stage's own chords
 * (Ctrl+Alt+Home/End/Enter) never do, a held key is let go when control
 * pauses, an open menu keeps the keyboard, and a view-only share is offered
 * nothing that injects.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    sendInput: vi.fn(() => true),
    sendPowerAction: vi.fn(() => true),
    setPrivacyMode: vi.fn(),
    requestMonitor: vi.fn(),
    sendStreamQuality: vi.fn(),
    endSession: vi.fn(),
    setCursorOwned: vi.fn(),
    sendLatencyProbe: vi.fn(() => false),
    probeUsable: false,
    storage: new Map<string, string>(),
    /** What deviceStatsSample answers: null (no stats) unless a test sets it.
     *  `lossPct` makes each reading lose that share of its packets. */
    statsPath: null as null | { path: 'direct' | 'relay'; lan: boolean; protocol: string; rttMs: number; lossPct?: number },
    statsReadings: 0,
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
    sendInput: (...a: unknown[]) => (h.sendInput as unknown as (...x: unknown[]) => boolean)(...a),
    requestMonitor: (...a: unknown[]) => h.requestMonitor(...a),
    requestKeyframe: () => true,
    setCursorOwned: (...a: unknown[]) => h.setCursorOwned(...a),
    endSession: (...a: unknown[]) => h.endSession(...a),
    sendClipboard: async () => null,
    sendStreamQuality: (...a: unknown[]) => h.sendStreamQuality(...a),
    setPrivacyMode: (...a: unknown[]) => h.setPrivacyMode(...a),
    sendPowerAction: (...a: unknown[]) => (h.sendPowerAction as unknown as (...x: unknown[]) => boolean)(...a),
    deviceDiagnosticsWindow: async () => [],
    deviceStatsSample: async () => {
        if (!h.statsPath) return null;
        // Cumulative counters, as the browser's are: each reading adds 1000
        // packets, `lossPct` of them lost.
        const n = ++h.statsReadings * 1000;
        const { lossPct = 0, ...path } = h.statsPath;
        return {
            at: Date.now(), framesDecoded: Math.floor(performance.now() / 16), bytesReceived: 0, freezeCount: 0,
            totalDecodeTime: 0, jitterBufferDelay: 0, jitterBufferEmittedCount: 0,
            packetsLost: Math.round((n * lossPct) / 100), packetsReceived: Math.round((n * (100 - lossPct)) / 100),
            frameWidth: 1920, frameHeight: 1080, decoder: null, hardwareDecode: null, inputLane: 'channel',
            ...path,
        };
    },
    activeSessions: () => [],
    requestFileAccess: () => { /* noop */ },
    latencyProbeUsable: () => h.probeUsable,
    sendLatencyProbe: () => h.sendLatencyProbe(),
    noteFramePresented: () => { /* noop */ },
    subscribeLatency: () => () => { /* unsubscribe */ },
}));
vi.mock('../api/devices/tunnel', () => ({
    tunnelStatus: async () => ({ listeners: [], inbound_streams: 0, outbound_streams: 0, forwards: [] }),
}));
vi.mock('../api/platform', async (importOriginal) => {
    const real = await importOriginal<typeof import('../api/platform')>();
    return { ...real, isMobile: () => false, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

const { DeviceStage } = await import('../components/DeviceStage');
const { useStreamStore } = await import('../stores/streamStore');

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
        matches: false, media: '', onchange: null,
        addEventListener() { /* noop */ }, removeEventListener() { /* noop */ },
        addListener() { /* noop */ }, removeListener() { /* noop */ }, dispatchEvent() { return false; },
    })) as unknown as typeof window.matchMedia;
    h.storage.clear();
    vi.mocked(localStorage.getItem).mockImplementation((k: string) => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k: string, v: string) => { h.storage.set(k, v); });
    h.listeners.clear();
    h.snapshot = [];
    h.statsPath = null;
    h.statsReadings = 0;
    useStreamStore.getState().clearAllStreams();
    for (const f of [h.sendInput, h.sendPowerAction, h.setPrivacyMode, h.requestMonitor, h.sendStreamQuality, h.endSession, h.setCursorOwned, h.sendLatencyProbe]) f.mockClear();
    h.probeUsable = false;
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
        monitors: [
            { id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 },
            { id: 1, label: 'Display 2', left: 1920, top: 0, width: 1920, height: 1080 },
        ],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false, powerNotice: null, peerName: 'Work Laptop',
        ...over,
    };
}

const flush = () => act(async () => {
    for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
});

async function mount(over: Snapshot = {}) {
    h.snapshot = [session(over)];
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<DeviceStage />); });
    await flush();
}

const buttons = () => Array.from(host!.querySelectorAll('button'));
const byText = (t: string | RegExp) => buttons().find(b =>
    typeof t === 'string' ? b.textContent?.trim() === t : t.test(b.textContent ?? ''));
const menuItem = (label: string) => Array.from(host!.querySelectorAll<HTMLButtonElement>('.dsb-item'))
    .find(b => b.querySelector('.dsb-item-label')?.textContent === label);

async function click(el: Element | undefined | null) {
    expect(el, 'the control must be there').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await flush();
}

async function openMenu(name: string) {
    await click(name === 'More' ? host!.querySelector('button[aria-label="More"]') : byText(new RegExp(`^\\s*${name}`)));
}

/** A key press as the window sees it. */
async function key(type: 'keydown' | 'keyup', code: string, mods: Partial<KeyboardEventInit> = {}) {
    const keyName = code === 'Escape' ? 'Escape' : code.replace(/^Key/, '').toLowerCase();
    await act(async () => {
        window.dispatchEvent(new KeyboardEvent(type, { code, key: keyName, bubbles: true, cancelable: true, ...mods }));
    });
    await flush();
}

const frames = () => h.sendInput.mock.calls.map(c => (c as unknown[])[1] as { t: string; code?: string; down?: boolean; text?: string });
const keyFrames = () => frames().filter(f => f.t === 'key').map(f => `${f.code}${f.down ? '↓' : '↑'}`);

describe('keys on the desktop stage', () => {
    it('Esc goes to the remote machine, and control stays on', async () => {
        await mount();
        await key('keydown', 'Escape');
        await key('keyup', 'Escape');
        expect(keyFrames()).toEqual(['Escape↓', 'Escape↑']);
        expect(host!.textContent, 'Esc no longer pauses').not.toContain('Control paused');
    });

    it('Ctrl+Alt+Home pauses — letting go of the held Ctrl and Alt on the host — and resumes', async () => {
        await mount();
        await key('keydown', 'ControlLeft', { ctrlKey: true });
        await key('keydown', 'AltLeft', { ctrlKey: true, altKey: true });
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(host!.textContent).toContain('Control paused');
        // The two modifiers went down to the host before the chord, and the
        // pause released them there — before, they stayed down until a blur.
        expect(keyFrames()).toEqual(['ControlLeft↓', 'AltLeft↓', 'ControlLeft↑', 'AltLeft↑']);
        expect(keyFrames(), 'Home itself never goes over').not.toContain('Home↓');
        // The physical releases find nothing held: nothing more goes out.
        await key('keyup', 'Home', { ctrlKey: true, altKey: true });
        await key('keyup', 'AltLeft', { ctrlKey: true });
        await key('keyup', 'ControlLeft');
        expect(keyFrames()).toHaveLength(4);
        // Paused: an ordinary key goes nowhere.
        await key('keydown', 'KeyA');
        expect(keyFrames()).toHaveLength(4);
        // The same chord resumes.
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(host!.textContent).not.toContain('Control paused');
    });

    it('Ctrl+Alt+End sends Ctrl+Alt+Del as the one {t:"sas"} frame', async () => {
        await mount();
        await key('keydown', 'End', { ctrlKey: true, altKey: true });
        expect(frames().filter(f => f.t === 'sas')).toHaveLength(1);
        expect(keyFrames(), 'End is not typed over there').toEqual([]);
    });

    it('while a bar menu is open no key goes over, and Esc closes the menu', async () => {
        await mount();
        await openMenu('Keyboard');
        expect(host!.querySelector('[role="menu"]')).toBeTruthy();
        await key('keydown', 'KeyA');
        await key('keydown', 'Escape');
        expect(keyFrames(), 'the menu has the keyboard').toEqual([]);
        expect(host!.querySelector('[role="menu"]'), 'Esc closed it').toBeNull();
        // POSITIVE CONTROL: with the menu closed, the same key goes over.
        await key('keydown', 'KeyB');
        expect(keyFrames()).toEqual(['KeyB↓']);
    });
});

describe("minimised to the chat (Back to Púca), the keyboard is the app's", () => {
    it('lets go of a held key on the way out, sends nothing while minimised (chords included), and drives again once back', async () => {
        await mount();
        await key('keydown', 'KeyW');
        expect(keyFrames(), 'held on the remote machine').toEqual(['KeyW↓']);
        await openMenu('More');
        await click(menuItem('Back to Púca (keep the session)'));
        expect(host!.querySelector('.device-stage-minimized'), 'the pill is up').toBeTruthy();
        expect(keyFrames(), 'the held key was let go over there').toEqual(['KeyW↓', 'KeyW↑']);
        h.sendInput.mockClear();
        // Typing in the chat with the focus off the composer: the window is
        // the target, as it is for any key nothing local claims.
        await key('keydown', 'KeyO');
        await key('keydown', 'KeyK');
        await key('keydown', 'Enter');
        await key('keydown', 'Delete');
        await key('keydown', 'KeyA', { ctrlKey: true });
        await key('keydown', 'End', { ctrlKey: true, altKey: true });
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(frames(), 'not a key, not a Ctrl+Alt+Del').toEqual([]);
        // Back: the stage drives again, and Ctrl+Alt+Home did not pause it.
        await click(host!.querySelector('.device-stage-minimized'));
        expect(host!.textContent).not.toContain('Control paused');
        await key('keydown', 'KeyB');
        expect(keyFrames()).toEqual(['KeyB↓']);
    });
});

describe('the menus reach the session layer as the phone\'s do', () => {
    it('Keyboard: Ctrl+Alt+Del is one sas frame; Alt+Tab and Alt+F4 are chords', async () => {
        await mount();
        await openMenu('Keyboard');
        await click(menuItem('Ctrl + Alt + Del'));
        expect(frames().map(f => f.t)).toEqual(['sas']);
        h.sendInput.mockClear();
        await openMenu('Keyboard');
        await click(menuItem('Alt + Tab'));
        expect(keyFrames()).toEqual(['AltLeft↓', 'Tab↓', 'Tab↑', 'AltLeft↑']);
        h.sendInput.mockClear();
        await openMenu('Keyboard');
        await click(menuItem('Alt + F4'));
        expect(keyFrames()).toEqual(['AltLeft↓', 'F4↓', 'F4↑', 'AltLeft↑']);
    });

    it('Type text types lines as text with Enter between them', async () => {
        await mount();
        await openMenu('Keyboard');
        await click(menuItem('Type text…'));
        const area = host!.querySelector<HTMLTextAreaElement>('.device-stage-typetext textarea');
        expect(area, 'the dialog is open').toBeTruthy();
        // A key typed into the box stays here.
        await act(async () => {
            area!.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'x', bubbles: true, cancelable: true }));
        });
        expect(keyFrames()).toEqual([]);
        await act(async () => {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
            setter.call(area, 'ab\ncd');
            area!.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await click(byText('Type it'));
        expect(frames()).toEqual([
            { t: 'text', text: 'ab' },
            { t: 'key', code: 'Enter', down: true },
            { t: 'key', code: 'Enter', down: false },
            { t: 'text', text: 'cd' },
        ]);
        expect(host!.querySelector('.device-stage-typetext'), 'and closes').toBeNull();
    });

    it("while Type text is open the keyboard is the dialog's: its buttons, Esc, and keys after its padding took a click", async () => {
        await mount();
        await openMenu('Keyboard');
        await click(menuItem('Type text…'));
        const dialog = host!.querySelector<HTMLElement>('.device-stage-typetext');
        expect(dialog, 'the dialog is open').toBeTruthy();
        const cancel = byText('Cancel')!;
        // Tab onto Cancel, then Enter and Space on it.
        await act(async () => {
            cancel.focus();
            cancel.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true, cancelable: true }));
            cancel.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true }));
        });
        // The focus dropped to the page (a click on the padding, before the
        // dialog took it), then a key: the window is its target.
        await act(async () => { cancel.blur(); });
        await key('keydown', 'KeyP');
        expect(keyFrames(), 'none of it went over').toEqual([]);
        // Esc from the button closes the dialog, and is not sent either.
        await act(async () => {
            cancel.focus();
            cancel.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
        });
        await flush();
        expect(host!.querySelector('.device-stage-typetext'), 'Esc closed it').toBeNull();
        expect(keyFrames()).toEqual([]);
        // POSITIVE CONTROL: with it closed, the same key goes over.
        await key('keydown', 'KeyP');
        expect(keyFrames()).toEqual(['KeyP↓']);
    });

    it('Screen: a monitor, privacy mode and display power', async () => {
        await mount();
        await openMenu('Screen');
        await click(menuItem('Display 2'));
        expect(h.requestMonitor).toHaveBeenCalledWith('ds-1', 1);
        await openMenu('Screen');
        await click(menuItem('All displays'));
        expect(h.requestMonitor).toHaveBeenLastCalledWith('ds-1', 255);
        await openMenu('Screen');
        await click(menuItem('Privacy mode (blank that computer\'s screen)'));
        expect(h.setPrivacyMode).toHaveBeenCalledWith('ds-1', true);
        await openMenu('Screen');
        await click(menuItem('Turn displays off'));
        expect(h.sendPowerAction).toHaveBeenCalledWith('ds-1', 'displays_off');
    });

    it('Quality: a preset goes to the host', async () => {
        await mount();
        await openMenu('Quality');
        await click(menuItem('Max (15Mbps, 60fps)'));
        expect(h.sendStreamQuality).toHaveBeenCalledWith('ds-1', 60, 15000);
    });

    it('More: Lock at once; Shut down only after the confirmation', async () => {
        await mount();
        await openMenu('More');
        await click(menuItem('Lock'));
        expect(h.sendPowerAction).toHaveBeenCalledWith('ds-1', 'lock');
        await openMenu('More');
        await click(menuItem('Shut down…'));
        expect(h.sendPowerAction, 'nothing sent before the confirmation').not.toHaveBeenCalledWith('ds-1', 'shutdown');
        expect(host!.textContent).toContain('Shut down the computer you are controlling?');
        await click(byText('Shut down'));
        expect(h.sendPowerAction).toHaveBeenCalledWith('ds-1', 'shutdown');
    });

    it('the paused banner has its own Resume', async () => {
        await mount();
        await click(byText(/Pause control/));
        expect(host!.textContent).toContain('Control paused');
        await click(host!.querySelector('.device-stage-paused button'));
        expect(host!.textContent).not.toContain('Control paused');
    });
});

describe('a view-only share', () => {
    it('is offered nothing that injects', async () => {
        await mount({ viewOnly: true });
        expect(byText(/^\s*Keyboard/), 'no Keyboard menu').toBeUndefined();
        expect(byText(/^\s*Mouse/), 'no Mouse menu').toBeUndefined();
        expect(byText(/Pause control/), 'nothing to pause').toBeUndefined();
        await openMenu('More');
        expect(menuItem('Lock')).toBeUndefined();
        expect(menuItem('Shut down…')).toBeUndefined();
        expect(menuItem('Copy diagnostics'), 'diagnostics are fine').toBeTruthy();
        await openMenu('Screen');
        expect(menuItem('Turn displays off')).toBeUndefined();
        expect(menuItem('Privacy mode (blank that computer\'s screen)')).toBeUndefined();
    });
});

describe('60 fps on your own network', () => {
    // The live stats need two readings a second apart before the path is known.
    const settleStats = () => act(async () => { await new Promise(r => setTimeout(r, 1300)); });

    it('a direct UDP picture with a short round trip steps up ONCE to 60 fps / 10 Mbps, and says so', async () => {
        h.statsPath = { path: 'direct', lan: true, protocol: 'udp', rttMs: 3 };
        await mount();
        await settleStats();
        await flush();
        expect(h.sendStreamQuality).toHaveBeenCalledTimes(1);
        expect(h.sendStreamQuality).toHaveBeenCalledWith('ds-1', 60, 10000);
        expect(host!.textContent).toContain('streaming at 60 fps');
        await settleStats();
        expect(h.sendStreamQuality, 'once per session').toHaveBeenCalledTimes(1);
    }, 15_000);

    it('a relayed picture stays where it is', async () => {
        h.statsPath = { path: 'relay', lan: false, protocol: 'udp', rttMs: 3 };
        await mount();
        await settleStats();
        expect(h.sendStreamQuality).not.toHaveBeenCalled();
    }, 15_000);

    it('a long round trip stays where it is', async () => {
        h.statsPath = { path: 'direct', lan: true, protocol: 'udp', rttMs: 40 };
        await mount();
        await settleStats();
        expect(h.sendStreamQuality).not.toHaveBeenCalled();
    }, 15_000);

    it('a path punched across the internet is "direct" but not your own network: it stays where it is', async () => {
        h.statsPath = { path: 'direct', lan: false, protocol: 'udp', rttMs: 3 };
        await mount();
        await settleStats();
        await settleStats();
        expect(h.sendStreamQuality).not.toHaveBeenCalled();
        expect(host!.textContent).not.toContain('On your own network');
    }, 15_000);

    /** The quality as the host would confirm it, so the stage sees its own step. */
    const confirming = () => h.sendStreamQuality.mockImplementation((...a: unknown[]) => {
        const [id, fps, bitrate] = a as [string, number, number];
        useStreamStore.getState().setStreamQuality(id, { fps, bitrate });
    });

    it('stepped up, a path that leaves your own network goes back to 30 fps once, and says so', async () => {
        confirming();
        h.statsPath = { path: 'direct', lan: true, protocol: 'udp', rttMs: 3 };
        await mount();
        await settleStats();
        await flush();
        expect(h.sendStreamQuality.mock.calls).toEqual([['ds-1', 60, 10000]]);
        h.statsPath = { path: 'relay', lan: false, protocol: 'udp', rttMs: 30 };
        await settleStats();
        await flush();
        expect(h.sendStreamQuality.mock.calls.at(-1)).toEqual(['ds-1', 30, 6000]);
        expect(host!.textContent).toContain('No longer on your own network: back to 30 fps');
        await settleStats();
        expect(h.sendStreamQuality, 'once').toHaveBeenCalledTimes(2);
    }, 20_000);

    it('stepped up, two readings in a row losing packets go back to 30 fps', async () => {
        confirming();
        h.statsPath = { path: 'direct', lan: true, protocol: 'udp', rttMs: 3 };
        await mount();
        await settleStats();
        await flush();
        expect(h.sendStreamQuality).toHaveBeenCalledTimes(1);
        h.statsPath = { ...h.statsPath, lossPct: 5 };
        await settleStats();
        await settleStats();
        await settleStats();
        await flush();
        expect(h.sendStreamQuality.mock.calls.at(-1)).toEqual(['ds-1', 30, 6000]);
        expect(host!.textContent).toContain('Packets are being lost: back to 30 fps');
    }, 20_000);

    it('a quality somebody picked after the step-up is theirs: nothing steps it down', async () => {
        confirming();
        h.statsPath = { path: 'direct', lan: true, protocol: 'udp', rttMs: 3 };
        await mount();
        await settleStats();
        await flush();
        act(() => { useStreamStore.getState().setStreamQuality('ds-1', { fps: 30, bitrate: 3000 }); });
        await flush();
        h.statsPath = { path: 'relay', lan: false, protocol: 'udp', rttMs: 30 };
        await settleStats();
        await settleStats();
        expect(h.sendStreamQuality).toHaveBeenCalledTimes(1);
    }, 20_000);
});

describe('the pointer drawn here, with no delay', () => {
    const surface = () => host!.querySelector<HTMLElement>('.device-stage-surface')!;
    const lastOwnership = () => h.setCursorOwned.mock.calls.at(-1);

    it('a desktop takes the pointer from the host by default', async () => {
        await mount();
        expect(lastOwnership()).toEqual(['ds-1', true]);
    });

    it("once the host hands it over, this pointer takes the host's shape", async () => {
        await mount({ cursorOwned: true, remoteCursor: 'text' });
        expect(surface().style.cursor).toBe('text');
        // Taken over there (a game in mouse-look; the agent says `none` for
        // nothing else): hidden here.
        h.snapshot = [session({ cursorOwned: true, remoteCursor: 'none' })];
        await act(async () => { for (const l of h.listeners) l(h.snapshot); });
        await flush();
        expect(surface().style.cursor).toBe('none');
    });

    it("POSITIVE CONTROL: a host that kept its pointer leaves this one alone (the stylesheet's crosshair)", async () => {
        await mount({ cursorOwned: false, remoteCursor: 'text' });
        expect(surface().style.cursor).toBe('');
    });

    it('the marker shows where the remote pointer was left only while the mouse is outside the picture', async () => {
        await mount({ cursorOwned: true, remoteCursor: 'default' });
        const marker = () => host!.querySelector('.device-stage-virtual-cursor');
        expect(marker(), 'the real pointer is the pointer').toBeNull();
        // React makes enter/leave out of over/out with a relatedTarget, as a
        // browser's mouse produces them crossing the surface's edge.
        await act(async () => { surface().dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body })); });
        await flush();
        expect(marker(), 'outside: where it was left').toBeTruthy();
        await act(async () => { surface().dispatchEvent(new MouseEvent('pointerover', { bubbles: true, relatedTarget: document.body })); });
        await flush();
        expect(marker(), 'back over the picture: the real pointer again').toBeNull();
    });

    it('turning it off in the Mouse menu hands the pointer back to the host, remembered', async () => {
        await mount();
        await openMenu('Mouse');
        await click(menuItem('Draw the pointer here (no delay)'));
        expect(lastOwnership()).toEqual(['ds-1', false]);
        expect(h.storage.get('device-stage-instant-pointer')).toBe('off');
    });

    it('pausing hands the pointer back to the host — watching, its own is the one to see — and resuming takes it again', async () => {
        await mount({ cursorOwned: true, remoteCursor: 'text' });
        expect(lastOwnership()).toEqual(['ds-1', true]);
        expect(surface().style.cursor).toBe('text');
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(host!.textContent).toContain('Control paused');
        expect(lastOwnership(), 'the host draws its own again').toEqual(['ds-1', false]);
        expect(surface().style.cursor, "and this one is the stylesheet's, not a shape frozen at the pause").toBe('');
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(lastOwnership()).toEqual(['ds-1', true]);
    });

    it('Game mode hands it back too: pointer lock hides this pointer', async () => {
        h.storage.set('sovereign-fps-mode', 'on');
        await mount();
        expect(h.setCursorOwned.mock.calls.some(c => c[1] === true), 'never taken in Game mode').toBe(false);
    });
});

describe('the measured delay', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('is measured while you control, and never while paused: a probe is not a hand', async () => {
        h.probeUsable = true;
        h.sendLatencyProbe.mockImplementation(() => true);
        // The probe's clock only; the rest of the stage keeps real timers.
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
        await mount();
        await act(async () => { vi.advanceTimersByTime(3_050); });
        expect(h.sendLatencyProbe.mock.calls.length, 'about one a second').toBeGreaterThanOrEqual(3);
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(host!.textContent).toContain('Control paused');
        h.sendLatencyProbe.mockClear();
        await act(async () => { vi.advanceTimersByTime(5_000); });
        expect(h.sendLatencyProbe, 'paused: none').not.toHaveBeenCalled();
        await key('keydown', 'Home', { ctrlKey: true, altKey: true });
        expect(h.sendLatencyProbe, 'resumed: measuring again at once').toHaveBeenCalledTimes(1);
    });
});
