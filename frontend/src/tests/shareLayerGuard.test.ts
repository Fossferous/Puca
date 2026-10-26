// @vitest-environment jsdom
/**
 * A viewer whose connection keeps losing a watched share is asked a smaller
 * copy of it, and given the full picture back after a clean stretch
 * (shareLayerGuard.ts). jsdom only because livekit-client, imported for the
 * real VideoQuality numbers the guard mirrors, reads `window` as it loads.
 *
 * THE REPORT (2026-10-25). One viewer of a 1080p60 share lost packets from
 * every sender and froze for 7.3 s, and stayed on the full picture. The other
 * froze for 1.4-2.3 s with NOTHING lost, behind a sharer short of frames: a
 * smaller copy would not have helped them, and must not be taken from them.
 *
 * What is pinned: it steps on sustained loss or freezes that came with packet
 * trouble, never on one bad window or on freezes with none; it comes back only
 * after a clean stretch; and a link that is bad whenever it is given the full
 * picture is not switched back and forth (the wait doubles).
 */
import { describe, it, expect } from 'vitest';
import { VideoQuality } from 'livekit-client';

import {
    ShareLayerGuard, lowerLayer, shareLayers, qualityName,
    CLEAN_MAX_MS, CLEAN_MS, FORGIVE_MS, FREEZE_SPAN_MS, LOSSY_PCT, MIN_PACKETS, QUALITY, SETTLE_MS, VIEW_SAMPLE_MS,
    type LayerChange, type ReceiveSample,
} from '../api/rtc/shareLayerGuard';

interface Window {
    lossPct?: number;
    /** Packets in the window (a 9.4 Mb/s share: about 800 a second). */
    packets?: number;
    freezes?: number;
    nack?: number;
    pli?: number;
}

/** A receiver read every VIEW_SAMPLE_MS, its counters grown by each window. */
function link() {
    let at = 0;
    let recv = 0;
    let lost = 0;
    let frz = 0;
    let nack = 0;
    let pli = 0;
    return (w: Window): ReceiveSample => {
        at += VIEW_SAMPLE_MS;
        const packets = w.packets ?? 2400;
        const l = Math.round((packets * (w.lossPct ?? 0)) / 100);
        recv += packets - l;
        lost += l;
        frz += w.freezes ?? 0;
        nack += w.nack ?? l;
        pli += w.pli ?? 0;
        return { atMs: at, packetsReceived: recv, packetsLost: lost, freezeCount: frz, nackCount: nack, pliCount: pli };
    };
}

/** Run `n` windows; every change with the time it happened. */
function run(guard: ShareLayerGuard, next: (w: Window) => ReceiveSample, n: number, w: Window | ((g: ShareLayerGuard) => Window)) {
    const changes: Array<LayerChange & { at: number }> = [];
    for (let i = 0; i < n; i++) {
        const s = next(typeof w === 'function' ? w(guard) : w);
        const c = guard.observe(s);
        if (c) changes.push({ ...c, at: s.atMs });
    }
    return changes;
}

const clean: Window = {};
const lossy: Window = { lossPct: 3 };
const settleWindows = Math.ceil(SETTLE_MS / VIEW_SAMPLE_MS) + 1;

