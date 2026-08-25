/**
 * StreamPopout — the OS picture-in-picture host — and the controls that
 * toggle it.
 *
 * jsdom has no PiP surface at all (no requestPictureInPicture, no
 * pictureInPictureEnabled), which is exactly the "unsupported platform" the
 * feature must hide itself on. The suite installs the surface per file
 * (restored in afterEach — the prototype method does not exist in jsdom, so
 * leaving it would leak into other files) and drives the element lifecycle:
 * metadata → request, OS-close → onClose, deselect → onClose, unmount → exit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** The Android APP's native engine, as the plugin wrappers expose it. */
const nativeMock = vi.hoisted(() => ({
    known: false,
    enter: vi.fn(async (_w: number, _h: number) => true),
    exit: vi.fn(async () => {}),
    listener: null as null | ((d: { active: boolean }) => void),
    remove: vi.fn(),
}));
vi.mock('../api/mobileApp', () => ({
    nativePipSupported: async () => nativeMock.known,
    nativePipKnownSupported: () => nativeMock.known,
    enterNativePip: (w: number, h: number) => nativeMock.enter(w, h),
    exitNativePip: () => nativeMock.exit(),
    onNativePipChange: async (cb: (d: { active: boolean }) => void) => {
        nativeMock.listener = cb;
        return { remove: nativeMock.remove };
    },
}));

let selected: number[] = [];
const STREAMS = new Map<number, { username: string; stream: MediaStream | null }>();
let notify: (() => void) | null = null;

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { notify = cb; return () => { notify = null; }; },
    subscribeToVoiceUsers: () => () => {},
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? undefined,
    getAllStreamers: () => [],
    deselectStream: vi.fn(),
    selectStream: vi.fn(),
    clearAllStreams: vi.fn(),
    stopOwnScreenShare: vi.fn(),
    getCurrentStreamingUserId: () => null,
    notifyStreamStateChange: vi.fn(),
    globalSpeakingUsers: new Set<number>(),
    getAllVoiceUsers: () => [],
}));

vi.mock('../api/remoteControl', () => ({
    requestControl: vi.fn(),
    stopControlling: vi.fn(),
    sendControlEvent: vi.fn(),
    subscribeControl: () => () => {},
    getControlState: () => ({ controlling: null, hosting: null }),
    offerControl: vi.fn(),
    computeRmoveScale: () => 1,
    getControlHostCapture: () => null,
}));

import { StreamPopout } from '../components/StreamPopout';
import { pipSupported, pipEngine, PIP_METADATA_TIMEOUT_MS, PIP_NATIVE_CONFIRM_TIMEOUT_MS } from '../components/streamPopout.utils';
import { StreamPip } from '../components/StreamPip';

const reqPip = vi.fn<() => Promise<unknown>>();
const exitPip = vi.fn<() => Promise<void>>();
let pipEl: Element | null = null;
let pipEnabled = true;

/** Install a fake PiP surface on the jsdom document/prototype. */
function installPipSurface() {
    Object.defineProperty(HTMLVideoElement.prototype, 'requestPictureInPicture', {
        value: function (this: HTMLVideoElement) { return reqPip(); },
        configurable: true, writable: true,
    });
    Object.defineProperty(document, 'pictureInPictureEnabled', { get: () => pipEnabled, configurable: true });
    Object.defineProperty(document, 'pictureInPictureElement', { get: () => pipEl, configurable: true });
    Object.defineProperty(document, 'exitPictureInPicture', { value: () => exitPip(), configurable: true, writable: true });
}
function removePipSurface() {
    delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>).requestPictureInPicture;
    delete (document as unknown as Record<string, unknown>).pictureInPictureEnabled;
    delete (document as unknown as Record<string, unknown>).pictureInPictureElement;
    delete (document as unknown as Record<string, unknown>).exitPictureInPicture;
}

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;

const hostVideo = () => container.querySelector<HTMLVideoElement>('video.stream-popout-host')!;
const metadata = (v: HTMLVideoElement) => act(() => { v.dispatchEvent(new Event('loadedmetadata')); });

function mountPopout(userId = 1) {
    act(() => { root.render(<StreamPopout userId={userId} onClose={onClose} />); });
}

