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

import { screenSharePublishOptions } from '../api/rtc/sfuManager';

describe('the screen-share publish contract', () => {
    it('publishes more than one rung', () => {
        const o = screenSharePublishOptions();
        expect(o.simulcast, 'one layer means nothing to fall back to').toBe(true);
        expect(o.screenShareSimulcastLayers.length).toBeGreaterThan(0);
    });

    it('orders the rungs lowest first, as LiveKit requires', () => {
        // "the layers need to be ordered from lowest to highest quality"
        // — livekit-client's own TrackPublishOptions docs. Out of order they
        // are not rejected; they are just wrong, which is the worst kind.
        const layers = screenSharePublishOptions().screenShareSimulcastLayers;
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
        const o = screenSharePublishOptions();
        const top = o.videoEncoding.maxBitrate;
        for (const l of o.screenShareSimulcastLayers) {
            expect(l.encoding.maxBitrate, 'no rung may exceed the primary').toBeLessThan(top);
            expect(l.width).toBeLessThan(1920);
        }
    });

    it('stays on H.264, which is the only codec that can carry the ladder', () => {
        // Measured on the engine the app ships (frontend/e2e/share-ramp-2pc.mjs):
        // h264 sustains 1920x1080@56 / 960x540@56 / 480x270@16 because it
        // encodes in hardware. The same three rungs in VP8 fall to 19 / 7 / 4
        // fps in software. Switching codec here without re-measuring would turn
        // a fix for one viewer into a regression for everybody.
        expect(screenSharePublishOptions().videoCodec).toBe('h264');
    });

    it('still protects frame rate over sharpness under congestion', () => {
        // A choppy game stream is worse than a blurry one. Unchanged by the
        // ladder — the rungs decide what a struggling SUBSCRIBER receives, this
        // decides what the encoder gives up when the SENDER is squeezed.
        expect(screenSharePublishOptions().degradationPreference).toBe('maintain-framerate');
    });

    it('asks for 60 fps on the primary', () => {
        expect(screenSharePublishOptions().videoEncoding.maxFramerate).toBe(60);
    });
});
