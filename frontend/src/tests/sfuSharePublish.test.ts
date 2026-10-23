// @vitest-environment jsdom
/**
 * How a screen share is published to the SFU.
 *
 * THE INCIDENT THIS PINS, from a real call on 2026-09-08. One viewer on a weak
 * link, watching a 1080p share, with everyone else fine:
 *
 *   size 1920x1080, fps 2, framesReceived 12 in 5 s, framesDropped 0,
 *   packetsLost 899, nack 394, freezeMs 8481, decodeMs 2.6 (hardware decoder)
 *
 * Their machine was idle — 2.6 ms to decode a frame — and the picture arriving
 * was full 1920x1080, because the share was published `simulcast: false`.
 * Everything the server can do for a subscriber in trouble is hand them a
 * smaller layer, and there wasn't one, so it handed them the same bytes as
 * everyone else and their bottleneck ate 899 packets of it. Retransmissions
 * then doubled the traffic on the link that was already failing.
 *
 * So the assertions below are not style. A ladder that silently becomes one
 * rung again puts that viewer back to two frames a second.
 */
import { describe, it, expect, vi } from 'vitest';

import { screenSharePublishOptions, publicationsHaveLadder } from '../api/rtc/sfuManager';
import { LEGACY_SHARE_KBPS, SHARE_KBPS_TABLE } from '../api/rtc/shareBitrate';
import { Track } from 'livekit-client';

/** The extra rungs of a laddered share. The field is optional on the options
 *  (a share with the ladder off carries none — pinned below), so a laddered
 *  share that lost it must fail HERE, loudly, rather than hand the loops below
 *  nothing to iterate and let them pass. */
function ladderLayers() {
    const layers = screenSharePublishOptions(true).screenShareSimulcastLayers;
    if (!layers) throw new Error('a share published with simulcast on carries no screenShareSimulcastLayers');
    return layers;
}

