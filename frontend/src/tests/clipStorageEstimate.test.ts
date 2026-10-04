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
    CLIP_DOWNLOAD_LIMIT_BYTES, CLIP_MAX_PARTS, CLIP_PART_OVERHEAD_BYTES, CLIP_PART_PLAIN_BYTES, CLIP_PART_RAMP_FRAGMENTS, CLIP_RING_GOP_SECONDS, CLIP_TRIM_LIMIT_BYTES, GIB,
    clipLimits, clipPartCount, clipPreset, clipStorageBytes, formatMB, ringSecondsFor,
} from '../api/clips/clipPresets';
import { Fmp4Splitter, PART_RAMP_FRAGMENTS, fitPartCount, type SplitPart } from '../api/clips/fmp4Split';
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
        expect(CLIP_PART_RAMP_FRAGMENTS).toEqual(PART_RAMP_FRAGMENTS);
    });

    // Parts are counted the way fmp4Split cuts them: an init-only part 0, then
    // the ramp (media parts of 1, 2, 4 and 8 whole 2 s fragments, each still
    // under 24 MiB), then whole fragments packed under 24 MiB
    // (perPart = floor(24 MiB / frag)) — or flat with no ramp when the ramp
    // would need more than 64 parts.
    it('1080p30 for 2:00 is 91.92 MB of media in 8 parts (init + 4 ramp + 3), about 88 MB', () => {
        // (6 000 000 + 128 000) / 8 = 766 000 B/s; a 2 s fragment is 1 532 000 B,
        // 16 fit a part; 60 fragments -> 15 in the ramp's 4 parts, 45 in 3 more,
        // + the init part.
        const b = clipStorageBytes(clipPreset('1080p30'), 120);
        expect(b).toBe(91_920_000 + 8 * 35);
        expect(formatMB(b)).toBe('88 MB');
        const l = clipLimits(clipPreset('1080p30'), 120, 2 * GIB);
        expect(l).toMatchObject({ bytes: b, parts: 8, overParts: false, overDownload: false, overTrim: false });
        expect(l.quotaShare!).toBeCloseTo(b / (2 * GIB), 9);
    });

    it('480p for 2:00 is 31.92 MB of media in 6 parts, about 30 MB — a third of 1080p30', () => {
        // 266 000 B/s; 532 000 B fragments, 47 per part; 60 fragments -> 4 ramp + 1 + init.
        const b = clipStorageBytes(clipPreset('480p30'), 120);
        expect(b).toBe(31_920_000 + 6 * 35);
        expect(formatMB(b)).toBe('30 MB');
        // Even the server maximum (10:00) fits every in-app limit: 300 fragments -> 4 ramp + 7 + init.
        expect(clipLimits(clipPreset('480p30'), 600)).toMatchObject({ parts: 12, overParts: false, overDownload: false, overTrim: false });
    });

    it('4K for 10:00 is over BOTH the download and the trim limit, and most of the storage', () => {
        // 2 270 000 B/s; 4 540 000 B fragments, only 5 fit a part, so the ramp
        // is 1, 2, 4 and 5 (12 fragments); 300 -> 4 + 58 + init = 63, which
        // still fits 64, so the ramp stays.
        const b = clipStorageBytes(clipPreset('2160p30'), 600);
        expect(b).toBe(1_362_000_000 + 63 * 35);
        const l = clipLimits(clipPreset('2160p30'), 600, 2 * GIB);
        expect(l).toMatchObject({ parts: 63, overParts: false, overDownload: true, overTrim: true });
        expect(l.quotaShare!).toBeGreaterThan(0.63);
        expect(l.quotaShare!).toBeLessThan(0.64);
    });

    it('positive control between the two limits: Native for 10:00 can be downloaded but not trimmed', () => {
        // 1 770 000 B/s; 7 fragments a part; ramp 1, 2, 4, 7 (14); 300 -> 4 + 41 + init.
        const l = clipLimits(clipPreset('native'), 600);
        expect(l).toMatchObject({ parts: 46, overDownload: false, overTrim: true, quotaShare: null });
    });

    it('flags a clip that needs more parts than a clip reference can carry — the init part counts', () => {
        expect(clipLimits(clipPreset('2160p30'), 900)).toMatchObject({ parts: 91, overParts: true });
        // The exact edge at 4K: 315 fragments = 63 media parts + init = 64 posts;
        // one more fragment needs a 65th part and the seal refuses it. Counting
        // bytes / 24 MiB (no init part, no whole-fragment packing) put this
        // edge near 11:05 instead of 10:30. The ramp would need 66 parts at
        // 630 s, so the seal re-cuts that clip flat (fitPartCount) and the
        // edge does not move: the ramp never costs a clip its ability to post.
        expect(clipLimits(clipPreset('2160p30'), 630)).toMatchObject({ parts: CLIP_MAX_PARTS, overParts: false });
        expect(clipLimits(clipPreset('2160p30'), 632)).toMatchObject({ parts: CLIP_MAX_PARTS + 1, overParts: true });
    });

    it('a measured bitrate can be priced too (the composer uses the live kbps)', () => {
        // 1 000 000 B/s; 2 000 000 B fragments, 12 a part; 30 -> 4 ramp (15) + 2 + init.
        expect(clipStorageBytes({ videoBitrate: 8_000_000, audioBitrate: 0 }, 60)).toBe(60_000_000 + 7 * 35);
        expect(clipStorageBytes(clipPreset('1080p30'), 0)).toBe(0);
        expect(clipLimits(clipPreset('1080p30'), 0)).toMatchObject({ bytes: 0, parts: 0, overParts: false });
    });
});

