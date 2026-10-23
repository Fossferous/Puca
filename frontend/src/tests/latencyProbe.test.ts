/**
 * The latency probe's matching (api/devices/latencyProbe.ts): a probe sent,
 * the agent's answer naming the RTP timestamp of the frame that answers it,
 * and that frame presented — in whichever order the network delivers them.
 */
import { describe, it, expect } from 'vitest';
import { ProbeMatcher, recentMedian, rtpAtOrAfter, PROBE_TIMEOUT_MS, type ProbeResult } from '../api/devices/latencyProbe';

function rig() {
    const m = new ProbeMatcher();
    const results: ProbeResult[] = [];
    m.subscribe(r => results.push(r));
    return { m, results };
}

describe('the latency probe', () => {
    it('answer first, frame later: the time is send to that frame on screen', () => {
        const { m, results } = rig();
        const id = m.sent(1000, false);
        m.answered(id, 90_000, 6.4);
        expect(results, 'not on screen yet').toEqual([]);
        m.presented(87_000, 1030);   // an older frame changes nothing
        expect(results).toEqual([]);
        m.presented(90_000, 1041.5);
        expect(results).toEqual([{ id, totalMs: 41.5, hostMs: 6.4, classic: false }]);
        expect(m.inFlight(1041.5)).toBe(0);
    });

    it('frame first, answer later (the picture beat its answer over the network)', () => {
        const { m, results } = rig();
        const id = m.sent(1000, true);
        m.presented(90_000, 1038);
        m.answered(id, 90_000, null);
        expect(results).toEqual([{ id, totalMs: 38, hostMs: null, classic: true }]);
    });

    it('a frame the renderer skipped resolves on the first later one', () => {
        const { m, results } = rig();
        const id = m.sent(0, false);
        m.answered(id, 90_000, 3);
        m.presented(93_000, 52);
        expect(results.map(r => r.totalMs)).toEqual([52]);
    });

    it('RTP wrap-around: a timestamp just past 2^32 is AFTER one just before it', () => {
        expect(rtpAtOrAfter(10, 0xFFFF_FFF0)).toBe(true);
        expect(rtpAtOrAfter(0xFFFF_FFF0, 10)).toBe(false);
        const { m, results } = rig();
        const id = m.sent(0, false);
        m.answered(id, 0xFFFF_FFF0, 2);
        m.presented(10, 30);
        expect(results.map(r => r.id)).toEqual([id]);
    });

    it('an answer for an unknown or already-answered probe changes nothing', () => {
        const { m, results } = rig();
        m.answered(99, 1, 1);
        const id = m.sent(0, false);
        m.answered(id, 100, 1);
        m.answered(id, 50, 1);   // a duplicate must not move it backwards
        m.presented(60, 10);
        expect(results).toEqual([]);
        m.presented(100, 20);
        expect(results.map(r => r.totalMs)).toEqual([20]);
    });

    it('a probe nobody answers expires instead of piling up', () => {
        const { m } = rig();
        m.sent(0, false);
        expect(m.inFlight(10)).toBe(1);
        // With no frame and no new probe to run the clock, asking is enough.
        expect(m.inFlight(PROBE_TIMEOUT_MS + 1)).toBe(0);
    });

    it('the median of the recent readings', () => {
        expect(recentMedian([])).toBeNull();
        expect(recentMedian([40])).toBe(40);
        expect(recentMedian([40, 50])).toBe(45);
        expect(recentMedian([100, 30, 40, 35, 38, 41, 39, 37], 7)).toBe(38);
    });
});
