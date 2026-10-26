/**
 * A share SHORT OF FRAMES, with nothing limited (shareHealth.ts frameVerdict).
 *
 * THE REPORT THIS ANSWERS (2026-10-25). The sharer's own log, 214 one-minute
 * samples: the top rung read `set60fps cap30fps` (or cap44-49fps) and sent a
 * median of 26 frames a second (p25 20, p75 41), on hardware encoders at ~4 ms
 * a frame, with `limit=none` throughout. Two viewers saw it stutter all
 * evening, and the sharer was never told: the only offer there was spoke on
 * `limit === 'cpu'`.
 *
 * The halves that can fail silently are pinned: WHEN it speaks (frames being
 * lost for a sustained stretch: never a dip, never a still picture, and never
 * a picture at its own steady rate, a film at 24 or a game capped at 30), and
 * WHAT it offers (30 fps first, then a smaller picture, for this share only,
 * in words that say what the button does).
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

const times = (n: number, s: Step): Step[] => Array.from({ length: n }, () => s);
const healthy: Step = { set: 60, capture: 59, sent: 58 };
/** A capture that keeps JUMPING under a 60 setting, everything captured sent:
 *  a starved capture, delivering irregularly. */
const jumping = (n: number, extra: Partial<Step> = {}, lo = 20, hi = 35): Step[] =>
    Array.from({ length: n }, (_, i) => ({ set: 60, capture: i % 2 ? hi : lo, sent: i % 2 ? hi : lo, ...extra }));

describe('a picture at its own steady rate is not short of frames', () => {
    it('never asks about a film at 24 or a game capped at 30 under a 60 setting', () => {
        // The review's measurement: steady 24 fps motion under 60 read
        // "short at the capture" ten readings of ten. Each reading still
        // says so; the WINDOW must not, because nothing is being lost.
        for (const fps of [24, 25, 30]) {
            const steady: Step = { set: 60, capture: fps, sent: fps };
            const next = share();
            const a = next(steady);
            expect(frameVerdict(next(steady), a), 'the reading alone is short').toBe('capture');
            expect(offersFor(times(200, steady)), `${fps} fps`).toEqual([]);
        }
        // ...nor about its rate wobbling a frame or two, as a real one does.
        expect(offersFor(Array.from({ length: 200 }, (_, i) => ({ set: 60, capture: 23 + (i % 3), sent: 24 + (i % 2) })))).toEqual([]);
    });

    it('never asks when the content\'s own rate changes once (a film starting after a game)', () => {
        expect(offersFor([...times(10, healthy), ...times(60, { set: 60, capture: 24, sent: 24 })])).toEqual([]);
    });
});

describe('a share losing frames', () => {
    it('is offered 30 fps, for this share only, once its capture has kept jumping for a full window', () => {
        const watch = createShareLoadWatch();
        expect(offersFor(jumping(40), watch)).toEqual([FRAMES_WINDOW - 1]);
        const why = watch.reason();
        expect(why).toMatchObject({ kind: 'capture', setFps: 60 });
        const offer = shareLoadOffer(why!, { resolution: '1080', fps: 60 }, { width: W, height: H });
        expect(offer?.to, 'the frame rate it can reach, at the same size').toEqual({ resolution: '1080', fps: 30 });
        expect(offer?.remember, 'NOT kept as the setting for the next share').toBe(false);
        expect(offer?.text).toMatch(/^Your screen share is getting only about \d+ of the 60 frames a second you chose, and unevenly, so it stutters for viewers\. Lower this share to 1080p at 30 fps\?$/);
    });

    it('is offered when frames reach the encoder and do not go out, steady capture or not', () => {
        const watch = createShareLoadWatch();
        expect(offersFor(times(12, { set: 60, capture: 47, sent: 26 }), watch)).toEqual([FRAMES_WINDOW - 1]);
        const why = watch.reason() as FrameShortfall;
        expect(why).toMatchObject({ kind: 'send', setFps: 60, captureFps: 47, sentFps: 26 });
        expect(framesOffer(why, { resolution: '1080', fps: 60 }, { width: W, height: H })?.text)
            .toBe('Your screen share is sending only about 26 of the 47 frames a second it captures, '
                + 'so it stutters for viewers. Lower this share to 1080p at 30 fps?');
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
        // And the line in puca.log carries what the encoder made of the frames.
        expect(shareLoadLogLine(watch.reason()!, 'H.264 Encoder MFT', { resolution: '1080', fps: 30 }))
            .toMatch(/^\[share\] short of frames at the capture: set 60 fps, captured 30, sent \d+, bpp 0\.15, of target \?/);
    });

    it('counts nothing as short that keeps up (the NEGATIVE CONTROL for every test here)', () => {
        expect(offersFor(times(200, healthy))).toEqual([]);
        // Exactly at the line is not short: FRAME_SHORT_RATIO of 60 is 42.
        expect(offersFor(jumping(40, {}, 60 * FRAME_SHORT_RATIO, 59))).toEqual([]);
    });
});

