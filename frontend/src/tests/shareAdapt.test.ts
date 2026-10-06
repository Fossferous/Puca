/**
 * How an SFU screen share adapts to the SENDER's upload (shareAdapt.ts).
 *
 * THE INCIDENT, 2026-10-05. A streamer's share went live at 1866x1080, their
 * bandwidth estimate collapsed within 20 s, and libwebrtc's own adaptation
 * ('maintain-framerate') stepped the picture down one notch every ~5 s to its
 * 310x180 floor, where it stayed: viewers watched a thumbnail for minutes,
 * and on a second share it never climbed out. Measured on a shaped loopback
 * LiveKit (scratch rig lkshape.mjs, 500 ms of router buffer):
 *
 *   link       maintain-framerate   balanced        this module
 *   450 kbps   180p @ 30 fps        270p @ 15 fps   360p @ 13 fps
 *   1 Mbps     270-360p @ 30 fps    360p @ 15 fps   540p @ 30 fps
 *   1.5 Mbps   540p @ 30 fps        540-720p @ 30   720p @ 30 fps
 *   good       1080p @ 30           -               1080p @ 30 (from ~6 s)
 *
 * and after a squeeze to 250 kbps lifted to 5 Mbps, 1080p came back in
 * 60-101 s as shipped (and with the rung picker alone), 24-34 s with the
 * probe below (six runs); a second share after the squeeze reached 1080p in
 * 22-40 s, against 85 s and "not within 90 s" as shipped.
 */
import { describe, it, expect } from 'vitest';

import {
    ShareAdapter, rungsFor, rungNeedKbps, SHARE_ADAPT_INTERVAL_MS, type ShareAdaptSample,
} from '../api/rtc/shareAdapt';

/** One reading as a test writes it: `sentKbps` and `fps` (frames ENCODED a
 *  second, default 30) are turned into the cumulative counters. */
type Feed = Partial<ShareAdaptSample> & { sentKbps?: number; fps?: number };

/** Feed the adapter one sample per interval and collect what it asked for. */
function drive(a: ShareAdapter, samples: Feed[], startMs = 0) {
    const out: ReturnType<ShareAdapter['step']>[] = [];
    let t = startMs;
    let bytes = 0;
    let frames = 0;
    for (const s of samples) {
        t += SHARE_ADAPT_INTERVAL_MS;
        // Bytes advance at `sentKbps` unless the sample says otherwise.
        const { sentKbps, fps, ...rest } = s;
        bytes += Math.round(((sentKbps ?? s.targetKbps ?? 0) * SHARE_ADAPT_INTERVAL_MS) / 8);
        frames += Math.round(((fps ?? 30) * SHARE_ADAPT_INTERVAL_MS) / 1000);
        out.push(a.step({ atMs: t, targetKbps: 0, bytesSent: bytes, framesEncoded: frames, limit: 'none', ...rest }));
    }
    return out;
}
const steady = (n: number, targetKbps: number, extra: Feed = {}): Feed[] =>
    Array.from({ length: n }, () => ({ targetKbps, ...extra }));
const heightAfter = (a: ShareAdapter) => a.currentHeight;

describe('the rungs', () => {
    it('are the source and the standard heights below it, never above it, down to 360 lines', () => {
        expect(rungsFor(1080)).toEqual([1080, 720, 540, 360]);
        expect(rungsFor(1440)).toEqual([1440, 1080, 720, 540, 360]);
        // A window share is whatever size the window is.
        expect(rungsFor(1032)).toEqual([1032, 720, 540, 360]);
        expect(rungsFor(600)).toEqual([600, 540, 360]);
    });

    it('never goes under 360 lines: below it Chromium will not use a hardware encoder', () => {
        for (const h of [2160, 1440, 1080, 720, 540, 400]) expect(Math.min(...rungsFor(h))).toBe(360);
        expect(rungsFor(300), 'a source smaller than the floor is sent as it is').toEqual([300]);
    });

    it('needs bitrate in proportion to the pixels, more at 60 fps, and the floor needs nothing', () => {
        expect(rungNeedKbps(1080, 30, 360)).toBe(2600);
        expect(rungNeedKbps(720, 30, 360)).toBe(1156);
        expect(rungNeedKbps(540, 30, 360)).toBe(650);
        expect(rungNeedKbps(360, 30, 360), 'the floor is always allowed').toBe(0);
        expect(rungNeedKbps(1080, 60, 360)).toBe(3900);
    });
});

