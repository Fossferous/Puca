import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The stream stage TAKING OVER a phone's screen (components/streamTakeover.ts,
 * phoneLandscape.css), and its Fullscreen button on an engine with no
 * fullscreen at all.
 *
 * The report: on an iPhone held sideways "cant even see the stream at all",
 * and "full screen ... does nothing". jsdom computes no layout (the geometry
 * is e2e/iphone-stream-real-browser.mjs's job); this pins the state the CSS
 * keys on: <html data-stream-takeover> while a phone is sideways or a stream
 * is in the in-app fullscreen, the tap that hides and shows the controls,
 * their hiding by themselves, and that nothing is published on a desktop.
 */

const STREAMS = new Map<number, { username: string; stream: MediaStream }>();
let selected: number[] = [];
let streamers: { userId: number; username: string }[] = [];
// MANY subscribers, like the real module: the stage subscribes, and so does
// the camera rail beneath it. A single-slot stub let the second subscriber
// silently replace the first, so a change event re-rendered the rail and never
// the stage — the tests then saw a tile that would not go away.
const subscribers = new Set<() => void>();
const notify = () => { for (const cb of [...subscribers]) cb(); };

vi.mock('../components/voiceState', () => ({
    subscribeToStreamState: (cb: () => void) => { subscribers.add(cb); return () => { subscribers.delete(cb); }; },
    subscribeToVoiceUsers: () => () => { /* no voice users in these tests */ },
    subscribeToSpeaking: () => () => { /* nobody speaks in these tests */ },
    getSelectedStreams: () => [...selected],
    getStreamData: (id: number) => STREAMS.get(id) ?? null,
    getAllStreamers: () => [...streamers],
    deselectStream: vi.fn(),
    selectStream: vi.fn(),
    clearAllStreams: vi.fn(),
    stopOwnScreenShare: vi.fn(),
    getCurrentStreamingUserId: () => null,
    notifyStreamStateChange: vi.fn(),
    globalSpeakingUsers: new Set<number>(),
    getAllVoiceUsers: () => [],
    // The stage now carries a camera rail below the grid. These tests are
    // about the GRID's layout contract, so the rail is given an empty world
    // and renders nothing — but the module stub still has to offer everything
    // the rail imports, or the whole file fails to load.
    globalCameraStreams: new Map<number, MediaStream>(),
}));

/** Mutable so a test can put an ACTIVE remote-control session on a given user. */
let controlState: { controlling: unknown; hosting: unknown } = { controlling: null, hosting: null };

vi.mock('../api/remoteControl', () => ({
    requestControl: vi.fn(),
    stopControlling: vi.fn(),
    sendControlEvent: vi.fn(),
    subscribeControl: () => () => { /* unsubscribe */ },
    getControlState: () => controlState,
    offerControl: vi.fn(),
    computeRmoveScale: () => 1,
    getControlHostCapture: () => null,
}));

const setFocusedRemote = vi.fn();
vi.mock('../api/rtc/sfuManager', () => ({
    sfuManager: {
        setFocusedRemote: (id: number | null) => setFocusedRemote(id),
    },
}));

import { StreamStage } from '../components/StreamStage';
import { useStreamStore } from '../stores/streamStore';


let container: HTMLDivElement;
let root: Root;
let landscape = false;
const mqListeners = new Set<() => void>();

function render() {
    act(() => {
        root = createRoot(container);
        root.render(<StreamStage onBackToChat={() => { /* not exercised */ }} />);
    });
}
const html = () => document.documentElement.dataset;
const fullscreenBtn = (i = 0) => container.querySelectorAll<HTMLButtonElement>('.tile-btn[aria-label]')[i];
const tap = (el: Element) => act(() => { (el as HTMLElement).click(); });

beforeEach(() => {
    vi.useFakeTimers();
    useStreamStore.getState().clearAllStreams();
    controlState = { controlling: null, hosting: null };
    STREAMS.clear();
    STREAMS.set(1, { username: 'alice', stream: new MediaStream() });
    selected = [1];
    streamers = [{ userId: 1, username: 'alice' }];
    landscape = false;
    mqListeners.clear();
    window.matchMedia = ((q: string) => ({
        get matches() { return q.includes('orientation: landscape') ? landscape : false; },
        media: q,
        addEventListener: (_: string, fn: () => void) => mqListeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => mqListeners.delete(fn),
    })) as unknown as typeof window.matchMedia;
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    delete (window as { matchMedia?: unknown }).matchMedia;
    delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function rotate(toLandscape: boolean) {
    landscape = toLandscape;
    act(() => { mqListeners.forEach(f => f()); });
}

describe('the phone-landscape takeover', () => {
    it('publishes nothing in portrait or on a desktop (CONTROL)', () => {
        render();
        expect(html().streamTakeover).toBeUndefined();
        expect(container.querySelector('.stream-stage.is-takeover')).toBeNull();
    });

    it('takes over when the phone turns sideways, and gives the screen back when it turns back', () => {
        render();
        rotate(true);
        expect(html().streamTakeover).toBe('landscape');
        expect(container.querySelector('.stream-stage.is-takeover')).not.toBeNull();
        rotate(false);
        expect(html().streamTakeover).toBeUndefined();
    });

    it('starts sideways already taken over, and unmounting clears it', () => {
        landscape = true;
        render();
        expect(html().streamTakeover).toBe('landscape');
        act(() => { vi.advanceTimersByTime(5000); });
        expect(html().streamChrome).toBe('hidden');
        act(() => root.unmount());
        expect(html().streamTakeover).toBeUndefined();
        expect(html().streamChrome).toBeUndefined();
        render(); // afterEach unmounts again
    });

    it('a tap on the picture hides the controls and another shows them; a tap on a button does not', () => {
        landscape = true;
        render();
        expect(html().streamChrome).toBeUndefined();
        tap(container.querySelector('video')!);
        expect(html().streamChrome).toBe('hidden');
        tap(container.querySelector('video')!);
        expect(html().streamChrome).toBeUndefined();
        tap(container.querySelector('.stream-tile-header button')!);
        expect(html().streamChrome).toBeUndefined();
    });

    it('a tap toggles nothing when the stage is NOT taking over (CONTROL)', () => {
        render();
        tap(container.querySelector('video')!);
        expect(html().streamChrome).toBeUndefined();
    });

    it('the controls hide by themselves after a few idle seconds, and a touch restarts the clock', () => {
        landscape = true;
        render();
        act(() => { vi.advanceTimersByTime(3000); });
        act(() => { container.querySelector('.stream-stage')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        act(() => { vi.advanceTimersByTime(3000); });
        expect(html().streamChrome).toBeUndefined();
        act(() => { vi.advanceTimersByTime(1100); });
        expect(html().streamChrome).toBe('hidden');
    });

    it('never hide while a control session needs its Stop button', () => {
        landscape = true;
        controlState = { controlling: { userId: 1, username: 'alice', status: 'active' }, hosting: null };
        render();
        act(() => { vi.advanceTimersByTime(10000); });
        expect(html().streamChrome).toBeUndefined();
    });

    it('the controls are back each time the phone turns sideways again', () => {
        landscape = true;
        render();
        act(() => { vi.advanceTimersByTime(5000); });
        expect(html().streamChrome).toBe('hidden');
        rotate(false);
        rotate(true);
        expect(html().streamChrome).toBeUndefined();
    });
});

describe('Fullscreen where nothing can go fullscreen (in-app)', () => {
    function noFullscreenAnywhere() {
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    }

    it('fills the screen with the stream, and the same button leaves', () => {
        noFullscreenAnywhere();
        render();
        const btn = fullscreenBtn();
        expect(btn.getAttribute('aria-label')).toBe('Fullscreen');
        tap(btn);
        expect(html().streamTakeover).toBe('fullscreen');
        expect(container.querySelector('.stream-tile.is-app-fullscreen')).not.toBeNull();
        expect(fullscreenBtn().getAttribute('aria-label')).toBe('Exit fullscreen');
        tap(fullscreenBtn());
        expect(html().streamTakeover).toBeUndefined();
        expect(container.querySelector('.is-app-fullscreen')).toBeNull();
    });

    it('Escape leaves it too', () => {
        noFullscreenAnywhere();
        render();
        tap(fullscreenBtn());
        act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(html().streamTakeover).toBeUndefined();
    });

    it('ends with its stream: no black screen left over the app', () => {
        noFullscreenAnywhere();
        STREAMS.set(2, { username: 'bob', stream: new MediaStream() });
        selected = [1, 2];
        streamers.push({ userId: 2, username: 'bob' });
        render();
        tap(fullscreenBtn());
        expect(html().streamTakeover).toBe('fullscreen');
        selected = [2];
        act(() => notify());
        expect(html().streamTakeover).toBeUndefined();
    });

    it('on an iPhone the video goes to the system player instead, and the stage stays put', () => {
        noFullscreenAnywhere();
        const enter = vi.fn();
        Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: enter });
        try {
            render();
            tap(fullscreenBtn());
            expect(enter).toHaveBeenCalledTimes(1);
            expect(html().streamTakeover).toBeUndefined();
        } finally {
            delete (HTMLVideoElement.prototype as { webkitEnterFullscreen?: unknown }).webkitEnterFullscreen;
        }
    });

    it('a desktop (element fullscreen available) asks the TILE, as before, and nothing in-app (CONTROL)', () => {
        const req = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: req });
        try {
            render();
            tap(fullscreenBtn());
            expect(req).toHaveBeenCalledTimes(1);
            expect((req.mock.instances[0] as unknown as HTMLElement).classList.contains('stream-tile')).toBe(true);
            expect(html().streamTakeover).toBeUndefined();
        } finally {
            delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
        }
    });
});
