/**
 * The rules behind Púca's own video controls (components/videoPlayerModel.ts):
 * how loud a video is against Settings' Output Volume, how its times read,
 * which keys it takes, what it remembers and how much of its bar fits.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    PLAYBACK_RATES, SEEK_STEP_S, VOLUME_STEP, MEDIUM_MIN_PX, WIDE_MIN_PX,
    __resetVideoPlayerMemory, clampTime, effectiveVolume, formatTime, keyAction, knownDuration, rateLabel,
    rememberRate, rememberVolume, rememberedRate, rememberedVolume, sizeFor,
} from '../components/videoPlayerModel';

beforeEach(() => __resetVideoPlayerMemory());

describe('effectiveVolume: this video times the master Output Volume', () => {
    it('multiplies, so the master can only turn a video down', () => {
        expect(effectiveVolume(1, 1)).toBe(1);
        expect(effectiveVolume(0.8, 0.5)).toBeCloseTo(0.4, 10);
        expect(effectiveVolume(1, 0.25)).toBe(0.25);
        expect(effectiveVolume(0.5, 0)).toBe(0); // master at 0 silences every video
        expect(effectiveVolume(0, 1)).toBe(0);
    });

    it('never leaves 0..1, whatever it is handed', () => {
        expect(effectiveVolume(2, 1)).toBe(1);
        expect(effectiveVolume(1, 3)).toBe(1);
        expect(effectiveVolume(-1, 1)).toBe(0);
        expect(effectiveVolume(Number.NaN, 1)).toBe(0);
        expect(effectiveVolume(1, Number.POSITIVE_INFINITY)).toBe(0);
    });
});

describe('times', () => {
    it('reads like every player', () => {
        expect(formatTime(0)).toBe('0:00');
        expect(formatTime(5.9)).toBe('0:05');
        expect(formatTime(65)).toBe('1:05');
        expect(formatTime(754)).toBe('12:34');
        expect(formatTime(3723)).toBe('1:02:03');
    });

    it('a time nobody knows yet reads 0:00, not NaN:NaN', () => {
        expect(formatTime(Number.NaN)).toBe('0:00');
        expect(formatTime(Number.POSITIVE_INFINITY)).toBe('0:00');
        expect(formatTime(-3)).toBe('0:00');
    });

    it("a clip's manifest length stands in until the element knows its own", () => {
        expect(knownDuration(Number.NaN, 5)).toBe(5);
        expect(knownDuration(Number.POSITIVE_INFINITY, 5)).toBe(5);
        expect(knownDuration(12.5, 5)).toBe(12.5);
        expect(knownDuration(Number.NaN)).toBeNaN();
        expect(knownDuration(0, 0)).toBeNaN();
    });

    it('a seek lands inside the video', () => {
        expect(clampTime(-4, 60)).toBe(0);
        expect(clampTime(75, 60)).toBe(60);
        expect(clampTime(30, 60)).toBe(30);
        expect(clampTime(Number.NaN, 60)).toBe(0);
    });
});

describe('speeds', () => {
    it('offers 0.5x to 2x with Normal among them, labelled with a multiplication sign', () => {
        expect([...PLAYBACK_RATES]).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
        expect(PLAYBACK_RATES.map(rateLabel)).toEqual(['0.5×', '0.75×', '1×', '1.25×', '1.5×', '2×']);
    });
});

describe('keys (only ever asked while focus is inside the player)', () => {
    it('Space and K play/pause, arrows seek and change volume, M mutes, F goes full screen, Esc leaves', () => {
        expect(keyAction({ key: ' ' }, 'surface')).toEqual({ kind: 'toggle-play' });
        expect(keyAction({ key: 'k' }, 'surface')).toEqual({ kind: 'toggle-play' });
        expect(keyAction({ key: 'K' }, 'button')).toEqual({ kind: 'toggle-play' });
        expect(keyAction({ key: 'ArrowLeft' }, 'surface')).toEqual({ kind: 'seek', by: -SEEK_STEP_S });
        expect(keyAction({ key: 'ArrowRight' }, 'button')).toEqual({ kind: 'seek', by: SEEK_STEP_S });
        expect(keyAction({ key: 'ArrowUp' }, 'surface')).toEqual({ kind: 'volume', by: VOLUME_STEP });
        expect(keyAction({ key: 'ArrowDown' }, 'seek')).toEqual({ kind: 'volume', by: -VOLUME_STEP });
        expect(keyAction({ key: 'm' }, 'surface')).toEqual({ kind: 'mute' });
        expect(keyAction({ key: 'F' }, 'surface')).toEqual({ kind: 'fullscreen' });
        expect(keyAction({ key: 'Escape' }, 'surface')).toEqual({ kind: 'escape' });
    });

    it('Space on one of its buttons presses that button, so the player does not also take it', () => {
        expect(keyAction({ key: ' ' }, 'button')).toBeNull();
        expect(keyAction({ key: ' ' }, 'seek')).toEqual({ kind: 'toggle-play' });
    });

    it('on the volume slider every arrow is the volume; on the timeline Home/End go to the ends', () => {
        expect(keyAction({ key: 'ArrowLeft' }, 'volume')).toEqual({ kind: 'volume', by: -VOLUME_STEP });
        expect(keyAction({ key: 'ArrowRight' }, 'volume')).toEqual({ kind: 'volume', by: VOLUME_STEP });
        expect(keyAction({ key: 'Home' }, 'seek')).toEqual({ kind: 'seek-to', fraction: 0 });
        expect(keyAction({ key: 'End' }, 'seek')).toEqual({ kind: 'seek-to', fraction: 1 });
        expect(keyAction({ key: 'Home' }, 'surface')).toBeNull();
    });

    it('never takes a key with Ctrl, Cmd or Alt (find, back, copy stay the browser\'s), nor one it has no use for', () => {
        expect(keyAction({ key: 'f', ctrlKey: true }, 'surface')).toBeNull();
        expect(keyAction({ key: 'ArrowLeft', altKey: true }, 'surface')).toBeNull();
        expect(keyAction({ key: 'k', metaKey: true }, 'surface')).toBeNull();
        expect(keyAction({ key: 'a' }, 'surface')).toBeNull();
        expect(keyAction({ key: 'Enter' }, 'surface')).toBeNull();
        expect(keyAction({ key: 'Tab' }, 'surface')).toBeNull();
    });
});

describe('what a player starts with (this session, in memory only)', () => {
    it('volume and mute: the last level set on any video', () => {
        expect(rememberedVolume()).toEqual({ volume: 1, muted: false });
        rememberVolume(0.3, true);
        expect(rememberedVolume()).toEqual({ volume: 0.3, muted: true });
        rememberVolume(4, false);
        expect(rememberedVolume()).toEqual({ volume: 1, muted: false });
    });

    it("speed: each video's own, so a 2x lecture does not speed up the next clip", () => {
        rememberRate('lecture', 2);
        expect(rememberedRate('lecture')).toBe(2);
        expect(rememberedRate('clip')).toBe(1);
        expect(rememberedRate(undefined)).toBe(1);
        rememberRate(undefined, 1.5); // nothing to key it by: not remembered
        expect(rememberedRate(undefined)).toBe(1);
        rememberRate('lecture', 1);
        expect(rememberedRate('lecture')).toBe(1);
    });

    it('forgets the oldest speeds first, so a long session cannot grow it without bound', () => {
        for (let i = 0; i < 250; i++) rememberRate(`v${i}`, 1.5);
        expect(rememberedRate('v0')).toBe(1);
        expect(rememberedRate('v49')).toBe(1);
        expect(rememberedRate('v50')).toBe(1.5);
        expect(rememberedRate('v249')).toBe(1.5);
    });
});

describe("how much of the bar fits: by the PLAYER's width", () => {
    it('a portrait video in a message (~170 px) is narrow; a landscape one (400 px) is wide', () => {
        expect(sizeFor(169)).toBe('narrow');
        expect(sizeFor(176)).toBe('narrow');
        expect(sizeFor(MEDIUM_MIN_PX - 1)).toBe('narrow');
        expect(sizeFor(MEDIUM_MIN_PX)).toBe('medium');
        expect(sizeFor(WIDE_MIN_PX - 1)).toBe('medium');
        expect(sizeFor(WIDE_MIN_PX)).toBe('wide');
        expect(sizeFor(400)).toBe('wide');
        expect(sizeFor(1920)).toBe('wide');
    });
});
