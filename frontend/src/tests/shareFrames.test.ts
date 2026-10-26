/**
 * A share SHORT OF FRAMES, with nothing limited (shareHealth.ts frameVerdict).
 *
 * THE REPORT THIS ANSWERS (2026-10-25). The sharer's own log, 214 one-minute
 * samples: the top rung read `set60fps cap30fps` (or cap44-49fps) and sent a
 * median of 26 frames a second, on hardware encoders at ~4 ms a frame, with
 * `limit=none` throughout. Two viewers saw it stutter all evening, and the
 * sharer was never told: the only offer there was spoke on `limit === 'cpu'`.
 *
 * The halves that can fail silently are pinned: WHEN it speaks (a sustained
 * shortfall, never a dip, never a still picture), and WHAT it offers (30 fps
 * first, then a smaller picture, in words that say what the button does).
 */
import { describe, it, expect } from 'vitest';

import {
    createShareLoadWatch, frameVerdict, framesOffer, framesStepDown, liveQuality, shareLoadOffer,
    shareLoadLogLine, starvedOffer,
    FRAMES_WINDOW, FRAMES_NEEDED, FRAME_SHORT_RATIO, MOVING_BPP, MOVING_TARGET_SHARE, SAMPLE_MS, STILL_FPS, CPU_WINDOW,
    type EncodeSample, type FrameShortfall,
} from '../api/rtc/shareHealth';
import { shareSendReading } from '../api/rtc/statsSummary';

const W = 1920;
const H = 1080;

interface Step {
    set: number;
    capture: number;
    sent: number;
    /** Bits a pixel in each frame sent (0.15: 1080p at ~9 Mbps, a game). */
    bpp?: number;
    maxFps?: number;
    limit?: string;
    /** Chromium leaves framesPerSecond out when it is 0. */
    noFps?: boolean;
    ssrc?: number;
    /** The rung's bandwidth target, kbps. */
    target?: number;
}

/** A share read every SAMPLE_MS: each call is the next reading, its counters
 *  grown by what the step says was sent in between. */
function share() {
    let at = 0;
    let frames = 0;
    let bytes = 0;
    return (s: Step): EncodeSample => {
        at += SAMPLE_MS;
        const n = Math.round((s.sent * SAMPLE_MS) / 1000);
        frames += n;
        bytes += Math.round((n * (s.bpp ?? 0.15) * W * H) / 8);
        return {
            limit: s.limit ?? 'none',
            encoder: 'SimulcastEncoderAdapter (MediaFoundationVideoEncodeAccelerator (H.264 Encoder MFT))',
            atMs: at,
            setFps: s.set,
            captureFps: s.capture,
            sent: {
                ...(s.noFps ? {} : { fps: s.sent }),
                ...(s.maxFps ? { maxFps: s.maxFps } : {}),
                ...(s.target ? { targetKbps: s.target } : {}),
                frames, bytes, width: W, height: H, ssrc: s.ssrc ?? 1,
            },
        };
    };
}

/** Feed `steps` to a watch; the indexes (0-based) of the readings that offered. */
function offersFor(steps: Step[], watch = createShareLoadWatch(), next = share()): number[] {
    const at: number[] = [];
    steps.forEach((s, i) => { if (watch.add(next(s))) at.push(i); });
    return at;
}

const healthy: Step = { set: 60, capture: 59, sent: 58 };
const halfCaptured: Step = { set: 60, capture: 30, sent: 29 };
const times = (n: number, s: Step): Step[] => Array.from({ length: n }, () => s);

