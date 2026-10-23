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
        // Over a profile that had the old switch on: the control writes both
        // fields, so even Automatic is not read back as Always.
        const oldSwitchOn = { shareSimulcast: true };
        for (const m of ['auto', 'always', 'never'] as const) {
            expect(rememberedShareLadder({ ...oldSwitchOn, ...ladderSettingsFor(m) })).toBe(m);
        }
    });
});

describe('the rungs', () => {
    const top = SHARE_KBPS_TABLE[1080][60];

    it('uses a 720p middle rung from a 1080-line capture up', () => {
        expect(ladderRungs(1920, 1080, top)).toEqual([LADDER_LOW, LADDER_MID_720]);
        expect(ladderRungs(2560, 1440, top)).toEqual([LADDER_LOW, LADDER_MID_720]);
        expect(ladderRungs(3440, 1440, top)).toEqual([LADDER_LOW, LADDER_MID_720]);
        // Portrait: the SHORT side decides, as livekit-client scales by it.
        expect(ladderRungs(1080, 1920, top)).toEqual([LADDER_LOW, LADDER_MID_720]);
    });

    it('keeps 540p below that, so a 720p capture is not encoded at 720p twice', () => {
        expect(ladderRungs(1280, 720, top)).toEqual([LADDER_LOW, LADDER_MID_540]);
        expect(ladderRungs(1600, 900, top)).toEqual([LADDER_LOW, LADDER_MID_540]);
    });

    it('never goes under the 360 lines Chromium encodes in hardware', () => {
        for (const [w, h] of [[1280, 720], [1920, 1080], [3840, 2160], [800, 600]]) {
            for (const r of ladderRungs(w, h, top)) expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(360);
        }
    });

    it('sends nothing the size of the capture: a small capture gets fewer rungs, a tiny one none', () => {
        // A rung at the capture's own size would be a second full encode
        // (livekit-client never scales a rung UP: scaleResolutionDownBy >= 1).
        expect(ladderRungs(960, 540, top), '540 lines: only 360p is smaller').toEqual([LADDER_LOW]);
        expect(ladderRungs(1024, 576, top)).toEqual([LADDER_LOW, LADDER_MID_540]);
        expect(ladderRungs(640, 360, top), '360 lines: nothing smaller to send').toEqual([]);
        expect(ladderRungs(480, 270, top)).toEqual([]);
    });

    it('asks for no rung livekit-client would not build (a middle one needs 960 px, any one 480)', () => {
        // computeVideoEncodings: three encodings only when the LONGER side is
        // 960+ and a middle preset exists, two from 480. A middle rung it
        // drops would leave the in-place re-size writing to an encoding that
        // is not there.
        expect(ladderRungs(900, 700, top), '700 lines but 900 px wide: two encodings').toEqual([LADDER_LOW]);
        expect(ladderRungs(959, 600, top)).toEqual([LADDER_LOW]);
        expect(ladderRungs(960, 600, top)).toEqual([LADDER_LOW, LADDER_MID_540]);
        expect(ladderRungs(470, 400, top), 'under 480 px: one encoding').toEqual([]);
    });

    it('keeps every rung below the top, also under an older server\'s lower ceiling', () => {
        // A server from before SHARE_MIN_KBPS was raised may set 1.5 Mbps; the
        // 720p rung at 2.5 Mbps would then send more than the full picture.
        expect(ladderRungs(1920, 1080, 2000)).toEqual([LADDER_LOW, LADDER_MID_540]);
        expect(ladderRungs(1920, 1080, LADDER_MID_720.kbps), 'equal is not below').toEqual([LADDER_LOW, LADDER_MID_540]);
        expect(ladderRungs(1920, 1080, 1100)).toEqual([LADDER_LOW]);
        expect(ladderRungs(1920, 1080, 500)).toEqual([]);
        // POSITIVE CONTROL: just above the middle rung, it is used.
        expect(ladderRungs(1920, 1080, LADDER_MID_720.kbps + 1)).toEqual([LADDER_LOW, LADDER_MID_720]);
    });

    it('a capture of unknown size gets no ladder (livekit-client sends one encoding then too)', () => {
        expect(ladderRungs(0, 0, top)).toEqual([]);
        expect(ladderRungs(1920, 0, top)).toEqual([]);
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
        expect(e[2]).toMatchObject({ rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 6_000_000 });
    });

    it('names the full picture `h` on a two-encoding ladder, as livekit-client does', () => {
        // videoRids by position: [low, original] is q + h. Matching the
        // middle rung's numbers to `h` there would shrink the whole picture.
        expect(ladderEncodings(900, 700, 6000)).toEqual([
            { rid: 'q', scaleResolutionDownBy: 700 / 360, maxBitrate: 600_000, maxFramerate: 30 },
            { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 6_000_000, maxFramerate: 60 },
        ]);
    });

    it('takes the rungs it is given (the ones the share was published with)', () => {
        expect(ladderEncodings(1920, 1080, 10000, [LADDER_LOW]).map(e => e.rid)).toEqual(['q', 'h']);
    });
});

describe('software encoders', () => {
    it('recognises them, also inside the simulcast wrapper', () => {
        expect(isSoftwareEncoder('OpenH264')).toBe(true);
        expect(isSoftwareEncoder('SimulcastEncoderAdapter (OpenH264, OpenH264, OpenH264)')).toBe(true);
        // One software rung among hardware ones still counts.
        expect(isSoftwareEncoder('SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator, OpenH264)')).toBe(true);
        expect(isSoftwareEncoder('libvpx')).toBe(true);
    });

    it('does not mistake a hardware encoder for one', () => {
        expect(isSoftwareEncoder('MediaFoundationVideoEncodeAccelerator (NVIDIA H.264 Encoder MFT)')).toBe(false);
        expect(isSoftwareEncoder(undefined)).toBe(false);
    });
});
