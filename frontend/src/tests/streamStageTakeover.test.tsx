import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PHONE_LAYOUT_QUERY, installPhoneSideways } from '../api/phoneSideways';

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
 *
 * "Sideways" comes from the REAL store (api/phoneSideways.ts) on a fake
 * window that answers only the real phone-layout query and turns by its
 * screen orientation; what counts as sideways is pinned in
 * phoneSideways.test.ts.
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
let sidewaysWin: EventTarget;
let undoSideways: () => void = () => {};

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
    // An iPhone: coarse pointer, the phone layout, a 390x844 screen that does
    // not rotate, and a screen orientation that does.
    const orientation = new EventTarget();
    Object.defineProperty(orientation, 'type', { get: () => (landscape ? 'landscape-primary' : 'portrait-primary') });
    sidewaysWin = Object.assign(new EventTarget(), {
        document,
        screen: { width: 390, height: 844, orientation },
        matchMedia: (q: string) => {
            if (q !== PHONE_LAYOUT_QUERY) throw new Error(`unexpected query: ${q}`);
            return { matches: true, addEventListener() {}, removeEventListener() {} };
        },
    });
    undoSideways = installPhoneSideways(sidewaysWin as unknown as Window);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    undoSideways();
    document.querySelectorAll('.voice-panel-compact').forEach(n => n.remove());
    delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function rotate(toLandscape: boolean) {
    landscape = toLandscape;
    act(() => { sidewaysWin.dispatchEvent(new Event('orientationchange')); });
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
        rotate(true);
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
        rotate(true);
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
        rotate(true);
        render();
        act(() => { vi.advanceTimersByTime(3000); });
        act(() => { container.querySelector('.stream-stage')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        act(() => { vi.advanceTimersByTime(3000); });
        expect(html().streamChrome).toBeUndefined();
        act(() => { vi.advanceTimersByTime(1100); });
        expect(html().streamChrome).toBe('hidden');
    });

    it('a control session: published for the layout (controls beside the picture), never hidden, by time or by a tap anywhere', () => {
        rotate(true);
        controlState = { controlling: { userId: 1, username: 'alice', status: 'active' }, hosting: null };
        render();
        expect(html().streamControlling).toBe('true');
        act(() => { vi.advanceTimersByTime(10000); });
        expect(html().streamChrome).toBeUndefined();
        // The review's lock-out: one tap on the header's blank area hid
        // everything, and every later tap was a click on the other computer.
        tap(container.querySelector('.stream-stage-header')!);
        tap(container.querySelector('.stream-stage-title')!);
        tap(container.querySelector('video')!);
        expect(html().streamChrome).toBeUndefined();
        expect(container.querySelector('.stop-controlling-btn')).not.toBeNull();
    });

    it('interaction in the voice bar (portaled OUTSIDE the stage) keeps the controls up', () => {
        const bar = document.createElement('div');
        bar.className = 'voice-panel-compact';
        bar.innerHTML = '<button title="Mute">m</button>';
        document.body.appendChild(bar);
        rotate(true);
        render();
        act(() => { vi.advanceTimersByTime(3000); });
        act(() => { bar.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
        act(() => { vi.advanceTimersByTime(1700); });
        expect(html().streamChrome).toBeUndefined();
        act(() => { vi.advanceTimersByTime(2400); });
        expect(html().streamChrome).toBe('hidden');
    });

    it('a key brings hidden controls back (keyboard, switch access, a screen reader)', () => {
        rotate(true);
        render();
        tap(container.querySelector('video')!);
        expect(html().streamChrome).toBe('hidden');
        const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        act(() => { document.body.dispatchEvent(tab); });
        expect(html().streamChrome).toBeUndefined();
        // Hidden controls cannot take focus, so Tab's own move would skip
        // them: it is taken over and lands on the first control instead.
        expect(tab.defaultPrevented).toBe(true);
        act(() => { vi.advanceTimersByTime(1); });
        expect(container.querySelector('.stream-stage')!.contains(document.activeElement)).toBe(true);
    });

    it('focus arriving on one of the controls shows them', () => {
        rotate(true);
        render();
        tap(container.querySelector('video')!);
        expect(html().streamChrome).toBe('hidden');
        act(() => { (container.querySelector('.stream-tile-header button') as HTMLButtonElement).focus(); });
        expect(html().streamChrome).toBeUndefined();
    });

    it('the controls are back each time the phone turns sideways again', () => {
        rotate(true);
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

    it('the same person sharing again later does NOT reopen it fullscreen unasked', () => {
        noFullscreenAnywhere();
        STREAMS.set(2, { username: 'bob', stream: new MediaStream() });
        selected = [1, 2];
        streamers.push({ userId: 2, username: 'bob' });
        render();
        tap(fullscreenBtn());
        expect(html().streamTakeover).toBe('fullscreen');
        selected = [2];
        act(() => notify());
        selected = [2, 1];
        act(() => notify());
        expect(html().streamTakeover).toBeUndefined();
        expect(container.querySelector('.is-app-fullscreen')).toBeNull();
    });

    it('every stream ending, then the same person sharing again, does not reopen it either', () => {
        noFullscreenAnywhere();
        render();
        tap(fullscreenBtn());
        expect(html().streamTakeover).toBe('fullscreen');
        selected = [];
        act(() => notify());
        selected = [1];
        act(() => notify());
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

    it('the iPhone player\'s speaker button unmutes a stream muted AFTER Fullscreen was tapped (no stale state)', () => {
        noFullscreenAnywhere();
        const enter = vi.fn();
        Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', { configurable: true, value: enter });
        try {
            render();
            tap(fullscreenBtn());
            const video = container.querySelector('video')!;
            act(() => { video.dispatchEvent(new Event('webkitbeginfullscreen')); });
            const mute = () => container.querySelector<HTMLButtonElement>('.stream-tile-header button[title$="stream"]')!;
            expect(mute().title).toBe('Mute stream');
            tap(mute());
            expect(mute().title).toBe('Unmute stream');
            act(() => { video.muted = false; video.dispatchEvent(new Event('volumechange')); });
            expect(mute().title).toBe('Mute stream');
            expect(video.muted).toBe(true);
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