describe('a dip is not a shortfall', () => {
    it('lets a few short readings pass among good ones, however often', () => {
        // A level loading or a scene change starves the capture for a reading
        // or two. FRAMES_NEEDED - 1 in a row, again and again, never speaks.
        const dip = jumping(FRAMES_NEEDED - 1);
        const steps = [...times(10, healthy), ...dip, ...times(10, healthy), ...dip, ...times(10, healthy)];
        expect(offersFor(steps)).toEqual([]);
        // POSITIVE CONTROL: one more short reading in the run, and it does.
        expect(offersFor([...times(10, healthy), ...jumping(FRAMES_NEEDED)]).length).toBe(1);
    });

    it('needs a full window before it has an opinion', () => {
        // Every reading short, and still nothing until the window is full:
        // a share that has only just started has earned no verdict.
        expect(offersFor(jumping(FRAMES_WINDOW - 1))).toEqual([]);
    });
});

describe('a still picture is not starved', () => {
    it('stays quiet about a screen where nothing changes (about one frame a second)', () => {
        expect(offersFor(times(200, { set: 60, capture: 1, sent: 1, bpp: 0.0004 }))).toEqual([]);
        expect(frameVerdict({ setFps: 60, captureFps: STILL_FPS }, null)).toBe('still');
    });

    it('stays quiet about a desktop that changes a little at a time (a clock, a cursor, typing)', () => {
        // Damage-driven capture can deliver a dozen frames a second of a
        // desktop with one small thing moving, and unevenly. The frame rate
        // alone cannot tell that from a game the machine cannot keep up with;
        // the frames' size can: these are a few hundred bytes each.
        expect(offersFor(jumping(200, { bpp: 0.002 }, 8, 18))).toEqual([]);
        expect(offersFor(jumping(200, { bpp: 0.002, sent: 4 }, 8, 18)), 'nor its frames not all sent').toEqual([]);
        // POSITIVE CONTROL: the same jumping capture of a MOVING picture is short.
        expect(offersFor(jumping(20, { bpp: 0.15 }, 8, 18)).length).toBe(1);
        expect(MOVING_BPP).toBeGreaterThan(0.002);
        expect(MOVING_BPP).toBeLessThan(0.15);
    });

    it('counts a moving picture on a slow uplink as moving: few bits a pixel, but all the encoder may send', () => {
        // 1080p at ~30 fps and 0.02 bits a pixel is ~1.2 Mbps. Against a
        // 1.3 Mbps target that is an encoder sending all it may: motion.
        // Against a 10 Mbps one it is a picture that barely changes.
        const slow = { bpp: 0.02 };
        expect(offersFor(jumping(20, { ...slow, target: 1300 }, 25, 35)).length).toBe(1);
        expect(offersFor(jumping(200, { ...slow, target: 10_000 }, 25, 35))).toEqual([]);
        expect(offersFor(jumping(200, slow, 25, 35)), 'no target read: the bits a pixel decide').toEqual([]);
        expect(MOVING_TARGET_SHARE).toBeGreaterThan(0.12);
        expect(MOVING_TARGET_SHARE).toBeLessThan(0.96);
    });

    it('has no verdict without two readings of the same sender to measure the frames by', () => {
        const short: Step = { set: 60, capture: 30, sent: 29 };
        const next = share();
        const a = next(short);
        expect(frameVerdict(a, null), 'no previous reading').toBe('unknown');
        expect(frameVerdict(next(short), a), 'POSITIVE CONTROL').toBe('capture');
        const b = next({ ...short, ssrc: 2 });
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
        expect(watch.reason()).toMatchObject({ kind: 'send', setFps: 60, captureFps: 50, sentFps: 20 });
    });
});

