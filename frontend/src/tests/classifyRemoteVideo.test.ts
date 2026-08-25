/**
 * The mesh video classification matrix. The case that forced the announced
 * id into existence: a LISTEN-ONLY peer (mic never pinned) who is sharing
 * and then turns their camera on — by elimination both videos looked like
 * the share, so the camera rendered as a share tile AND its receiver
 * overwrote the share's entry in the remote-control latency registry.
 */
import { describe, it, expect } from 'vitest';
import { classifyRemoteVideo } from '../api/rtc/manager';

const base = {
    streamId: 'share-1',
    isVoiceStream: false,
    micPinned: true,
    sharing: true,
    announcedShareId: 'share-1' as string | null,
};

describe('classifyRemoteVideo', () => {
    it('an announced id decides outright: match = screen, anything else = camera', () => {
        expect(classifyRemoteVideo(base)).toBe('screen');
        expect(classifyRemoteVideo({ ...base, streamId: 'cam-9' })).toBe('camera');
    });

    it('THE bug this exists for: a listen-only sharer\'s camera is a camera', () => {
        expect(classifyRemoteVideo({
            streamId: 'cam-9', isVoiceStream: false, micPinned: false,
            sharing: true, announcedShareId: 'share-1',
        })).toBe('camera');
        // ...and their actual share is still the share.
        expect(classifyRemoteVideo({
            streamId: 'share-1', isVoiceStream: false, micPinned: false,
            sharing: true, announcedShareId: 'share-1',
        })).toBe('screen');
    });

    describe('no announced id (old peer or old server): the elimination heuristic, unchanged', () => {
        it('the voice stream is never a share', () => {
            expect(classifyRemoteVideo({
                streamId: 'voice-1', isVoiceStream: true, micPinned: true,
                sharing: true, announcedShareId: null,
            })).toBe('camera');
        });

        it('no pinned mic + not sharing = camera', () => {
            expect(classifyRemoteVideo({
                streamId: 'cam-9', isVoiceStream: false, micPinned: false,
                sharing: false, announcedShareId: null,
            })).toBe('camera');
        });

        it('a non-voice stream from a sharing peer = screen', () => {
            expect(classifyRemoteVideo({
                streamId: 'share-1', isVoiceStream: false, micPinned: true,
                sharing: true, announcedShareId: null,
            })).toBe('screen');
        });

        it('a second stream from a mic-pinned NON-sharing peer stays a share (legacy semantics)', () => {
            // "Screen shares are always announced first" is the assumption the
            // legacy branch leans on; this pins that we did not change it for
            // old peers.
            expect(classifyRemoteVideo({
                streamId: 'mystery-2', isVoiceStream: false, micPinned: true,
                sharing: false, announcedShareId: null,
            })).toBe('screen');
        });

        it('KNOWN misfile preserved for old peers: listen-only sharer\'s camera reads as share', () => {
            // Documented, not desired: without an id there is nothing to tell
            // these apart, and inventing new behaviour for old peers risks
            // breaking the common case to improve the rare one.
            expect(classifyRemoteVideo({
                streamId: 'cam-9', isVoiceStream: false, micPinned: false,
                sharing: true, announcedShareId: null,
            })).toBe('screen');
        });
    });
});
