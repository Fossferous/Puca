/**
 * The desktop stage's measured latency: the probe (latencyProbe.ts) run once a
 * second while the stats chip is up, and the before-and-after comparison.
 *
 * Presented frames come from `requestVideoFrameCallback` on the stage's video,
 * whose metadata carries each frame's `rtpTimestamp` and when it is expected
 * on screen. The loop is (re)started on whatever <video> the stage has now, so
 * a minimise-and-restore that remounts the element keeps measuring.
 *
 * An agent that predates the probe never answers it. Three unanswered in a row
 * and this stops asking for the rest of the session, rather than putting a
 * refused-frame line in that computer's log every second.
 */
import { useEffect, useRef, useState } from 'react';
import { latencyProbeUsable, noteFramePresented, sendLatencyProbe, subscribeLatency } from './session';
import { PROBE_TIMEOUT_MS, recentMedian, type ProbeResult } from './latencyProbe';

export interface LatencyReading {
    /** Median of the recent probes with the current timing, ms. */
    totalMs: number | null;
    /** The other computer's share of it, ms. */
    hostMs: number | null;
    samples: number;
    /** The far end never answers (an older agent), or there is no direct channel. */
    unavailable: boolean;
}

export interface LatencyComparison {
    running: boolean;
    /** Median with the OLD timing (the agent's capture not pulled in), ms. */
    oldMs: number | null;
    /** Median with the current timing, ms. */
    newMs: number | null;
}

type VideoWithFrames = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: { rtpTimestamp?: number; expectedDisplayTime?: number }) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
};

/** How often a probe goes out while the chip is up. */
const PROBE_EVERY_MS = 1_000;
/** Unanswered probes in a row before giving up for the session. */
const GIVE_UP_AFTER = 3;
/** Probes per arm of a comparison, and their spacing. */
const COMPARE_EACH = 8;
const COMPARE_EVERY_MS = 300;

export function useLatencyProbe(
    sessionId: string | null,
    on: boolean,
    video: () => HTMLVideoElement | null,
): { reading: LatencyReading | null; comparison: LatencyComparison; compare: () => void } {
    const [state, setState] = useState<{ id: string; results: ProbeResult[]; unavailable: boolean } | null>(null);
    const [comparison, setComparison] = useState<LatencyComparison>({ running: false, oldMs: null, newMs: null });
    const compareRef = useRef<{ old: number[]; now: number[]; left: number } | null>(null);
    const videoRef = useRef(video);
    useEffect(() => { videoRef.current = video; }, [video]);

    useEffect(() => {
        if (!sessionId || !on) return;
        let alive = true;
        let misses = 0;
        let lastSent = 0;
        let answeredSince = true;
        let rvfcOn: { el: VideoWithFrames; handle: number } | null = null;

        const unsub = subscribeLatency(sessionId, r => {
            if (!alive) return;
            answeredSince = true;
            misses = 0;
            const cmp = compareRef.current;
            if (cmp) (r.classic ? cmp.old : cmp.now).push(r.totalMs);
            if (r.classic) return;
            setState(prev => ({
                id: sessionId,
                results: [...(prev && prev.id === sessionId ? prev.results : []), r].slice(-30),
                unavailable: false,
            }));
        });

        // Frames presented, from whichever <video> the stage has right now.
        const ensureFrames = () => {
            const el = videoRef.current() as VideoWithFrames | null;
            if (!el || typeof el.requestVideoFrameCallback !== 'function') return;
            if (rvfcOn && rvfcOn.el === el) return;
            if (rvfcOn) rvfcOn.el.cancelVideoFrameCallback?.(rvfcOn.handle);
            const loop = (now: number, meta: { rtpTimestamp?: number; expectedDisplayTime?: number }) => {
                if (!alive || !rvfcOn || rvfcOn.el !== el) return;
                if (typeof meta.rtpTimestamp === 'number') {
                    noteFramePresented(sessionId, meta.rtpTimestamp, meta.expectedDisplayTime ?? now);
                }
                rvfcOn.handle = el.requestVideoFrameCallback!(loop);
            };
            rvfcOn = { el, handle: el.requestVideoFrameCallback(loop) };
        };

        const tick = () => {
            if (!alive) return;
            ensureFrames();
            const t = performance.now();
            const cmp = compareRef.current;
            const every = cmp ? COMPARE_EVERY_MS : PROBE_EVERY_MS;
            if (t - lastSent < every) return;
            // The last probe got no answer in time: count it, once.
            if (!answeredSince && t - lastSent >= PROBE_TIMEOUT_MS) {
                answeredSince = true;
                misses++;
                if (misses >= GIVE_UP_AFTER) {
                    setState({ id: sessionId, results: [], unavailable: true });
                    if (cmp) {
                        compareRef.current = null;
                        setComparison({ running: false, oldMs: null, newMs: null });
                    }
                    window.clearInterval(timer);
                    return;
                }
            }
            if (!latencyProbeUsable(sessionId)) return;
            // Alternate the arms during a comparison; the current timing otherwise.
            const classic = cmp ? cmp.left % 2 === 0 : false;
            if (sendLatencyProbe(sessionId, classic)) {
                lastSent = t;
                answeredSince = false;
                if (cmp) {
                    cmp.left--;
                    if (cmp.left <= 0) {
                        // Let the last answers land, then report.
                        window.setTimeout(() => {
                            const done = compareRef.current;
                            compareRef.current = null;
                            if (!alive || !done) return;
                            setComparison({ running: false, oldMs: recentMedian(done.old, 99), newMs: recentMedian(done.now, 99) });
                        }, PROBE_TIMEOUT_MS);
                    }
                }
            }
        };
        const timer = window.setInterval(tick, 100);
        tick();
        return () => {
            alive = false;
            window.clearInterval(timer);
            unsub();
            if (rvfcOn) rvfcOn.el.cancelVideoFrameCallback?.(rvfcOn.handle);
        };
    }, [sessionId, on]);

    const compare = () => {
        if (compareRef.current) return;
        compareRef.current = { old: [], now: [], left: COMPARE_EACH * 2 };
        setComparison({ running: true, oldMs: null, newMs: null });
    };

    const mine = on && state && state.id === sessionId ? state : null;
    const reading: LatencyReading | null = mine
        ? {
            totalMs: recentMedian(mine.results.map(r => r.totalMs)),
            hostMs: recentMedian(mine.results.filter(r => r.hostMs !== null).map(r => r.hostMs as number)),
            samples: mine.results.length,
            unavailable: mine.unavailable,
        }
        : null;
    return { reading, comparison, compare };
}