describe('a share short of frames, with nothing limited', () => {
    it('is offered 30 fps once the shortfall has lasted a full window', () => {
        // The first reading has nothing to compare its counters with, so
        // it is no evidence; the window fills on the FRAMES_WINDOW-th.
        const watch = createShareLoadWatch();
        expect(offersFor(times(40, halfCaptured), watch)).toEqual([FRAMES_WINDOW - 1]);
        const why = watch.reason();
        expect(why).toEqual({ kind: 'capture', setFps: 60, captureFps: 30, sentFps: 29 });
        const offer = shareLoadOffer(why!, { resolution: '1080', fps: 60 }, { width: W, height: H });
        expect(offer?.to, 'the frame rate it can reach, at the same size').toEqual({ resolution: '1080', fps: 30 });
        expect(offer?.text).toBe('Your screen share is getting only about 30 of the 60 frames a second you chose, '
            + 'so it can look choppy to viewers. Lower it to 1080p at 30 fps?');
    });

    it('catches frames that reach the encoder and do not go out', () => {
        const watch = createShareLoadWatch();
        expect(offersFor(times(12, { set: 60, capture: 47, sent: 26 }), watch)).toEqual([FRAMES_WINDOW - 1]);
        const why = watch.reason() as FrameShortfall;
        expect(why).toEqual({ kind: 'send', setFps: 60, captureFps: 47, sentFps: 26 });
        expect(framesOffer(why, { resolution: '1080', fps: 60 }, { width: W, height: H })?.text)
            .toBe('Your screen share is sending only about 26 of the 47 frames a second it captures, '
                + 'so it stutters for viewers. Lower it to 1080p at 30 fps?');
    });

    it('speaks on the sharer\'s own numbers from that evening', () => {
        // Captured 30 or 44-49 of 60; sent p25 20, median 26, p75 41.
        const evening: Step[] = [
            { set: 60, capture: 30, sent: 26 }, { set: 60, capture: 30, sent: 20 }, { set: 60, capture: 47, sent: 26 },
            { set: 60, capture: 30, sent: 24 }, { set: 60, capture: 45, sent: 41 }, { set: 60, capture: 30, sent: 26 },
            { set: 60, capture: 49, sent: 26 }, { set: 60, capture: 30, sent: 20 }, { set: 60, capture: 44, sent: 41 },
        ];
        const watch = createShareLoadWatch();
        expect(offersFor(evening, watch).length).toBe(1);
        expect(watch.reason()).toMatchObject({ kind: 'capture', setFps: 60, captureFps: 30 });
    });

    it('counts nothing as short that keeps up (the NEGATIVE CONTROL for every test here)', () => {
        expect(offersFor(times(200, healthy))).toEqual([]);
        // Exactly at the line is not short: FRAME_SHORT_RATIO of 60 is 42.
        expect(offersFor(times(40, { set: 60, capture: 60 * FRAME_SHORT_RATIO, sent: 60 * FRAME_SHORT_RATIO })))
            .toEqual([]);
    });
});

describe('a dip is not a shortfall', () => {
    it('lets a few short readings pass among good ones, however often', () => {
        // A level loading or a scene change starves the capture for a reading
        // or two. FRAMES_NEEDED - 1 in a row, again and again, never speaks.
        const dip = times(FRAMES_NEEDED - 1, halfCaptured);
        const steps = [...times(10, healthy), ...dip, ...times(10, healthy), ...dip, ...times(10, healthy)];
        expect(offersFor(steps)).toEqual([]);
        // POSITIVE CONTROL: one more short reading in the run, and it does.
        expect(offersFor([...times(10, healthy), ...times(FRAMES_NEEDED, halfCaptured)]).length).toBe(1);
    });

    it('needs a full window before it has an opinion', () => {
        // Every reading short, and still nothing until the window is full:
        // a share that has only just started has earned no verdict.
        const offers = offersFor(times(FRAMES_WINDOW - 1, halfCaptured));
        expect(offers).toEqual([]);
    });
});

