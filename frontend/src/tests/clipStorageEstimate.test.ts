/**
 * WHAT A SAVED CLIP COSTS, AND WHICH LIMIT IT HITS. Settings priced only the
 * RAM of the rolling buffer; nothing said how big a POSTED clip is, and the
 * app's own limits (64 parts, the 1 GiB in-app download, the 768 MiB trim,
 * the per-member clip storage) were nowhere a member could see them before a
 * seal had been paid for. clipStorageBytes / clipLimits are the one place that
 * arithmetic lives; every readout (Settings, the composer chips, Server
 * Settings' Longest clip) is built from them.
 */
import { describe, it, expect } from 'vitest';
import {
    CLIP_DOWNLOAD_LIMIT_BYTES, CLIP_MAX_PARTS, CLIP_PART_OVERHEAD_BYTES, CLIP_PART_PLAIN_BYTES, CLIP_TRIM_LIMIT_BYTES, GIB,
    clipLimits, clipPreset, clipStorageBytes, formatMB, ringSecondsFor,
} from '../api/clips/clipPresets';
import { MAX_CLIP_PARTS } from '../api/clips/clipRef';
import { PART_HEADER_BYTES, PART_MAX_PLAINTEXT, PART_TAG_BYTES } from '../api/clips/clipCrypto';
import { CLIP_DOWNLOAD_MAX_BYTES } from '../api/clips/clipPlayback';
import { TRIM_MAX_CIPHER_BYTES } from '../api/clips/clipTrim';

describe('clipStorageBytes — the size of a saved clip', () => {
    it('the limits it checks are the ones the app enforces (no private copies that can drift)', () => {
        expect(CLIP_MAX_PARTS).toBe(MAX_CLIP_PARTS);
        expect(CLIP_PART_PLAIN_BYTES).toBe(PART_MAX_PLAINTEXT);
        expect(CLIP_PART_OVERHEAD_BYTES).toBe(PART_HEADER_BYTES + PART_TAG_BYTES);
        expect(CLIP_DOWNLOAD_LIMIT_BYTES).toBe(CLIP_DOWNLOAD_MAX_BYTES);
        expect(CLIP_TRIM_LIMIT_BYTES).toBe(TRIM_MAX_CIPHER_BYTES);
    });

    it('1080p30 for 2:00 is 91.92 MB of media in 4 parts, about 88 MB', () => {
        // (6 000 000 + 128 000) / 8 × 120 = 91 920 000; ceil(/24 MiB) = 4 parts × 35 B.
        const b = clipStorageBytes(clipPreset('1080p30'), 120);
        expect(b).toBe(91_920_000 + 4 * 35);
        expect(formatMB(b)).toBe('88 MB');
        const l = clipLimits(b, 2 * GIB);
        expect(l).toMatchObject({ parts: 4, overParts: false, overDownload: false, overTrim: false });
        expect(l.quotaShare!).toBeCloseTo(91_920_140 / (2 * GIB), 9);
    });

    it('480p for 2:00 is 31.92 MB of media in 2 parts, about 30 MB — a third of 1080p30', () => {
        // (2 000 000 + 128 000) / 8 × 120 = 31 920 000; ceil(/24 MiB) = 2 parts × 35 B.
        const b = clipStorageBytes(clipPreset('480p30'), 120);
        expect(b).toBe(31_920_000 + 2 * 35);
        expect(formatMB(b)).toBe('30 MB');
        // Even the server maximum (10:00) fits every in-app limit.
        expect(clipLimits(clipStorageBytes(clipPreset('480p30'), 600))).toMatchObject({ parts: 7, overParts: false, overDownload: false, overTrim: false });
    });

    it('4K for 10:00 is over BOTH the download and the trim limit, and most of the storage', () => {
        const b = clipStorageBytes(clipPreset('2160p30'), 600);
        expect(b).toBe(1_362_000_000 + 55 * 35);
        const l = clipLimits(b, 2 * GIB);
        expect(l).toMatchObject({ parts: 55, overParts: false, overDownload: true, overTrim: true });
        expect(l.quotaShare!).toBeGreaterThan(0.63);
        expect(l.quotaShare!).toBeLessThan(0.64);
    });

    it('positive control between the two limits: Native for 10:00 can be downloaded but not trimmed', () => {
        const l = clipLimits(clipStorageBytes(clipPreset('native'), 600));
        expect(l).toMatchObject({ parts: 43, overDownload: false, overTrim: true, quotaShare: null });
    });

    it('flags a clip that needs more parts than a clip reference can carry', () => {
        const l = clipLimits(clipStorageBytes(clipPreset('2160p30'), 900));
        expect(l.parts).toBe(82);
        expect(l.overParts).toBe(true);
        expect(clipLimits(64 * PART_MAX_PLAINTEXT).overParts).toBe(false);
        expect(clipLimits(64 * PART_MAX_PLAINTEXT + 1).overParts).toBe(true);
    });

    it('a measured bitrate can be priced too (the composer uses the live kbps)', () => {
        expect(clipStorageBytes({ videoBitrate: 8_000_000, audioBitrate: 0 }, 60)).toBe(60_000_000 + 3 * 35);
        expect(clipStorageBytes(clipPreset('1080p30'), 0)).toBe(0);
    });
});

describe('ringSecondsFor — the buffer never holds more than the server lets you post', () => {
    it('clamps to the server cap plus one 2 s keyframe interval', () => {
        expect(ringSecondsFor(300, 120)).toBe(122);
        expect(ringSecondsFor(900, 600)).toBe(602);
    });
    it('leaves a shorter buffer alone (positive control)', () => {
        expect(ringSecondsFor(60, 120)).toBe(60);
        expect(ringSecondsFor(120, 120)).toBe(120);
    });
    it('no known cap means the user’s setting stands', () => {
        expect(ringSecondsFor(300, undefined)).toBe(300);
        expect(ringSecondsFor(300, null)).toBe(300);
        expect(ringSecondsFor(300, 0)).toBe(300);
        expect(ringSecondsFor(300, Number.NaN)).toBe(300);
    });
});