describe('when it steps down', () => {
    it('on a connection that keeps losing packets, after two lossy windows, not one', () => {
        const g = new ShareLayerGuard();
        const next = link();
        run(g, next, settleWindows, clean);
        expect(run(g, next, 1, lossy), 'one lossy window is a moment').toEqual([]);
        const [c] = run(g, next, 1, lossy);
        expect(c?.to).toBe('reduced');
        expect(c?.why).toContain('2 of the last');
        expect(g.state).toBe('reduced');
    });

    it('never on a connection that is fine (the NEGATIVE CONTROL for all of these)', () => {
        const g = new ShareLayerGuard();
        expect(run(g, link(), 2000, clean)).toEqual([]);
        expect(g.state).toBe('full');
    });

    it('draws the line at about 1%', () => {
        expect(run(new ShareLayerGuard(), link(), 400, { lossPct: LOSSY_PCT * 0.8 })).toEqual([]);
        expect(run(new ShareLayerGuard(), link(), 400, { lossPct: LOSSY_PCT * 1.5 }).map(c => c.to)).toEqual(['reduced']);
    });

    it('does not read a percentage into a handful of packets', () => {
        // One lost of twenty is 5%, and means nothing.
        expect(run(new ShareLayerGuard(), link(), 400, { packets: 20, lossPct: 5 })).toEqual([]);
        expect(MIN_PACKETS).toBeGreaterThan(20);
    });

    it('on two freezes in a minute in windows that lost packets or asked for a keyframe again', () => {
        const g = new ShareLayerGuard();
        const next = link();
        run(g, next, settleWindows, clean);
        // 0.6% lost: the network's (CLEAN_PCT or more), though not a lossy window.
        expect(run(g, next, 1, { freezes: 1, lossPct: 0.6 })).toEqual([]);
        run(g, next, 5, clean);
        const [c] = run(g, next, 1, { freezes: 1, pli: 1 });
        expect(c?.to).toBe('reduced');
        expect(c?.why).toContain('2 freezes');
    });

    it('never on freezes with nothing lost: the sender\'s frames never left, or the picture stopped', () => {
        // The other viewer that evening: 1.4-2.3 s freezes, zero loss. A
        // smaller copy freezes there just the same.
        expect(run(new ShareLayerGuard(), link(), 400, { freezes: 2 })).toEqual([]);
        // ...and two freezes spread wider than a minute do not add up.
        const g = new ShareLayerGuard();
        const next = link();
        run(g, next, settleWindows, clean);
        run(g, next, 1, { freezes: 1, pli: 1 });
        run(g, next, Math.ceil(FREEZE_SPAN_MS / VIEW_SAMPLE_MS), clean);
        expect(run(g, next, 1, { freezes: 1, pli: 1 })).toEqual([]);
    });

    it('never on freezes beside a lone repaired packet: slides or code over busy Wi-Fi', () => {
        // Measured on a real capture: a picture that pauses "freezes" one to
        // three times a window with nothing lost, and busy Wi-Fi repairs a
        // packet now and then. One NACK in every busy window stepped a healthy
        // viewer down within 9-15 s, and it never came back.
        expect(run(new ShareLayerGuard(), link(), 400, { freezes: 2, nack: 1 })).toEqual([]);
        expect(run(new ShareLayerGuard(), link(), 400, { freezes: 3, nack: 1, lossPct: 0.3 }), '7 of 2400 lost: under CLEAN_PCT').toEqual([]);
        // POSITIVE CONTROL: the same freezes beside a keyframe asked for again.
        expect(run(new ShareLayerGuard(), link(), 40, { freezes: 2, nack: 1, pli: 1 }).map(c => c.to)).toEqual(['reduced']);
    });

    it('judges nothing while the share settles after it is first seen', () => {
        const g = new ShareLayerGuard();
        const next = link();
        expect(run(g, next, Math.floor(SETTLE_MS / VIEW_SAMPLE_MS), { lossPct: 10, freezes: 3 })).toEqual([]);
    });
});

