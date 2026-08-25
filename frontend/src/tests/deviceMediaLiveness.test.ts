/**
 * The mid-session picture watchdog's ladder (mediaLiveness.ts).
 *
 * Every "never fires" case here has a sibling proving the rig CAN see it fire
 * — a suite of only-negative assertions passes against a ladder that does
 * nothing at all, which is exactly the kind of green this repo has learned
 * not to trust.
 */
import { describe, it, expect } from 'vitest';
import {
    MediaLiveness,
    STALL_AFTER_MS,
    PROBE_SPACING_MS,
    PROBES_BEFORE_ESCALATE,
    INPUT_RECENT_MS,
    PROBE_COOLDOWN_MS,
} from '../api/devices/mediaLiveness';

/** Drive one tick. Defaults describe an eligible, measurable session. */
function tick(
    l: MediaLiveness,
    now: number,
    opts: { frames?: number | null; lastInputAt?: number; eligible?: boolean } = {},
) {
    return l.sample({
        now,
        framesDecoded: opts.frames === undefined ? 0 : opts.frames,
        lastInputAt: opts.lastInputAt ?? 0,
        eligible: opts.eligible ?? true,
    });
}

/** Walk an eligible session from t0 with FROZEN frames and CONTINUOUS input,
 *  sending every probe the ladder asks for; returns the time and count when
 *  `escalate` fired. The positive control most other tests lean on. */
function driveToEscalate(l: MediaLiveness, t0: number): { at: number; probes: number } {
    let probes = 0;
    for (let t = t0; t < t0 + 60_000; t += 1000) {
        const v = tick(l, t, { frames: 7, lastInputAt: t });
        if (v === 'probe') {
            l.probeSent(t);
            probes += 1;
        } else if (v === 'escalate') {
            return { at: t, probes };
        }
    }
    throw new Error('never escalated');
}

