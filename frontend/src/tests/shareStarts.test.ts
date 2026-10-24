/**
 * A share on its way (components/shareStarts.ts): one start at a time, the
 * dialog's or a host's, and a Stop, or the picture ending, that reaches it
 * before it is live. Found in review of the Steam Deck share (2026-10-23): a
 * Stop pressed while a share was starting was dropped, and the share went
 * live with a dead track, an empty tile on everyone's screen.
 */
import { describe, expect, it } from 'vitest';
import { SHARE_START_STALE_MS, ShareStarts, stillWanted } from '../components/shareStarts';

const stream = (...states: string[]) => ({ getVideoTracks: () => states.map(readyState => ({ readyState })) });

describe('one share start at a time', () => {
    it("refuses a second start, the dialog's or a host's, until the first is over", () => {
        const starts = new ShareStarts(() => 0);
        const host = starts.begin('host');
        expect(host).not.toBeNull();
        expect(starts.begin('dialog')).toBeNull();
        expect(starts.begin('host')).toBeNull();
        starts.end(host);
        expect(starts.begin('dialog')?.by).toBe('dialog');
    });

    it("ends only its own start: a late end of an older one leaves the next alone", () => {
        const starts = new ShareStarts(() => 0);
        const first = starts.begin('dialog');
        starts.end(first);
        const second = starts.begin('host');
        starts.end(first);
        expect(starts.active).toBe(second);
        starts.end(null);
        starts.end(undefined);
        expect(starts.active).toBe(second);
    });

    it('a start nobody ended no longer holds the next one back, and is itself cancelled', () => {
        let now = 1000;
        const starts = new ShareStarts(() => now);
        const forgotten = starts.begin('dialog');
        now += SHARE_START_STALE_MS - 1;
        expect(starts.begin('host')).toBeNull();
        now += 1;
        const next = starts.begin('host');
        expect(next?.by).toBe('host');
        expect(forgotten?.cancelled).toBe(true);
        expect(next?.cancelled).toBe(false);
    });
});

describe('a Stop while a share is starting', () => {
    it('cancels the start that runs, and says there was one', () => {
        const starts = new ShareStarts(() => 0);
        expect(starts.cancel()).toBe(false);
        const start = starts.begin('host');
        expect(starts.cancel()).toBe(true);
        expect(start?.cancelled).toBe(true);
    });

    it('keeps it from going live at the next step, whatever the picture', () => {
        const starts = new ShareStarts(() => 0);
        const start = starts.begin('host');
        expect(stillWanted(start, stream('live'))).toBe(true);
        starts.cancel();
        expect(stillWanted(start, stream('live'))).toBe(false);
    });
});

describe('the picture is still there', () => {
    it('only a live video track can go live', () => {
        expect(stillWanted(null, stream('live'))).toBe(true);
        expect(stillWanted(undefined, stream('live', 'ended'))).toBe(true);
        expect(stillWanted(null, stream('ended'))).toBe(false);
        expect(stillWanted(null, stream())).toBe(false);
        expect(stillWanted(null, null)).toBe(false);
        expect(stillWanted(null, undefined)).toBe(false);
    });
});
