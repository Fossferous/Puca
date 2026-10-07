/**
 * Púca's own video player (components/VideoPlayer.tsx).
 *
 * The owner, 2026-10-07: "videos should have volume selecter, full screen
 * icon and speed selecter" — the engine's own controls had folded all three
 * away on a ~170 px portrait video. These tests pin, under jsdom:
 *  - the player draws OUR controls (never `controls`, never autoplay), with
 *    volume, speed and fullscreen in the bar at every width;
 *  - the volume is this video's level TIMES Settings > Output Volume, applied
 *    again when Settings change while it plays, and never written back;
 *  - speed (pitch kept, surviving a reload of the source, remembered per
 *    video), the keyboard (only inside the player), fullscreen (the frame,
 *    the in-app fallback, the phone app), a covered player being inert, and
 *    touch: a tap on the picture never plays and a scroll never seeks.
 * Layout itself (what is visible at 170 px, the panels inside a 390 px
 * column, all eight themes) is the real browser's: e2e/video-controls-real-browser.mjs.
 * Nothing ever plays here: play() and pause() are stand-ins.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { memoryLocalStorage } from './fixtures/fakeSink';

const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock('../api/platform', async (orig) => ({
    ...(await orig<typeof import('../api/platform')>()),
    isMobile: () => platform.mobile,
}));
/** Android's BACK gesture, as api/mobileApp.ts hands it over (an APK after
 *  0.9.836): who holds it, and how often it was let go. */
const back = vi.hoisted(() => ({ holders: [] as Array<() => void>, released: 0 }));
vi.mock('../api/mobileApp', () => ({
    interceptBack: (onBack: () => void) => {
        back.holders.push(onBack);
        return () => { back.released++; back.holders = back.holders.filter((f) => f !== onBack); };
    },
}));

import { VideoPlayer, type VideoPlayerProps } from '../components/VideoPlayer';
import { LayerOnScreenContext } from '../components/portalTarget';
import { loadSettings, saveSettings } from '../components/settingsStore';
import { __resetVideoPlayerMemory } from '../components/videoPlayerModel';
import { useOutputDeviceRef } from '../hooks/useOutputDeviceRef';

let container: HTMLDivElement;
let root: Root;

/** The element the way a browser runs it: play()/pause() flip `paused` and
 *  fire their events; the length is known. Nothing makes a sound. */
function fakeMedia(v: HTMLVideoElement, duration = 60) {
    let paused = true;
    Object.defineProperty(v, 'paused', { configurable: true, get: () => paused });
    Object.defineProperty(v, 'ended', { configurable: true, get: () => false });
    Object.defineProperty(v, 'duration', { configurable: true, get: () => duration });
    const play = vi.fn(() => { paused = false; v.dispatchEvent(new Event('play')); return Promise.resolve(); });
    const pause = vi.fn(() => { paused = true; v.dispatchEvent(new Event('pause')); });
    v.play = play as unknown as HTMLMediaElement['play'];
    v.pause = pause;
    v.dispatchEvent(new Event('durationchange'));
    return { play, pause };
}

async function mount(props: Partial<VideoPlayerProps> = {}) {
    await act(async () => { root.render(<VideoPlayer src="blob:test-1" title="portrait.mp4" {...props} />); });
    const video = container.querySelector('video')!;
    let media!: ReturnType<typeof fakeMedia>;
    await act(async () => { media = fakeMedia(video); });
    return { video, frame: container.querySelector<HTMLElement>('.vpl')!, ...media };
}

const q = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
const btn = (label: RegExp | string, scope: ParentNode = document) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        typeof label === 'string' ? b.getAttribute('aria-label') === label : label.test(b.getAttribute('aria-label') ?? ''));
async function key(target: Element, k: string, init: KeyboardEventInit = {}) {
    let ev!: KeyboardEvent;
    await act(async () => {
        ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
        target.dispatchEvent(ev);
    });
    return ev;
}
async function click(el: Element) {
    await act(async () => { (el as HTMLElement).click(); });
}
/** A pointer event as React reads it (jsdom has no PointerEvent constructor). */
function pointer(type: string, el: Element, init: { pointerType: string; clientX?: number; clientY?: number; pointerId?: number; button?: number }) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.clientX ?? 0, clientY: init.clientY ?? 0, button: init.button ?? 0 });
    Object.defineProperty(ev, 'pointerType', { value: init.pointerType });
    Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 });
    act(() => { el.dispatchEvent(ev); });
}
function setMaster(outputVolume: number) {
    act(() => { saveSettings({ ...loadSettings(), outputVolume }); });
}
/** jsdom has no layout: give the player's frame a size and report it. */
function stubFrameSize(width: number, height: number) {
    const observers: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
        cb: () => void;
        constructor(cb: () => void) { this.cb = cb; observers.push(cb); }
        observe() {}
        disconnect() {}
    });
    const orig = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this.classList.contains('vpl')) return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON() { return this; } } as DOMRect;
        return orig.call(this);
    });
    return () => act(() => { observers.forEach((cb) => cb()); });
}

