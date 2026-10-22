/**
 * When a screen share goes out at several sizes, and which (shareLadder.ts).
 *
 * The incident: a viewer whose link is slower than a one-size share's bitrate
 * gets a frozen picture (measured: 6 Mbps viewer, 10 Mbps share, 0 fps), and
 * nothing in LiveKit's config changes that. A ladder lets the SFU send that
 * viewer a smaller copy.
 */
import { describe, it, expect } from 'vitest';

import {
    AUTO_LADDER_ABOVE_KBPS,
    LADDER_LOW,
    LADDER_MID_540,
    LADDER_MID_720,
    LADDER_MID_TOP_KBPS,
    isSoftwareEncoder,
    ladderEncodings,
    ladderRungs,
    ladderSettingsFor,
    rememberedShareLadder,
    shareWantsLadder,
} from '../api/rtc/shareLadder';
import { LEGACY_SHARE_KBPS, SHARE_KBPS_TABLE } from '../api/rtc/shareBitrate';

describe('Automatic', () => {
    it('ladders a hardware-encoded share that sends more than the old cap', () => {
        expect(shareWantsLadder('auto', true, SHARE_KBPS_TABLE[1080][60])).toBe(true);
        expect(shareWantsLadder('auto', true, SHARE_KBPS_TABLE[1080][30])).toBe(true);
    });

    it('leaves a share at or under the old cap at one size', () => {
        // Viewers who could carry 4.5 Mbps before still can.
        expect(AUTO_LADDER_ABOVE_KBPS).toBe(LEGACY_SHARE_KBPS);
        expect(shareWantsLadder('auto', true, SHARE_KBPS_TABLE[720][30])).toBe(false);
        expect(shareWantsLadder('auto', true, AUTO_LADDER_ABOVE_KBPS)).toBe(false);
        expect(shareWantsLadder('auto', true, AUTO_LADDER_ABOVE_KBPS + 1)).toBe(true);
    });

    it('never imposes three SOFTWARE encodes, whatever the bitrate', () => {
        expect(shareWantsLadder('auto', false, SHARE_KBPS_TABLE[1440][60])).toBe(false);
    });

    it('lets the person override it either way', () => {
        expect(shareWantsLadder('always', false, 1000)).toBe(true);
        expect(shareWantsLadder('never', true, 20000)).toBe(false);
    });
});

describe('the remembered mode', () => {
    it('defaults to Automatic', () => {
        expect(rememberedShareLadder({})).toBe('auto');
        expect(rememberedShareLadder({ shareLadder: 'garbage' })).toBe('auto');
    });

    it('keeps the ladder for a profile that had turned the old setting on', () => {
        expect(rememberedShareLadder({ shareSimulcast: true })).toBe('always');
        // ...as stored after loadSettings merges the new default in.
        expect(rememberedShareLadder({ shareSimulcast: true, shareLadder: 'auto' })).toBe('always');
        // POSITIVE CONTROL: the old default (off) is NOT read as Never.
        expect(rememberedShareLadder({ shareSimulcast: false, shareLadder: 'auto' })).toBe('auto');
    });

    it('a choice made with the new control is read back as made', () => {
        for (const m of ['auto', 'always', 'never'] as const) {
            expect(rememberedShareLadder({ shareSimulcast: true, ...ladderSettingsFor(m) })).toBe(m);
        }
    });
});

describe('the rungs', () => {
    it('uses a 720p middle rung from a 1080-line capture up', () => {
        expect(ladderRungs(1920, 1080)).toEqual([LADDER_LOW, LADDER_MID_720]);
        expect(ladderRungs(2560, 1440)).toEqual([LADDER_LOW, LADDER_MID_720]);
        expect(ladderRungs(3440, 1440)).toEqual([LADDER_LOW, LADDER_MID_720]);
    });

    it('keeps 540p below that, so a 720p capture is not encoded at 720p twice', () => {
        expect(ladderRungs(1280, 720)).toEqual([LADDER_LOW, LADDER_MID_540]);
        expect(ladderRungs(1600, 900)).toEqual([LADDER_LOW, LADDER_MID_540]);
    });

    it('never goes under the 360 lines Chromium encodes in hardware', () => {
        for (const [w, h] of [[1280, 720], [1920, 1080], [3840, 2160]]) {
            for (const r of ladderRungs(w, h)) expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(360);
        }
    });

    it('names its largest middle rung for the server, which keeps every ceiling above it', () => {
        expect(Math.max(LADDER_MID_540.kbps, LADDER_MID_720.kbps)).toBe(LADDER_MID_TOP_KBPS);
        // Every quality whose share can be laddered by Automatic sends more
        // than the middle rung, so no rung is above its top.
        for (const t of [1080, 1440, 2160] as const) {
            for (const f of [30, 60] as const) expect(SHARE_KBPS_TABLE[t][f]).toBeGreaterThan(LADDER_MID_TOP_KBPS);
        }
    });
});

describe('re-sizing a ladder in place', () => {
    it('computes the rungs as livekit-client does at publish', () => {
        // encodingsFromPresets: scale = short side / preset short side.
        expect(ladderEncodings(1920, 1080, 10000)).toEqual([
            { rid: 'q', scaleResolutionDownBy: 3, maxBitrate: 600_000, maxFramerate: 30 },
            { rid: 'h', scaleResolutionDownBy: 1.5, maxBitrate: 2_500_000, maxFramerate: 60 },
            { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 10_000_000, maxFramerate: 60 },
        ]);
    });

    it('keeps the bottom rung at 360 lines when the capture shrinks', () => {
        // The bug this replaces: a re-capped capture shrank every rung by the
        // same ratio, and 1080 -> 720 took the bottom rung to 240 lines.
        const e = ladderEncodings(1280, 720, 6000);
        expect(720 / e[0].scaleResolutionDownBy).toBe(360);
        expect(720 / e[1].scaleResolutionDownBy).toBe(540);
        expect(e[2]).toMatchObject({ scaleResolutionDownBy: 1, maxBitrate: 6_000_000 });
    });
});

describe('software encoders', () => {
    it('recognises them, also inside the simulcast wrapper', () => {
        expect(isSoftwareEncoder('OpenH264')).toBe(true);
        expect(isSoftwareEncoder('SimulcastEncoderAdapter (OpenH264, OpenH264, OpenH264)')).toBe(true);
        expect(isSoftwareEncoder('libvpx')).toBe(true);
    });

    it('does not mistake a hardware encoder for one', () => {
        expect(isSoftwareEncoder('MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)')).toBe(false);
        expect(isSoftwareEncoder(undefined)).toBe(false);
    });
});
