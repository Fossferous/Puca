/**
 * api/videoDims.ts: the picture size a video declares in its header, as a
 * player shows it, read before (or without) a player — MessageContent sizes a
 * video waiting for a player by it, so getting one moves nothing.
 *
 * The real files under fixtures/video-dims were made with ffmpeg's test
 * pattern; the sizes asserted for them are what headless Edge reported as
 * videoWidth x videoHeight for each (2026-10-05): a quarter-turned MP4/MOV is
 * upright, an anamorphic one is its display size, audio-only is 0 x 0.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readVideoDims } from '../api/videoDims';
import { mp4Header, webmHeader, box, largeBox, trak } from './fixtures/videoHeaders';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('real files: the size a browser reports', () => {
    it.each([
        ['video-dims/320x180.webm', { width: 320, height: 180 }],
        ['video-dims/320x180.mkv', { width: 320, height: 180 }],
        ['video-dims/320x180-rot90.mp4', { width: 180, height: 320 }],
        ['video-dims/320x180-rot90.mov', { width: 180, height: 320 }],
        ['video-dims/180x320-fragmented.mp4', { width: 180, height: 320 }],
        ['video-dims/320x240-sar4-3.mp4', { width: 427, height: 240 }],
        // A Púca Clip as the clip encoder writes it (fragmented, moov first).
        ['clip-avc-1s.mp4', { width: 1920, height: 1080 }],
    ])('%s', (name, dims) => {
        expect(readVideoDims(fixture(name))).toEqual(dims);
    });

    it.each(['video-dims/audio-only.mp4', 'video-dims/audio-only.webm'])('%s has no picture: null', (name) => {
        expect(readVideoDims(fixture(name))).toBeNull();
    });
});

describe('MP4 / MOV headers', () => {
    it('reads the video track, tkhd version 0 and 1', () => {
        expect(readVideoDims(mp4Header())).toEqual({ width: 1920, height: 1080 });
        expect(readVideoDims(mp4Header({ tracks: [{ handler: 'vide', width: 640, height: 480, version: 1 }] }))).toEqual({ width: 640, height: 480 });
    });

    it('a quarter turn is reported upright; a half turn is not swapped', () => {
        expect(readVideoDims(mp4Header({ tracks: [{ handler: 'vide', width: 1920, height: 1080, rotate: 90 }] }))).toEqual({ width: 1080, height: 1920 });
        expect(readVideoDims(mp4Header({ tracks: [{ handler: 'vide', width: 1920, height: 1080, rotate: 270 }] }))).toEqual({ width: 1080, height: 1920 });
        expect(readVideoDims(mp4Header({ tracks: [{ handler: 'vide', width: 1920, height: 1080, rotate: 180 }] }))).toEqual({ width: 1920, height: 1080 });
    });

    it('skips a sound track before the picture, and a picture track of no size', () => {
        const tracks = [
            { handler: 'soun', width: 0, height: 0 },
            { handler: 'vide', width: 0, height: 0 },
            { handler: 'vide', width: 1280, height: 720 },
        ];
        expect(readVideoDims(mp4Header({ tracks }))).toEqual({ width: 1280, height: 720 });
    });

    it('a sound track that claims a size is still not a picture', () => {
        expect(readVideoDims(mp4Header({ tracks: [{ handler: 'soun', width: 1920, height: 1080 }] }))).toBeNull();
    });

    it('finds moov after the media (no "faststart"), past a 64-bit mdat', () => {
        expect(readVideoDims(mp4Header({ moovLast: true, media: 5000 }))).toEqual({ width: 1920, height: 1080 });
        const big = new Uint8Array([
            ...box('ftyp', [105, 115, 111, 109]),
            ...largeBox('mdat', new Array<number>(300).fill(1)),
            ...box('moov', trak({ handler: 'vide', width: 720, height: 1280 })),
        ]);
        expect(readVideoDims(big)).toEqual({ width: 720, height: 1280 });
    });

    it('a cut-off header, a lying box size or random bytes: null, never a throw', () => {
        const whole = mp4Header();
        for (let cut = 0; cut < 400; cut += 7) expect(() => readVideoDims(whole.subarray(0, cut))).not.toThrow();
        expect(readVideoDims(whole.subarray(0, 120))).toBeNull();
        const lying = whole.slice();
        lying.set([0xff, 0xff, 0xff, 0xf0], 0); // ftyp claims ~4 GB
        expect(readVideoDims(lying)).toBeNull();
        let seed = 7;
        const noise = Uint8Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) >>> 0) & 255);
        expect(readVideoDims(noise)).toBeNull();
        expect(readVideoDims(new Uint8Array(0))).toBeNull();
    });
});

describe('Matroska / WebM headers', () => {
    it('reads the pixel size inside a Segment of unknown size (MediaRecorder)', () => {
        expect(readVideoDims(webmHeader())).toEqual({ width: 1280, height: 720 });
    });

    it('the display size wins when it is in pixels; otherwise the pixel size', () => {
        expect(readVideoDims(webmHeader([{ type: 1, width: 1440, height: 1080, displayWidth: 1920, displayHeight: 1080 }]))).toEqual({ width: 1920, height: 1080 });
        expect(readVideoDims(webmHeader([{ type: 1, width: 1440, height: 1080, displayWidth: 16, displayHeight: 9, displayUnit: 3 }]))).toEqual({ width: 1440, height: 1080 });
    });

    it('skips a sound track before the picture; sound only is null', () => {
        expect(readVideoDims(webmHeader([{ type: 2 }, { type: 1, width: 640, height: 360 }]))).toEqual({ width: 640, height: 360 });
        expect(readVideoDims(webmHeader([{ type: 2 }]))).toBeNull();
    });

    it('a cut-off header is null, never a throw', () => {
        const whole = webmHeader();
        for (let cut = 0; cut < whole.length; cut += 3) expect(() => readVideoDims(whole.subarray(0, cut))).not.toThrow();
        expect(readVideoDims(whole.subarray(0, 20))).toBeNull();
    });
});