beforeEach(() => {
    vi.stubGlobal('localStorage', memoryLocalStorage());
    __resetVideoPlayerMemory();
    platform.mobile = false;
    back.holders = [];
    back.released = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("Púca's controls, not the engine's", () => {
    it('no native controls and no autoplay; play, volume, speed and fullscreen are ours', async () => {
        const { video, frame, play } = await mount();
        expect(video.hasAttribute('controls')).toBe(false);
        expect(video.hasAttribute('autoplay')).toBe(false);
        expect(video.getAttribute('preload')).toBe('metadata');
        expect(video.getAttribute('src')).toBe('blob:test-1');
        expect(video.getAttribute('title')).toBe('portrait.mp4');
        expect(frame.getAttribute('role')).toBe('group');
        expect(frame.getAttribute('aria-label')).toBe('Video player: portrait.mp4');
        const bar = q('.vpl-bar', frame)!;
        expect(btn('Play', bar)).toBeTruthy();
        expect(btn(/^Volume, 100%$/, bar)).toBeTruthy();
        expect(btn('Playback speed, 1×', bar)).toBeTruthy();
        expect(btn('Full screen', bar)).toBeTruthy();
        expect(q('[role="slider"][aria-label="Seek"]', bar)).toBeTruthy();
        // Mounting played nothing.
        await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
        expect(play).not.toHaveBeenCalled();
    });

    it('a 170 px portrait player is "narrow" and still has volume, speed and fullscreen in its bar', async () => {
        const report = stubFrameSize(170, 300);
        const { frame } = await mount();
        report();
        expect(frame.dataset.size).toBe('narrow');
        const bar = q('.vpl-bar', frame)!;
        for (const label of [/^Volume, /, /^Playback speed, /, /^Full screen$/]) {
            expect(btn(label, bar), String(label)).toBeTruthy();
        }
        // The centre button is the play/pause there.
        expect(btn('Play', q('.vpl-center', frame)!.parentElement!)).toBeTruthy();
    });

    it('measures the PLAYER, not the window: 400 px wide is "wide"', async () => {
        const report = stubFrameSize(400, 225);
        const { frame } = await mount();
        report();
        expect(frame.dataset.size).toBe('wide');
    });

    it('play and pause from the centre button and the bar; the caller hears every media event', async () => {
        const onPlay = vi.fn(), onPause = vi.fn(), onEnded = vi.fn(), onTimeUpdate = vi.fn(), onLoadedMetadata = vi.fn(), onError = vi.fn();
        const { video, frame, play, pause } = await mount({ onPlay, onPause, onEnded, onTimeUpdate, onLoadedMetadata, onError });
        await click(q('.vpl-center', frame)!);
        expect(play).toHaveBeenCalledTimes(1);
        expect(onPlay).toHaveBeenCalledTimes(1);
        expect(frame.dataset.paused).toBe('false');
        await click(btn('Pause', q('.vpl-bar', frame)!)!);
        expect(pause).toHaveBeenCalledTimes(1);
        expect(onPause).toHaveBeenCalledTimes(1);
        for (const type of ['ended', 'timeupdate', 'loadedmetadata', 'error']) {
            await act(async () => { video.dispatchEvent(new Event(type)); });
        }
        expect([onEnded, onTimeUpdate, onLoadedMetadata, onError].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1]);
    });

    it("the caller's ref gets the element: its cleanup runs on unmount, and useOutputDeviceRef's RefObject is filled", async () => {
        const cleanup = vi.fn();
        const cb = vi.fn(() => cleanup);
        await mount({ videoRef: cb });
        const el = container.querySelector('video');
        expect(cb).toHaveBeenCalledWith(el);
        await act(async () => { root.render(<div />); });
        expect(cleanup).toHaveBeenCalledTimes(1);

        let seen: HTMLVideoElement | null = null;
        function WithObject() {
            const r = useRef<HTMLVideoElement | null>(null);
            const sinkRef = useOutputDeviceRef(r); // what ClipAttachment hands it
            return <><VideoPlayer src="blob:x" title="x" videoRef={sinkRef} /><button type="button" onClick={() => { seen = r.current; }}>peek</button></>;
        }
        await act(async () => { root.render(<WithObject />); });
        await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'peek')!);
        expect(seen).toBe(container.querySelector('video'));
    });
});