describe('a still picture is not starved', () => {
    it('stays quiet about a screen where nothing changes (about one frame a second)', () => {
        expect(offersFor(times(200, { set: 60, capture: 1, sent: 1, bpp: 0.0004 }))).toEqual([]);
        expect(frameVerdict({ setFps: 60, captureFps: STILL_FPS }, null)).toBe('still');
    });

    it('stays quiet about a desktop that changes a little at a time (a clock, a cursor, typing)', () => {
        // Damage-driven capture can deliver a dozen frames a second of a
        // desktop with one small thing moving. The frame rate alone cannot
        // tell that from a game the machine cannot keep up with; the frames'
        // size can: these are a few hundred bytes each.
        expect(offersFor(times(200, { set: 60, capture: 15, sent: 15, bpp: 0.002 }))).toEqual([]);
        expect(offersFor(times(200, { set: 60, capture: 15, sent: 8, bpp: 0.002 })), 'nor its frames not all sent').toEqual([]);
        // POSITIVE CONTROL: the same 15 frames a second of a MOVING picture is short.
        expect(offersFor(times(20, { set: 60, capture: 15, sent: 15, bpp: 0.15 })).length).toBe(1);
        expect(MOVING_BPP).toBeGreaterThan(0.002);
        expect(MOVING_BPP).toBeLessThan(0.15);
    });

    it('counts a moving picture on a slow uplink as moving: few bits a pixel, but all the encoder may send', () => {
        // 1080p at 30 fps and 0.02 bits a pixel is ~1.2 Mbps. Against a
        // 1.3 Mbps target that is an encoder sending all it may: motion.
        // Against a 10 Mbps one it is a picture that barely changes.
        const slow = { set: 60, capture: 30, sent: 30, bpp: 0.02 };
        expect(offersFor(times(20, { ...slow, target: 1300 })).length).toBe(1);
        expect(offersFor(times(200, { ...slow, target: 10_000 }))).toEqual([]);
        expect(offersFor(times(200, slow)), 'no target read: the bits a pixel decide').toEqual([]);
        expect(MOVING_TARGET_SHARE).toBeGreaterThan(0.12);
        expect(MOVING_TARGET_SHARE).toBeLessThan(0.96);
    });

    it('has no verdict without two readings of the same sender to measure the frames by', () => {
        const next = share();
        const a = next(halfCaptured);
        expect(frameVerdict(a, null), 'no previous reading').toBe('unknown');
        expect(frameVerdict(next(halfCaptured), a), 'POSITIVE CONTROL').toBe('capture');
        const b = next({ ...halfCaptured, ssrc: 2 });
        expect(frameVerdict(b, a), 'a new sender (published again): its counters started over').toBe('unknown');
        expect(frameVerdict({ captureFps: 30 }, a), 'no setting read').toBe('unknown');
    });
});

describe('what counts as sent', () => {
    it('measures a rung against its own cap: a bottom rung at 30 is not dropping frames', () => {
        expect(offersFor(times(40, { set: 60, capture: 60, sent: 30, maxFps: 30 }))).toEqual([]);
        // POSITIVE CONTROL: the same 30 with no cap of its own is half dropped.
        expect(offersFor(times(40, { set: 60, capture: 60, sent: 30 })).length).toBe(1);
    });

    it('reads a rate Chromium left out (it does at 0) from the frame counter', () => {
        const watch = createShareLoadWatch();
        expect(offersFor(times(12, { set: 60, capture: 50, sent: 20, noFps: true }), watch).length).toBe(1);
        expect(watch.reason()).toEqual({ kind: 'send', setFps: 60, captureFps: 50, sentFps: 20 });
    });
});

describe('one offer for either reason', () => {
    it('still gives a CPU-limited encoder its own offer first', () => {
        const watch = createShareLoadWatch();
        const offers = offersFor(times(20, { ...halfCaptured, limit: 'cpu' }), watch);
        expect(offers, 'once, as soon as the CPU window fills').toEqual([CPU_WINDOW - 1]);
        expect(watch.reason()).toEqual({ kind: 'cpu' });
        expect(shareLoadOffer({ kind: 'cpu' }, { resolution: '1080', fps: 60 }, { width: W, height: H }))
            .toEqual(starvedOffer({ resolution: '1080', fps: 60 }, { width: W, height: H }));
    });

    it('is silent after a decline, and speaks once more after a step only on fresh evidence', () => {
        const watch = createShareLoadWatch();
        const next = share();
        expect(offersFor(times(FRAMES_WINDOW, halfCaptured), watch, next).length).toBe(1);
        expect(offersFor(times(50, halfCaptured), watch, next), 'declined: an answer').toEqual([]);
        watch.rearm();
        expect(watch.reason(), 'the old reason goes with the old evidence').toBeNull();
        // Accepted, and still short: a full fresh window before it speaks.
        expect(offersFor(times(FRAMES_WINDOW + 4, { set: 30, capture: 18, sent: 18 }), watch, next))
            .toEqual([FRAMES_WINDOW - 1]);
    });
});

