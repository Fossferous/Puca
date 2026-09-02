import { describe, it, expect } from 'vitest';
import { AnnouncedVideoGate, classifyRemoteVideo } from '../api/rtc/announcedVideo';

// The manager's release-time context: which stream is the peer's pinned voice
// stream (null = listen-only / not pinned yet).
const ctxOf = (voiceId: string | null) => (streamId: string) => ({
    isVoiceStream: voiceId !== null && streamId === voiceId,
    micPinned: voiceId !== null,
});

describe('AnnouncedVideoGate — mesh video renders only what the server announced', () => {
    it('holds an unannounced camera and releases it exactly once when CameraStarted lands', () => {
        const g = new AnnouncedVideoGate<string>();
        expect(g.offer(7, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam')).toBe('held');
        expect(g.heldCount(7)).toBe(1);
        expect(g.release(7, ctxOf('voice'))).toEqual([]); // nothing announced yet
        g.announceCamera(7);
        expect(g.release(7, ctxOf('voice'))).toEqual([{ kind: 'camera', payload: 'cam' }]);
        expect(g.release(7, ctxOf('voice'))).toEqual([]); // never twice
        expect(g.heldCount(7)).toBe(0);
    });

    it('renders an announced camera immediately', () => {
        const g = new AnnouncedVideoGate<string>();
        g.announceCamera(7);
        expect(g.offer(7, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam')).toBe('camera');
        expect(g.heldCount(7)).toBe(0);
    });

    it("holds a listen-only peer's unannounced share and releases it as a share on ScreenShareStarted", () => {
        const g = new AnnouncedVideoGate<string>();
        // No mic pinned and nothing announced: the elimination heuristic would
        // have called this a camera and rendered it. Held either way.
        expect(g.offer(3, { streamId: 'share', isVoiceStream: false, micPinned: false }, 'scr')).toBe('held');
        g.announceShare(3, 'share');
        expect(g.release(3, ctxOf(null))).toEqual([{ kind: 'screen', payload: 'scr' }]);
    });

    it('with an announced share id, the peer\'s OTHER stream is a camera and still needs its own announcement', () => {
        const g = new AnnouncedVideoGate<string>();
        g.announceShare(3, 'share');
        expect(g.offer(3, { streamId: 'share', isVoiceStream: false, micPinned: true }, 'scr')).toBe('screen');
        expect(g.offer(3, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam')).toBe('held');
        g.announceCamera(3);
        expect(g.release(3, ctxOf('voice'))).toEqual([{ kind: 'camera', payload: 'cam' }]);
    });

    it('a stopped announcement puts later tracks back on hold; a re-announcement releases them', () => {
        const g = new AnnouncedVideoGate<string>();
        g.announceCamera(7);
        g.stopCamera(7);
        expect(g.offer(7, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam2')).toBe('held');
        g.announceCamera(7);
        expect(g.release(7, ctxOf('voice'))).toEqual([{ kind: 'camera', payload: 'cam2' }]);
    });

    it('a second track of the same held stream does not double the release', () => {
        const g = new AnnouncedVideoGate<string>();
        g.offer(3, { streamId: 'share', isVoiceStream: false, micPinned: false }, 'scr');
        g.offer(3, { streamId: 'share', isVoiceStream: false, micPinned: false }, 'scr-again');
        g.announceShare(3, 'share');
        expect(g.release(3, ctxOf(null))).toEqual([{ kind: 'screen', payload: 'scr' }]);
    });

    it('release re-derives the voice pin: a camera held before the mic was pinned still classifies afterwards', () => {
        const g = new AnnouncedVideoGate<string>();
        // Arrived before any audio, so not yet known to be the voice stream.
        g.offer(7, { streamId: 'voice', isVoiceStream: false, micPinned: false }, 'cam');
        g.announceCamera(7);
        expect(g.release(7, ctxOf('voice'))).toEqual([{ kind: 'camera', payload: 'cam' }]);
    });

    it('old peers (an announce without a stream id) keep the elimination heuristic, gated the same way', () => {
        const g = new AnnouncedVideoGate<string>();
        g.announceShare(3, null);
        // Mic pinned, a non-voice stream while sharing: screen, and the share is announced.
        expect(g.offer(3, { streamId: 'x', isVoiceStream: false, micPinned: true }, 'scr')).toBe('screen');
        // The voice stream's video while sharing: camera, which needs its own announcement.
        expect(g.offer(3, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam')).toBe('held');
    });

    it('forgetHeld drops the parked tracks of a torn-down peer but keeps its announcements', () => {
        const g = new AnnouncedVideoGate<string>();
        g.announceShare(3, 'share');
        g.offer(3, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam');
        g.forgetHeld(3);
        expect(g.heldCount(3)).toBe(0);
        expect(g.isSharing(3)).toBe(true);
        expect(g.shareId(3)).toBe('share');
    });

    it('reset clears announcements and held tracks alike', () => {
        const g = new AnnouncedVideoGate<string>();
        g.announceShare(3, 'share');
        g.announceCamera(7);
        g.offer(9, { streamId: 'v', isVoiceStream: true, micPinned: true }, 'x');
        g.reset();
        expect(g.isSharing(3)).toBe(false);
        expect(g.offer(7, { streamId: 'voice', isVoiceStream: true, micPinned: true }, 'cam')).toBe('held');
        expect(g.heldCount(9)).toBe(0);
    });
});

describe('classifyRemoteVideo', () => {
    it('an announced share id decides by identity', () => {
        expect(classifyRemoteVideo({ streamId: 'a', isVoiceStream: false, micPinned: true, sharing: true, announcedShareId: 'a' })).toBe('screen');
        expect(classifyRemoteVideo({ streamId: 'b', isVoiceStream: false, micPinned: true, sharing: true, announcedShareId: 'a' })).toBe('camera');
    });
});
