import { describe, it, expect } from 'vitest';
import { ShareAnnouncements } from '../utils/shareAnnouncements';

/**
 * These encode the four orderings VoicePanel actually sees. The chime, the
 * auto-select of a tile and nothing else hang off `announce()` returning true.
 */
describe('ShareAnnouncements', () => {
    it('treats the first announcement as news', () => {
        const a = new ShareAnnouncements();
        expect(a.announce(7)).toBe(true);
    });

    it('treats a replay as a replay — the reconnect re-announce', () => {
        const a = new ShareAnnouncements();
        a.announce(7);
        expect(a.announce(7)).toBe(false);
        expect(a.announce(7)).toBe(false);
    });

    it('handles the doubled reconnect delivery (room-state replay + own echo)', () => {
        // A reconnecting client receives BOTH the JoinRoom room-state replay
        // and the broadcast echo of the re-announce. Exactly one must be news,
        // and on a reconnect neither is (we were already told before the blip).
        const a = new ShareAnnouncements();
        a.announce(7);
        expect([a.announce(7), a.announce(7)]).toEqual([false, false]);
    });

    it('makes a share news again after they stop', () => {
        const a = new ShareAnnouncements();
        a.announce(7);
        a.stopped(7);
        expect(a.announce(7)).toBe(true);
    });

    it('re-seeds from scratch after leaving voice', () => {
        const a = new ShareAnnouncements();
        a.announce(7);
        a.clear();
        expect(a.announce(7)).toBe(true);
    });

    it('tracks peers independently', () => {
        const a = new ShareAnnouncements();
        a.announce(7);
        expect(a.announce(8)).toBe(true);
        a.stopped(8);
        expect(a.announce(7)).toBe(false);
    });

    /**
     * THE REGRESSION THIS REPLACED. The first implementation asked "do we hold
     * live video from them" instead of "were we told". Media routinely arrives
     * BEFORE the announcement — handleScreenShareStream has an explicit
     * no-entry branch for exactly that, and over the SFU LiveKit pushes the
     * track independently of our socket — so a genuinely new share was
     * classified as a replay and lost its chime and tile.
     *
     * Arrival of media must not mark anyone as announced; only announce() does.
     */
    it('still counts as news when the media arrived before the announcement', () => {
        const a = new ShareAnnouncements();
        // ...media arrives here; nothing calls announce()...
        expect(a.announce(7)).toBe(true);
    });
});