describe('MediaLiveness', () => {
    it('advancing frames under input never probe', () => {
        const l = new MediaLiveness();
        for (let t = 0; t < 30_000; t += 1000) {
            expect(tick(l, t, { frames: t / 1000, lastInputAt: t })).toBe('ok');
        }
    });

    it('a still desktop with NOBODY driving never probes (the false-positive bound)', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 5, lastInputAt: 0 });
        for (let t = 1000; t < 60_000; t += 1000) {
            // No input since t=0 and the last frame also landed at t=0: input
            // is not newer than progress, so the clock never starts.
            expect(tick(l, t, { frames: 5, lastInputAt: 0 })).toBe('ok');
        }
    });

    it('frozen frames under input probe, then escalate after unanswered probes', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        const { at, probes } = driveToEscalate(l, 1000);
        expect(probes).toBe(PROBES_BEFORE_ESCALATE);
        // First probe waits out STALL_AFTER_MS from the LAST PROGRESS (the
        // t=0 pre-tick above); each probe — INCLUDING the last — then gets a
        // full PROBE_SPACING_MS answer window. Escalating one tick after the
        // final probe was a real bug: on a slow link the proving IDR arrived
        // just after the verdict.
        const expectedEarliest = STALL_AFTER_MS + PROBES_BEFORE_ESCALATE * PROBE_SPACING_MS;
        expect(at).toBeGreaterThanOrEqual(expectedEarliest);
        expect(at).toBeLessThan(expectedEarliest + 3000);
    });

    it('an answer landing inside the FINAL probe\'s window still averts escalation', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        // Walk to the third (final) probe without answering.
        let probes = 0;
        let lastProbeAt = -1;
        let t = 1000;
        for (; probes < PROBES_BEFORE_ESCALATE; t += 1000) {
            const v = tick(l, t, { frames: 7, lastInputAt: t });
            expect(v).not.toBe('escalate');
            if (v === 'probe') { l.probeSent(t); probes += 1; lastProbeAt = t; }
        }
        // A slow IDR: answered 3s after the final probe, inside its window.
        expect(tick(l, lastProbeAt + 3000, { frames: 8, lastInputAt: lastProbeAt + 3000 })).toBe('ok');
        // No escalation follows — the ladder reset on progress.
        for (let u = lastProbeAt + 4000; u < lastProbeAt + 10_000; u += 1000) {
            expect(tick(l, u, { frames: 8, lastInputAt: 0 })).toBe('ok');
        }
    });

    it('an ANSWERED probe resets the ladder and opens the cooldown', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        // Stall under input until the first probe.
        let probeAt = -1;
        for (let t = 1000; t <= 10_000; t += 1000) {
            if (tick(l, t, { frames: 7, lastInputAt: t }) === 'probe') {
                l.probeSent(t);
                probeAt = t;
                break;
            }
        }
        expect(probeAt).toBeGreaterThan(0);
        // The agent answers with an IDR: frames advance once, then freeze again.
        expect(tick(l, probeAt + 1000, { frames: 8, lastInputAt: probeAt + 1000 })).toBe('ok');
        // Continued input over the still picture: silent for the whole cooldown...
        for (let t = probeAt + 2000; t < probeAt + 1000 + PROBE_COOLDOWN_MS; t += 1000) {
            expect(tick(l, t, { frames: 8, lastInputAt: t })).toBe('ok');
        }
        // ...and the sibling positive control: it DOES probe again afterwards.
        let probedAgain = false;
        for (let t = probeAt + 1000 + PROBE_COOLDOWN_MS; t < probeAt + 1000 + PROBE_COOLDOWN_MS + STALL_AFTER_MS + 2000; t += 1000) {
            if (tick(l, t, { frames: 8, lastInputAt: t }) === 'probe') {
                probedAgain = true;
                break;
            }
        }
        expect(probedAgain).toBe(true);
    });

    it('a probe suppressed by the shared budget (probeSent never called) is re-offered next tick', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        let firstProbe = -1;
        for (let t = 1000; t <= 10_000; t += 1000) {
            if (tick(l, t, { frames: 7, lastInputAt: t }) === 'probe') { firstProbe = t; break; }
        }
        expect(firstProbe).toBeGreaterThan(0);
        // Not sent (requestKeyframe returned false) — the next tick offers again
        // rather than waiting out PROBE_SPACING_MS for a probe that never left.
        expect(tick(l, firstProbe + 1000, { frames: 7, lastInputAt: firstProbe + 1000 })).toBe('probe');
    });

    it('ineligible ticks and null stats do not count toward a stall', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        // 30s of frozen frames under input — but ineligible (reconnecting) or
        // unmeasurable. Nothing may fire: these clocks measure the observer.
        for (let t = 1000; t < 15_000; t += 1000) {
            expect(tick(l, t, { frames: 7, lastInputAt: t, eligible: false })).toBe('ok');
        }
        for (let t = 15_000; t < 30_000; t += 1000) {
            expect(tick(l, t, { frames: null, lastInputAt: t })).toBe('ok');
        }
        // Positive control: the same ladder, made eligible again, still walks
        // all the way to escalate — it was dormant, not dead.
        expect(driveToEscalate(l, 30_000).probes).toBe(PROBES_BEFORE_ESCALATE);
    });

    it('input older than INPUT_RECENT_MS stops the ladder mid-climb', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        const inputStopped = 2000;
        // Input happened at t=2000 (after the last frame at t=0), then the
        // user walked away. Probes may fire inside the recency window...
        let sawProbe = false;
        for (let t = 1000; t <= inputStopped + INPUT_RECENT_MS; t += 1000) {
            const v = tick(l, t, { frames: 7, lastInputAt: inputStopped });
            if (v === 'probe') { l.probeSent(t); sawProbe = true; }
            expect(v).not.toBe('escalate');
        }
        expect(sawProbe).toBe(true); // control: the window was genuinely armed
        // ...but once the input is stale, the ladder goes quiet instead of
        // escalating a stall nobody is looking at.
        for (let t = inputStopped + INPUT_RECENT_MS + 1000; t < inputStopped + INPUT_RECENT_MS + 20_000; t += 1000) {
            expect(tick(l, t, { frames: 7, lastInputAt: inputStopped })).toBe('ok');
        }
    });

    it('a framesDecoded REGRESSION (fresh pc after restart) counts as progress', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 500, lastInputAt: 0 });
        // Approach the stall threshold...
        tick(l, 3000, { frames: 500, lastInputAt: 3000 });
        // ...then the counter resets to 1 (new RTCPeerConnection): progress,
        // not a deeper stall.
        expect(tick(l, 4000, { frames: 1, lastInputAt: 4000 })).toBe('ok');
        expect(tick(l, 5000, { frames: 1, lastInputAt: 5000 })).toBe('ok'); // clock restarted
    });

    it('reset() starts a fresh measurement instead of instantly re-escalating', () => {
        const l = new MediaLiveness();
        tick(l, 0, { frames: 7, lastInputAt: 0 });
        const { at } = driveToEscalate(l, 1000);
        l.reset(at);
        // Immediately after reset, the same frozen picture must not escalate —
        // the restart owns the next STALL_AFTER_MS + probe ladder.
        expect(tick(l, at + 1000, { frames: 7, lastInputAt: at + 1000 })).toBe('ok');
        // Control: it can still walk the whole ladder again from here.
        expect(driveToEscalate(l, at + 2000).probes).toBe(PROBES_BEFORE_ESCALATE);
    });
});