describe('what it steps down to', () => {
    it('spends the frame rate first, keeping the resolution', () => {
        expect(framesStepDown({ resolution: '1440', fps: 60 }, { width: 2560, height: 1440 })).toEqual({ resolution: '1440', fps: 30 });
        expect(framesStepDown({ resolution: 'source', fps: 60 }, { width: W, height: H })).toEqual({ resolution: 'source', fps: 30 });
    });

    it('then a smaller picture, from the size actually captured', () => {
        expect(framesStepDown({ resolution: 'source', fps: 30 }, { width: W, height: H })).toEqual({ resolution: '720', fps: 30 });
        expect(framesStepDown({ resolution: '720', fps: 30 }, { width: 1280, height: 720 })).toEqual({ resolution: '720', fps: 15 });
        expect(framesStepDown({ resolution: '720', fps: 15 }, { width: 1280, height: 720 })).toBeNull();
        const short: FrameShortfall = { kind: 'capture', setFps: 15, captureFps: 8, sentFps: 8 };
        expect(framesOffer(short, { resolution: '720', fps: 15 }, { width: 1280, height: 720 }), 'nothing left: quiet').toBeNull();
    });

    it('steps from the rate the capture is really set to', () => {
        // Remembered 30, running at 60 (a share an embedding host started):
        // a step to 30 from the remembered rate would change nothing.
        expect(liveQuality({ resolution: '1080', fps: 30 }, 60)).toEqual({ resolution: '1080', fps: 60 });
        expect(liveQuality({ resolution: '1080', fps: 30 }, 59.94)).toEqual({ resolution: '1080', fps: 60 });
        expect(liveQuality({ resolution: '1080', fps: 30 }, 45), 'not a rate the dialog offers').toEqual({ resolution: '1080', fps: 30 });
        const short: FrameShortfall = { kind: 'capture', setFps: 60, captureFps: 31, sentFps: 30 };
        expect(framesOffer(short, { resolution: '1080', fps: 30 }, { width: W, height: H })?.to).toEqual({ resolution: '1080', fps: 30 });
    });

    it('writes one log line saying what ran short and what was offered', () => {
        const short: FrameShortfall = { kind: 'capture', setFps: 60, captureFps: 30, sentFps: 26 };
        expect(shareLoadLogLine(short, 'H.264 Encoder MFT', { resolution: '1080', fps: 30 }))
            .toBe('[share] short of frames at the capture: set 60 fps, captured 30, sent 26 (encoder=H.264 Encoder MFT); offered 1080p at 30 fps');
        expect(shareLoadLogLine({ kind: 'cpu' }, undefined, null))
            .toBe('[share] encoder CPU-limited (encoder=unknown); nothing lower to offer');
    });
});

describe('reading a share sender (statsSummary.ts shareSendReading)', () => {
    const report = (rows: Array<Record<string, unknown>>) =>
        new Map(rows.map(r => [String(r.id), r])) as unknown as RTCStatsReport;
    const rung = (rid: string, h: number, fps: number, extra: Record<string, unknown> = {}) => ({
        id: `out-${rid}`, type: 'outbound-rtp', kind: 'video', rid, mediaSourceId: 'src', frameWidth: Math.round(h * 16 / 9), frameHeight: h,
        framesPerSecond: fps, framesEncoded: 1000, bytesSent: 5_000_000, ssrc: h, ...extra,
    });
    const src = { id: 'src', type: 'media-source', kind: 'video', framesPerSecond: 31, trackIdentifier: 'screen' };
    const encodings = [{ rid: 'q', maxFramerate: 30, active: true }, { rid: 'h', maxFramerate: 60, active: true }, { rid: 'f', maxFramerate: 60, active: false }];

    it('takes the largest picture still switched on, and what the capture delivered', () => {
        const r = shareSendReading(report([src, rung('q', 360, 30), rung('h', 720, 26), rung('f', 1080, 0)]), 60, encodings);
        // f is switched off (nobody asked for it): what viewers get is h.
        expect(r).toEqual({
            setFps: 60, captureFps: 31,
            sent: { fps: 26, maxFps: 60, frames: 1000, bytes: 5_000_000, width: 1280, height: 720, ssrc: 720 },
        });
        const all = encodings.map(e => ({ ...e, active: true }));
        expect(shareSendReading(report([src, rung('q', 360, 30), rung('h', 720, 26), rung('f', 1080, 24)]), 60, all).sent?.height)
            .toBe(1080);
    });

    it('reads a share of one size, and invents nothing', () => {
        expect(shareSendReading(report([src, { ...rung('x', 1080, 58), rid: undefined }]), 60, [{ maxFramerate: 60 }]).sent)
            .toMatchObject({ fps: 58, maxFps: 60, height: 1080 });
        expect(shareSendReading(report([{ id: 'a', type: 'outbound-rtp', kind: 'audio' }]), undefined)).toEqual({});
    });
});