/** WebKit's flavour: no requestPictureInPicture, a presentation mode. */
const wkSet = vi.fn<(mode: string) => void>();
let wkMode = 'inline';
function installWebKitSurface() {
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSetPresentationMode', {
        value: function (mode: string) { wkSet(mode); wkMode = mode; }, configurable: true, writable: true,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitSupportsPresentationMode', {
        value: (mode: string) => mode === 'picture-in-picture', configurable: true, writable: true,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitPresentationMode', {
        get: () => wkMode, configurable: true,
    });
}
function removeWebKitSurface() {
    for (const k of ['webkitSetPresentationMode', 'webkitSupportsPresentationMode', 'webkitPresentationMode']) {
        delete (HTMLVideoElement.prototype as unknown as Record<string, unknown>)[k];
    }
}

beforeEach(() => {
    reqPip.mockReset().mockResolvedValue({});
    exitPip.mockReset().mockResolvedValue();
    nativeMock.known = false;
    nativeMock.enter.mockReset().mockResolvedValue(true);
    nativeMock.exit.mockReset().mockResolvedValue(undefined);
    nativeMock.remove.mockReset();
    nativeMock.listener = null;
    wkSet.mockReset();
    wkMode = 'inline';
    pipEl = null;
    pipEnabled = true;
    installPipSurface();
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: new MediaStream() });
    STREAMS.set(2, { username: 'bob', stream: new MediaStream() });
    selected = [1, 2];
    onClose = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    removePipSurface();
    removeWebKitSurface();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('pipSupported', () => {
    it('is true only with BOTH the flag and the method (jsdom itself has neither)', () => {
        expect(pipSupported()).toBe(true);
        pipEnabled = false;
        expect(pipSupported()).toBe(false);
        pipEnabled = true;
        removePipSurface();
        expect(pipSupported()).toBe(false);
    });

    it('picks one engine per runtime: standard, else WebKit, else the Android app, else nothing', () => {
        expect(pipEngine()).toBe('standard');
        // Standard wins even where the others also answer.
        installWebKitSurface(); nativeMock.known = true;
        expect(pipEngine()).toBe('standard');
        // No standard API (Safari / iOS): WebKit's presentation mode.
        removePipSurface();
        expect(pipEngine()).toBe('webkit');
        // Neither web API (the Android WebView): the native plugin, once it
        // has said yes — and NOT before it has (never a button wired to nothing).
        removeWebKitSurface();
        expect(pipEngine()).toBe('native');
        nativeMock.known = false;
        expect(pipEngine()).toBeNull();
        expect(pipSupported()).toBe(false);
    });
});