describe('coming back to the full picture', () => {
    /** A guard stepped down at the end of a lossy spell; the time it did. */
    const steppedDown = () => {
        const g = new ShareLayerGuard();
        const next = link();
        run(g, next, settleWindows, clean);
        const [c] = run(g, next, 3, lossy);
        expect(c?.to, 'fixture: stepped down').toBe('reduced');
        return { g, next, at: c!.at };
    };

    it('after a clean stretch, and not a window before it', () => {
        const { g, next, at } = steppedDown();
        const changes = run(g, next, 200, clean);
        expect(changes.map(c => c.to)).toEqual(['full']);
        const after = changes[0].at - at;
        expect(after, 'the settle after the step, then CLEAN_MS clean').toBeGreaterThanOrEqual(SETTLE_MS + CLEAN_MS);
        expect(after).toBeLessThanOrEqual(SETTLE_MS + CLEAN_MS + 2 * VIEW_SAMPLE_MS);
    });

    it('starts the stretch again after any window that is not clean', () => {
        const { g, next, at } = steppedDown();
        run(g, next, Math.round((SETTLE_MS + CLEAN_MS / 2) / VIEW_SAMPLE_MS), clean);
        run(g, next, 1, lossy);
        const changes = run(g, next, 200, clean);
        expect(changes[0].at - at, 'half a stretch, a lossy window, then a whole one').toBeGreaterThan(SETTLE_MS + CLEAN_MS * 1.5);
    });

    it('comes back through freezes beside lone repaired packets, and stays back', () => {
        // The other half of the trap above: those windows used to restart the
        // clean stretch for ever.
        const { g, next } = steppedDown();
        expect(run(g, next, 400, { freezes: 2, nack: 1 }).map(c => c.to)).toEqual(['full']);
    });

    it('stays on the smaller copy for as long as that copy keeps losing too', () => {
        const { g, next } = steppedDown();
        expect(run(g, next, 1000, lossy)).toEqual([]);
        expect(g.state).toBe('reduced');
    });
});

describe('never thrashing', () => {
    it('doubles the wait each time the full picture has to be left again soon after', () => {
        // The worst link: bad whenever it is given the full picture, clean on
        // the smaller copy. An hour of it.
        const g = new ShareLayerGuard();
        const changes = run(g, link(), Math.round(3_600_000 / VIEW_SAMPLE_MS), (guard) => (guard.state === 'full' ? lossy : clean));
        const ups = changes.filter(c => c.to === 'full');
        const downs = changes.filter(c => c.to === 'reduced');
        expect(downs.length).toBeGreaterThan(1);
        // Each stretch on the smaller copy at least as long as the last, and
        // growing until the cap: 60 s, 120 s, 240 s, 480 s, 480 s...
        const stays = ups.map(u => u.at - downs.filter(d => d.at < u.at).at(-1)!.at);
        for (let i = 1; i < stays.length; i++) expect(stays[i], `stay ${i}`).toBeGreaterThanOrEqual(stays[i - 1] - VIEW_SAMPLE_MS);
        expect(stays.at(-1)!).toBeGreaterThanOrEqual(CLEAN_MAX_MS);
        // So an hour holds a handful of tries at the full picture, not hundreds.
        expect(ups.length).toBeLessThanOrEqual(10);
        expect(g.cleanWaitMs).toBe(CLEAN_MAX_MS);
    });

    it('forgives a long healthy stretch at the full picture', () => {
        const g = new ShareLayerGuard();
        const next = link();
        // Two relapses: the wait is now four times CLEAN_MS...
        run(g, next, 600, (guard) => (guard.state === 'full' ? lossy : clean));
        expect(g.cleanWaitMs).toBeGreaterThan(CLEAN_MS);
        // ...then the connection recovers for good at the full picture.
        run(g, next, 400, (guard) => (guard.state === 'full' ? clean : clean));
        expect(g.state).toBe('full');
        run(g, next, Math.ceil(FORGIVE_MS / VIEW_SAMPLE_MS) + 1, clean);
        const [c] = run(g, next, 3, lossy);
        expect(c?.to).toBe('reduced');
        expect(g.cleanWaitMs, 'a fresh bad spell waits the first wait again').toBe(CLEAN_MS);
    });
});

