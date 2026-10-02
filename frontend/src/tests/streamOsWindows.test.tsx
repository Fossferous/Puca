/**
 * Púca's OWN pop-out windows (desktop): one always-on-top, freely resizable
 * OS window per popped stream, opened with window.open and turned into a
 * Tauri window by the shell (src-tauri/src/popout.rs).
 *
 * What is pinned here:
 *  - the URL/name contract with the shell's filter (`about:blank#puca-pop-<n>`);
 *  - slot assignment: stable per stream, lowest free, never handing a slot
 *    freed in the SAME change to a new stream (the shell is still destroying
 *    that window, and a second window with its label is refused);
 *  - the mode: desktop shell with the probe answered → 'windows', multi;
 *    never on a phone, never without the shell's answer;
 *  - the window component: one window.open per stream, a MUTED video bound to
 *    the stream's MediaStream (audio stays on StreamAudioHost), the title is
 *    the streamer's name, the user closing it brings the stream back, the app
 *    closing it goes through the shell (`popout_close`, NOT window.close —
 *    wry leaves the frame standing on a script close), a refusal is reported,
 *    the pin reads and writes the shell.
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const h = vi.hoisted(() => ({
    tauri: true,
    mobile: false,
    calls: [] as { cmd: string; args?: Record<string, unknown> }[],
    supported: true as boolean | 'reject',
    pinned: new Map<number, boolean>(),
    stream: { id: 'ms-7' } as unknown as MediaStream,
}));

vi.mock('../api/platform', async importOriginal => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isTauri: () => h.tauri,
    isMobile: () => h.mobile,
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
        h.calls.push({ cmd, args });
        if (cmd === 'popout_supported') {
            if (h.supported === 'reject') throw new Error('unknown command popout_supported');
            return h.supported;
        }
        if (cmd === 'popout_pin') {
            const slot = args?.slot as number;
            if (typeof args?.pinned === 'boolean') h.pinned.set(slot, args.pinned);
            return h.pinned.get(slot) ?? true;
        }
        if (cmd === 'popout_close' || cmd === 'log_stream_diag') return null;
        throw new Error(`no shell command ${cmd}`);
    },
}));
vi.mock('../components/voiceState', () => ({
    getStreamData: (id: number) => ({ username: `user-${id}`, stream: id === 7 ? h.stream : null }),
    subscribeToStreamState: () => () => {},
}));
vi.mock('../components/deviceStageResume', () => ({
    installBackgroundResumeAll: () => () => {},
}));

const {
    MAX_POPOUT_WINDOWS, popoutWindowUrl, popoutWindowName, assignSlots,
    osWindowsSupported, primeOsWindowSupport, noteOsWindowRefused, noteOsWindowOpened,
    __resetOsWindowsForTests,
} = await import('../components/streamOsWindows');
const { popoutMode, togglePopped, inAppPipPlan } = await import('../components/streamDocPip');
const { StreamPopoutWindows } = await import('../components/StreamPopoutWindows');

const calls = (cmd: string) => h.calls.filter(c => c.cmd === cmd);
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
    h.tauri = true;
    h.mobile = false;
    h.supported = true;
    h.calls = [];
    h.pinned = new Map();
    __resetOsWindowsForTests();
});

describe('the URL contract with the shell filter (popout.rs requested_slot)', () => {
    it('opens about:blank with the slot in the fragment, named after the slot', () => {
        expect(popoutWindowUrl(1)).toBe('about:blank#puca-pop-1');
        expect(popoutWindowUrl(8)).toBe('about:blank#puca-pop-8');
        expect(popoutWindowName(3)).toBe('puca-pop-3');
        // Must match popout.rs MAX_POPOUTS, or the last slots are refused.
        expect(MAX_POPOUT_WINDOWS).toBe(8);
    });
});

describe('assignSlots', () => {
    it('lowest free slot, stable for streams already out', () => {
        let m = assignSlots(new Map(), [7]);
        expect([...m]).toEqual([[7, 1]]);
        m = assignSlots(m, [7, 9]);
        expect([...m]).toEqual([[7, 1], [9, 2]]);
        // 7 goes back in: 9 KEEPS slot 2 (its window and remembered place).
        m = assignSlots(m, [9]);
        expect([...m]).toEqual([[9, 2]]);
        // A LATER pop reuses the free slot 1.
        m = assignSlots(m, [9, 11]);
        expect(m.get(11)).toBe(1);
    });
    it('never hands a slot freed in the SAME change to a new stream', () => {
        const prev = new Map([[7, 1], [9, 2]]);
        // 7 out, 11 in, in one change: slot 1 is still being destroyed.
        const m = assignSlots(prev, [9, 11]);
        expect(m.get(9)).toBe(2);
        expect(m.get(11)).toBe(3);
    });
    it('caps at MAX_POPOUT_WINDOWS: a stream past the cap gets no slot', () => {
        const ids = Array.from({ length: MAX_POPOUT_WINDOWS + 2 }, (_, i) => 100 + i);
        const m = assignSlots(new Map(), ids);
        expect(m.size).toBe(MAX_POPOUT_WINDOWS);
        expect(new Set(m.values()).size).toBe(MAX_POPOUT_WINDOWS);
    });
});

describe('popoutMode on the desktop shell', () => {
    it("is 'windows' once the shell answers the probe, and pops are multi", async () => {
        expect(osWindowsSupported()).toBe(false); // unknown until asked
        expect(await primeOsWindowSupport()).toBe(true);
        expect(osWindowsSupported()).toBe(true);
        expect(popoutMode()).toBe('windows');
        expect(togglePopped([7], 9, true)).toEqual([7, 9]);
        // The in-app float never shows a stream that is in a pop-out window.
        expect(inAppPipPlan([7, 9], [7], 'windows')).toEqual({ show: 9, hidden: false });
        expect(inAppPipPlan([7], [7], 'windows')).toEqual({ show: null, hidden: true });
    });
    it('an OLD shell (no popout_supported command) keeps the browser engines', async () => {
        h.supported = 'reject';
        expect(await primeOsWindowSupport()).toBe(false);
        expect(popoutMode()).not.toBe('windows');
    });
    it('never on a phone or in a browser tab — no shell is asked', async () => {
        h.mobile = true;
        expect(await primeOsWindowSupport()).toBe(false);
        expect(popoutMode()).not.toBe('windows');
        h.mobile = false;
        h.tauri = false;
        __resetOsWindowsForTests();
        expect(await primeOsWindowSupport()).toBe(false);
        expect(popoutMode()).not.toBe('windows');
        expect(calls('popout_supported')).toHaveLength(0);
    });
    it('a refusal before any window ever opened latches the mode off; after one opened it is transient', async () => {
        await primeOsWindowSupport();
        expect(noteOsWindowRefused()).toBe('latched');
        expect(popoutMode()).not.toBe('windows');
        __resetOsWindowsForTests();
        await primeOsWindowSupport();
        noteOsWindowOpened();
        expect(noteOsWindowRefused()).toBe('transient');
        expect(popoutMode()).toBe('windows');
    });
});

describe('StreamPopoutWindows', () => {
    let container: HTMLDivElement;
    let root: Root;
    let opened: { url: string; name: string; win: FakeWin }[];
    let refuse: boolean;

    interface FakeWin {
        document: Document;
        closed: boolean;
        close: ReturnType<typeof vi.fn>;
        addEventListener: (n: string, cb: () => void) => void;
        removeEventListener: (n: string, cb: () => void) => void;
        fire: (n: string) => void;
    }
    function fakeWin(): FakeWin {
        const doc = document.implementation.createHTMLDocument('');
        const listeners = new Map<string, Set<() => void>>();
        return {
            document: doc,
            closed: false,
            close: vi.fn(),
            addEventListener: (n, cb) => { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n)!.add(cb); },
            removeEventListener: (n, cb) => { listeners.get(n)?.delete(cb); },
            fire: n => { for (const cb of listeners.get(n) ?? []) cb(); },
        };
    }

    beforeEach(async () => {
        await primeOsWindowSupport();
        opened = [];
        refuse = false;
        vi.spyOn(window, 'open').mockImplementation(((url: string, name: string) => {
            if (refuse) return null;
            const win = fakeWin();
            opened.push({ url, name, win });
            return win as unknown as Window;
        }) as typeof window.open);
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });
    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.restoreAllMocks();
    });

    const render = async (ui: React.ReactNode) => { await act(async () => { root.render(ui); await flush(); }); };

    it('one window per stream, named by slot; a MUTED video on the SAME MediaStream; titled by the streamer', async () => {
        await render(<StreamPopoutWindows userIds={[7, 9]} onCloseOne={() => {}} onRefused={() => {}} />);
        expect(opened.map(o => [o.url, o.name])).toEqual([
            ['about:blank#puca-pop-1', 'puca-pop-1'],
            ['about:blank#puca-pop-2', 'puca-pop-2'],
        ]);
        const doc7 = opened[0].win.document;
        const v = doc7.querySelector('video') as HTMLVideoElement;
        expect(v).not.toBeNull();
        expect(v.muted).toBe(true);
        expect(v.srcObject).toBe(h.stream);
        expect(doc7.title).toBe('user-7');
        expect(opened[1].win.document.title).toBe('user-9');
        // No audible element anywhere in the pop-out documents.
        for (const o of opened) {
            for (const m of Array.from(o.win.document.querySelectorAll('video, audio'))) {
                expect((m as HTMLMediaElement).muted).toBe(true);
            }
        }
    });

    it('the USER closing a window (pagehide) brings that stream back', async () => {
        const onCloseOne = vi.fn();
        await render(<StreamPopoutWindows userIds={[7, 9]} onCloseOne={onCloseOne} onRefused={() => {}} />);
        act(() => opened[1].win.fire('pagehide'));
        expect(onCloseOne).toHaveBeenCalledWith(9);
        expect(onCloseOne).not.toHaveBeenCalledWith(7);
    });

    it("the 'Back to Púca' button brings the stream back", async () => {
        const onCloseOne = vi.fn();
        await render(<StreamPopoutWindows userIds={[7]} onCloseOne={onCloseOne} onRefused={() => {}} />);
        const back = opened[0].win.document.querySelector('[data-testid="os-pop-back"]') as HTMLButtonElement;
        await act(async () => { back.click(); });
        expect(onCloseOne).toHaveBeenCalledWith(7);
    });

    it('the APP closing a window goes through the shell (popout_close), not window.close', async () => {
        await render(<StreamPopoutWindows userIds={[7, 9]} onCloseOne={() => {}} onRefused={() => {}} />);
        await render(<StreamPopoutWindows userIds={[9]} onCloseOne={() => {}} onRefused={() => {}} />);
        await act(async () => { await flush(); });
        expect(calls('popout_close').map(c => c.args)).toEqual([{ slot: 1 }]);
        expect(opened[0].win.close).not.toHaveBeenCalled();
        // 9 kept its window — no reopen.
        expect(opened).toHaveLength(2);
    });

    it('StrictMode: ONE window.open per stream and no close', async () => {
        await render(
            <StrictMode>
                <StreamPopoutWindows userIds={[7]} onCloseOne={() => {}} onRefused={() => {}} />
            </StrictMode>,
        );
        await act(async () => { await flush(); });
        expect(opened).toHaveLength(1);
        expect(calls('popout_close')).toHaveLength(0);
        expect(opened[0].win.document.querySelectorAll('video')).toHaveLength(1);
    });

    it('a refused window.open is reported, not left as a toggle pointing at nothing', async () => {
        refuse = true;
        const onRefused = vi.fn();
        await render(<StreamPopoutWindows userIds={[7]} onCloseOne={() => {}} onRefused={onRefused} />);
        expect(onRefused).toHaveBeenCalledWith(7);
    });

    it('the pin reads the shell for its slot and toggles always-on-top there', async () => {
        h.pinned.set(1, true);
        await render(<StreamPopoutWindows userIds={[7]} onCloseOne={() => {}} onRefused={() => {}} />);
        const pin = opened[0].win.document.querySelector('[data-testid="os-pop-pin"]') as HTMLButtonElement;
        expect(pin.getAttribute('aria-pressed')).toBe('true');
        await act(async () => { pin.click(); await flush(); });
        expect(calls('popout_pin').at(-1)?.args).toEqual({ slot: 1, pinned: false });
        expect(pin.getAttribute('aria-pressed')).toBe('false');
    });

    it('unmounting (leaving the call, the stream ending) closes every window through the shell', async () => {
        await render(<StreamPopoutWindows userIds={[7, 9]} onCloseOne={() => {}} onRefused={() => {}} />);
        act(() => root.unmount());
        // Each close goes through a dynamic import of the shell API; give
        // both a bounded number of turns to land.
        for (let i = 0; i < 50 && calls('popout_close').length < 2; i++) {
            await act(async () => { await new Promise(r => setTimeout(r, 5)); });
        }
        expect(calls('popout_close').map(c => c.args).sort((a, b) => (a!.slot as number) - (b!.slot as number)))
            .toEqual([{ slot: 1 }, { slot: 2 }]);
        root = createRoot(container); // for afterEach
    });
});
