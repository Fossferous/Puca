/**
 * The desktop stage's pure helpers: its own shortcuts (stageShortcuts.ts),
 * typing text on the remote machine (typeText.ts), and the live numbers
 * (liveStats.ts).
 */
import { describe, it, expect } from 'vitest';
import { stageShortcut } from '../api/devices/stageShortcuts';
import { textChunks, typeTextEvents, TEXT_CHUNK } from '../api/devices/typeText';
import { liveStatsFrom } from '../api/devices/liveStats';
import type { DeviceStatsSample } from '../api/devices/session';

const key = (code: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

describe('the stage\'s own shortcuts', () => {
    it('Ctrl+Alt + Home / End / Enter are the stage\'s', () => {
        expect(stageShortcut(key('Home', { ctrlKey: true, altKey: true }))).toBe('pause');
        expect(stageShortcut(key('End', { ctrlKey: true, altKey: true }))).toBe('sas');
        expect(stageShortcut(key('Enter', { ctrlKey: true, altKey: true }))).toBe('fullscreen');
        expect(stageShortcut(key('NumpadEnter', { ctrlKey: true, altKey: true }))).toBe('fullscreen');
    });

    it('Esc is for the remote machine now — it used to pause control, so it could never be sent', () => {
        expect(stageShortcut(key('Escape'))).toBeNull();
        expect(stageShortcut(key('Escape', { ctrlKey: true, altKey: true }))).toBeNull();
    });

    it('the same keys with any other modifier mix go to the remote machine', () => {
        expect(stageShortcut(key('Home'))).toBeNull();
        expect(stageShortcut(key('Home', { ctrlKey: true }))).toBeNull();
        expect(stageShortcut(key('Home', { altKey: true }))).toBeNull();
        expect(stageShortcut(key('End', { ctrlKey: true, altKey: true, shiftKey: true }))).toBeNull();
        expect(stageShortcut(key('Enter', { ctrlKey: true, altKey: true, metaKey: true }))).toBeNull();
        expect(stageShortcut(key('KeyA', { ctrlKey: true, altKey: true }))).toBeNull();
    });
});

describe('typing text on the remote machine', () => {
    it('one line is one text frame', () => {
        expect(typeTextEvents('hello')).toEqual([{ t: 'text', text: 'hello' }]);
    });

    it('a line break is an Enter key between lines (a text frame refuses control characters)', () => {
        expect(typeTextEvents('ab\ncd')).toEqual([
            { t: 'text', text: 'ab' },
            { t: 'key', code: 'Enter', down: true },
            { t: 'key', code: 'Enter', down: false },
            { t: 'text', text: 'cd' },
        ]);
        // CRLF and a lone CR are one line break each, not two.
        expect(typeTextEvents('ab\r\ncd')).toEqual(typeTextEvents('ab\ncd'));
        expect(typeTextEvents('ab\rcd')).toEqual(typeTextEvents('ab\ncd'));
    });

    it('a tab is a Tab key; other control characters are dropped', () => {
        expect(typeTextEvents('a\tb')).toEqual([
            { t: 'text', text: 'a' },
            { t: 'key', code: 'Tab', down: true },
            { t: 'key', code: 'Tab', down: false },
            { t: 'text', text: 'b' },
        ]);
        expect(typeTextEvents('a\u0007b\u001bc')).toEqual([{ t: 'text', text: 'abc' }]);
    });

    it('long text is chunked by code point, never splitting a surrogate pair', () => {
        const emoji = '\u{1F600}';
        const text = emoji.repeat(TEXT_CHUNK + 5);
        const chunks = textChunks(text);
        expect(chunks).toHaveLength(2);
        expect(Array.from(chunks[0])).toHaveLength(TEXT_CHUNK);
        expect(chunks.join('')).toBe(text);
        expect(chunks.every(c => !/[\uD800-\uDBFF]$/.test(c)), 'no chunk ends on a lone high surrogate').toBe(true);
    });

    it('nothing to type is nothing', () => {
        expect(typeTextEvents('')).toEqual([]);
        expect(typeTextEvents('\u0007')).toEqual([]);
    });
});

describe('the live numbers', () => {
    const sample = (over: Partial<DeviceStatsSample>): DeviceStatsSample => ({
        at: 0, framesDecoded: 0, bytesReceived: 0, freezeCount: 0, totalDecodeTime: 0,
        jitterBufferDelay: 0, jitterBufferEmittedCount: 0, packetsLost: 0, packetsReceived: 0,
        frameWidth: 1920, frameHeight: 1080, rttMs: 4, path: 'direct', lan: true, protocol: 'udp',
        decoder: null, hardwareDecode: true, inputLane: 'channel', ...over,
    });

    it('rates come from the window between two readings, not the session average', () => {
        const a = sample({ at: 10_000, framesDecoded: 600, bytesReceived: 5_000_000, jitterBufferDelay: 6, jitterBufferEmittedCount: 600, totalDecodeTime: 1.2 });
        // One second later: 60 frames, 1.5 MB, each frame 12 ms in the buffer and 2 ms decoding.
        const b = sample({ at: 11_000, framesDecoded: 660, bytesReceived: 6_500_000, jitterBufferDelay: 6.72, jitterBufferEmittedCount: 660, totalDecodeTime: 1.32 });
        const s = liveStatsFrom(a, b);
        expect(s.fps).toBe(60);
        expect(s.kbps).toBe(12_000);
        expect(s.bufferMs).toBe(12);
        expect(s.decodeMs).toBe(2);
        // Half the 4 ms round trip + 12 + 2.
        expect(s.hereMs).toBe(16);
        expect(s.frame).toBe('1920x1080');
    });

    it('loss is a percentage of the window, and freezes are counted in it', () => {
        const a = sample({ at: 0, packetsReceived: 1000, packetsLost: 10, freezeCount: 2 });
        const b = sample({ at: 1000, packetsReceived: 1990, packetsLost: 20, freezeCount: 3 });
        const s = liveStatsFrom(a, b);
        expect(s.lossPct).toBe(1);
        expect(s.freezes).toBe(1);
    });

    it('a still picture (no frames) reports no buffer or decode figure rather than a made-up one', () => {
        const a = sample({ at: 0, framesDecoded: 100, jitterBufferEmittedCount: 100 });
        const b = sample({ at: 1000, framesDecoded: 100, jitterBufferEmittedCount: 100 });
        const s = liveStatsFrom(a, b);
        expect(s.fps).toBe(0);
        expect(s.bufferMs).toBeNull();
        expect(s.decodeMs).toBeNull();
        expect(s.hereMs).toBeNull();
    });
});
