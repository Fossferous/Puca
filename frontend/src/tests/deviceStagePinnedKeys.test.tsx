/**
 * Pinned keys on the stage (DeviceStagePinnedKeys.tsx) and in the Android
 * notification (shadeKeys.ts), through the REAL DeviceStage.
 *
 * The obligations, each pinned:
 *   - a pin presses like a physical key: modifiers then the key on pointer
 *     DOWN, released in reverse on UP; two thumbs sharing a modifier keep it
 *     down until the last lets go; nothing is stranded down on unmount, blur
 *     or pause;
 *   - Ctrl+Alt+Del is the Secure Attention frame, on a completed click only;
 *   - the editor pins, unpins and reorders, refuses a duplicate, and the list
 *     survives a reload;
 *   - the notification is offered the pins marked for it only while input can
 *     land (a live session, not paused), a press there sends that pin's tap
 *     and says so, and a stale or paused press sends nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

type Snapshot = Record<string, unknown>;
const h = vi.hoisted(() => ({
    listeners: new Set<(s: Snapshot[]) => void>(),
    snapshot: [] as Snapshot[],
    sendInput: vi.fn((..._a: unknown[]) => true),
    storage: new Map<string, string>(),
    platform: 'web',
    shadeSets: [] as Array<{ keys: Array<{ id: string; label: string }>; status: string | null }>,
    press: null as ((d: { id: string }) => void) | null,
}));

vi.mock('@capacitor/core', async (importOriginal) => {
    const real = await importOriginal<typeof import('@capacitor/core')>();
    // Every other plugin the stage reaches is absent, as on an old APK.
    const absent = () => new Proxy({}, {
        get: (_t, p) => (p === 'then' ? undefined : () => Promise.reject(new Error('not here'))),
    });
    return {
        ...real,
        Capacitor: {
            ...real.Capacitor,
            getPlatform: () => h.platform,
            isNativePlatform: () => h.platform !== 'web',
            isPluginAvailable: (name: string) => h.platform === 'android' && name === 'SovereignShadeKeys',
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
    return { ...real, isMobile: () => false, isTauri: () => false };
});
vi.mock('../api/keyboardInset', () => ({
    currentKeyboardInset: () => ({ visible: false, top: null, source: 'none' }),
    watchKeyboardInset: () => () => { /* unsubscribe */ },
}));

const { DeviceStage } = await import('../components/DeviceStage');
const { DeviceStagePinnedKeys, DeviceStagePinnedKeysEditor } = await import('../components/DeviceStagePinnedKeys');
const { PINS_STORE_KEY, SAS_CODE } = await import('../api/devices/pinnedKeys');
const { __resetShadeKeysForTests } = await import('../api/devices/shadeKeys');
type Pin = import('../api/devices/pinnedKeys').PinnedKey;

const F5: Pin = { id: 'f5', code: 'F5', mods: [], shade: true };
const COPY: Pin = { id: 'cc', code: 'KeyC', mods: ['ctrl'], shade: false };
const PASTE: Pin = { id: 'cv', code: 'KeyV', mods: ['ctrl'], shade: true };
const SAS: Pin = { id: 'sas', code: SAS_CODE, mods: [], shade: false };

beforeEach(() => {
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 1920 });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 1080 });
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
    vi.mocked(localStorage.getItem).mockImplementation(k => h.storage.get(k) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((k, v) => { h.storage.set(k, String(v)); });
    h.listeners.clear();
    h.snapshot = [];
    h.sendInput.mockClear();
    h.platform = 'web';
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

async function render(node: React.ReactNode) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(node); });
}

