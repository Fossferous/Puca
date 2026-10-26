/**
 * A share on its way (components/shareStarts.ts): one start at a time, the
 * dialog's or a host's, and a Stop, or the picture ending, that reaches it
 * before it is live. Found in review of the Steam Deck share (2026-10-23): a
 * Stop pressed while a share was starting was dropped, and the share went
 * live with a dead track, an empty tile on everyone's screen.
 */
import { describe, expect, it } from 'vitest';
import { SHARE_START_STALE_MS, ShareStarts, captureFor, ownsCapture, stillWanted } from '../components/shareStarts';

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

    // The capture is one slot: a start replaced while it waits on its picker,
    // or while it holds a live picture (the dialog waiting on its app step),
    // would have that picture stopped under it by the next capture.
    it('a start still asking for its picture is never stale, however long the picker stays open', async () => {
        let now = 1000;
        const starts = new ShareStarts(() => now);
        const start = starts.begin('dialog')!;
        let answer!: (s: ReturnType<typeof stream>) => void;
        const asked = captureFor(start, () => new Promise<ReturnType<typeof stream>>(r => { answer = r; }));
        now += SHARE_START_STALE_MS * 10;
        expect(starts.begin('host')).toBeNull();
        expect(start.cancelled).toBe(false);
        answer(stream('ended'));
        await asked;
        // CONTROL: answered, with a picture that is already gone, it is stale again.
        expect(starts.begin('host')?.by).toBe('host');
        expect(start.cancelled).toBe(true);
    });

    it('a start holding a live picture is never stale; once that picture ends, it is', async () => {
        let now = 1000;
        const starts = new ShareStarts(() => now);
        const start = starts.begin('dialog')!;
        const track = { readyState: 'live' };
        await captureFor(start, async () => ({ getVideoTracks: () => [track] }));
        now += SHARE_START_STALE_MS * 10;
        expect(starts.begin('host')).toBeNull();
        track.readyState = 'ended';
        expect(starts.begin('host')?.by).toBe('host');
    });
});

// The dialog's Go Live (and its Cancel) act on the start THEIR capture began. They used to take
// whichever start was active when they ran, so after a host's start replaced a dialog start as stale
// the old flow got null (or the host's start) and ran on, uncancellable, beside the new one.
describe("the dialog's own start, carried to its Go Live", () => {
    const ended = () => ({ getVideoTracks: () => [{ readyState: 'ended' }] });

    it('is handed over once, and only the dialog has one', () => {
        const starts = new ShareStarts(() => 0);
        expect(starts.takeDialog()).toBeNull();
        const dialog = starts.begin('dialog');
        expect(starts.takeDialog()).toBe(dialog);
        expect(starts.takeDialog()).toBeNull();
        starts.end(dialog);
        const host = starts.begin('host');
        expect(host).not.toBeNull();
        expect(starts.takeDialog()).toBeNull();
    });

    it('is still its own after a host start replaced it as stale: cancelled, not null, never the host\'s', async () => {
        let now = 0;
        const starts = new ShareStarts(() => now);
        const dialog = starts.begin('dialog')!;
        await captureFor(dialog, async () => ended());
        now += SHARE_START_STALE_MS;
        const host = starts.begin('host')!;
        expect(host.by).toBe('host');
        expect(starts.active).toBe(host);
        const carried = starts.takeDialog();
        expect(carried).toBe(dialog);
        expect(carried?.cancelled).toBe(true);
        expect(host.cancelled).toBe(false);
        // What the old flow then sees: nothing to go live with, and its end leaves the host's start alone.
        expect(stillWanted(carried, ended())).toBe(false);
        starts.end(carried);
        expect(starts.active).toBe(host);
    });

    it('is gone once its start ended, and a newer dialog start is the one carried', () => {
        const starts = new ShareStarts(() => 0);
        const first = starts.begin('dialog');
        starts.end(first);
        expect(starts.takeDialog()).toBeNull();
        const second = starts.begin('dialog');
        expect(second).not.toBe(first);
        expect(starts.takeDialog()).toBe(second);
    });
});

describe("a start's picture", () => {
    it('is kept on the start once captured, and capturing clears either way', async () => {
        const start = new ShareStarts(() => 0).begin('host')!;
        const picture = stream('live');
        const p = captureFor(start, async () => picture);
        expect(start.capturing).toBe(true);
        expect(await p).toBe(picture);
        expect(start.picture).toBe(picture);
        expect(start.capturing).toBe(false);

        const refused = new ShareStarts(() => 0).begin('host')!;
        await expect(captureFor(refused, async () => { throw new Error('not allowed'); })).rejects.toThrow('not allowed');
        expect(refused.capturing).toBe(false);
        expect(refused.picture).toBeNull();
    });

    it("the slot is a start's to take down while it is empty or holds that start's own picture, never another's", async () => {
        const start = new ShareStarts(() => 0).begin('dialog')!;
        const own = stream('live');
        await captureFor(start, async () => own);
        expect(ownsCapture(start, own)).toBe(true);
        expect(ownsCapture(start, null)).toBe(true);
        expect(ownsCapture(start, stream('live'))).toBe(false);
        // No picture recorded (a start that never captured), or no start at all: whatever is there.
        expect(ownsCapture(new ShareStarts(() => 0).begin('host'), stream('live'))).toBe(true);
        expect(ownsCapture(null, stream('live'))).toBe(true);
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