describe('volume: this video times Settings > Output Volume', () => {
    it('the element gets the product, a master change reaches a playing video, and the master is never written', async () => {
        setMaster(50);
        const { video, frame } = await mount();
        expect(video.volume).toBeCloseTo(0.5, 5);
        await click(q('.vpl-center', frame)!); // playing
        // Down 4 steps of 5 % on this video: 0.8 x 0.5.
        for (let i = 0; i < 4; i++) await key(frame, 'ArrowDown');
        expect(video.volume).toBeCloseTo(0.4, 5);
        // Settings moved while it plays: applied at once, no remount.
        const same = container.querySelector('video');
        setMaster(25);
        expect(container.querySelector('video')).toBe(same);
        expect(video.volume).toBeCloseTo(0.2, 5);
        // The video's own level never reached Settings.
        expect(loadSettings().outputVolume).toBe(25);
        // Mute is the element's mute; the level stays.
        await key(frame, 'm');
        expect(video.muted).toBe(true);
        expect(video.volume).toBeCloseTo(0.2, 5);
        await key(frame, 'M');
        expect(video.muted).toBe(false);
    });

    it('master at 0 silences every video whatever its own slider says', async () => {
        setMaster(0);
        const { video, frame } = await mount();
        await key(frame, 'ArrowUp');
        expect(video.volume).toBe(0);
    });

    it('the panel (a narrower player): a mute button and a slider; Esc closes it and gives focus back', async () => {
        setMaster(60);
        const { video, frame } = await mount();
        const open = btn(/^Volume, /, frame)!;
        await click(open);
        expect(open.getAttribute('aria-expanded')).toBe('true');
        const panel = q('[role="dialog"][aria-label="Volume"]')!;
        const slider = q('[role="slider"]', panel)!;
        expect(document.activeElement).toBe(slider);
        expect(panel.textContent).toContain('Output Volume in Settings: 60%');
        await key(slider, 'ArrowLeft');
        expect(slider.getAttribute('aria-valuenow')).toBe('95');
        expect(video.volume).toBeCloseTo(0.95 * 0.6, 5);
        await click([...panel.querySelectorAll('button')].find((b) => b.textContent?.includes('Mute'))!);
        expect(video.muted).toBe(true);
        await key(document.activeElement!, 'Escape');
        expect(q('[role="dialog"][aria-label="Volume"]')).toBeNull();
        expect(document.activeElement).toBe(open);
    });

    it('a wide player: the speaker button mutes, and the slider is in the bar', async () => {
        const report = stubFrameSize(400, 225);
        const { video, frame } = await mount();
        report();
        await click(btn('Mute', frame)!);
        expect(video.muted).toBe(true);
        expect(btn('Unmute', frame)).toBeTruthy();
        expect(q('.vpl-volume-inline[role="slider"]', frame)).toBeTruthy();
    });

    it('the next video starts at the level last set (this session only, nothing stored)', async () => {
        const { frame } = await mount();
        for (let i = 0; i < 6; i++) await key(frame, 'ArrowDown');
        await act(async () => { root.render(<div />); });
        const before = JSON.stringify(localStorage);
        const second = await mount({ src: 'blob:test-2', title: 'other.mp4' });
        expect(second.video.volume).toBeCloseTo(0.7, 5);
        expect(JSON.stringify(localStorage)).toBe(before);
    });
});