describe('the WebKit engine (Safari, iOS)', () => {
    beforeEach(() => { removePipSurface(); installWebKitSurface(); });

    it('enters presentation mode on metadata, and leaves with the element', () => {
        mountPopout();
        expect(wkSet).not.toHaveBeenCalled();
        metadata(hostVideo());
        expect(wkSet).toHaveBeenCalledWith('picture-in-picture');
        expect(onClose).not.toHaveBeenCalled();
        // The user closes the PiP window: WebKit flips the mode and fires ONE
        // event; that is our close.
        wkMode = 'inline';
        act(() => { hostVideo().dispatchEvent(new Event('webkitpresentationmodechanged')); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('the mode-change event for ENTERING is not mistaken for a close', () => {
        mountPopout();
        metadata(hostVideo());
        // wkMode is now 'picture-in-picture' (set by the fake); the entry event
        // arrives — still in PiP, so nothing closes.
        act(() => { hostVideo().dispatchEvent(new Event('webkitpresentationmodechanged')); });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('unmount takes the window down (back to inline) when it owns it', () => {
        mountPopout();
        metadata(hostVideo());
        wkSet.mockClear();
        act(() => root.unmount());
        expect(wkSet).toHaveBeenCalledWith('inline');
        // Re-create for afterEach's own unmount.
        root = createRoot(container);
    });
});

describe('the native engine (the Android app)', () => {
    beforeEach(() => { removePipSurface(); nativeMock.known = true; });
    const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

    it('is full-viewport ABOVE everything from the start — the OS window shows the page, so the page must be the video', () => {
        mountPopout();
        const v = hostVideo();
        expect(v.className).toContain('stream-popout-host--native');
        expect(v.style.position).toBe('fixed');
        expect(v.style.width).toBe('100%');
        expect(v.style.height).toBe('100%');
        expect(Number(v.style.zIndex)).toBeGreaterThan(10000);
        expect(v.muted).toBe(true);
    });

    it('asks the plugin for a window shaped like the video (16:9 until the stream says otherwise), once', async () => {
        mountPopout();
        expect(nativeMock.enter).not.toHaveBeenCalled();
        metadata(hostVideo());
        await settle();
        // jsdom reports videoWidth/Height 0 — the fallback shape.
        expect(nativeMock.enter).toHaveBeenCalledTimes(1);
        expect(nativeMock.enter).toHaveBeenCalledWith(16, 9);
        expect(reqPip).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it('the plugin refusing is the same close path as any other refusal', async () => {
        nativeMock.enter.mockResolvedValue(false);
        mountPopout();
        metadata(hostVideo());
        await settle();
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('every way out of the floating window (expand, swipe-away, refusal) is ONE plugin event, and it closes us', async () => {
        mountPopout();
        metadata(hostVideo());
        await settle();
        expect(nativeMock.listener, 'subscribed to pipModeChanged').toBeTruthy();
        act(() => { nativeMock.listener!({ active: true }); });
        expect(onClose).not.toHaveBeenCalled();
        act(() => { nativeMock.listener!({ active: false }); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('an unmount in the GAP between the plugin accepting and the OS confirming still takes the window down', async () => {
        // The plugin says ok:true when the request is made; the OS floats the
        // window hundreds of ms later. A second tap (or the sharer stopping)
        // in that gap used to leave a floating window with the app's only
        // WebView borrowed and nothing in JS that knew.
        mountPopout();
        metadata(hostVideo());
        await settle();
        expect(nativeMock.enter).toHaveBeenCalledTimes(1);
        // No {active:true} yet.
        act(() => root.unmount());
        expect(nativeMock.exit).toHaveBeenCalledTimes(1);
        root = createRoot(container);
    });

    it('a request the OS never answers is given up on (the host would otherwise cover the app for ever)', async () => {
        vi.useFakeTimers();
        mountPopout();
        metadata(hostVideo());
        // Flush the listener/enter promise chain under fake timers.
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(nativeMock.enter).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(PIP_NATIVE_CONFIRM_TIMEOUT_MS + 10); });
        expect(onClose).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('the watchdog stands down once the OS confirms', async () => {
        vi.useFakeTimers();
        mountPopout();
        metadata(hostVideo());
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        act(() => { nativeMock.listener!({ active: true }); });
        await act(async () => { await vi.advanceTimersByTimeAsync(PIP_NATIVE_CONFIRM_TIMEOUT_MS + 10); });
        expect(onClose).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('unmount while floating takes the window down; unmount before it ever floated does not call out', async () => {
        mountPopout();
        metadata(hostVideo());
        await settle();
        act(() => { nativeMock.listener!({ active: true }); });
        act(() => root.unmount());
        expect(nativeMock.exit).toHaveBeenCalledTimes(1);
        await settle(); // the listener handle resolves asynchronously
        expect(nativeMock.remove).toHaveBeenCalled();
        root = createRoot(container);

        nativeMock.exit.mockClear();
        mountPopout();
        await settle();
        act(() => root.unmount());
        expect(nativeMock.exit).not.toHaveBeenCalled();
        root = createRoot(container);
    });
});

describe('StreamPopout host', () => {
    it('waits for metadata before asking for PiP, then asks exactly once', () => {
        mountPopout();
        // Chromium rejects requestPictureInPicture on a metadata-less element
        // with InvalidStateError — asking at mount would silently never work.
        expect(reqPip).not.toHaveBeenCalled();
        metadata(hostVideo());
        expect(reqPip).toHaveBeenCalledTimes(1);
        metadata(hostVideo());
        expect(reqPip).toHaveBeenCalledTimes(1);
        expect(onClose).not.toHaveBeenCalled();
    });

    it('binds the popped stream to the hidden host and plays it', () => {
        mountPopout(2);
        expect(hostVideo().srcObject).toBe(STREAMS.get(2)!.stream);
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    });

    it('the host is MUTED — audio stays on the stage / in-app PiP paths', () => {
        // Unmuting this element is the one-line "fix" that would double every
        // stream's audio; pin it.
        mountPopout();
        expect(hostVideo().muted).toBe(true);
    });

    it('tears down when the OS window is closed', () => {
        mountPopout();
        metadata(hostVideo());
        act(() => { hostVideo().dispatchEvent(new Event('leavepictureinpicture')); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes when the stream stops being watched', () => {
        mountPopout();
        selected = [2];
        act(() => { notify?.(); });
        expect(onClose).toHaveBeenCalled();
    });

    it('closes when the stream itself is gone', () => {
        mountPopout();
        STREAMS.delete(1);
        act(() => { notify?.(); });
        expect(onClose).toHaveBeenCalled();
    });

    it('exits PiP on unmount when it owns the window', () => {
        mountPopout();
        pipEl = hostVideo();
        act(() => root.unmount());
        expect(exitPip).toHaveBeenCalledTimes(1);
    });

    it('does not exit someone else\'s PiP on unmount', () => {
        mountPopout();
        pipEl = document.createElement('video');
        act(() => root.unmount());
        expect(exitPip).not.toHaveBeenCalled();
    });

    it('gives up (and says so) if metadata never arrives inside the activation window', () => {
        vi.useFakeTimers();
        mountPopout();
        act(() => { vi.advanceTimersByTime(PIP_METADATA_TIMEOUT_MS + 1); });
        expect(reqPip).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalledTimes(1);
        // A late metadata event must not resurrect a request we abandoned.
        metadata(hostVideo());
        expect(reqPip).not.toHaveBeenCalled();
    });

    it('a refused request routes to the same close path', async () => {
        reqPip.mockRejectedValue(new DOMException('no gesture', 'NotAllowedError'));
        mountPopout();
        metadata(hostVideo());
        await act(async () => { await Promise.resolve(); });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('asks for nothing where PiP is unsupported', () => {
        pipEnabled = false;
        mountPopout();
        metadata(hostVideo());
        expect(reqPip).not.toHaveBeenCalled();
        expect(onClose).toHaveBeenCalled(); // the parent clears its state
    });
});

describe('the Pop out control', () => {
    const popOutButtons = () => [...container.querySelectorAll<HTMLButtonElement>('button')]
        .filter(b => /Pop out|Bring back/.test(b.title));

    it('appears on the in-app PiP only where PiP is supported, and toggles the primary stream', () => {
        const toggle = vi.fn();
        act(() => {
            root.render(<StreamPip onExpand={() => {}} onClose={() => {}} poppedStream={null} onTogglePopout={toggle} />);
        });
        expect(popOutButtons()).toHaveLength(1);
        expect(popOutButtons()[0].title).toMatch(/Pop out/);
        act(() => { popOutButtons()[0].click(); });
        expect(toggle).toHaveBeenCalledWith(1); // selectedStreams[0]

        // While popped, the same button reads "Bring back".
        act(() => {
            root.render(<StreamPip onExpand={() => {}} onClose={() => {}} poppedStream={1} onTogglePopout={toggle} />);
        });
        expect(popOutButtons()[0].title).toMatch(/Bring back/);
        expect(popOutButtons()[0].className).toContain('active');
    });

    it('appears on the Android APP once the plugin has said the OS can float the app', () => {
        removePipSurface();
        nativeMock.known = true;
        act(() => {
            root.render(<StreamPip onExpand={() => {}} onClose={() => {}} poppedStream={null} onTogglePopout={vi.fn()} />);
        });
        expect(popOutButtons()).toHaveLength(1);
    });

    it('is absent where PiP is unsupported (an old APK, Firefox), and when no toggle is wired', () => {
        pipEnabled = false;
        act(() => {
            root.render(<StreamPip onExpand={() => {}} onClose={() => {}} poppedStream={null} onTogglePopout={vi.fn()} />);
        });
        expect(popOutButtons()).toHaveLength(0);

        pipEnabled = true;
        act(() => { root.render(<StreamPip onExpand={() => {}} onClose={() => {}} />); });
        expect(popOutButtons()).toHaveLength(0);
    });
});