// ---- the part count is the REAL splitter's -----------------------------------
// The same rule at 1/1024 scale (24 KiB parts, rates in bytes per second /
// 1024), run through the Fmp4Splitter the seal uses — with the seal's ramp and
// its 64-part fallback (fitPartCount) — on a synthetic stream of one fragment
// per 2 s keyframe interval. If either side changes how it packs, this goes red.
const enc = new TextEncoder();
function box(type: string, payloadBytes: number): Uint8Array {
    const out = new Uint8Array(8 + payloadBytes);
    new DataView(out.buffer).setUint32(0, out.byteLength);
    out.set(enc.encode(type), 4);
    return out;
}
function splitterParts(bytesPerSecond: number, seconds: number, budget: number): number {
    const frag = bytesPerSecond * CLIP_RING_GOP_SECONDS;
    const parts: SplitPart[] = [];
    const sp = new Fmp4Splitter(budget, p => parts.push(p), PART_RAMP_FRAGMENTS);
    sp.push(box('ftyp', 8));
    sp.push(box('moov', 0));
    for (let i = 0; i < Math.ceil(seconds / CLIP_RING_GOP_SECONDS); i++) {
        sp.push(box('moof', 0));
        sp.push(box('mdat', frag - 16)); // moof + mdat = exactly one fragment
    }
    sp.end();
    const fitted = fitPartCount(parts, budget, MAX_CLIP_PARTS);
    expect(fitted[0].isInit).toBe(true);
    return fitted.length;
}

describe('clipPartCount matches what Fmp4Splitter really produces', () => {
    const budget = CLIP_PART_PLAIN_BYTES / 1024;
    // The real presets' rates, scaled: 4K, Native, 1080p30, 480p.
    for (const bps of [2270, 1770, 766, 266]) {
        for (const seconds of [2, 60, 120, 600, 630, 632, 900]) {
            it(`${bps * 1024} B/s for ${seconds} s`, () => {
                const helper = clipPartCount({ videoBitrate: bps * 8, audioBitrate: 0 }, seconds, budget);
                expect(helper).toBe(splitterParts(bps, seconds, budget));
            });
        }
    }
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