describe('speed', () => {
    it('six speeds in a menu; the choice sets the rate with pitch kept, and survives the source reloading', async () => {
        const { video, frame } = await mount({ memoryKey: 'file-1' });
        const open = btn('Playback speed, 1×', frame)!;
        await click(open);
        const menu = q('[role="menu"][aria-label="Playback speed"]')!;
        const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
        expect(items.map((i) => i.textContent)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']);
        expect(items.find((i) => i.getAttribute('aria-checked') === 'true')?.textContent).toBe('1×');
        expect(document.activeElement).toBe(items[2]);
        // Arrow keys move between them.
        await key(items[2], 'ArrowDown');
        expect(document.activeElement).toBe(items[3]);
        await click(items[4]);
        expect(video.playbackRate).toBe(1.5);
        expect(video.defaultPlaybackRate).toBe(1.5);
        expect((video as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch).toBe(true);
        expect(q('[role="menu"]')).toBeNull();
        expect(btn('Playback speed, 1.5×', frame)).toBeTruthy();
        expect(document.activeElement).toBe(btn('Playback speed, 1.5×', frame));
        // A reload resets playbackRate to the default; metadata puts it back.
        video.playbackRate = 1;
        await act(async () => { video.dispatchEvent(new Event('loadedmetadata')); });
        expect(video.playbackRate).toBe(1.5);
    });

    it('is remembered for that video, and only that video', async () => {
        const { frame } = await mount({ memoryKey: 'lecture' });
        await click(btn(/^Playback speed/, frame)!);
        await click([...document.querySelectorAll('[role="menuitemradio"]')].find((i) => i.textContent === '2×')!);
        await act(async () => { root.render(<div />); });
        const again = await mount({ memoryKey: 'lecture' });
        expect(again.video.playbackRate).toBe(2);
        await act(async () => { root.render(<div />); });
        const other = await mount({ memoryKey: 'clip' });
        expect(other.video.playbackRate).toBe(1);
    });
});

describe('keyboard: only while focus is inside the player', () => {
    it('Space / K play-pause, arrows seek 5 s, Home on the timeline goes to the start', async () => {
        const { video, frame, play, pause } = await mount();
        frame.focus();
        await key(frame, ' ');
        expect(play).toHaveBeenCalledTimes(1);
        await key(frame, 'k');
        expect(pause).toHaveBeenCalledTimes(1);
        video.currentTime = 10;
        await key(frame, 'ArrowRight');
        expect(video.currentTime).toBe(15);
        await key(frame, 'ArrowLeft');
        await key(frame, 'ArrowLeft');
        expect(video.currentTime).toBe(5);
        const seek = q('[role="slider"][aria-label="Seek"]', frame)!;
        await key(seek, 'Home');
        expect(video.currentTime).toBe(0);
        await key(seek, 'End');
        expect(video.currentTime).toBe(60);
    });

    it('takes what it handles away from the rest of the page, and leaves everything else alone', async () => {
        const { frame } = await mount();
        const seen: string[] = [];
        const listener = (e: KeyboardEvent) => seen.push(e.key);
        window.addEventListener('keydown', listener);
        try {
            const space = await key(frame, ' ');
            expect(space.defaultPrevented).toBe(true); // no page scroll
            await key(frame, 'ArrowUp');
            await key(frame, 'a');
            await key(frame, 'f', { ctrlKey: true });
            await key(frame, 'Escape'); // nothing to close: not ours
        } finally {
            window.removeEventListener('keydown', listener);
        }
        expect(seen).toEqual(['a', 'f', 'Escape']);
    });

    it('a key pressed anywhere else (the message box) does nothing to the player', async () => {
        const { video, frame, play } = await mount();
        const box = document.createElement('textarea');
        document.body.appendChild(box);
        try {
            box.focus();
            video.currentTime = 10;
            for (const k of [' ', 'k', 'ArrowRight', 'ArrowUp', 'm', 'f']) await key(box, k);
            expect(play).not.toHaveBeenCalled();
            expect(video.currentTime).toBe(10);
            expect(video.muted).toBe(false);
            expect(frame.dataset.fs).toBe('none');
        } finally {
            box.remove();
        }
    });

    it('Space on one of its buttons is left to the button', async () => {
        const { frame, play } = await mount();
        const speed = btn(/^Playback speed/, frame)!;
        const ev = await key(speed, ' ');
        expect(ev.defaultPrevented).toBe(false);
        expect(play).not.toHaveBeenCalled();
    });
});

describe('fullscreen', () => {
    function realFullscreen(grant: boolean) {
        const doc: { el: Element | null } = { el: null };
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => doc.el });
        const request = vi.fn(function (this: HTMLElement) {
            if (!grant) return Promise.reject(new TypeError('Permissions check failed'));
            doc.el = this;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        });
        const exit = vi.fn(() => {
            doc.el = null;
            document.dispatchEvent(new Event('fullscreenchange'));
            return Promise.resolve();
        });
        (HTMLElement.prototype as unknown as { requestFullscreen: unknown }).requestFullscreen = request;
        (document as unknown as { exitFullscreen: unknown }).exitFullscreen = exit;
        return { request, exit, leaveByEsc: () => act(() => { doc.el = null; document.dispatchEvent(new Event('fullscreenchange')); }) };
    }

    it('the FRAME goes fullscreen (so these controls stay), and the caller hears both ways', async () => {
        const fs = realFullscreen(true);
        const onFullscreenChange = vi.fn();
        const { frame } = await mount({ onFullscreenChange });
        await click(btn('Full screen', frame)!);
        expect(fs.request).toHaveBeenCalledTimes(1);
        expect(fs.request.mock.instances[0]).toBe(frame);
        expect(frame.dataset.fs).toBe('native');
        expect(onFullscreenChange).toHaveBeenLastCalledWith(true);
        await click(btn('Exit full screen', frame)!);
        expect(fs.exit).toHaveBeenCalledTimes(1);
        expect(frame.dataset.fs).toBe('none');
        expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
        // F does the same; leaving by the browser's own Esc is heard too.
        await key(frame, 'f');
        expect(frame.dataset.fs).toBe('native');
        fs.leaveByEsc();
        expect(frame.dataset.fs).toBe('none');
        expect(onFullscreenChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    });

    it('a refused request fills the app instead; Esc (on the player or anywhere) leaves', async () => {
        const fs = realFullscreen(false);
        const onFullscreenChange = vi.fn();
        const { frame } = await mount({ onFullscreenChange });
        await click(btn('Full screen', frame)!);
        expect(fs.request).toHaveBeenCalledTimes(1);
        expect(frame.dataset.fs).toBe('app');
        expect(frame.classList.contains('vpl-app-fs')).toBe(true);
        expect(frame.getAttribute('popover')).toBe('manual');
        expect(onFullscreenChange).toHaveBeenLastCalledWith(true);
        await key(frame, 'Escape');
        expect(frame.dataset.fs).toBe('none');
        expect(frame.hasAttribute('popover')).toBe(false);
        expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
        await click(btn('Full screen', frame)!);
        expect(frame.dataset.fs).toBe('app');
        await key(document.body, 'Escape');
        expect(frame.dataset.fs).toBe('none');
    });

    it('in the phone app it never asks the Fullscreen API: it fills the app itself', async () => {
        platform.mobile = true;
        const fs = realFullscreen(true);
        const { frame } = await mount();
        await click(btn('Full screen', frame)!);
        expect(fs.request).not.toHaveBeenCalled();
        expect(frame.dataset.fs).toBe('app');
        await click(btn('Exit full screen', frame)!);
        expect(frame.dataset.fs).toBe('none');
    });

    it("in the app's in-app fullscreen, Android's BACK leaves it (an open panel first), and is handed back after", async () => {
        platform.mobile = true;
        const { frame } = await mount();
        expect(back.holders).toHaveLength(0); // back is the system's until then
        await click(btn('Full screen', frame)!);
        expect(back.holders).toHaveLength(1);
        await click(btn(/^Playback speed/, frame)!);
        expect(q('[role="menu"]')).not.toBeNull();
        await act(async () => { back.holders[0](); });
        expect(q('[role="menu"]')).toBeNull();
        expect(frame.dataset.fs).toBe('app');
        await act(async () => { back.holders[0](); });
        expect(frame.dataset.fs).toBe('none');
        expect(back.holders).toHaveLength(0);
        expect(back.released).toBe(1);
    });

    it('a player whose layer is off screen (Notes hidden in the desktop app) leaves Escape to the page', async () => {
        await act(async () => {
            root.render(<LayerOnScreenContext.Provider value={false}><VideoPlayer src="blob:test-1" title="portrait.mp4" /></LayerOnScreenContext.Provider>);
        });
        const frame = q('.vpl')!;
        await click(btn('Full screen', frame)!);
        expect(frame.dataset.fs).toBe('app');
        const esc = await key(document.body, 'Escape');
        expect(esc.defaultPrevented).toBe(false);
        expect(frame.dataset.fs).toBe('app');
        // Positive control: on screen, the same Escape leaves it.
        await act(async () => {
            root.render(<LayerOnScreenContext.Provider value><VideoPlayer src="blob:test-1" title="portrait.mp4" /></LayerOnScreenContext.Provider>);
        });
        const esc2 = await key(document.body, 'Escape');
        expect(esc2.defaultPrevented).toBe(true);
        expect(frame.dataset.fs).toBe('none');
    });

    it('a player that goes away fullscreen tells the caller it is over', async () => {
        const onFullscreenChange = vi.fn();
        const { frame } = await mount({ onFullscreenChange });
        await click(btn('Full screen', frame)!); // jsdom has no Fullscreen API: in-app
        expect(onFullscreenChange).toHaveBeenLastCalledWith(true);
        await act(async () => { root.render(<div />); });
        expect(onFullscreenChange).toHaveBeenLastCalledWith(false);
    });
});

describe('covered by a spoiler', () => {
    it('is inert (nothing focusable or pressable) until uncovered', async () => {
        await mount({ covered: true });
        const frame = q('.vpl')!;
        expect(frame.hasAttribute('inert')).toBe(true);
        expect(frame.tabIndex).toBe(-1);
        await act(async () => { root.render(<VideoPlayer src="blob:test-1" title="portrait.mp4" covered={false} />); });
        expect(frame.hasAttribute('inert')).toBe(false);
        expect(frame.tabIndex).toBe(0);
    });
});

describe('touch', () => {
    it('a tap on the picture shows or hides the controls and never plays; a mouse click plays', async () => {
        const { video, frame, play } = await mount();
        expect(frame.dataset.shown).toBe('true');
        pointer('pointerdown', video, { pointerType: 'touch' });
        await click(video);
        expect(play).not.toHaveBeenCalled();
        expect(frame.dataset.shown).toBe('false');
        pointer('pointerdown', video, { pointerType: 'touch' });
        await click(video);
        expect(frame.dataset.shown).toBe('true');
        expect(play).not.toHaveBeenCalled();
        pointer('pointerdown', video, { pointerType: 'mouse' });
        await click(video);
        expect(play).toHaveBeenCalledTimes(1);
    });

    it('a finger scrolling the chat across the timeline never seeks; a tap or a sideways drag does', async () => {
        const { video, frame } = await mount();
        const seek = q('[role="slider"][aria-label="Seek"]', frame)!;
        vi.spyOn(seek, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 32, right: 200, bottom: 32, x: 0, y: 0, toJSON() { return this; } } as DOMRect);
        video.currentTime = 30;
        // A vertical swipe: the browser takes it and cancels the pointer.
        pointer('pointerdown', seek, { pointerType: 'touch', clientX: 20, clientY: 10 });
        pointer('pointermove', seek, { pointerType: 'touch', clientX: 22, clientY: 60 });
        pointer('pointercancel', seek, { pointerType: 'touch', clientX: 22, clientY: 60 });
        expect(video.currentTime).toBe(30);
        // A swipe the browser did NOT take, ending far below where it began.
        pointer('pointerdown', seek, { pointerType: 'touch', clientX: 20, clientY: 10 });
        pointer('pointermove', seek, { pointerType: 'touch', clientX: 21, clientY: 40 });
        pointer('pointerup', seek, { pointerType: 'touch', clientX: 21, clientY: 80 });
        expect(video.currentTime).toBe(30);
        // A tap at a quarter of the way: there.
        pointer('pointerdown', seek, { pointerType: 'touch', clientX: 50, clientY: 10 });
        pointer('pointerup', seek, { pointerType: 'touch', clientX: 50, clientY: 11 });
        expect(video.currentTime).toBe(15);
        // A sideways drag follows the finger.
        pointer('pointerdown', seek, { pointerType: 'touch', clientX: 100, clientY: 10, pointerId: 2 });
        pointer('pointermove', seek, { pointerType: 'touch', clientX: 140, clientY: 12, pointerId: 2 });
        pointer('pointerup', seek, { pointerType: 'touch', clientX: 150, clientY: 12, pointerId: 2 });
        expect(video.currentTime).toBe(45);
    });

    it('while it plays the controls hide by themselves; paused, they come back and stay', async () => {
        vi.useFakeTimers();
        const { frame } = await mount();
        await act(async () => { q<HTMLButtonElement>('.vpl-center', frame)!.click(); });
        expect(frame.dataset.shown).toBe('true');
        await act(async () => { vi.advanceTimersByTime(2600); });
        expect(frame.dataset.shown).toBe('false');
        await act(async () => { q<HTMLButtonElement>('.vpl-center', frame)!.click(); }); // pause
        expect(frame.dataset.shown).toBe('true');
        await act(async () => { vi.advanceTimersByTime(10000); });
        expect(frame.dataset.shown).toBe('true');
    });
});