describe('a good link', () => {
    it('starts at 540p and reaches the full picture within a few seconds, then stays there', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        expect(a.currentHeight, 'a small first keyframe for a link nobody has measured yet').toBe(540);
        drive(a, steady(3, 4500));
        expect(heightAfter(a)).toBe(1080);
        const later = drive(a, steady(30, 4500), 10_000);
        expect(later.every(x => x.height === undefined), 'nothing is touched once it is right').toBe(true);
    });
});

describe('a squeezed link', () => {
    it('drops to the rung the bandwidth target can carry, at once', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(3, 4500));
        drive(a, steady(1, 900));
        expect(heightAfter(a), '900 < half of 1080p\'s 2600: straight down to what fits').toBe(540);
        drive(a, steady(1, 200));
        expect(heightAfter(a)).toBe(360);
    });

    it('rides out the estimator\'s sawtooth without flapping between two rungs', () => {
        // GCC's target saws between ~950 and ~1400 on a 1.5 Mbps link (measured);
        // a picker that followed each reading flapped 540 <-> 720 every few seconds.
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(4, 1300));
        expect(heightAfter(a)).toBe(720);
        const saw = [950, 1400, 1000, 1350, 1300, 980, 1420, 1250, 1050, 1380];
        const out = drive(a, saw.map(targetKbps => ({ targetKbps })), 20_000);
        expect(out.filter(x => x.height !== undefined), 'no rung changes').toHaveLength(0);
    });

    it('steps up only after two readings in a row say the bigger rung fits', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(3, 700));
        expect(heightAfter(a)).toBe(540);
        drive(a, steady(1, 1500));
        expect(heightAfter(a), 'one good reading is not enough').toBe(540);
        drive(a, [{ targetKbps: 800 }, { targetKbps: 1500 }]);
        expect(heightAfter(a), 'and they must be in a row').toBe(540);
        drive(a, steady(3, 1500));
        expect(heightAfter(a)).toBe(720);
    });

    it('steps a rung down when the ENCODER is starved, and stays off that rung for a minute', () => {
        // maintain-resolution spends a CPU shortage on frame rate; this gives the
        // pixels back instead, which is what the old preference did on its own.
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(3, 4500));
        expect(heightAfter(a)).toBe(1080);
        drive(a, steady(2, 4500, { limit: 'cpu' }));
        expect(heightAfter(a)).toBe(720);
        drive(a, steady(10, 4500), 20_000);
        expect(heightAfter(a), 'not straight back into the same overload').toBe(720);
        drive(a, steady(25, 4500), 40_000);
        expect(heightAfter(a)).toBe(1080);
    });
});