/** Dispatch with an explicit pointer id: two thumbs are two pointers. */
const fire = (target: Element, type: string, pointerId = 1) => act(() => {
    const ev = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'pointerId', { value: pointerId });
    target.dispatchEvent(ev);
});
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`)!;

describe('the cluster', () => {
    let keys: Array<[string, boolean]>;
    let sas: number;
    beforeEach(() => { keys = []; sas = 0; });
    const cluster = (pins: Pin[]) => render(
        <DeviceStagePinnedKeys pins={pins} onKey={(c, d) => keys.push([c, d])} onSas={() => { sas++; }} />,
    );

    it('presses like a physical key: modifiers then the key down, reverse on release', async () => {
        await cluster([COPY]);
        fire(byLabel('Ctrl + C'), 'pointerdown');
        expect(keys).toEqual([['ControlLeft', true], ['KeyC', true]]);
        expect(byLabel('Ctrl + C').className).toContain('vm-held');
        fire(byLabel('Ctrl + C'), 'pointerup');
        expect(keys).toEqual([['ControlLeft', true], ['KeyC', true], ['KeyC', false], ['ControlLeft', false]]);
        expect(byLabel('Ctrl + C').className).not.toContain('vm-held');
    });

    it('two thumbs sharing Ctrl keep it down until the LAST lets go', async () => {
        await cluster([COPY, PASTE]);
        fire(byLabel('Ctrl + C'), 'pointerdown', 1);
        fire(byLabel('Ctrl + V'), 'pointerdown', 2);
        expect(keys).toEqual([['ControlLeft', true], ['KeyC', true], ['KeyV', true]]); // Ctrl once
        fire(byLabel('Ctrl + C'), 'pointerup', 1);
        expect(keys.slice(3)).toEqual([['KeyC', false]]);                            // Ctrl still held
        fire(byLabel('Ctrl + V'), 'pointercancel', 2);
        expect(keys.slice(4)).toEqual([['KeyV', false], ['ControlLeft', false]]);
    });

    it('a second down from the same pointer presses nothing more; an up with nothing held releases nothing', async () => {
        await cluster([F5]);
        fire(byLabel('F5'), 'pointerup');
        expect(keys).toEqual([]);
        fire(byLabel('F5'), 'pointerdown');
        fire(byLabel('F5'), 'pointerdown');
        expect(keys).toEqual([['F5', true]]);
    });

    it('after a blur (the stage let go of everything) a second pin sharing Ctrl presses Ctrl again', async () => {
        await cluster([COPY, PASTE]);
        fire(byLabel('Ctrl + C'), 'pointerdown', 1);
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        keys.length = 0;
        fire(byLabel('Ctrl + V'), 'pointerdown', 2);
        expect(keys).toEqual([['ControlLeft', true], ['KeyV', true]]);
        expect(byLabel('Ctrl + C').className).not.toContain('vm-held');
    });

    it('unmounting mid-hold releases what it held', async () => {
        await cluster([COPY]);
        fire(byLabel('Ctrl + C'), 'pointerdown');
        await act(async () => root!.unmount());
        root = null;
        expect(keys).toEqual([['ControlLeft', true], ['KeyC', true], ['KeyC', false], ['ControlLeft', false]]);
    });

    it('Ctrl+Alt+Del sends nothing on a touch, only on a completed click', async () => {
        await cluster([SAS]);
        fire(byLabel('Ctrl + Alt + Del'), 'pointerdown');
        expect(sas).toBe(0);
        expect(keys).toEqual([]);
        await act(async () => { (byLabel('Ctrl + Alt + Del') as HTMLButtonElement).click(); });
        expect(sas).toBe(1);
    });

    it('draws nothing with nothing pinned; arrows draw as arrows, still named for a screen reader', async () => {
        await cluster([]);
        expect(document.querySelector('[data-testid="pinned-keys"]')).toBeNull();
        await act(async () => root!.render(<DeviceStagePinnedKeys pins={[{ id: 'up', code: 'ArrowUp', mods: [], shade: false }]} onKey={() => { /* */ }} onSas={() => { /* */ }} />));
        const b = byLabel('Up arrow');
        expect(b.querySelector('svg')).not.toBeNull();
        expect(b.getAttribute('tabindex')).toBe('-1');
    });
});

describe('the editor', () => {
    let lists: Pin[][];
    beforeEach(() => { lists = []; });
    const editor = (pins: Pin[]) => render(
        <DeviceStagePinnedKeysEditor
            pins={pins}
            onChange={next => lists.push(next)}
            show
            onShow={() => { /* */ }}
            peerName="Desk PC"
            onClose={() => { /* */ }}
        />,
    );
    const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
    const check = (label: string) => [...document.querySelectorAll('label')].find(l => l.textContent?.trim() === label)!.querySelector('input')!;

    it('pins the chosen key with the chosen modifiers', async () => {
        await editor([]);
        const select = document.querySelector('select[aria-label="Key"]') as HTMLSelectElement;
        await act(async () => {
            select.value = 'KeyT';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await act(async () => { check('Ctrl').click(); });
        await act(async () => { check('Alt').click(); });
        expect(document.querySelector('.dspk-preview')!.textContent).toBe('Ctrl + Alt + T');
        await act(async () => { button('Pin it').click(); });
        expect(lists).toHaveLength(1);
        expect(lists[0]).toEqual([expect.objectContaining({ code: 'KeyT', mods: ['ctrl', 'alt'], shade: false })]);
    });

    it('refuses a duplicate, reorders one place at a time, unpins', async () => {
        await editor([F5, COPY]);
        // The default choice is F5, already pinned.
        expect(button('Pin it').disabled).toBe(true);
        expect(document.body.textContent).toContain('That one is already pinned.');
        expect((byLabel('Move F5 up') as HTMLButtonElement).disabled).toBe(true);
        await act(async () => { (byLabel('Move F5 down') as HTMLButtonElement).click(); });
        expect(lists.at(-1)!.map(p => p.id)).toEqual(['cc', 'f5']);
        await act(async () => { (byLabel('Unpin Ctrl + C') as HTMLButtonElement).click(); });
        expect(lists.at(-1)!.map(p => p.id)).toEqual(['f5']);
    });

    it('Ctrl + Alt + Delete chosen as keys is pinned as Ctrl + Alt + Del, and says so', async () => {
        await editor([]);
        const select = document.querySelector('select[aria-label="Key"]') as HTMLSelectElement;
        await act(async () => { select.value = 'Delete'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => { check('Ctrl').click(); });
        await act(async () => { check('Alt').click(); });
        expect(document.querySelector('.dspk-preview')!.textContent).toBe('Ctrl + Alt + Del');
        expect(document.body.textContent).toContain('pinned as Ctrl + Alt + Del');
        await act(async () => { button('Pin it').click(); });
        expect(lists[0]).toEqual([expect.objectContaining({ code: SAS_CODE, mods: [] })]);
    });

    it('Win + L cannot be pinned, and the editor says to use Lock instead', async () => {
        await editor([]);
        const select = document.querySelector('select[aria-label="Key"]') as HTMLSelectElement;
        await act(async () => { select.value = 'KeyL'; select.dispatchEvent(new Event('change', { bubbles: true })); });
        await act(async () => { check('Win').click(); });
        expect(button('Pin it').disabled).toBe(true);
        expect(document.body.textContent).toContain('Use Lock in the More menu');
        await act(async () => { check('Win').click(); });        // CONTROL: plain L is fine
        expect(button('Pin it').disabled).toBe(false);
    });

    it('Escape closes it even when pinning left the focus on the page', async () => {
        let closed = 0;
        await render(
            <DeviceStagePinnedKeysEditor pins={[]} onChange={next => lists.push(next)} show onShow={() => { /* */ }}
                peerName={null} onClose={() => { closed++; }} />,
        );
        await act(async () => { button('Pin it').click(); });
        // The dialog takes the focus back from the button about to be disabled.
        expect(document.activeElement?.classList.contains('dspk-editor')).toBe(true);
        (document.activeElement as HTMLElement).blur();
        expect(document.activeElement).toBe(document.body);
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(closed).toBe(1);
    });

    it('on a browser, offers no notification checkboxes and says what cannot be pinned', async () => {
        await editor([F5]);
        expect(document.body.textContent).not.toContain('In the notification');
        expect(document.body.textContent).toContain('Media and volume keys cannot be pinned');
    });

    it('in the Android app, a fourth key cannot join the notification', async () => {
        h.platform = 'android';
        await editor([F5, PASTE, { ...COPY, shade: true }, { id: 'tb', code: 'Tab', mods: [], shade: false }]);
        const rows = [...document.querySelectorAll('.dspk-row')];
        const shadeBox = (i: number) => rows[i].querySelector('.dspk-shade input') as HTMLInputElement;
        expect(shadeBox(0).checked).toBe(true);
        expect(shadeBox(3).checked).toBe(false);
        expect(shadeBox(3).disabled).toBe(true);
        await act(async () => { shadeBox(0).click(); });
        expect(lists.at(-1)!.find(p => p.id === 'f5')!.shade).toBe(false);
    });
});

function session(over: Snapshot = {}): Snapshot {
    return {
        id: 'ds-1', role: 'controller', peerDevice: 'dev-host', phase: 'active',
        stream: new MediaStream(), captureSize: null, error: null, peerName: 'Desk PC',
        monitors: [{ id: 0, label: 'Main display', left: 0, top: 0, width: 1920, height: 1080 }],
        activeMonitor: 0,
        filesChannel: null, fileRoot: null, fileScopeKind: null, filesOnly: false,
        privacyActive: false, cursorOwned: false, reconnecting: false,
        awaitingMedia: false, mediaRestarting: false, secureDesktop: false,
        shareUser: null, viewOnly: false, unattended: false,
        ...over,
    };
}
const emit = (s: Snapshot[]) => act(async () => {
    h.snapshot = s;
    for (const l of h.listeners) l(s);
    await new Promise(r => setTimeout(r, 0));
});
async function mountStage(pins: Pin[]) {
    h.storage.set(PINS_STORE_KEY, JSON.stringify(pins));
    h.snapshot = [session()];
    await render(<DeviceStage />);
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const keyFrames = () => h.sendInput.mock.calls.filter(c => (c[1] as { t?: string })?.t === 'key').map(c => [c[0], c[1]]);
const pause = () => act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Home', key: 'Home', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 0));
});
const settle = () => act(async () => { for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0)); });

describe('through the real stage', () => {
    it('a pinned key from storage is on the stage and reaches the host as key-down then key-up', async () => {
        await mountStage([F5, COPY]);
        fire(byLabel('F5'), 'pointerdown');
        expect(keyFrames()).toEqual([['ds-1', { t: 'key', code: 'F5', down: true }]]);
        fire(byLabel('F5'), 'pointerup');
        expect(keyFrames()).toEqual([
            ['ds-1', { t: 'key', code: 'F5', down: true }],
            ['ds-1', { t: 'key', code: 'F5', down: false }],
        ]);
    });

    it('a key held when the window loses focus is released over there', async () => {
        await mountStage([COPY]);
        fire(byLabel('Ctrl + C'), 'pointerdown');
        await act(async () => { window.dispatchEvent(new Event('blur')); });
        const ups = keyFrames().filter(([, f]) => !(f as { down: boolean }).down).map(([, f]) => (f as { code: string }).code);
        expect(ups.sort()).toEqual(['ControlLeft', 'KeyC']);
    });

    it('pausing control lets go of a held pin and takes the cluster away', async () => {
        await mountStage([F5]);
        fire(byLabel('F5'), 'pointerdown');
        await pause();
        expect(keyFrames().at(-1)).toEqual(['ds-1', { t: 'key', code: 'F5', down: false }]);
        expect(document.querySelector('[data-testid="pinned-keys"]')).toBeNull();
    });

    it('the notification is offered the marked pins while input can land, and none when paused or ended', async () => {
        h.platform = 'android';
        await mountStage([F5, COPY, PASTE]);
        await settle();
        expect(h.shadeSets.at(-1)).toEqual({ keys: [{ id: 'f5', label: 'F5' }, { id: 'cv', label: 'Ctrl+V' }], status: null });
        await pause();
        await settle();
        expect(h.shadeSets.at(-1)).toEqual({ keys: [], status: null });
        await pause(); // resume
        await settle();
        expect(h.shadeSets.at(-1)!.keys).toHaveLength(2);
        await emit([]);                       // the session ended
        await settle();
        expect(h.shadeSets.at(-1)).toEqual({ keys: [], status: null });
    });

    it('a press in the notification sends that pin\'s tap and says so; a stale or paused one sends nothing', async () => {
        h.platform = 'android';
        await mountStage([F5, COPY, PASTE]);
        await settle();
        expect(h.press).not.toBeNull();
        h.sendInput.mockClear();
        await act(async () => { h.press!({ id: 'cv' }); });
        await settle();
        expect(keyFrames()).toEqual([
            ['ds-1', { t: 'key', code: 'ControlLeft', down: true }],
            ['ds-1', { t: 'key', code: 'KeyV', down: true }],
            ['ds-1', { t: 'key', code: 'KeyV', down: false }],
            ['ds-1', { t: 'key', code: 'ControlLeft', down: false }],
        ]);
        expect(h.shadeSets.at(-1)!.status).toBe('Last sent: Ctrl+V');

        h.sendInput.mockClear();
        await act(async () => { h.press!({ id: 'cc' }); });   // pinned, but not in the notification
        await act(async () => { h.press!({ id: 'gone' }); }); // unpinned a moment ago
        expect(h.sendInput).not.toHaveBeenCalled();

        await pause();
        await act(async () => { h.press!({ id: 'f5' }); });   // a notification a frame behind the pause
        expect(h.sendInput.mock.calls.filter(c => (c[1] as { t?: string }).t === 'key' && (c[1] as { code?: string }).code === 'F5')).toEqual([]);
    });

    it('a view-only share offers no keys anywhere', async () => {
        h.platform = 'android';
        h.storage.set(PINS_STORE_KEY, JSON.stringify([F5]));
        h.snapshot = [session({ viewOnly: true })];
        await render(<DeviceStage />);
        await settle();
        // Positive controls: the stage is up, and it did tell the notification.
        expect(document.querySelector('.device-stage-surface')).not.toBeNull();
        expect(h.shadeSets.length).toBeGreaterThan(0);
        expect(document.querySelector('[data-testid="pinned-keys"]')).toBeNull();
        expect(h.shadeSets.every(s => s.keys.length === 0)).toBe(true);
    });

    it('a session still connecting offers the notification no keys until it is active', async () => {
        h.platform = 'android';
        h.storage.set(PINS_STORE_KEY, JSON.stringify([F5]));
        h.snapshot = [session({ phase: 'connecting' })];
        await render(<DeviceStage />);
        await settle();
        expect(h.shadeSets.length).toBeGreaterThan(0);
        expect(h.shadeSets.every(s => s.keys.length === 0)).toBe(true);
        await emit([session({ phase: 'active' })]);
        await settle();
        expect(h.shadeSets.at(-1)!.keys).toEqual([{ id: 'f5', label: 'F5' }]);
    });

    it('two presses of the same key are both told to the notification (it may have said "not sent" in between)', async () => {
        h.platform = 'android';
        await mountStage([F5]);
        await settle();
        const before = h.shadeSets.length;
        await act(async () => { h.press!({ id: 'f5' }); });
        await settle();
        await act(async () => { h.press!({ id: 'f5' }); });
        await settle();
        const after = h.shadeSets.slice(before);
        expect(after.filter(s => s.status === 'Last sent: F5')).toHaveLength(2);
    });

    it('a physical key and a pin holding the same Ctrl do not lift each other\'s', async () => {
        await mountStage([{ id: 'ct', code: 'ControlLeft', mods: [], shade: false }]);
        const ctrlUps = () => keyFrames().filter(([, f]) => (f as { code: string; down: boolean }).code === 'ControlLeft' && !(f as { down: boolean }).down).length;
        // The pin holds Ctrl; a physical Ctrl goes down and up meanwhile.
        fire(byLabel('Ctrl'), 'pointerdown');
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true, bubbles: true, cancelable: true }));
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft', key: 'Control', bubbles: true, cancelable: true }));
        });
        expect(ctrlUps()).toBe(0);                 // the pin still holds it
        fire(byLabel('Ctrl'), 'pointerup');
        expect(ctrlUps()).toBe(1);                 // now it goes up
        // And the other way round: a physical Ctrl held across a pin's tap.
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', key: 'Control', ctrlKey: true, bubbles: true, cancelable: true }));
        });
        fire(byLabel('Ctrl'), 'pointerdown');
        fire(byLabel('Ctrl'), 'pointerup');
        expect(ctrlUps()).toBe(1);                 // the physical key still holds it
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ControlLeft', key: 'Control', bubbles: true, cancelable: true }));
        });
        expect(ctrlUps()).toBe(2);
    });

    it('with the editor open, a key typed after the focus fell to the page reaches nothing over there', async () => {
        await mountStage([F5]);
        const menuButton = [...document.querySelectorAll('button')].find(b => /Keyboard/.test(b.textContent ?? ''))!;
        await act(async () => { menuButton.click(); });
        const item = [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'Pinned keys…') as HTMLButtonElement;
        await act(async () => { item.click(); });
        expect(document.querySelector('.dspk-editor')).not.toBeNull();
        (document.activeElement as HTMLElement | null)?.blur();
        h.sendInput.mockClear();
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }));
        });
        expect(keyFrames()).toEqual([]);
        // CONTROL: closed, the same key goes over.
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
        });
        expect(document.querySelector('.dspk-editor')).toBeNull();
        await act(async () => {
            document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true }));
        });
        expect(keyFrames()).toEqual([['ds-1', { t: 'key', code: 'KeyA', down: true }]]);
    });

    it('a new session does not start with the editor open', async () => {
        await mountStage([F5]);
        const menuButton = [...document.querySelectorAll('button')].find(b => /Keyboard/.test(b.textContent ?? ''))!;
        await act(async () => { menuButton.click(); });
        await act(async () => { ([...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent === 'Pinned keys…') as HTMLButtonElement).click(); });
        expect(document.querySelector('.dspk-editor')).not.toBeNull();
        await emit([session({ id: 'ds-2' })]);
        expect(document.querySelector('.dspk-editor')).toBeNull();
    });
});
