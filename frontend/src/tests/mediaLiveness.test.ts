import { describe, it, expect } from 'vitest';
import { hasLiveVideo } from '../utils/mediaLiveness';

/**
 * `hasLiveVideo` guards ONE decision: whether an incoming `ScreenShareStarted`
 * may overwrite an existing sharers entry with a fresh `stream: null`
 * placeholder. Keep a genuinely live stream (never clobber video we are
 * watching); replace anything else (a stale dead-stream entry left by an
 * unclean disconnect is the black-tile producer — it must not be preserved).
 *
 * It is deliberately NOT the re-announce discriminator: media can arrive before
 * the announcement, so liveness cannot tell news from a replay. That job
 * belongs to [ShareAnnouncements] — see shareAnnouncements.test.ts.
 */

function stream(tracks: { readyState: string }[], active = true): MediaStream {
    return {
        active,
        getVideoTracks: () => tracks,
    } as unknown as MediaStream;
}

describe('hasLiveVideo', () => {
    it('is false with no entry at all (a share we have never seen)', () => {
        expect(hasLiveVideo(undefined)).toBe(false);
        expect(hasLiveVideo(null)).toBe(false);
    });

    it('is false for an announced-but-not-yet-arrived placeholder', () => {
        expect(hasLiveVideo({ stream: null })).toBe(false);
    });

    it('is false for a stale entry whose track ended — the black-tile case', () => {
        expect(hasLiveVideo({ stream: stream([{ readyState: 'ended' }]) })).toBe(false);
    });

    it('is false for an inactive stream even if a track still reads live', () => {
        expect(hasLiveVideo({ stream: stream([{ readyState: 'live' }], false) })).toBe(false);
    });

    it('is false for a stream carrying no video at all', () => {
        expect(hasLiveVideo({ stream: stream([]) })).toBe(false);
    });

    it('is true while video is genuinely flowing — the re-announce case', () => {
        expect(hasLiveVideo({ stream: stream([{ readyState: 'live' }]) })).toBe(true);
    });

    it('is true when any one track is still live (partially ended stream)', () => {
        expect(hasLiveVideo({
            stream: stream([{ readyState: 'ended' }, { readyState: 'live' }]),
        })).toBe(true);
    });
});