describe('climbing out after the link recovers', () => {
    // Why this exists: at the bottom rung a high-motion picture needs more bits
    // per frame than the target allows, so the encoder sends a frame or two a
    // second — far below its own target — and the estimator, which may only
    // rise to about 1.5x what it sees acknowledged, never learns the link came
    // back. Measured: stuck at ~120 kbps for 40-100 s on a 5 Mbps link. A
    // screen-content track turns on libwebrtc's periodic bandwidth probing;
    // a 'motion' one does not (measured: 1080p back in 26-32 s with it).
    const stuck = (n: number) => steady(n, 100, { sentKbps: 40 });

    it('marks the track as screen content while the encoder is sending far under its target', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(3, 200));
        const out = drive(a, stuck(6), 12_000);
        expect(out.some(x => x.contentHint === 'detail')).toBe(true);
        expect(a.probing).toBe(true);
    });

    it('does not probe while the encoder fills its target, however low', () => {
        // A steady 450 kbps link: the encoder sends what it is allowed. Nothing
        // is wrong that probing could fix, and screen-content mode costs frame
        // rate (measured 13 -> 4 fps at 360p), so it must stay off.
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        const out = drive(a, steady(60, 300, { sentKbps: 290 }));
        expect(out.some(x => x.contentHint !== undefined)).toBe(false);
    });

    it('does not probe on a link already good enough for the full picture', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        // A static screen sends next to nothing: that is not a starved encoder.
        const out = drive(a, steady(30, 4500, { sentKbps: 50 }));
        expect(out.some(x => x.contentHint !== undefined)).toBe(false);
    });

    it('goes back to motion once the estimate carries the next rung, and climbs', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(3, 200));
        drive(a, stuck(6), 12_000);
        expect(a.probing).toBe(true);
        const out = drive(a, steady(8, 4500, { sentKbps: 600 }), 40_000);
        expect(out.some(x => x.contentHint === 'motion')).toBe(true);
        expect(a.probing).toBe(false);
        expect(heightAfter(a)).toBe(1080);
    });

    it('holds each mode for at least 10 s, so a link that keeps teasing cannot make it flap', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(6, 200));
        // Starved twice, then three readings good enough to leave, over and
        // over: without the hold that is two hint changes every 10 s.
        const cycle: Feed[] = [
            { targetKbps: 100, sentKbps: 40 }, { targetKbps: 100, sentKbps: 40 },
            { targetKbps: 900, sentKbps: 880 }, { targetKbps: 900, sentKbps: 880 }, { targetKbps: 900, sentKbps: 880 },
        ];
        const out = drive(a, Array.from({ length: 12 }, () => cycle).flat(), 12_000);
        const flips = out.filter(x => x.contentHint !== undefined).length;
        expect(flips, 'it does probe on this link').toBeGreaterThan(0);
        expect(flips, `${flips} hint changes in 120 s`).toBeLessThanOrEqual(12);
    });

    // A SECOND share on the same call (2026-10-05: 320x174 for three minutes)
    // starts from the estimate the first one left behind. Measured on the rig:
    // the encoder then sends 60-90% of a ~100 kbps target at 2-3 fps — not
    // "starved" by the rule above — and the estimate still sat flat for 40 s
    // on a 5 Mbps link. What gives it away is that the picture is already a
    // slideshow on the lowest rung, so screen-content mode costs nothing.
    it('probes at the lowest rung once the picture is down to a slideshow, even if the encoder fills its target', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        const out = drive(a, steady(12, 120, { sentKbps: 100, fps: 2 }));
        expect(a.currentHeight).toBe(360);
        expect(out.some(x => x.contentHint === 'detail')).toBe(true);
    });

    it('does not probe a weak link where the picture still moves', () => {
        // Measured on a steady 450 kbps link: the first seconds after going
        // live (a keyframe draining) dip to 5-8 fps, then ~13. A probe that
        // fired there cost 13 -> 4 fps for the rest of the share (measured:
        // an earlier version keyed on the round trip did exactly that).
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        const fps = [13, 7, 5, 7, 8, 14, 15, 12, 13, 9, 14, 11, 6, 13, 4, 12];
        const out = drive(a, Array.from({ length: 64 }, (_, i) => ({ targetKbps: 300, sentKbps: 290, fps: fps[i % fps.length] })));
        expect(a.currentHeight).toBe(360);
        expect(out.some(x => x.contentHint !== undefined)).toBe(false);
    });

    it('does not probe above the lowest rung', () => {
        // 540p30 on a 1 Mbps link is the picture working; screen-content mode
        // would cost it 30 -> 18 fps (measured).
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        const out = drive(a, steady(60, 900, { sentKbps: 300, fps: 3 }));
        expect(a.currentHeight).toBe(540);
        expect(out.some(x => x.contentHint !== undefined)).toBe(false);
    });

    it('needs two starved readings, not one', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(6, 200));
        const out = drive(a, [{ targetKbps: 100, sentKbps: 40 }, { targetKbps: 100, sentKbps: 95 }, { targetKbps: 100, sentKbps: 40 }, { targetKbps: 100, sentKbps: 95 }], 20_000);
        expect(out.some(x => x.contentHint !== undefined)).toBe(false);
    });

    it('a new sender (bytes went backwards) gives no rate, rather than a starved one', () => {
        const a = new ShareAdapter({ sourceHeight: 1080, fps: 30 });
        drive(a, steady(10, 200));
        // Counters restart: one reading with no rate, then one genuinely
        // starved reading — which is ONE, not the two it takes to probe.
        const out = [a.step({ atMs: 22_000, targetKbps: 100, bytesSent: 10, framesEncoded: 1, limit: 'none' }),
            a.step({ atMs: 24_000, targetKbps: 100, bytesSent: 10 + 10_000, framesEncoded: 61, limit: 'none' })];
        expect(out.some(x => x.contentHint !== undefined)).toBe(false);
    });
});
