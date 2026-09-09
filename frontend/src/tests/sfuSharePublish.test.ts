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
import { describe, it, expect } from 'vitest';

import { screenSharePublishOptions, publicationsHaveLadder } from '../api/rtc/sfuManager';
import { Track } from 'livekit-client';

describe('the screen-share publish contract', () => {
    it('publishes more than one rung', () => {
        const o = screenSharePublishOptions(true);
        expect(o.simulcast, 'one layer means nothing to fall back to').toBe(true);
        expect(o.screenShareSimulcastLayers.length).toBeGreaterThan(0);
    });

    it('orders the rungs lowest first, as LiveKit requires', () => {
        // "the layers need to be ordered from lowest to highest quality"
        // — livekit-client's own TrackPublishOptions docs. Out of order they
        // are not rejected; they are just wrong, which is the worst kind.
        const layers = screenSharePublishOptions(true).screenShareSimulcastLayers;
        for (let i = 1; i < layers.length; i++) {
            expect(layers[i].width, `layer ${i} must be wider than ${i - 1}`)
                .toBeGreaterThan(layers[i - 1].width);
            expect(layers[i].encoding.maxBitrate)
                .toBeGreaterThan(layers[i - 1].encoding.maxBitrate);
        }
    });

    it('keeps every extra rung BELOW the full picture', () => {
        // The backend charges each share subscriber the top rung
        // (SHARE_KBPS in src/sfu.rs) and a subscriber only ever receives one,
        // so that charge is the correct worst case only while nothing here
        // exceeds it. A rung above the primary would silently over-run the
        // node's egress budget.
        const o = screenSharePublishOptions(true);
        const top = o.videoEncoding.maxBitrate;
        for (const l of o.screenShareSimulcastLayers) {
            expect(l.encoding.maxBitrate, 'no rung may exceed the primary').toBeLessThan(top);
            expect(l.width).toBeLessThan(1920);
        }
    });

    it('stays on H.264, which is the only codec that can carry the ladder', () => {
        // Measured with frontend/e2e/share-ramp-2pc.mjs: h264 sustains all
        // three rungs at 56 / 56 / 16 fps where the same ladder in VP8 falls
        // to 19 / 7 / 4. Switching codec here without re-measuring would turn
        // a fix for one viewer into a regression for everybody. (That run used
        // a hardware H.264 encoder the shipped app does not get — which is why
        // the ladder is off by default, not why h264 is the right codec.)
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
        for (const l of screenSharePublishOptions(true).screenShareSimulcastLayers) {
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
        expect(screenSharePublishOptions(true).videoEncoding.maxFramerate).toBe(60);
    });
});

describe('turning the ladder off', () => {
    // The cost of the ladder lands on the person SHARING -- two extra encodes
    // and about 1.5 Mbps more upload -- so `shareSimulcast` lets them decline
    // it. Nobody should have to choose between sharing a game and playing it.

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
        expect(off.degradationPreference).toBe(on.degradationPreference);
        expect(off.videoEncoding).toEqual(on.videoEncoding);
        expect(off.source).toBe(on.source);
    });
});

describe('the default, with nothing configured', () => {
    it('does NOT impose extra encodes on a machine nobody has measured', () => {
        // THE REVERSAL, one day after shipping it on. The rig that cleared the
        // ladder measured a HARDWARE H.264 encoder; every stream-diag line in
        // the field reads `encoder=OpenH264`, which is software. So the
        // measurement justifying three encodes was taken against an encoder no
        // user has, on a machine far faster than the ones that report their
        // game stuttering while they share.
        //
        // Called with NO argument on purpose: this is the path the app takes,
        // and the parameter's default is where the setting is read.
        const o = screenSharePublishOptions();
        expect(o.simulcast, 'off unless the person sharing opts in').toBe(false);
        expect(o.screenShareSimulcastLayers).toBeUndefined();
    });

});

describe('deciding whether the RUNNING share has a simulcast ladder', () => {
    // The guard that decides whether "Lower it" may re-cap the live track.
    // Re-capping a laddered share shrinks every rung with the source, pushing
    // the bottom one under Chromium's 360-line hardware-encode floor — which
    // is the whole reason SHARE_LOW was raised to 640x360.
    const vid = (encodings: unknown[] | undefined) => ({
        kind: Track.Kind.Video,
        track: { sender: { getParameters: () => ({ encodings }) } },
    });

    it('sees a real ladder', () => {
        // THE ASSERTION THAT MATTERS. This guard fails OPEN — anything it
        // cannot read reads as "no ladder" and permits the re-cap — so the one
        // thing that must never regress is that a genuine ladder IS seen.
        expect(publicationsHaveLadder([vid([{}, {}, {}])])).toBe(true);
        expect(publicationsHaveLadder([vid([{}, {}])])).toBe(true);
    });

    it('does not invent one from a single-encoding share', () => {
        // POSITIVE CONTROL for the case above: a share published with
        // simulcast off must stay re-cappable, or "Lower it" does nothing for
        // the people who turned the ladder off precisely because their machine
        // could not afford it.
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
        // the click handler.
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