describe('one offer for either reason', () => {
    it('still gives a CPU-limited encoder its own offer first, and remembers that one', () => {
        const watch = createShareLoadWatch();
        const offers = offersFor(times(20, { set: 60, capture: 30, sent: 29, limit: 'cpu' }), watch);
        expect(offers, 'once, as soon as the CPU window fills').toEqual([CPU_WINDOW - 1]);
        expect(watch.reason()).toEqual({ kind: 'cpu' });
        expect(shareLoadOffer({ kind: 'cpu' }, { resolution: '1080', fps: 60 }, { width: W, height: H }))
            .toEqual({ ...starvedOffer({ resolution: '1080', fps: 60 }, { width: W, height: H }), remember: true });
    });

    it('is silent after a decline, and speaks once more after a step only on fresh evidence', () => {
        const watch = createShareLoadWatch();
        const next = share();
        expect(offersFor(jumping(FRAMES_WINDOW), watch, next).length).toBe(1);
        expect(offersFor(jumping(50), watch, next), 'declined: an answer').toEqual([]);
        watch.rearm();
        expect(watch.reason(), 'the old reason goes with the old evidence').toBeNull();
        // Accepted, and still losing frames at 30: a full fresh window first.
        expect(offersFor(jumping(FRAMES_WINDOW + 4, { set: 30 }, 12, 19), watch, next)).toEqual([FRAMES_WINDOW - 1]);
    });
});

describe('what it steps down to', () => {
    const short = (over: Partial<FrameShortfall>): FrameShortfall =>
        ({ kind: 'capture', setFps: 60, captureFps: 30, sentFps: 26, bpp: null, targetShare: null, ...over });

    it('spends the frame rate first, keeping the resolution', () => {
        expect(framesStepDown({ resolution: '1440', fps: 60 }, { width: 2560, height: 1440 })).toEqual({ resolution: '1440', fps: 30 });
        expect(framesStepDown({ resolution: 'source', fps: 60 }, { width: W, height: H })).toEqual({ resolution: 'source', fps: 30 });
    });

    it('then a smaller picture, from the size actually captured', () => {
        expect(framesStepDown({ resolution: 'source', fps: 30 }, { width: W, height: H })).toEqual({ resolution: '720', fps: 30 });
        expect(framesStepDown({ resolution: '720', fps: 30 }, { width: 1280, height: 720 })).toEqual({ resolution: '720', fps: 15 });
        expect(framesStepDown({ resolution: '720', fps: 15 }, { width: 1280, height: 720 })).toBeNull();
        expect(framesOffer(short({ setFps: 15, captureFps: 8, sentFps: 8 }), { resolution: '720', fps: 15 }, { width: 1280, height: 720 }),
            'nothing left: quiet').toBeNull();
    });

    it('steps from the rate the capture is really set to', () => {
        // Remembered 30, running at 60 (a share an embedding host started):
        // a step to 30 from the remembered rate would change nothing.
        expect(liveQuality({ resolution: '1080', fps: 30 }, 60)).toEqual({ resolution: '1080', fps: 60 });
        expect(liveQuality({ resolution: '1080', fps: 30 }, 59.94)).toEqual({ resolution: '1080', fps: 60 });
        expect(liveQuality({ resolution: '1080', fps: 30 }, 45), 'not a rate the dialog offers').toEqual({ resolution: '1080', fps: 30 });
        expect(framesOffer(short({ captureFps: 31, sentFps: 30 }), { resolution: '1080', fps: 30 }, { width: W, height: H })?.to)
            .toEqual({ resolution: '1080', fps: 30 });
    });

    it('writes one log line: what ran short, what the encoder made of the frames, and what was offered', () => {
        expect(shareLoadLogLine(short({ bpp: 0.162, targetShare: 0.94 }), 'H.264 Encoder MFT', { resolution: '1080', fps: 30 }))
            .toBe('[share] short of frames at the capture: set 60 fps, captured 30, sent 26, bpp 0.162, of target 0.94 (encoder=H.264 Encoder MFT); offered 1080p at 30 fps');
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
        expect(shareSendReading(report([src, { ...rung('x', 1080, 58), rid: undefined, targetBitrate: 9_400_000 }]), 60, [{ maxFramerate: 60 }]).sent)
            .toMatchObject({ fps: 58, maxFps: 60, height: 1080, targetKbps: 9400 });
        expect(shareSendReading(report([{ id: 'a', type: 'outbound-rtp', kind: 'audio' }]), undefined)).toEqual({});
    });
});
