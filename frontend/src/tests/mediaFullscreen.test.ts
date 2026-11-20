// @vitest-environment jsdom
/**
 * components/mediaFullscreen.ts: fullscreen for a live picture on every engine.
 *
 * The report: "full screen on the web app stream does nothing" (iPhone Safari).
 * The stage called `target?.requestFullscreen?.()`, and on an iPhone an element
 * has no requestFullscreen at all, so the optional call was a silent no-op.
 * These cases pin the routes, that the first — the only one desktop, an
 * Android browser and iPad ever take — is called exactly as before, and that
 * the Android APP never takes it (route 0; the owner's report of 2026-11-20:
 * a fullscreen stream with parts of Púca still around and over it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ android: false, bars: [] as string[] }));
// The real platform module, with only "is this the Android app" made a switch.
vi.mock('../api/platform', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../api/platform')>()),
    isAndroidApp: () => h.android,
}));
// Android's bars, recorded (api/systemBars.ts has its own suite).
vi.mock('../api/systemBars', () => ({
    holdSystemBarsHidden: () => {
        h.bars.push('hide');
        let done = false;
        return () => { if (!done) { done = true; h.bars.push('show'); } };
    },
}));

import { enterMediaFullscreen, holdBareFullscreen, inAppFullscreenOnly, type IosVideo } from '../components/mediaFullscreen';

let tile: HTMLDivElement;
let video: IosVideo;

/** An iPhone: no element fullscreen, the document says so, the video can. */
function iphone(): { enter: ReturnType<typeof vi.fn> } {
    Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
    Object.defineProperty(tile, 'requestFullscreen', { configurable: true, value: undefined });
    const enter = vi.fn();
    video.webkitEnterFullscreen = enter;
    video.webkitSupportsFullscreen = true;
    return { enter };
}

beforeEach(() => {
    vi.useFakeTimers();
    tile = document.createElement('div');
    video = document.createElement('video') as IosVideo;
    video.muted = true;
    tile.appendChild(video);
    document.body.appendChild(tile);
});