describe('counters from another receiver', () => {
    const read = (atMs: number, recv: number, lost: number): ReceiveSample =>
        ({ atMs, packetsReceived: recv, packetsLost: lost, freezeCount: 0, nackCount: lost, pliCount: 0 });
    /** A guard past its settling with ONE real lossy window behind it: one
     *  more lossy window, read or misread, steps it down. */
    const oneLossyBehind = () => {
        const g = new ShareLayerGuard();
        let t = 0;
        let recv = 0;
        for (let i = 0; i < settleWindows; i++) g.observe(read(t += VIEW_SAMPLE_MS, recv += 2400, 0));
        expect(g.observe(read(t += VIEW_SAMPLE_MS, recv += 2300, 100)), 'fixture: one lossy window, no step').toBeNull();
        return { g, t, recv };
    };

    it('never reads a counter that went back as a window', () => {
        // Published again: the new receiver counts from zero, and lost a burst
        // as it started. Against the old counters that would read as a
        // window losing 50,000 packets: the second lossy window, a step.
        const { g, t } = oneLossyBehind();
        expect(g.observe(read(t + VIEW_SAMPLE_MS, 1000, 50_100))).toBeNull();
        expect(g.state).toBe('full');
    });

    it('takes a new baseline after resetCounters, even when the new counts are higher', () => {
        const { g, t, recv } = oneLossyBehind();
        g.resetCounters();
        expect(g.observe(read(t + VIEW_SAMPLE_MS, recv + 90_000, 60_000)), 'a baseline, not a window').toBeNull();
        expect(g.observe(read(t + 2 * VIEW_SAMPLE_MS, recv + 92_400, 60_000)), 'then windows as usual').toBeNull();
        expect(g.state).toBe('full');
        // POSITIVE CONTROL: the same jump read as a window IS the second lossy one.
        const { g: h, t: t2, recv: r2 } = oneLossyBehind();
        expect(h.observe(read(t2 + VIEW_SAMPLE_MS, r2 + 90_000, 60_000))?.to).toBe('reduced');
    });
});

describe('which copy is the next smaller one', () => {
    const three = { simulcasted: true, trackInfo: { layers: [{ quality: 0 }, { quality: 1 }, { quality: 2 }] } };

    it('mirrors livekit-client\'s numbering', () => {
        expect(QUALITY).toEqual({ LOW: VideoQuality.LOW, MEDIUM: VideoQuality.MEDIUM, HIGH: VideoQuality.HIGH });
        expect(qualityName(VideoQuality.MEDIUM)).toBe('medium');
    });

    it('is the middle copy for a share at three sizes', () => {
        expect(lowerLayer(QUALITY.HIGH, shareLayers(three))).toBe(QUALITY.MEDIUM);
        // Three or more shares watched ask for MEDIUM already: one below it.
        expect(lowerLayer(QUALITY.MEDIUM, shareLayers(three))).toBe(QUALITY.LOW);
        expect(lowerLayer(QUALITY.LOW, shareLayers(three))).toBeNull();
    });

    it('is the bottom copy for a share at two sizes, whose full picture is MEDIUM', () => {
        // livekit-client names a two-encoding ladder's rids q and h: LOW and
        // MEDIUM. Asking it for MEDIUM would change nothing.
        const two = { simulcasted: true, trackInfo: { layers: [{ quality: 0 }, { quality: 1 }] } };
        expect(lowerLayer(QUALITY.HIGH, shareLayers(two))).toBe(QUALITY.LOW);
    });

    it('is nothing for a share sent at one size', () => {
        expect(lowerLayer(QUALITY.HIGH, shareLayers({ simulcasted: false, trackInfo: { layers: [{ quality: 2 }] } }))).toBeNull();
        expect(lowerLayer(QUALITY.HIGH, shareLayers({}))).toBeNull();
    });

    it('reads the per-codec layer lists too, and assumes three for a ladder that lists none', () => {
        expect(shareLayers({ simulcasted: true, trackInfo: { layers: [], codecs: [{ layers: [{ quality: 0 }, { quality: 2 }] }] } }))
            .toEqual([QUALITY.LOW, QUALITY.HIGH]);
        expect(shareLayers({ simulcasted: true })).toEqual([QUALITY.LOW, QUALITY.MEDIUM, QUALITY.HIGH]);
    });
});
