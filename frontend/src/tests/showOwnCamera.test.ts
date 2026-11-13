// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { globalCameraStreams, showOwnCamera, subscribeToStreamState } from '../components/voiceState';

/**
 * Your own camera on the stage after a camera switch (voiceState.showOwnCamera,
 * called by VoicePanel's applyCameraSwitch once the switch has gone to every
 * peer and the SFU, after awaits). A camera turned off, or a call left, in
 * that time has stopped the track and removed your entry; putting it back
 * showed a black tile of you with your camera off, and on an SFU call the
 * stale entry outlived the call.
 */

const track = (readyState: 'live' | 'ended') => ({ kind: 'video', id: `t-${readyState}`, readyState, enabled: true }) as unknown as MediaStreamTrack;

beforeEach(() => { globalCameraStreams.clear(); });

describe('your own camera on the stage after a switch', () => {
    it('a live camera is shown, as a fresh stream of that track, and the stage is told', () => {
        let told = 0;
        const off = subscribeToStreamState(() => { told++; });
        expect(showOwnCamera(7, track('live'))).toBe(true);
        off();
        expect(globalCameraStreams.has(7)).toBe(true);
        expect(told).toBe(1);
    });

    it('a camera stopped meanwhile (turned off, or the call left) is not put back', () => {
        let told = 0;
        const off = subscribeToStreamState(() => { told++; });
        expect(showOwnCamera(7, track('ended'))).toBe(false);
        off();
        expect(globalCameraStreams.has(7), 'a black tile of you came back with the camera off').toBe(false);
        expect(told).toBe(0);
    });
});