afterEach(() => {
    tile.remove();
    delete (document as { fullscreenEnabled?: boolean }).fullscreenEnabled;
    delete document.documentElement.dataset.fullscreenBare;
    h.android = false;
    h.bars = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('route 0: the Android APP fills its own view', () => {
    it('asks neither the tile nor the video: the in-app fullscreen, at once', async () => {
        h.android = true;
        const req = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(tile, 'requestFullscreen', { configurable: true, value: req });
        const enter = vi.fn();
        video.webkitEnterFullscreen = enter;
        video.webkitSupportsFullscreen = true;
        const fallback = vi.fn();
        expect(inAppFullscreenOnly()).toBe(true);
        expect(enterMediaFullscreen(tile, video, { fallback })).toBe('app');
        // At once, inside the tap: no promise or timer between the press and the picture.
        expect(fallback).toHaveBeenCalledTimes(1);
        await vi.runAllTimersAsync();
        expect(fallback).toHaveBeenCalledTimes(1);
        expect(req).not.toHaveBeenCalled();
        expect(enter).not.toHaveBeenCalled();
    });

    it('CONTROL: an Android BROWSER (not the app) still asks the tile', async () => {
        const req = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(tile, 'requestFullscreen', { configurable: true, value: req });
        const fallback = vi.fn();
        expect(inAppFullscreenOnly()).toBe(false);
        expect(enterMediaFullscreen(tile, video, { fallback })).toBe('element');
        await vi.runAllTimersAsync();
        expect(req).toHaveBeenCalledTimes(1);
        expect(fallback).not.toHaveBeenCalled();
    });
});

describe('holdBareFullscreen: the picture alone, the bars away (Android app)', () => {
    const bare = () => document.documentElement.dataset.fullscreenBare;

    it('publishes <html data-fullscreen-bare> and hides the system bars until released', () => {
        h.android = true;
        const release = holdBareFullscreen();
        expect(bare()).toBe('true');
        expect(h.bars).toEqual(['hide']);
        release();
        expect(bare()).toBeUndefined();
        expect(h.bars).toEqual(['hide', 'show']);
        release(); // twice is harmless
        expect(h.bars).toEqual(['hide', 'show']);
    });

    it('two holders: the page stays bare until the LAST one lets go', () => {
        h.android = true;
        const a = holdBareFullscreen();
        const b = holdBareFullscreen();
        a();
        a();
        expect(bare()).toBe('true');
        b();
        expect(bare()).toBeUndefined();
    });

    it('CONTROL: off the Android app (an iPhone, a browser, the desktop) it does nothing', () => {
        const release = holdBareFullscreen();
        expect(bare()).toBeUndefined();
        expect(h.bars).toEqual([]);
        release();
        expect(h.bars).toEqual([]);
    });
});

describe('route 1: the element (desktop, an Android browser, iPad) — unchanged', () => {
    it('asks the TILE, once, and touches neither the video nor the fallback', async () => {
        const req = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(tile, 'requestFullscreen', { configurable: true, value: req });
        const enter = vi.fn();
        video.webkitEnterFullscreen = enter;
        const fallback = vi.fn();
        expect(enterMediaFullscreen(tile, video, { fallback })).toBe('element');
        await vi.runAllTimersAsync();
        expect(req).toHaveBeenCalledTimes(1);
        expect(req.mock.instances[0]).toBe(tile);
        expect(enter).not.toHaveBeenCalled();
        expect(fallback).not.toHaveBeenCalled();
    });

    it('a REFUSED request falls back to the in-app fullscreen', async () => {
        Object.defineProperty(tile, 'requestFullscreen', { configurable: true, value: vi.fn().mockRejectedValue(new TypeError('denied')) });
        const fallback = vi.fn();
        enterMediaFullscreen(tile, video, { fallback });
        await vi.runAllTimersAsync();
        expect(fallback).toHaveBeenCalledTimes(1);
    });
});

describe('route 2: the iPhone system player', () => {
    it('CONTROL: the old call does nothing on an iPhone (the bug)', () => {
        const { enter } = iphone();
        const old = (t: HTMLElement | null) => (t as { requestFullscreen?: () => void } | null)?.requestFullscreen?.();
        expect(() => old(tile)).not.toThrow();
        expect(enter).not.toHaveBeenCalled();
    });

    it('hands the video to the system player and does not fall back once it began', async () => {
        const { enter } = iphone();
        const fallback = vi.fn();
        expect(enterMediaFullscreen(tile, video, { fallback })).toBe('video');
        expect(enter).toHaveBeenCalledTimes(1);
        video.dispatchEvent(new Event('webkitbeginfullscreen'));
        await vi.advanceTimersByTimeAsync(5000);
        expect(fallback).not.toHaveBeenCalled();
    });

    it('keeps a muted-on-purpose video muted (no doubled stream audio) and reports the unmute', () => {
        iphone();
        const onUnmuteRequest = vi.fn();
        enterMediaFullscreen(tile, video, { fallback: vi.fn(), onUnmuteRequest });
        video.dispatchEvent(new Event('webkitbeginfullscreen'));
        video.muted = false;
        video.dispatchEvent(new Event('volumechange'));
        expect(video.muted).toBe(true);
        expect(onUnmuteRequest).toHaveBeenCalledTimes(1);
    });

    it('on the way out: plays the paused inline video again, re-mutes it, and stops listening', () => {
        iphone();
        const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
        const onVideoExit = vi.fn();
        const onUnmuteRequest = vi.fn();
        enterMediaFullscreen(tile, video, { fallback: vi.fn(), onVideoExit, onUnmuteRequest });
        video.dispatchEvent(new Event('webkitbeginfullscreen'));
        // jsdom's `paused` is true for a video that never played: the state
        // the system player leaves behind.
        video.dispatchEvent(new Event('webkitendfullscreen'));
        expect(play).toHaveBeenCalledTimes(1);
        expect(onVideoExit).toHaveBeenCalledTimes(1);
        expect(video.muted).toBe(true);
        // Gone after the trip: an unmute later is the page's own business.
        video.muted = false;
        video.dispatchEvent(new Event('volumechange'));
        expect(onUnmuteRequest).not.toHaveBeenCalled();
    });

    it('a system player that never begins falls back to the in-app fullscreen', async () => {
        iphone();
        const fallback = vi.fn();
        enterMediaFullscreen(tile, video, { fallback, beginTimeoutMs: 800 });
        await vi.advanceTimersByTimeAsync(799);
        expect(fallback).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('a video without metadata yet (webkitSupportsFullscreen false) goes to the in-app fullscreen', () => {
        const { enter } = iphone();
        video.webkitSupportsFullscreen = false;
        const fallback = vi.fn();
        expect(enterMediaFullscreen(tile, video, { fallback })).toBe('app');
        expect(enter).not.toHaveBeenCalled();
        expect(fallback).toHaveBeenCalledTimes(1);
    });
});

describe('route 3: neither', () => {
    it('falls back at once, exactly once', () => {
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: false });
        const fallback = vi.fn();
        expect(enterMediaFullscreen(tile, video, { fallback })).toBe('app');
        expect(fallback).toHaveBeenCalledTimes(1);
    });
});