describe('the screen-share publish contract', () => {
    it('publishes more than one rung', () => {
        const o = screenSharePublishOptions(true);
        expect(o.simulcast, 'one layer means nothing to fall back to').toBe(true);
        expect(ladderLayers().length).toBeGreaterThan(0);
    });

    it('orders the rungs lowest first, as LiveKit requires', () => {
        // "the layers need to be ordered from lowest to highest quality"
        // — livekit-client's own TrackPublishOptions docs. Out of order they
        // are not rejected; they are just wrong, which is the worst kind.
        const layers = ladderLayers();
        for (let i = 1; i < layers.length; i++) {
            expect(layers[i].width, `layer ${i} must be wider than ${i - 1}`)
                .toBeGreaterThan(layers[i - 1].width);
            expect(layers[i].encoding.maxBitrate)
                .toBeGreaterThan(layers[i - 1].encoding.maxBitrate);
        }
    });

    it('keeps every extra rung BELOW the full picture', () => {
        // The backend charges each share subscriber the node's share ceiling
        // (room_egress_kbps in src/sfu.rs), the most the top rung may carry,
        // and a subscriber only ever receives one rung, so that charge is the
        // correct worst case only while nothing here exceeds the top. A rung
        // above the primary would silently over-run the node's egress budget.
        // Checked for every quality with the capture it really has (the
        // middle rung follows the capture), down to the lowest top a share can
        // have (720p15), where a fixed rung is likeliest to overtake it.
        const caps: Array<[keyof typeof SHARE_KBPS_TABLE, number, number]> = [
            [720, 1280, 720], [1080, 1920, 1080], [1440, 2560, 1440], [2160, 3840, 2160],
        ];
        let checked = 0;
        for (const [tier, w, h] of caps) {
            for (const fps of [15, 30, 60] as const) {
                const o = screenSharePublishOptions(true, SHARE_KBPS_TABLE[tier][fps] * 1000, { width: w, height: h });
                const top = o.screenShareEncoding.maxBitrate;
                for (const l of o.screenShareSimulcastLayers ?? []) {
                    expect(l.encoding.maxBitrate, `${tier}p${fps}: no rung may exceed the primary`).toBeLessThan(top);
                    expect(l.height, `${tier}p${fps}`).toBeLessThan(h);
                    checked++;
                }
            }
        }
        expect(checked, 'compared rungs, not nothing').toBe(caps.length * 3 * 2);
    });

    it('stays on H.264, which is the only codec that can carry the ladder', () => {
        // Measured with frontend/e2e/share-ramp-2pc.mjs: h264 sustains all
        // three rungs at 56 / 56 / 16 fps where the same ladder in VP8 falls
        // to 19 / 7 / 4. Switching codec here without re-measuring would turn
        // a fix for one viewer into a regression for everybody. (That run used
        // a hardware H.264 encoder the shipped app did not get then — which is
        // why Automatic ladders only where one is offered, not why h264 is the
        // right codec.)
        expect(screenSharePublishOptions(true).videoCodec).toBe('h264');
    });

    it('keeps every rung above the height Chromium encodes in software', () => {
        // MEASURED 2026-09-09, RTX 4080 SUPER, real capture, bitrate pinned:
        // 640x360 used the NVIDIA MFT, 576x324 and 480x270 both fell to
        // OpenH264 — and with kForceSoftwareForRtcLowResolutions disabled as a
        // positive control, all of them used the MFT. A rung below this line
        // can NEVER be hardware-encoded on any machine, so publishing one
        // guarantees a software encode on exactly the people the ladder is
        // meant to spare. The old bottom rung was 480x270.
        const SOFTWARE_FLOOR_LINES = 360;
        for (const l of ladderLayers()) {
            expect(l.height, `${l.width}x${l.height} is below Chromium's hardware floor`)
                .toBeGreaterThanOrEqual(SOFTWARE_FLOOR_LINES);
        }
    });

    it('still protects frame rate over sharpness under congestion', () => {
        // A choppy game stream is worse than a blurry one. Unchanged by the
        // ladder — the rungs decide what a struggling SUBSCRIBER receives, this
        // decides what the encoder gives up when the SENDER is squeezed.
        expect(screenSharePublishOptions(true).degradationPreference).toBe('maintain-framerate');
    });

    it('asks for 60 fps on the primary', () => {
        expect(screenSharePublishOptions(true).screenShareEncoding.maxFramerate).toBe(60);
    });

    it('carries its cap in the field livekit-client actually reads for a share', () => {
        // For a ScreenShare source livekit-client REPLACES videoEncoding with
        // screenShareEncoding (computeVideoEncodings), falling back to the
        // room's publishDefaults. This field was videoEncoding until
        // 2026-10-20: ignored, so a per-quality cap set there would never have
        // reached the encoder.
        const o = screenSharePublishOptions(false, 10_000_000) as Record<string, unknown>;
        expect((o.screenShareEncoding as { maxBitrate: number }).maxBitrate).toBe(10_000_000);
        expect(o.videoEncoding, 'a share cap in videoEncoding is silently ignored').toBeUndefined();
    });

    it('keeps the old 4.5 Mbps when the caller names no bitrate', () => {
        expect(screenSharePublishOptions(false).screenShareEncoding.maxBitrate).toBe(LEGACY_SHARE_KBPS * 1000);
    });
});

describe('turning the ladder off', () => {
    // The cost of the ladder lands on the person SHARING -- two extra encodes
    // and about 1.5 Mbps more upload -- so `shareLadder` (Never) lets them
    // decline it. Nobody should have to choose between sharing a game and
    // playing it.

    it('publishes a single encoding, with no layers left behind', () => {
        const o = screenSharePublishOptions(false);
        expect(o.simulcast).toBe(false);
        // ABSENT, not present-and-ignored. A publish carrying layers it is not
        // using is the shape someone later reads as "simulcast is on".
        expect(o.screenShareSimulcastLayers).toBeUndefined();
    });

    it('changes nothing else about how a share is sent', () => {
        // The rungs decide what a struggling SUBSCRIBER can fall back to.
        // Everything else here is about the sender and must not move with them,
        // or turning this off would quietly become a second, unrelated setting.
        const on = screenSharePublishOptions(true);
        const off = screenSharePublishOptions(false);
        expect(off.videoCodec).toBe(on.videoCodec);
        expect(off.screenShareEncoding).toEqual(on.screenShareEncoding);
        expect(on.screenShareEncoding.maxBitrate, 'compared something, not two undefineds').toBeGreaterThan(0);
        expect(off.source).toBe(on.source);
    });
});

