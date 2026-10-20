/**
 * What a screen share may spend, by its quality (shareBitrate.ts).
 *
 * The incident behind it: every SFU share was capped at 4.5 Mbps, and a
 * fast-motion 1080p share smeared and broke into blocks at that cap while the
 * source was clean. The table now follows the quality, and the server's
 * ceiling (src/sfu.rs `share_ceiling_kbps`) has the last word.
 */
import { describe, it, expect } from 'vitest';

import {
    LEGACY_SHARE_KBPS,
    SHARE_KBPS_TABLE,
    SHARE_TOP_KBPS,
    shareBitrateKbps,
    shareFpsTier,
    shareTier,
} from '../api/rtc/shareBitrate';

const NO_CEILING = 1_000_000;

describe('the bitrate follows the quality', () => {
    it('gives each setting the dialog offers its own figure', () => {
        expect(shareBitrateKbps(1280, 720, 30, NO_CEILING)).toBe(SHARE_KBPS_TABLE[720][30]);
        expect(shareBitrateKbps(1280, 720, 60, NO_CEILING)).toBe(SHARE_KBPS_TABLE[720][60]);
        expect(shareBitrateKbps(1920, 1080, 30, NO_CEILING)).toBe(SHARE_KBPS_TABLE[1080][30]);
        expect(shareBitrateKbps(1920, 1080, 60, NO_CEILING)).toBe(SHARE_KBPS_TABLE[1080][60]);
        expect(shareBitrateKbps(2560, 1440, 30, NO_CEILING)).toBe(SHARE_KBPS_TABLE[1440][30]);
        expect(shareBitrateKbps(2560, 1440, 60, NO_CEILING)).toBe(SHARE_KBPS_TABLE[1440][60]);
        expect(shareBitrateKbps(3840, 2160, 60, NO_CEILING)).toBe(SHARE_KBPS_TABLE[2160][60]);
        expect(shareBitrateKbps(1920, 1080, 15, NO_CEILING)).toBe(SHARE_KBPS_TABLE[1080][15]);
    });

    it('lifts the fast-motion qualities clear of the old single cap', () => {
        // THE POINT OF THE CHANGE. 1080p60 at 4.5 Mbps measured a mean
        // quantiser of ~42 (blocky); the owner asked for about 8-10 Mbps.
        expect(SHARE_KBPS_TABLE[1080][60]).toBeGreaterThanOrEqual(8000);
        expect(SHARE_KBPS_TABLE[1080][60]).toBeLessThanOrEqual(10000);
        expect(SHARE_KBPS_TABLE[1080][30]).toBeGreaterThan(LEGACY_SHARE_KBPS);
        expect(SHARE_KBPS_TABLE[720][60]).toBeGreaterThan(LEGACY_SHARE_KBPS);
        expect(SHARE_KBPS_TABLE[1440][60]).toBeGreaterThan(SHARE_KBPS_TABLE[1080][60]);
    });

    it('never spends more on fewer pixels or fewer frames', () => {
        const tiers = [720, 1080, 1440, 2160] as const;
        const fpss = [15, 30, 60] as const;
        for (const t of tiers) {
            for (let i = 1; i < fpss.length; i++) {
                expect(SHARE_KBPS_TABLE[t][fpss[i]], `${t}p${fpss[i]}`).toBeGreaterThan(SHARE_KBPS_TABLE[t][fpss[i - 1]]);
            }
        }
        for (const f of fpss) {
            for (let i = 1; i < tiers.length; i++) {
                expect(SHARE_KBPS_TABLE[tiers[i]][f], `${tiers[i]}p${f}`).toBeGreaterThan(SHARE_KBPS_TABLE[tiers[i - 1]][f]);
            }
        }
    });

    it('names its largest entry as the top the server mirrors', () => {
        // src/sfu.rs reads SHARE_TOP_KBPS from this file; it must really be
        // the table's top, or the server's ceiling would clip a quality the
        // table offers, or leave room nothing uses.
        const all = Object.values(SHARE_KBPS_TABLE).flatMap(r => Object.values(r));
        expect(Math.max(...all)).toBe(SHARE_TOP_KBPS);
    });
});

describe('the server has the last word', () => {
    it('holds every quality to the ceiling the server named', () => {
        expect(shareBitrateKbps(1920, 1080, 60, 5521)).toBe(5521);
        // ...and a ceiling above the quality's own figure changes nothing.
        expect(shareBitrateKbps(1280, 720, 30, 20000)).toBe(SHARE_KBPS_TABLE[720][30]);
    });

    it('keeps the old 4.5 Mbps on a server that names no ceiling', () => {
        // An older backend answers without `max_share_kbps`, and its admission
        // still charges 4.5 Mbps per share: sending more there would put real
        // egress over what it admitted.
        expect(shareBitrateKbps(1920, 1080, 60, undefined)).toBe(LEGACY_SHARE_KBPS);
        expect(shareBitrateKbps(1920, 1080, 60, 0)).toBe(LEGACY_SHARE_KBPS);
        expect(shareBitrateKbps(1920, 1080, 60, Number.NaN)).toBe(LEGACY_SHARE_KBPS);
        expect(shareBitrateKbps(1920, 1080, 60, -1)).toBe(LEGACY_SHARE_KBPS);
        // POSITIVE CONTROL: a quality below the legacy cap keeps its own.
        expect(shareBitrateKbps(1280, 720, 15, undefined)).toBe(SHARE_KBPS_TABLE[720][15]);
    });
});

describe('which tier a capture is', () => {
    it('puts the standard sizes in their own tier', () => {
        expect(shareTier(1280, 720)).toBe(720);
        expect(shareTier(1920, 1080)).toBe(1080);
        expect(shareTier(2560, 1440)).toBe(1440);
        expect(shareTier(3840, 2160)).toBe(2160);
    });

    it('goes by pixels, so an ultrawide pays for the picture it has', () => {
        // 3440x1440 is 34% more picture than 2560x1440.
        expect(shareTier(3440, 1440)).toBe(2160);
        expect(shareTier(2560, 1080)).toBe(1440);
        // A window a little over 1080p (borders) stays 1080p...
        expect(shareTier(1936, 1096)).toBe(1080);
        // ...and a smaller window is the smaller tier.
        expect(shareTier(1600, 900)).toBe(1080);
        expect(shareTier(1024, 768)).toBe(720);
    });

    it('reads a capture that reports no size as 1080p, not as the smallest', () => {
        expect(shareTier(0, 0)).toBe(1080);
        expect(shareTier(0, 1080)).toBe(1080);
    });

    it('rounds the frame rate to the rates the dialog offers', () => {
        expect(shareFpsTier(15)).toBe(15);
        expect(shareFpsTier(30)).toBe(30);
        expect(shareFpsTier(29.97)).toBe(30);
        expect(shareFpsTier(60)).toBe(60);
        expect(shareFpsTier(45)).toBe(60);
        expect(shareFpsTier(0)).toBe(30);
        expect(shareFpsTier(Number.NaN)).toBe(30);
    });
});