describe('who decides the resolution of a single-layer share', () => {
    // 2026-10-05: a streamer's estimate collapsed and libwebrtc's own
    // 'maintain-framerate' adaptation took the share to 310x180 and left it
    // there. Without a ladder Púca picks the resolution itself (shareAdapt.ts),
    // so libwebrtc must be told to hold it: under 'maintain-framerate' it would
    // shrink the picture again underneath every rung Púca chose.
    it('holds the resolution and lets Púca choose it', () => {
        expect(screenSharePublishOptions(false).degradationPreference).toBe('maintain-resolution');
    });

    it('leaves a laddered share to libwebrtc: its rungs are fixed ratios Púca must not rescale', () => {
        expect(screenSharePublishOptions(true).degradationPreference).toBe('maintain-framerate');
    });
});

describe('the default, with nothing configured', () => {
    it('does NOT impose extra encodes at the old cap, nor on a machine with no hardware encoder', () => {
        // THE REVERSAL, one day after shipping it on. The rig that cleared the
        // ladder measured a HARDWARE H.264 encoder; every stream-diag line in
        // the field read `encoder=OpenH264`, which is software. So the
        // measurement justifying three encodes was taken against an encoder no
        // user had, on a machine far faster than the ones that report their
        // game stuttering while they share. (The software encode was a
        // profile-negotiation accident, fixed 2026-09-16 — h264Profiles.ts —
        // but machines without a hardware encoder still exist and are still
        // the ones complaining, so the default never imposes it on one:
        // Automatic ladders only where a hardware encoder is offered, and only
        // above the old cap — shareLadder.ts.)
        //
        // Called with NO argument on purpose: this is the path the app takes,
        // and the parameter's default is where the setting is read.
        const o = screenSharePublishOptions();
        expect(o.simulcast, 'Automatic leaves a 4.5 Mbps share at one size').toBe(false);
        expect(o.screenShareSimulcastLayers).toBeUndefined();
        // jsdom has no RTCRtpSender: no hardware encoder, so even a 10 Mbps
        // share stays one size under Automatic.
        expect(screenSharePublishOptions(undefined, 10_000_000).simulcast).toBe(false);
    });

    it('ladders a share above the old cap on a machine with a hardware encoder', () => {
        // The High-profile entry is what only a hardware encoder advertises
        // (h264Profiles.ts hasHardwareH264).
        const codecs = [
            { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
            { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032' },
        ];
        vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs, headerExtensions: [] }) });
        try {
            expect(screenSharePublishOptions(undefined, 10_000_000).simulcast).toBe(true);
            expect(screenSharePublishOptions(undefined, 4_500_000).simulcast, 'not at the old cap').toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
        // POSITIVE CONTROL: the same share without the High entry stays one size.
        vi.stubGlobal('RTCRtpSender', { getCapabilities: () => ({ codecs: codecs.slice(0, 1), headerExtensions: [] }) });
        try {
            expect(screenSharePublishOptions(undefined, 10_000_000).simulcast).toBe(false);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('picks the middle rung by the capture', () => {
        const mid = (w: number, h: number) => screenSharePublishOptions(true, 10_000_000, { width: w, height: h }).screenShareSimulcastLayers?.[1];
        expect(mid(1920, 1080)?.height).toBe(720);
        expect(mid(1280, 720)?.height).toBe(540);
    });

    it('sends one size when the capture has nothing smaller to offer, even when asked for several', () => {
        // A rung the size of the capture is a second full-size encode for
        // nothing (livekit-client never scales a rung up).
        const tiny = screenSharePublishOptions(true, 6_000_000, { width: 640, height: 360 });
        expect(tiny.simulcast).toBe(false);
        expect(tiny.screenShareSimulcastLayers).toBeUndefined();
        expect(tiny.degradationPreference, 'one size: Púca picks its resolution').toBe('maintain-resolution');
        // 540 lines: only the 360p rung is smaller.
        const small = screenSharePublishOptions(true, 6_000_000, { width: 960, height: 540 });
        expect(small.simulcast).toBe(true);
        expect(small.screenShareSimulcastLayers?.map(l => l.height)).toEqual([360]);
    });

    it('keeps the middle rung under a low server ceiling', () => {
        // A server from before SHARE_MIN_KBPS was raised may cap a share at
        // 2 Mbps; a 2.5 Mbps middle rung would then send more than the top.
        const o = screenSharePublishOptions(true, 2_000_000, { width: 1920, height: 1080 });
        expect(o.screenShareSimulcastLayers?.map(l => l.height)).toEqual([360, 540]);
        for (const l of o.screenShareSimulcastLayers ?? []) expect(l.encoding.maxBitrate).toBeLessThan(2_000_000);
    });

});

describe('deciding whether the RUNNING share has a simulcast ladder', () => {
    // The guard that keeps the one-size resolution picker (shareAdaptTick)
    // off a ladder: its first encoding is the BOTTOM rung, and re-scaling it
    // as if it were the whole share pushes it under Chromium's 360-line
    // hardware-encode floor — the whole reason the bottom rung is 640x360.
    const vid = (encodings: unknown[] | undefined) => ({
        kind: Track.Kind.Video,
        track: { sender: { getParameters: () => ({ encodings }) } },
    });

    it('sees a real ladder', () => {
        // THE ASSERTION THAT MATTERS. This guard fails OPEN — anything it
        // cannot read reads as "no ladder" and lets the picker in — so the one
        // thing that must never regress is that a genuine ladder IS seen.
        expect(publicationsHaveLadder([vid([{}, {}, {}])])).toBe(true);
        expect(publicationsHaveLadder([vid([{}, {}])])).toBe(true);
    });

    it('does not invent one from a single-encoding share', () => {
        // POSITIVE CONTROL for the case above: a share published at one size
        // must keep its resolution picker, or nobody chooses its resolution
        // for the people whose machine could not afford the ladder.
        expect(publicationsHaveLadder([vid([{}])])).toBe(false);
        expect(publicationsHaveLadder([vid([])])).toBe(false);
        expect(publicationsHaveLadder([vid(undefined)])).toBe(false);
    });

    it('ignores audio publications', () => {
        // A share carries its system audio alongside the video. Counting an
        // audio sender's encodings would answer a question about the wrong
        // track.
        expect(publicationsHaveLadder([
            { kind: Track.Kind.Audio, track: { sender: { getParameters: () => ({ encodings: [{}, {}] }) } } },
        ])).toBe(false);
    });

    it('is false, not a throw, when there is nothing to read', () => {
        // A mesh call has no publications at all; a publication mid-teardown
        // has no track; a detached sender throws. None of those may take down
        // the picker's tick.
        expect(publicationsHaveLadder([])).toBe(false);
        expect(publicationsHaveLadder([{ kind: Track.Kind.Video, track: null }])).toBe(false);
        expect(publicationsHaveLadder([{ kind: Track.Kind.Video, track: { sender: null } }])).toBe(false);
        expect(publicationsHaveLadder([{
            kind: Track.Kind.Video,
            track: { sender: { getParameters: () => { throw new Error('detached'); } } },
        }])).toBe(false);
    });

    it('finds the ladder even when an unreadable publication comes first', () => {
        // Order must not decide the answer: a torn-down audio pub ahead of the
        // live video one would otherwise hide a real ladder.
        expect(publicationsHaveLadder([
            { kind: Track.Kind.Video, track: null },
            vid([{}, {}, {}]),
        ])).toBe(true);
    });
});
